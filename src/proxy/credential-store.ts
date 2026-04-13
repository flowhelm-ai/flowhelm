/**
 * Encrypted credential storage.
 *
 * Credentials are stored as AES-256-GCM encrypted JSON at
 * ~/.flowhelm/secrets/credentials.enc. The encryption key is
 * derived from a random 32-byte key file at ~/.flowhelm/secrets/credentials.key
 * (chmod 400). The proxy container receives the raw key as an env var
 * at launch and decrypts credentials into memory.
 *
 * File layout:
 *   ~/.flowhelm/secrets/
 *     credentials.enc   — AES-256-GCM ciphertext (IV + authTag + encrypted JSON)
 *     credentials.key   — 32-byte random key (chmod 400)
 */

import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { parseCredentialRules, type CredentialRules } from './credential-schema.js';
import { ensureCA as ensureCAImpl, caPaths, type CACertificate } from './ca-manager.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

// ─── Low-Level Crypto ──────────────────────────────────────────────────────

/**
 * Encrypt plaintext with AES-256-GCM.
 * Returns Buffer: [IV (16)] [authTag (16)] [ciphertext (...)]
 */
export function encrypt(plaintext: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]);
}

/**
 * Decrypt AES-256-GCM ciphertext.
 * Input Buffer: [IV (16)] [authTag (16)] [ciphertext (...)]
 * Throws on authentication failure (tampered or wrong key).
 */
export function decrypt(data: Buffer, key: Buffer): Buffer {
  if (data.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Encrypted data too short');
  }

  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// ─── Key Management ────────────────────────────────────────────────────────

/**
 * Generate a new random 32-byte encryption key.
 */
export function generateKey(): Buffer {
  return randomBytes(KEY_LENGTH);
}

/**
 * Read the encryption key from a file.
 * Validates that the key is exactly 32 bytes.
 */
export async function readKeyFile(keyPath: string): Promise<Buffer> {
  const key = await readFile(keyPath);
  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `Invalid key file: expected ${String(KEY_LENGTH)} bytes, got ${String(key.length)}`,
    );
  }
  return key;
}

/**
 * Write an encryption key to a file with restrictive permissions (0o400).
 * Creates parent directories if needed.
 */
export async function writeKeyFile(keyPath: string, key: Buffer): Promise<void> {
  await mkdir(dirname(keyPath), { recursive: true });
  await writeFile(keyPath, key, { mode: 0o400 });
}

// ─── Credential File Operations ────────────────────────────────────────────

/**
 * Save credential rules to an encrypted file.
 * Creates parent directories and sets restrictive permissions.
 */
export async function saveCredentials(
  rules: CredentialRules,
  encPath: string,
  key: Buffer,
): Promise<void> {
  const json = JSON.stringify(rules, null, 2);
  const encrypted = encrypt(Buffer.from(json, 'utf-8'), key);

  await mkdir(dirname(encPath), { recursive: true });
  // Use 0o600 (owner rw) so the file can be overwritten on update.
  // The secrets directory itself is 0o700.
  await writeFile(encPath, encrypted, { mode: 0o600 });
}

/**
 * Load and decrypt credential rules from an encrypted file.
 * Validates the decrypted JSON against the credential rules schema.
 * Returns empty rules if the file does not exist.
 */
export async function loadCredentials(encPath: string, key: Buffer): Promise<CredentialRules> {
  let data: Buffer;
  try {
    data = await readFile(encPath);
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { credentials: [], pinningBypass: [], secrets: {} };
    }
    throw err;
  }

  const decrypted = decrypt(data, key);
  const json: unknown = JSON.parse(decrypted.toString('utf-8'));
  return parseCredentialRules(json);
}

// ─── Credential Store (High-Level API) ─────────────────────────────────────

export interface CredentialStoreOptions {
  /** Path to the secrets directory (e.g., ~/.flowhelm/secrets). */
  secretsDir: string;
  /**
   * Provide the encryption key directly instead of reading from a file.
   * Used inside containers where the key arrives as an env var, not a file.
   */
  keyOverride?: Buffer;
}

/**
 * High-level credential store API.
 *
 * Manages the credential rules file and encryption key. Used by the CLI
 * for `flowhelm credentials add/remove/list` and by the proxy manager
 * for passing the key to the proxy container.
 */
export class CredentialStore {
  readonly secretsDir: string;
  private readonly keyOverride: Buffer | undefined;

  constructor(options: CredentialStoreOptions) {
    this.secretsDir = options.secretsDir;
    this.keyOverride = options.keyOverride;
  }

  /** Path to the encrypted credentials file. */
  get encPath(): string {
    return join(this.secretsDir, 'credentials.enc');
  }

  /** Path to the encryption key file. */
  get keyPath(): string {
    return join(this.secretsDir, 'credentials.key');
  }

  /** Path to the CA private key. */
  get caKeyPath(): string {
    return caPaths(this.secretsDir).keyPath;
  }

  /** Path to the CA certificate. */
  get caCertPath(): string {
    return caPaths(this.secretsDir).certPath;
  }

  /**
   * Ensure the key file exists. If not, generate a new key and write it.
   * Returns the encryption key.
   * When keyOverride is set (container mode), returns it directly.
   */
  async ensureKey(): Promise<Buffer> {
    if (this.keyOverride) return this.keyOverride;
    try {
      return await readKeyFile(this.keyPath);
    } catch {
      const key = generateKey();
      await writeKeyFile(this.keyPath, key);
      return key;
    }
  }

  /** Load credential rules (empty if no file exists yet). */
  async load(): Promise<CredentialRules> {
    const key = await this.ensureKey();
    return loadCredentials(this.encPath, key);
  }

