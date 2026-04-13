import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encrypt,
  decrypt,
  generateKey,
  readKeyFile,
  writeKeyFile,
  saveCredentials,
  loadCredentials,
  CredentialStore,
} from '../src/proxy/credential-store.js';
import type { CredentialRules } from '../src/proxy/credential-schema.js';

describe('encrypt/decrypt', () => {
  const key = generateKey();

  it('round-trips plaintext through encrypt → decrypt', () => {
    const plaintext = Buffer.from('hello, credentials!');
    const encrypted = encrypt(plaintext, key);
    const decrypted = decrypt(encrypted, key);
    expect(decrypted.toString()).toBe('hello, credentials!');
  });

  it('produces different ciphertext each time (random IV)', () => {
    const plaintext = Buffer.from('same input');
    const a = encrypt(plaintext, key);
    const b = encrypt(plaintext, key);
    expect(a.equals(b)).toBe(false);
  });

  it('throws on tampered ciphertext (GCM authentication)', () => {
    const encrypted = encrypt(Buffer.from('secret'), key);
    // Flip a byte in the ciphertext (past IV + authTag)
    encrypted[32] = encrypted[32]! ^ 0xff;
    expect(() => decrypt(encrypted, key)).toThrow();
  });

  it('throws on wrong key', () => {
    const encrypted = encrypt(Buffer.from('secret'), key);
    const wrongKey = generateKey();
    expect(() => decrypt(encrypted, wrongKey)).toThrow();
  });

  it('throws on data too short', () => {
    expect(() => decrypt(Buffer.alloc(16), key)).toThrow('Encrypted data too short');
  });

  it('handles empty plaintext', () => {
    const encrypted = encrypt(Buffer.alloc(0), key);
    const decrypted = decrypt(encrypted, key);
    expect(decrypted.length).toBe(0);
  });

  it('handles large plaintext', () => {
    const large = Buffer.alloc(100_000, 'A');
    const encrypted = encrypt(large, key);
    const decrypted = decrypt(encrypted, key);
    expect(decrypted.equals(large)).toBe(true);
  });
});

describe('key management', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'flowhelm-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('generateKey returns 32 bytes', () => {
    const key = generateKey();
    expect(key.length).toBe(32);
  });

  it('writes and reads back a key file', async () => {
    const key = generateKey();
    const keyPath = join(tmpDir, 'test.key');
    await writeKeyFile(keyPath, key);

    const loaded = await readKeyFile(keyPath);
    expect(loaded.equals(key)).toBe(true);
  });

  it('writeKeyFile creates parent directories', async () => {
    const key = generateKey();
    const keyPath = join(tmpDir, 'nested', 'deep', 'test.key');
    await writeKeyFile(keyPath, key);

    const loaded = await readKeyFile(keyPath);
    expect(loaded.equals(key)).toBe(true);
  });

  it('readKeyFile rejects wrong-size key', async () => {
    const keyPath = join(tmpDir, 'bad.key');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(keyPath, Buffer.alloc(16));
    await expect(readKeyFile(keyPath)).rejects.toThrow('expected 32 bytes');
  });

  it('writeKeyFile sets restrictive permissions', async () => {
    const key = generateKey();
    const keyPath = join(tmpDir, 'test.key');
    await writeKeyFile(keyPath, key);

    const s = await stat(keyPath);
    // 0o400 = owner read-only
    expect(s.mode & 0o777).toBe(0o400);
  });
});

describe('saveCredentials/loadCredentials', () => {
  let tmpDir: string;
  const key = generateKey();

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'flowhelm-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const sampleRules: CredentialRules = {
    credentials: [
      {
        name: 'Anthropic',
        hostPattern: 'api.anthropic.com',
        header: 'x-api-key',
        value: 'sk-ant-test-key',
        rateLimit: { requests: 100, windowSeconds: 3600 },
      },
      {
        name: 'Google',
        hostPattern: '*.googleapis.com',
        header: 'Authorization',
        value: 'Bearer ya29.test-token',
      },
    ],
  };

  it('round-trips credential rules through save → load', async () => {
    const encPath = join(tmpDir, 'creds.enc');
    await saveCredentials(sampleRules, encPath, key);
    const loaded = await loadCredentials(encPath, key);

    expect(loaded.credentials).toHaveLength(2);
    expect(loaded.credentials[0]!.name).toBe('Anthropic');
    expect(loaded.credentials[0]!.value).toBe('sk-ant-test-key');
    expect(loaded.credentials[1]!.hostPattern).toBe('*.googleapis.com');
  });

  it('loadCredentials returns empty rules for missing file', async () => {
    const loaded = await loadCredentials(join(tmpDir, 'nonexistent.enc'), key);
    expect(loaded.credentials).toHaveLength(0);
  });

  it('loadCredentials throws on wrong key', async () => {
    const encPath = join(tmpDir, 'creds.enc');
    await saveCredentials(sampleRules, encPath, key);
    const wrongKey = generateKey();
    await expect(loadCredentials(encPath, wrongKey)).rejects.toThrow();
  });

  it('encrypted file is not readable as plaintext', async () => {
    const encPath = join(tmpDir, 'creds.enc');
    await saveCredentials(sampleRules, encPath, key);
    const raw = await readFile(encPath, 'utf-8');
    expect(raw).not.toContain('Anthropic');
    expect(raw).not.toContain('sk-ant-test-key');
  });
});

