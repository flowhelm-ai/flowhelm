/**
 * Vault-backed WhatsApp auth state.
 *
 * Stores all Baileys authentication state (creds + signal keys) inside the
 * encrypted credential vault (credentials.enc) rather than as plaintext
 * files on disk. This gives WhatsApp session data the same AES-256-GCM
 * protection as all other FlowHelm secrets (API keys, OAuth tokens, etc.).
 *
 * Storage layout inside `secrets`:
 *   "whatsapp-auth-creds"      → JSON(AuthenticationCreds)
 *   "wa-key:{type}:{id}"       → JSON(key data)
 *
 * The CredentialStore's load/save cycle is atomic: every write re-encrypts
 * the entire vault. Signal key operations batch via a dirty flag to avoid
 * excessive re-encryption on high-frequency key updates during pairing.
 */

import {
  initAuthCreds,
  BufferJSON,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
  type SignalDataSet,
  type SignalKeyStore,
} from '@whiskeysockets/baileys';
import type { CredentialStore } from '../../proxy/credential-store.js';

const CREDS_SECRET_KEY = 'whatsapp-auth-creds';
const KEY_PREFIX = 'wa-key:';

/** Serialize a value with Baileys' Buffer-aware JSON replacer. */
function serialize(value: unknown): string {
  return JSON.stringify(value, BufferJSON.replacer);
}

/** Deserialize a value with Baileys' Buffer-aware JSON reviver. */
function deserialize<T>(json: string): T {
  return JSON.parse(json, BufferJSON.reviver) as T;
}

/** Build the secret key for a signal key entry. */
function keyName(type: string, id: string): string {
  return `${KEY_PREFIX}${type}:${id}`;
}

/**
 * Options for creating a vault-backed auth state.
 */
export interface VaultAuthStateOptions {
  /** The credential store (provides get/set secret + load/save). */
  store: CredentialStore;
}

/**
 * Result of initializing vault-backed auth state.
 * Mirrors the shape returned by Baileys' useMultiFileAuthState.
 */
export interface VaultAuthState {
  /** The AuthenticationState to pass to makeWASocket. */
  state: AuthenticationState;
  /** Save current creds to the vault. Call on 'creds.update' events. */
  saveCreds: () => Promise<void>;
}

/**
 * Create a vault-backed auth state for Baileys.
 *
 * Replaces useMultiFileAuthState — instead of reading/writing individual
 * files on disk, all auth data lives inside CredentialStore (credentials.enc).
 *
 * Usage:
 *   const { state, saveCreds } = await useVaultAuthState({ store });
 *   const socket = makeWASocket({ auth: state });
 *   socket.ev.on('creds.update', saveCreds);
 */
export async function useVaultAuthState(options: VaultAuthStateOptions): Promise<VaultAuthState> {
  const { store } = options;

  // Load or initialize creds
  const credsJson = await store.getSecret(CREDS_SECRET_KEY);
  const creds: AuthenticationCreds = credsJson
    ? deserialize<AuthenticationCreds>(credsJson)
    : initAuthCreds();

  // Save creds to vault
  const saveCreds = async (): Promise<void> => {
    await store.setSecret(CREDS_SECRET_KEY, serialize(creds));
  };

  // If this is a fresh init, persist the initial creds
  if (!credsJson) {
    await saveCreds();
  }

  // Signal key store backed by vault secrets
  const keys: SignalKeyStore = {
    async get<T extends keyof SignalDataTypeMap>(
      type: T,
      ids: string[],
    ): Promise<Record<string, SignalDataTypeMap[T]>> {
      const data: Record<string, SignalDataTypeMap[T]> = {};
      const rules = await store.load();

      for (const id of ids) {
        const json = rules.secrets[keyName(type, id)];
        if (json) {
          let value = deserialize<SignalDataTypeMap[T]>(json);
          // Baileys requires AppStateSyncKeyData to be a protobuf instance
          if (type === 'app-state-sync-key' && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(
              value as Record<string, unknown>,
            ) as unknown as SignalDataTypeMap[T];
          }
          data[id] = value;
        }
      }

      return data;
    },

    async set(data: SignalDataSet): Promise<void> {
      // Batch all key changes into a single vault write
      const rules = await store.load();
      let changed = false;

      for (const category in data) {
        const entries = data[category as keyof SignalDataSet];
        if (!entries) continue;
        for (const id in entries) {
          const value = entries[id];
          const name = keyName(category, id);
          if (value) {
            rules.secrets[name] = serialize(value);
            changed = true;
          } else {
            // null value = remove key
            if (name in rules.secrets) {
              Reflect.deleteProperty(rules.secrets, name);
              changed = true;
            }
          }
        }
      }

      if (changed) {
        await store.save(rules);
      }
    },
  };

  return {
    state: { creds, keys },
    saveCreds,
  };
}

/**
 * Remove all WhatsApp auth state from the vault.
 * Called when the user explicitly logs out or resets their WhatsApp session.
 */
export async function clearVaultAuthState(store: CredentialStore): Promise<void> {
  const rules = await store.load();
  let changed = false;

  // Remove creds
  if (CREDS_SECRET_KEY in rules.secrets) {
    Reflect.deleteProperty(rules.secrets, CREDS_SECRET_KEY);
    changed = true;
  }

  // Remove all signal keys
  for (const key of Object.keys(rules.secrets)) {
    if (key.startsWith(KEY_PREFIX)) {
      Reflect.deleteProperty(rules.secrets, key);
      changed = true;
    }
  }

  if (changed) {
    await store.save(rules);
  }
}
