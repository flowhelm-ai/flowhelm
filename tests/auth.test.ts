import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { webcrypto } from 'node:crypto';

const { subtle } = webcrypto;

// ─── API Key Validation ─────────────────────────────────────────────────────

import { validateApiKey, writeApiKey, readApiKey, deleteApiKey } from '../src/auth/api-key.js';

describe('API Key', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'fh-auth-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  describe('validateApiKey', () => {
    it('accepts valid api03 key format', () => {
      expect(
        validateApiKey('sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHIJKLMNOP'),
      ).toBe(true);
    });

    it('accepts legacy key format', () => {
      expect(validateApiKey('sk-ant-abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGH')).toBe(true);
    });

    it('rejects empty string', () => {
      expect(validateApiKey('')).toBe(false);
    });

    it('rejects keys without sk-ant prefix', () => {
      expect(validateApiKey('not-a-key-12345678901234567890123456789012')).toBe(false);
    });

    it('rejects OpenAI keys', () => {
      expect(validateApiKey('sk-proj-12345678901234567890123456789012345678901234')).toBe(false);
    });

    it('trims whitespace', () => {
      expect(
        validateApiKey('  sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHIJKLMNOP  '),
      ).toBe(true);
    });
  });

  describe('writeApiKey / readApiKey', () => {
    it('writes and reads back an API key', async () => {
      const keyPath = join(tempDir, 'secrets', 'api-key');
      const key = 'sk-ant-api03-testkey1234567890abcdefghijklmnopqrstuvwxyz';

      await writeApiKey(key, keyPath);
      const stored = await readApiKey(keyPath);
      expect(stored).toBe(key);
    });

    it('creates parent directories', async () => {
      const keyPath = join(tempDir, 'deep', 'nested', 'api-key');
      const key = 'sk-ant-api03-testkey1234567890abcdefghijklmnopqrstuvwxyz';
      await writeApiKey(key, keyPath);

      const content = await readFile(keyPath, 'utf-8');
      expect(content.trim()).toBe(key);
    });

    it('throws for invalid key format', async () => {
      const keyPath = join(tempDir, 'api-key');
      await expect(writeApiKey('invalid-key', keyPath)).rejects.toThrow('Invalid API key format');
    });

    it('returns null for non-existent file', async () => {
      const result = await readApiKey(join(tempDir, 'nope'));
      expect(result).toBeNull();
    });
  });

  describe('deleteApiKey', () => {
    it('deletes an existing key', async () => {
      const keyPath = join(tempDir, 'secrets', 'api-key');
      const key = 'sk-ant-api03-testkey1234567890abcdefghijklmnopqrstuvwxyz';
      await writeApiKey(key, keyPath);
      await deleteApiKey(keyPath);
      const result = await readApiKey(keyPath);
      expect(result).toBeNull();
    });

    it('no-ops for non-existent key', async () => {
      await expect(deleteApiKey(join(tempDir, 'nope'))).resolves.not.toThrow();
    });
  });
});

// ─── Credential Store ───────────────────────────────────────────────────────

import {
  readCredentials,
  writeCredentials,
  buildCredentials,
  validateCredentials,
  storeAccessToken,
  type CredentialFile,
} from '../src/auth/credential-store.js';