describe('CredentialStore', () => {
  let tmpDir: string;
  let store: CredentialStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'flowhelm-test-'));
    store = new CredentialStore({ secretsDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('addCredential creates encrypted file and retrieves it', async () => {
    await store.addCredential('Test', 'api.test.com', 'Authorization', 'Bearer xxx');
    const rules = await store.load();
    expect(rules.credentials).toHaveLength(1);
    expect(rules.credentials[0]!.name).toBe('Test');
  });

  it('addCredential replaces existing rule with same name', async () => {
    await store.addCredential('Test', 'api.test.com', 'Auth', 'old');
    await store.addCredential('Test', 'api.new.com', 'Auth', 'new');
    const rules = await store.load();
    expect(rules.credentials).toHaveLength(1);
    expect(rules.credentials[0]!.hostPattern).toBe('api.new.com');
    expect(rules.credentials[0]!.value).toBe('new');
  });

  it('removeCredential deletes a rule', async () => {
    await store.addCredential('A', 'a.com', 'x', 'v1');
    await store.addCredential('B', 'b.com', 'x', 'v2');
    await store.removeCredential('A');
    const rules = await store.load();
    expect(rules.credentials).toHaveLength(1);
    expect(rules.credentials[0]!.name).toBe('B');
  });

  it('removeCredential throws for unknown name', async () => {
    await expect(store.removeCredential('Ghost')).rejects.toThrow('not found');
  });

  it('listCredentials returns names and patterns without values', async () => {
    await store.addCredential('Anthropic', 'api.anthropic.com', 'x-api-key', 'sk-secret');
    const list = await store.listCredentials();
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe('Anthropic');
    expect(list[0]!.hostPattern).toBe('api.anthropic.com');
    expect(list[0]).not.toHaveProperty('value');
  });

  it('ensureKey generates key on first call and reuses on second', async () => {
    const key1 = await store.ensureKey();
    const key2 = await store.ensureKey();
    expect(key1.equals(key2)).toBe(true);
    expect(key1.length).toBe(32);
  });

  it('addCredential with rate limit', async () => {
    await store.addCredential('Test', 'api.test.com', 'Auth', 'token', {
      requests: 50,
      windowSeconds: 60,
    });
    const rules = await store.load();
    expect(rules.credentials[0]!.rateLimit).toEqual({ requests: 50, windowSeconds: 60 });
  });

  // ── Secrets ─────────────────────────────────────────────────────────────

  it('getSecret returns undefined for missing secret', async () => {
    const val = await store.getSecret('nonexistent');
    expect(val).toBeUndefined();
  });

  it('setSecret stores and getSecret retrieves', async () => {
    await store.setSecret('db-password', 'my-secret-pw');
    const val = await store.getSecret('db-password');
    expect(val).toBe('my-secret-pw');
  });

  it('setSecret overwrites existing value', async () => {
    await store.setSecret('token', 'old');
    await store.setSecret('token', 'new');
    expect(await store.getSecret('token')).toBe('new');
  });

  it('secrets coexist with credentials', async () => {
    await store.addCredential('API', 'api.test.com', 'Auth', 'bearer-xyz');
    await store.setSecret('db-password', 'pg-secret');

    const rules = await store.load();
    expect(rules.credentials).toHaveLength(1);
    expect(rules.credentials[0]!.value).toBe('bearer-xyz');
    expect(rules.secrets['db-password']).toBe('pg-secret');
  });

  // ── dbPassword ──────────────────────────────────────────────────

  it('dbPassword generates password on first boot', async () => {
    const pw = await store.dbPassword();
    expect(pw.length).toBeGreaterThan(10);

    // Second call returns the same password
    const pw2 = await store.dbPassword();
    expect(pw2).toBe(pw);
  });

  it('dbPassword migrates legacy plaintext file', async () => {
    // Write a legacy plaintext db-password file
    await writeFile(join(tmpDir, 'db-password'), 'legacy-password-123', { mode: 0o600 });

    const pw = await store.dbPassword();
    expect(pw).toBe('legacy-password-123');

    // Verify it's now in the encrypted store
    const fromStore = await store.getSecret('db-password');
    expect(fromStore).toBe('legacy-password-123');
  });

  it('dbPassword prefers encrypted store over legacy file', async () => {
    // Store a password in the encrypted vault first
    await store.setSecret('db-password', 'encrypted-password');
    // Write a different legacy file (should be ignored)
    await writeFile(join(tmpDir, 'db-password'), 'stale-legacy', { mode: 0o600 });

    const pw = await store.dbPassword();
    expect(pw).toBe('encrypted-password');
  });
});