  /** Save credential rules (encrypts and writes). */
  async save(rules: CredentialRules): Promise<void> {
    const key = await this.ensureKey();
    await saveCredentials(rules, this.encPath, key);
  }

  /**
   * Add a credential rule. Replaces any existing rule with the same name.
   * Returns the updated rules.
   */
  async addCredential(
    name: string,
    hostPattern: string,
    header: string,
    value: string,
    rateLimit?: { requests: number; windowSeconds: number },
  ): Promise<CredentialRules> {
    const rules = await this.load();
    // Remove existing rule with the same name
    rules.credentials = rules.credentials.filter((r) => r.name !== name);
    rules.credentials.push({ name, hostPattern, header, value, rateLimit });
    await this.save(rules);
    return rules;
  }

  /**
   * Remove a credential rule by name.
   * Returns the updated rules. Throws if the name is not found.
   */
  async removeCredential(name: string): Promise<CredentialRules> {
    const rules = await this.load();
    const before = rules.credentials.length;
    rules.credentials = rules.credentials.filter((r) => r.name !== name);
    if (rules.credentials.length === before) {
      throw new Error(`Credential "${name}" not found`);
    }
    await this.save(rules);
    return rules;
  }

  /**
   * List credential names and host patterns (never exposes values).
   */
  async listCredentials(): Promise<Array<{ name: string; hostPattern: string; header: string }>> {
    const rules = await this.load();
    return rules.credentials.map((r) => ({
      name: r.name,
      hostPattern: r.hostPattern,
      header: r.header,
    }));
  }

  /**
   * Read the raw key bytes. Used by ProxyManager to pass to the container.
   */
  async readKey(): Promise<Buffer> {
    return readKeyFile(this.keyPath);
  }

  /**
   * Ensure a CA certificate exists for MITM TLS interception.
   * Generates a new CA if none exists. Called by ProxyManager.start().
   */
  async ensureCA(username: string): Promise<CACertificate> {
    return ensureCAImpl(this.secretsDir, username);
  }

  /**
   * Migrate plaintext auth token files into the encrypted credential store.
   *
   * Reads `oauth-token` and `api-key` files from the secrets directory and
   * stores them as CredentialRule entries in `credentials.enc`. Idempotent —
   * skips if a rule with the same name already exists.
   *
   * Called during orchestrator startup (src/index.ts).
   */
  async migrateAuthTokens(): Promise<void> {
    const migrations: Array<{
      file: string;
      name: string;
      hostPattern: string;
      header: string;
      valuePrefix?: string;
      credentialMethod?: 'oauth' | 'api_key';
    }> = [
      {
        file: 'oauth-token',
        name: 'anthropic-oauth',
        hostPattern: 'api.anthropic.com',
        header: 'Authorization',
        valuePrefix: 'Bearer ',
        credentialMethod: 'oauth',
      },
      {
        file: 'api-key',
        name: 'anthropic-api-key',
        hostPattern: 'api.anthropic.com',
        header: 'x-api-key',
        credentialMethod: 'api_key',
      },
    ];

    const rules = await this.load();
    let changed = false;

    for (const m of migrations) {
      // Skip if rule already exists
      if (rules.credentials.some((r) => r.name === m.name)) continue;

      // Try to read the plaintext file
      let value: string;
      try {
        value = (await readFile(join(this.secretsDir, m.file), 'utf-8')).trim();
        if (!value) continue;
      } catch {
        continue; // File doesn't exist
      }

      const headerValue = m.valuePrefix ? `${m.valuePrefix}${value}` : value;
      rules.credentials.push({
        name: m.name,
        hostPattern: m.hostPattern,
        header: m.header,
        value: headerValue,
        ...(m.credentialMethod ? { credentialMethod: m.credentialMethod } : {}),
      });
      changed = true;
      console.log(`[flowhelm] Migrated ${m.file} → credential rule "${m.name}"`);
    }

    if (changed) {
      await this.save(rules);
    }
  }

  // ── General-Purpose Secrets ─────────────────────────────────────────────

  /**
   * Get a secret by name from the encrypted secrets store.
   * Returns undefined if the secret doesn't exist.
   */
  async getSecret(name: string): Promise<string | undefined> {
    const rules = await this.load();
    return rules.secrets[name];
  }

  /**
   * Set a secret in the encrypted secrets store.
   * Overwrites any existing value for the same name.
   */
  async setSecret(name: string, value: string): Promise<void> {
    const rules = await this.load();
    rules.secrets[name] = value;
    await this.save(rules);
  }

  /**
   * Get the DB password from the encrypted secrets store.
   *
   * On first boot: generates a random 24-byte password, stores it in
   * secrets["db-password"], and returns it.
   * On subsequent boots: reads and returns the existing password.
   *
   * Also migrates plaintext db-password files from pre-Phase-11 installs.
   */
  async dbPassword(): Promise<string> {
    const rules = await this.load();

    // Already stored — return it
    if (rules.secrets['db-password']) {
      return rules.secrets['db-password'];
    }

    // Check for legacy plaintext file and migrate
    const legacyPath = join(this.secretsDir, 'db-password');
    let password: string | undefined;
    try {
      password = (await readFile(legacyPath, 'utf-8')).trim();
      if (password) {
        console.log('[flowhelm] Migrated db-password → encrypted secrets store');
      }
    } catch {
      // No legacy file — generate a new password
    }

    if (!password) {
      password = randomBytes(24).toString('base64url');
    }

    rules.secrets['db-password'] = password;
    await this.save(rules);
    return password;
  }

  /**
   * Ensure the secrets directory exists with restrictive permissions.
   */
  async ensureSecretsDir(): Promise<void> {
    await mkdir(this.secretsDir, { recursive: true });
    await chmod(this.secretsDir, 0o700);
  }
}