describe('Credential Store', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'fh-creds-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  describe('buildCredentials', () => {
    it('wraps an access token in the expected format', () => {
      const creds = buildCredentials('sk-ant-oat01-test');
      expect(creds.claudeAiOauth.accessToken).toBe('sk-ant-oat01-test');
      expect(creds.claudeAiOauth.scopes).toContain('user:inference');
      expect(creds.claudeAiOauth.expiresAt).toBeDefined();
    });

    it('accepts optional subscription type', () => {
      const creds = buildCredentials('token', { subscriptionType: 'max' });
      expect(creds.claudeAiOauth.subscriptionType).toBe('max');
    });

    it('defaults subscription type to pro', () => {
      const creds = buildCredentials('token');
      expect(creds.claudeAiOauth.subscriptionType).toBe('pro');
    });
  });

  describe('validateCredentials', () => {
    it('accepts valid credentials', () => {
      const creds = buildCredentials('some-token');
      expect(validateCredentials(creds)).toBe(true);
    });

    it('rejects empty access token', () => {
      const creds: CredentialFile = {
        claudeAiOauth: { accessToken: '' },
      };
      expect(validateCredentials(creds)).toBe(false);
    });
  });

  describe('writeCredentials / readCredentials', () => {
    it('round-trips credentials through the filesystem', async () => {
      const credPath = join(tempDir, '.claude', '.credentials.json');
      const creds = buildCredentials('sk-ant-oat01-roundtrip', {
        subscriptionType: 'max',
        rateLimitTier: 'max',
      });

      await writeCredentials(creds, credPath);
      const loaded = await readCredentials(credPath);

      expect(loaded).not.toBeNull();
      expect(loaded!.claudeAiOauth.accessToken).toBe('sk-ant-oat01-roundtrip');
      expect(loaded!.claudeAiOauth.subscriptionType).toBe('max');
    });

    it('returns null for non-existent file', async () => {
      const result = await readCredentials(join(tempDir, 'nope.json'));
      expect(result).toBeNull();
    });

    it('returns null for malformed JSON', async () => {
      const credPath = join(tempDir, 'bad.json');
      const { writeFile: wf } = await import('node:fs/promises');
      await wf(credPath, 'not json');
      const result = await readCredentials(credPath);
      expect(result).toBeNull();
    });

    it('returns null for missing claudeAiOauth key', async () => {
      const credPath = join(tempDir, 'no-oauth.json');
      const { writeFile: wf } = await import('node:fs/promises');
      await wf(credPath, JSON.stringify({ foo: 'bar' }));
      const result = await readCredentials(credPath);
      expect(result).toBeNull();
    });
  });

  describe('storeAccessToken', () => {
    it('stores and reads back a token', async () => {
      const credPath = join(tempDir, '.claude', '.credentials.json');
      const creds = await storeAccessToken('my-token', { path: credPath });
      expect(creds.claudeAiOauth.accessToken).toBe('my-token');

      const loaded = await readCredentials(credPath);
      expect(loaded!.claudeAiOauth.accessToken).toBe('my-token');
    });
  });
});

// ─── X25519 Encryption Round-Trip ───────────────────────────────────────────

import { generateKeyPair, decryptCredentials } from '../src/auth/bridge-client.js';

