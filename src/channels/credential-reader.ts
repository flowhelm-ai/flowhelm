/**
 * Credential reader for the channel container.
 *
 * Decrypts credentials.enc using the AES-256-GCM key passed via
 * CREDENTIAL_KEY env var. Reuses the same encryption format as
 * the proxy's credential-store.ts: [IV (16)] [authTag (16)] [ciphertext].
 *
 * The channel container is trusted infrastructure — it decrypts
 * credentials directly because protocols like IMAP XOAUTH2 need
 * raw tokens over TLS sockets (not HTTP headers).
 */

import { createDecipheriv } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ChannelCredentials {
  /** Telegram bot token. */
  telegramBotToken?: string;
  /** Gmail OAuth client ID. */
  gmailOauthClientId?: string;
  /** Gmail OAuth client secret. */
  gmailOauthClientSecret?: string;
  /** Gmail OAuth refresh token. */
  gmailOauthRefreshToken?: string;
  /** Gmail service account key JSON (for Pub/Sub). */
  gmailServiceAccountKey?: string;
  /** Gmail email address. */
  gmailEmailAddress?: string;
  /** Raw credential rules (full parsed structure). */
  raw: Record<string, unknown>;
}

// ─── Decryption ─────────────────────────────────────────────────────────────

/**
 * Decrypt AES-256-GCM ciphertext.
 * Input: [IV (16)] [authTag (16)] [ciphertext (...)]
 */
function decrypt(data: Buffer, key: Buffer): Buffer {
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

// ─── Reader ─────────────────────────────────────────────────────────────────

/**
 * Read and decrypt channel credentials from credentials.enc.
 *
 * Extracts channel-specific credentials from the credential rules
 * structure. The credential rules are shared with the proxy container
 * but channel adapters only need a subset.
 */
export async function readChannelCredentials(
  encPath: string,
  keyHex: string,
): Promise<ChannelCredentials> {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) {
    throw new Error(`Invalid credential key: expected 32 bytes, got ${String(key.length)}`);
  }

  const data = await readFile(encPath);
  const decrypted = decrypt(data, key);
  const parsed = JSON.parse(decrypted.toString('utf-8')) as Record<string, unknown>;

  return extractChannelCredentials(parsed);
}

/**
 * Extract channel-specific credentials from the full credential rules.
 *
 * The credential rules have a `credentials` array with per-service entries.
 * Channel adapters need specific fields extracted by name convention.
 */
function extractChannelCredentials(rules: Record<string, unknown>): ChannelCredentials {
  const credentials = (rules['credentials'] ?? []) as Array<Record<string, unknown>>;
  const result: ChannelCredentials = { raw: rules };

  for (const cred of credentials) {
    const name = cred['name'] as string | undefined;
    const value = cred['value'] as string | undefined;

    if (!name || !value) continue;

    switch (name) {
      case 'telegram-bot':
        result.telegramBotToken = value;
        break;
      case 'gmail-oauth-client-id':
        result.gmailOauthClientId = value;
        break;
      case 'gmail-oauth-client-secret':
        result.gmailOauthClientSecret = value;
        break;
      case 'gmail-oauth-refresh-token':
        result.gmailOauthRefreshToken = value;
        break;
      case 'gmail-service-account-key':
        result.gmailServiceAccountKey = value;
        break;
      case 'gmail-email-address':
        result.gmailEmailAddress = value;
        break;
    }
  }

  return result;
}
