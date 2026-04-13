/**
 * Token Bridge client for headless VM authentication.
 *
 * Handles the VM side of the auth bridge flow:
 * 1. Generate X25519 keypair
 * 2. POST session to bridge server (send public key)
 * 3. Poll for encrypted credentials
 * 4. Decrypt with X25519 ECDH + AES-256-GCM
 */

import { webcrypto } from 'node:crypto';

const { subtle } = webcrypto;

type WebCryptoKey = webcrypto.CryptoKey;

export interface BridgeSession {
  token: string;
  expiresAt: number;
}

export interface EncryptedCredentials {
  encrypted: string;
  ephemeralPublicKey: string;
  nonce: string;
}

export interface BridgeKeyPair {
  publicKey: WebCryptoKey;
  privateKey: WebCryptoKey;
  publicKeyBase64: string;
}

/**
 * Generate an X25519 keypair for the auth bridge session.
 * The public key is sent to the bridge; the private key stays on the VM.
 */
export async function generateKeyPair(): Promise<BridgeKeyPair> {
  const keyPair = (await subtle.generateKey(
    { name: 'X25519' },
    true, // extractable for public key export
    ['deriveBits'],
  )) as webcrypto.CryptoKeyPair;

  const pubRaw = await subtle.exportKey('raw', keyPair.publicKey);
  const publicKeyBase64 = Buffer.from(pubRaw).toString('base64');

  return {
    publicKey: keyPair.publicKey,
    privateKey: keyPair.privateKey,
    publicKeyBase64,
  };
}

/**
 * Create a new auth session on the bridge server.
 */
export async function createSession(
  bridgeUrl: string,
  publicKeyBase64: string,
): Promise<BridgeSession> {
  const url = `${bridgeUrl}/api/session`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicKey: publicKeyBase64 }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Bridge session creation failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as BridgeSession;
  return data;
}

export type PollResult =
  | { status: 'pending' }
  | { status: 'ready'; encrypted: string; ephemeralPublicKey: string; nonce: string };

/**
 * Poll the bridge for encrypted credentials.
 * Returns the encrypted blob when available, or { status: 'pending' }.
 */
export async function pollSession(bridgeUrl: string, token: string): Promise<PollResult> {
  const url = `${bridgeUrl}/api/session/${token}/poll`;
  const response = await fetch(url);

  if (response.status === 404) {
    throw new Error('Session expired or not found');
  }

  if (!response.ok) {
    throw new Error(`Poll failed (${response.status})`);
  }

  return (await response.json()) as PollResult;
}

/**
 * Decrypt the credential blob using X25519 ECDH + AES-256-GCM.
 *
 * @param encrypted — base64-encoded AES-256-GCM ciphertext (includes 16-byte auth tag)
 * @param ephemeralPublicKeyB64 — base64-encoded browser's ephemeral X25519 public key
 * @param nonceB64 — base64-encoded 12-byte nonce
 * @param vmPrivateKey — the VM's X25519 private key
 * @returns The decrypted plaintext token string
 */
export async function decryptCredentials(
  encrypted: string,
  ephemeralPublicKeyB64: string,
  nonceB64: string,
  vmPrivateKey: WebCryptoKey,
): Promise<string> {
  // Import the browser's ephemeral public key
  const ephPubBytes = Buffer.from(ephemeralPublicKeyB64, 'base64');
  const ephPubKey = await subtle.importKey('raw', ephPubBytes, { name: 'X25519' }, false, []);

  // Derive shared secret via ECDH
  const sharedBits = await subtle.deriveBits(
    { name: 'X25519', public: ephPubKey },
    vmPrivateKey,
    256,
  );

  // Import shared secret as AES-256-GCM key
  const aesKey = await subtle.importKey('raw', sharedBits, { name: 'AES-GCM' }, false, ['decrypt']);

  // Decrypt
  const ciphertext = Buffer.from(encrypted, 'base64');
  const nonce = Buffer.from(nonceB64, 'base64');

  const plaintext = await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, aesKey, ciphertext);

  return new TextDecoder().decode(plaintext);
}

/**
 * Delete a session from the bridge after successful auth.
 */
export async function deleteSession(bridgeUrl: string, token: string): Promise<void> {
  await fetch(`${bridgeUrl}/api/session/${token}`, { method: 'DELETE' });
}

export interface PollOptions {
  /** Poll interval in ms. Default: 2000. */
  intervalMs?: number;
  /** Timeout in ms. Default: 600_000 (10 min). */
  timeoutMs?: number;
  /** Called on each poll attempt. */
  onPoll?: (attempt: number) => void;
  /** AbortSignal to cancel polling. */
  signal?: AbortSignal;
}

/**
 * Poll the bridge until credentials are available, then decrypt and return.
 * Uses exponential backoff on network errors.
 */
export async function pollAndDecrypt(
  bridgeUrl: string,
  token: string,
  vmPrivateKey: WebCryptoKey,
  options: PollOptions = {},
): Promise<string> {
  const intervalMs = options.intervalMs ?? 2000;
  const timeoutMs = options.timeoutMs ?? 600_000;
  const startTime = Date.now();
  let attempt = 0;
  let currentInterval = intervalMs;

  while (Date.now() - startTime < timeoutMs) {
    if (options.signal?.aborted) {
      throw new Error('Polling aborted');
    }

    attempt++;
    options.onPoll?.(attempt);

    try {
      const result = await pollSession(bridgeUrl, token);
      if (result.status === 'ready') {
        return decryptCredentials(
          result.encrypted,
          result.ephemeralPublicKey,
          result.nonce,
          vmPrivateKey,
        );
      }
      // Reset backoff on success
      currentInterval = intervalMs;
    } catch (err) {
      // Exponential backoff on errors (2s → 4s → 8s → 16s max)
      currentInterval = Math.min(currentInterval * 2, 16_000);
      if (err instanceof Error && err.message === 'Session expired or not found') {
        throw err;
      }
      // Network error — continue polling
    }

    await new Promise((resolve) => setTimeout(resolve, currentInterval));
  }

  throw new Error('Authentication timed out');
}