describe('E2E Encryption (X25519 + AES-256-GCM)', () => {
  it('encrypts and decrypts a token successfully', async () => {
    // Simulate the full flow: VM generates keypair, browser encrypts, VM decrypts

    // 1. VM side: generate keypair
    const vmKeyPair = await generateKeyPair();
    expect(vmKeyPair.publicKeyBase64).toBeDefined();
    expect(vmKeyPair.publicKeyBase64.length).toBeGreaterThan(0);

    // 2. Browser side: generate ephemeral keypair, derive shared secret, encrypt
    const vmPubBytes = Buffer.from(vmKeyPair.publicKeyBase64, 'base64');
    const vmPubKey = await subtle.importKey('raw', vmPubBytes, { name: 'X25519' }, false, []);

    const ephKeyPair = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);

    const sharedBits = await subtle.deriveBits(
      { name: 'X25519', public: vmPubKey },
      ephKeyPair.privateKey,
      256,
    );

    const aesKey = await subtle.importKey('raw', sharedBits, { name: 'AES-GCM' }, false, [
      'encrypt',
    ]);

    const plaintext = 'sk-ant-oat01-my-secret-token-for-testing';
    const nonce = webcrypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);

    const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, encoded);

    const ephPubRaw = await subtle.exportKey('raw', ephKeyPair.publicKey);

    // Base64 encode for transport
    const encryptedB64 = Buffer.from(ciphertext).toString('base64');
    const ephPubB64 = Buffer.from(ephPubRaw).toString('base64');
    const nonceB64 = Buffer.from(nonce).toString('base64');

    // 3. VM side: decrypt
    const decrypted = await decryptCredentials(
      encryptedB64,
      ephPubB64,
      nonceB64,
      vmKeyPair.privateKey,
    );

    expect(decrypted).toBe(plaintext);
  });

  it('fails to decrypt with wrong private key', async () => {
    const vmKeyPair = await generateKeyPair();
    const wrongKeyPair = await generateKeyPair();

    // Encrypt with vmKeyPair's public key
    const vmPubBytes = Buffer.from(vmKeyPair.publicKeyBase64, 'base64');
    const vmPubKey = await subtle.importKey('raw', vmPubBytes, { name: 'X25519' }, false, []);

    const ephKeyPair = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);

    const sharedBits = await subtle.deriveBits(
      { name: 'X25519', public: vmPubKey },
      ephKeyPair.privateKey,
      256,
    );

    const aesKey = await subtle.importKey('raw', sharedBits, { name: 'AES-GCM' }, false, [
      'encrypt',
    ]);

    const nonce = webcrypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await subtle.encrypt(
      { name: 'AES-GCM', iv: nonce },
      aesKey,
      new TextEncoder().encode('secret'),
    );

    const ephPubRaw = await subtle.exportKey('raw', ephKeyPair.publicKey);

    // Try to decrypt with WRONG private key
    await expect(
      decryptCredentials(
        Buffer.from(ciphertext).toString('base64'),
        Buffer.from(ephPubRaw).toString('base64'),
        Buffer.from(nonce).toString('base64'),
        wrongKeyPair.privateKey, // wrong key!
      ),
    ).rejects.toThrow();
  });

  it('generates distinct public keys each time', async () => {
    const kp1 = await generateKeyPair();
    const kp2 = await generateKeyPair();
    expect(kp1.publicKeyBase64).not.toBe(kp2.publicKeyBase64);
  });

  it('public key is 32 bytes (X25519)', async () => {
    const kp = await generateKeyPair();
    const pubBytes = Buffer.from(kp.publicKeyBase64, 'base64');
    expect(pubBytes.length).toBe(32);
  });
});

// ─── Config Schema Auth Section ─────────────────────────────────────────────

import { flowhelmConfigSchema } from '../src/config/schema.js';

describe('Config Schema — Auth Section', () => {
  it('defaults auth method to api_key', () => {
    const config = flowhelmConfigSchema.parse({ username: 'testuser' });
    expect(config.auth.method).toBe('api_key');
  });

  it('defaults bridge URL to flowhelm.to', () => {
    const config = flowhelmConfigSchema.parse({ username: 'testuser' });
    expect(config.auth.bridgeUrl).toBe('https://flowhelm.to');
  });

  it('accepts subscription_bridge method', () => {
    const config = flowhelmConfigSchema.parse({
      username: 'testuser',
      auth: { method: 'subscription_bridge' },
    });
    expect(config.auth.method).toBe('subscription_bridge');
  });

  it('accepts subscription_tunnel method', () => {
    const config = flowhelmConfigSchema.parse({
      username: 'testuser',
      auth: { method: 'subscription_tunnel' },
    });
    expect(config.auth.method).toBe('subscription_tunnel');
  });

  it('accepts custom bridge URL', () => {
    const config = flowhelmConfigSchema.parse({
      username: 'testuser',
      auth: { bridgeUrl: 'https://custom.example.com' },
    });
    expect(config.auth.bridgeUrl).toBe('https://custom.example.com');
  });

  it('rejects invalid auth method', () => {
    expect(() =>
      flowhelmConfigSchema.parse({
        username: 'testuser',
        auth: { method: 'invalid' },
      }),
    ).toThrow();
  });

  it('accepts optional API key', () => {
    const config = flowhelmConfigSchema.parse({
      username: 'testuser',
      auth: { apiKey: 'sk-ant-api03-test' },
    });
    expect(config.auth.apiKey).toBe('sk-ant-api03-test');
  });

  it('apiKey is optional', () => {
    const config = flowhelmConfigSchema.parse({ username: 'testuser' });
    expect(config.auth.apiKey).toBeUndefined();
  });
});
