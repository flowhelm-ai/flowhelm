import { describe, it, expect, beforeEach } from 'vitest';

// ─── Token Generator (Workers version) ─────────────────────────────────────

import {
  generateRawToken,
  generateUniqueToken,
  SAFE_ALPHABET,
  TOKEN_LENGTH,
} from '../services/auth-bridge-workers/src/token';

describe('Workers Token Generator', () => {
  it('generates tokens of correct length', () => {
    const token = generateRawToken();
    expect(token).toHaveLength(TOKEN_LENGTH);
  });

  it('uses only safe alphabet characters', () => {
    for (let i = 0; i < 50; i++) {
      const token = generateRawToken();
      for (const char of token) {
        expect(SAFE_ALPHABET).toContain(char);
      }
    }
  });

  it('generates unique tokens with collision check', () => {
    const existing = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const token = generateUniqueToken((t) => existing.has(t));
      expect(existing.has(token)).toBe(false);
      existing.add(token);
    }
  });
});

// ─── KV Session Store ───────────────────────────────────────────────────────

import { KVSessionStore } from '../services/auth-bridge-workers/src/store';

/** In-memory KV mock that behaves like Workers KV for testing. */
class MockKV {
  private data = new Map<string, { value: string; expiresAt: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.data.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.data.delete(key);
      return null;
    }
    return entry.value;
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    const ttl = opts?.expirationTtl ?? 3600;
    this.data.set(key, {
      value,
      expiresAt: Date.now() + ttl * 1000,
    });
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

describe('KV Session Store', () => {
  let mockKV: MockKV;
  let store: KVSessionStore;

  beforeEach(() => {
    mockKV = new MockKV();
    store = new KVSessionStore(mockKV as unknown as KVNamespace);
  });

  it('creates and retrieves a session', async () => {
    await store.create('abc', 'pubkey123');
    const session = await store.get('abc');
    expect(session).not.toBeNull();
    expect(session!.publicKey).toBe('pubkey123');
    expect(session!.encrypted).toBeUndefined();
  });

  it('returns null for non-existent token', async () => {
    const session = await store.get('nope');
    expect(session).toBeNull();
  });

  it('has() checks existence', async () => {
    expect(await store.has('x')).toBe(false);
    await store.create('x', 'pk');
    expect(await store.has('x')).toBe(true);
  });

  it('submits credentials', async () => {
    await store.create('sub', 'pk');
    const ok = await store.submitCredentials('sub', 'enc', 'eph', 'nonce');
    expect(ok).toBe(true);

    const session = await store.get('sub');
    expect(session!.encrypted).toBe('enc');
    expect(session!.ephemeralPublicKey).toBe('eph');
    expect(session!.nonce).toBe('nonce');
  });

  it('rejects double credential submission', async () => {
    await store.create('dbl', 'pk');
    expect(await store.submitCredentials('dbl', 'e1', 'p1', 'n1')).toBe(true);
    expect(await store.submitCredentials('dbl', 'e2', 'p2', 'n2')).toBe(false);
  });

  it('rejects submission to non-existent session', async () => {
    expect(await store.submitCredentials('nope', 'e', 'p', 'n')).toBe(false);
  });

  it('deletes sessions', async () => {
    await store.create('del', 'pk');
    await store.delete('del');
    expect(await store.get('del')).toBeNull();
  });
});

// ─── KV Rate Limiter ────────────────────────────────────────────────────────

import {
  KVRateLimiter,
  RATE_LIMITS,
  GLOBAL_SESSION_LIMIT,
  type RateLimitRule,
} from '../services/auth-bridge-workers/src/rate-limit';

describe('KV Rate Limiter', () => {
  let mockKV: MockKV;
  let limiter: KVRateLimiter;

  beforeEach(() => {
    mockKV = new MockKV();
    limiter = new KVRateLimiter(mockKV as unknown as KVNamespace);
  });

  it('allows requests under the limit', async () => {
    const rule: RateLimitRule = { maxRequests: 3, windowMs: 60_000 };
    expect(await limiter.check('ip1', rule)).toBe(true);
    expect(await limiter.check('ip1', rule)).toBe(true);
    expect(await limiter.check('ip1', rule)).toBe(true);
  });

  it('blocks requests over the limit', async () => {
    const rule: RateLimitRule = { maxRequests: 2, windowMs: 60_000 };
    expect(await limiter.check('ip2', rule)).toBe(true);
    expect(await limiter.check('ip2', rule)).toBe(true);
    expect(await limiter.check('ip2', rule)).toBe(false);
  });

  it('isolates rate limits per key', async () => {
    const rule: RateLimitRule = { maxRequests: 1, windowMs: 60_000 };
    expect(await limiter.check('ipA', rule)).toBe(true);
    expect(await limiter.check('ipB', rule)).toBe(true);
    expect(await limiter.check('ipA', rule)).toBe(false);
    expect(await limiter.check('ipB', rule)).toBe(false);
  });

  it('tracks global rate limit', async () => {
    const rule: RateLimitRule = { maxRequests: 2, windowMs: 60_000 };
    expect(await limiter.checkGlobal(rule)).toBe(true);
    expect(await limiter.checkGlobal(rule)).toBe(true);
    expect(await limiter.checkGlobal(rule)).toBe(false);
  });

  it('returns correct remaining count', async () => {
    const rule: RateLimitRule = { maxRequests: 3, windowMs: 60_000 };
    expect(await limiter.remaining('ip3', rule)).toBe(3);
    await limiter.check('ip3', rule);
    expect(await limiter.remaining('ip3', rule)).toBe(2);
  });

  it('defines expected rate limit rules', () => {
    expect(RATE_LIMITS.sessionCreate.maxRequests).toBe(5);
    expect(RATE_LIMITS.poll.maxRequests).toBe(30);
    expect(RATE_LIMITS.submit.maxRequests).toBe(3);
    expect(RATE_LIMITS.qr.maxRequests).toBe(30);
    expect(GLOBAL_SESSION_LIMIT.maxRequests).toBe(1000);
  });
});

// ─── QR Code (Workers version) ─────────────────────────────────────────────

import { generateQRMatrix, renderQRText, generateQR } from '../services/auth-bridge-workers/src/qr';

describe('Workers QR Code Generator', () => {
  it('generates a square matrix', () => {
    const matrix = generateQRMatrix('https://flowhelm.to/x3K9m');
    expect(matrix.length).toBeGreaterThanOrEqual(21);
    expect(matrix.length).toBe(matrix[0].length);
  });

  it('renders to UTF-8 block characters', () => {
    const text = generateQR('hello');
    expect(text).toContain('\u2588');
    expect(text.length).toBeGreaterThan(0);
  });

  it('all characters are valid QR display characters', () => {
    const text = generateQR('test');
    const validChars = new Set(['\u2588', '\u2580', '\u2584', ' ', '\n']);
    for (const char of text) {
      expect(validChars.has(char)).toBe(true);
    }
  });

  it('output matches Node.js version for same input', async () => {
    const { generateQR: nodeQR } = await import('../services/auth-bridge/qr.js');
    const workersOutput = generateQR('https://flowhelm.to/test');
    const nodeOutput = nodeQR('https://flowhelm.to/test');
    expect(workersOutput).toBe(nodeOutput);
  });
});

// ─── Inlined HTML ───────────────────────────────────────────────────────────

import { AUTH_PAGE_HTML } from '../services/auth-bridge-workers/src/page';

describe('Workers Auth Page HTML', () => {
  it('contains the placeholder tokens', () => {
    expect(AUTH_PAGE_HTML).toContain('{{TOKEN}}');
    expect(AUTH_PAGE_HTML).toContain('{{BASE_URL}}');
  });

  it('contains essential UI elements', () => {
    expect(AUTH_PAGE_HTML).toContain('Authenticate FlowHelm');
    expect(AUTH_PAGE_HTML).toContain('claude setup-token');
    expect(AUTH_PAGE_HTML).toContain('X25519');
    expect(AUTH_PAGE_HTML).toContain('AES-256-GCM');
  });

  it('contains the encryption script', () => {
    expect(AUTH_PAGE_HTML).toContain('crypto.subtle');
    expect(AUTH_PAGE_HTML).toContain('encryptAndSubmit');
  });
});
