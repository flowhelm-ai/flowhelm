import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─── Token Generator ────────────────────────────────────────────────────────

import {
  generateRawToken,
  generateUniqueToken,
  SAFE_ALPHABET,
  TOKEN_LENGTH,
  MAX_RETRIES,
} from '../services/auth-bridge/token.js';

describe('Token Generator', () => {
  it('generates tokens of correct length', () => {
    const token = generateRawToken();
    expect(token).toHaveLength(TOKEN_LENGTH);
  });

  it('uses only safe alphabet characters', () => {
    for (let i = 0; i < 100; i++) {
      const token = generateRawToken();
      for (const char of token) {
        expect(SAFE_ALPHABET).toContain(char);
      }
    }
  });

  it('excludes ambiguous characters (0, O, o, 1, l, I)', () => {
    const ambiguous = ['0', 'O', 'o', '1', 'l', 'I'];
    for (const char of ambiguous) {
      expect(SAFE_ALPHABET).not.toContain(char);
    }
  });

  it('safe alphabet has 56 characters', () => {
    expect(SAFE_ALPHABET).toHaveLength(56);
  });

  it('generates unique tokens with collision check', () => {
    const existing = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const token = generateUniqueToken((t) => existing.has(t));
      expect(existing.has(token)).toBe(false);
      existing.add(token);
    }
  });

  it('throws after MAX_RETRIES if all collide', () => {
    // Always returns true = always collides
    expect(() => generateUniqueToken(() => true)).toThrow(
      `Failed to generate unique token after ${MAX_RETRIES} attempts`,
    );
  });

  it('retries on collision and succeeds', () => {
    let attempts = 0;
    const token = generateUniqueToken(() => {
      attempts++;
      return attempts < 3; // Collide twice, then succeed
    });
    expect(token).toHaveLength(TOKEN_LENGTH);
    expect(attempts).toBeGreaterThanOrEqual(3);
  });
});

// ─── Session Store ──────────────────────────────────────────────────────────

import { SessionStore } from '../services/auth-bridge/store.js';

describe('Session Store', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore({
      ttlMs: 1000, // 1s for testing
      maxSessions: 5,
      cleanupIntervalMs: 60_000, // won't fire during tests
    });
  });

  afterEach(() => {
    store.destroy();
  });

  it('creates and retrieves sessions', () => {
    expect(store.create('abc', 'pubkey123')).toBe(true);
    const session = store.get('abc');
    expect(session).toBeDefined();
    expect(session!.publicKey).toBe('pubkey123');
    expect(session!.encrypted).toBeUndefined();
  });

  it('returns undefined for non-existent token', () => {
    expect(store.get('nonexistent')).toBeUndefined();
  });

  it('enforces max sessions limit', () => {
    for (let i = 0; i < 5; i++) {
      expect(store.create(`t${i}`, `pk${i}`)).toBe(true);
    }
    expect(store.create('overflow', 'pk')).toBe(false);
    expect(store.size).toBe(5);
  });

  it('expires sessions after TTL', async () => {
    store.create('expire-me', 'pk');
    expect(store.get('expire-me')).toBeDefined();

    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 1100));

    expect(store.get('expire-me')).toBeUndefined();
  });

  it('submits credentials to a session', () => {
    store.create('submit-test', 'pk');

    const ok = store.submitCredentials('submit-test', 'enc', 'ephPk', 'nonce');
    expect(ok).toBe(true);

    const session = store.get('submit-test');
    expect(session!.encrypted).toBe('enc');
    expect(session!.ephemeralPublicKey).toBe('ephPk');
    expect(session!.nonce).toBe('nonce');
  });

  it('rejects double credential submission', () => {
    store.create('double', 'pk');
    expect(store.submitCredentials('double', 'enc1', 'eph1', 'n1')).toBe(true);
    expect(store.submitCredentials('double', 'enc2', 'eph2', 'n2')).toBe(false);
  });

  it('rejects submission to non-existent session', () => {
    expect(store.submitCredentials('nope', 'enc', 'eph', 'n')).toBe(false);
  });

  it('deletes sessions', () => {
    store.create('del', 'pk');
    expect(store.delete('del')).toBe(true);
    expect(store.get('del')).toBeUndefined();
    expect(store.delete('del')).toBe(false);
  });

  it('cleanup removes expired sessions', async () => {
    store.create('a', 'pk1');
    store.create('b', 'pk2');

    await new Promise((r) => setTimeout(r, 1100));

    const removed = store.cleanup();
    expect(removed).toBe(2);
    expect(store.size).toBe(0);
  });

  it('has() checks existence without expired sessions', async () => {
    store.create('check', 'pk');
    expect(store.has('check')).toBe(true);

    await new Promise((r) => setTimeout(r, 1100));
    expect(store.has('check')).toBe(false);
  });
});

// ─── Rate Limiter ───────────────────────────────────────────────────────────

import {
  RateLimiter,
  RATE_LIMITS,
  GLOBAL_SESSION_LIMIT,
  type RateLimitRule,
} from '../services/auth-bridge/rate-limit.js';

describe('Rate Limiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter(600_000); // long cleanup interval
  });

  afterEach(() => {
    limiter.destroy();
  });

  it('allows requests under the limit', () => {
    const rule: RateLimitRule = { maxRequests: 3, windowMs: 1000 };
    expect(limiter.check('ip1', rule)).toBe(true);
    expect(limiter.check('ip1', rule)).toBe(true);
    expect(limiter.check('ip1', rule)).toBe(true);
  });

  it('blocks requests over the limit', () => {
    const rule: RateLimitRule = { maxRequests: 2, windowMs: 1000 };
    expect(limiter.check('ip2', rule)).toBe(true);
    expect(limiter.check('ip2', rule)).toBe(true);
    expect(limiter.check('ip2', rule)).toBe(false);
  });

  it('isolates rate limits per IP', () => {
    const rule: RateLimitRule = { maxRequests: 1, windowMs: 1000 };
    expect(limiter.check('ipA', rule)).toBe(true);
    expect(limiter.check('ipB', rule)).toBe(true);
    expect(limiter.check('ipA', rule)).toBe(false);
    expect(limiter.check('ipB', rule)).toBe(false);
  });

  it('allows requests after window expires', async () => {
    const rule: RateLimitRule = { maxRequests: 1, windowMs: 500 };
    expect(limiter.check('ip3', rule)).toBe(true);
    expect(limiter.check('ip3', rule)).toBe(false);

    await new Promise((r) => setTimeout(r, 600));
    expect(limiter.check('ip3', rule)).toBe(true);
  });

  it('tracks global rate limit separately', () => {
    const rule: RateLimitRule = { maxRequests: 2, windowMs: 1000 };
    expect(limiter.checkGlobal(rule)).toBe(true);
    expect(limiter.checkGlobal(rule)).toBe(true);
    expect(limiter.checkGlobal(rule)).toBe(false);
  });

  it('returns correct remaining count', () => {
    const rule: RateLimitRule = { maxRequests: 3, windowMs: 1000 };
    expect(limiter.remaining('ip4', rule)).toBe(3);
    limiter.check('ip4', rule);
    expect(limiter.remaining('ip4', rule)).toBe(2);
    limiter.check('ip4', rule);
    expect(limiter.remaining('ip4', rule)).toBe(1);
    limiter.check('ip4', rule);
    expect(limiter.remaining('ip4', rule)).toBe(0);
  });

  it('returns retryAfterMs when rate limited', () => {
    const rule: RateLimitRule = { maxRequests: 1, windowMs: 5000 };
    limiter.check('ip5', rule);
    const retry = limiter.retryAfterMs('ip5', rule);
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(5000);
  });

  it('returns 0 retryAfterMs when not limited', () => {
    const rule: RateLimitRule = { maxRequests: 5, windowMs: 1000 };
    expect(limiter.retryAfterMs('ip6', rule)).toBe(0);
  });

  it('defines expected rate limit rules', () => {
    expect(RATE_LIMITS.sessionCreate.maxRequests).toBe(5);
    expect(RATE_LIMITS.poll.maxRequests).toBe(30);
    expect(RATE_LIMITS.submit.maxRequests).toBe(3);
    expect(RATE_LIMITS.qr.maxRequests).toBe(30);
    expect(GLOBAL_SESSION_LIMIT.maxRequests).toBe(1000);
  });
});

// ─── QR Code Generator ─────────────────────────────────────────────────────

import {
  generateQRMatrix,
  renderQRText,
  generateQR,
  selectVersion,
  rsEncode,
  GF_EXP,
  GF_LOG,
} from '../services/auth-bridge/qr.js';

describe('QR Code Generator', () => {
  describe('GF(2^8) arithmetic', () => {
    it('exp and log tables are consistent', () => {
      // α^0 = 1
      expect(GF_EXP[0]).toBe(1);
      // log(1) = 0
      expect(GF_LOG[1]).toBe(0);
      // α^(log(x)) = x for x = 1..255
      for (let x = 1; x < 256; x++) {
        expect(GF_EXP[GF_LOG[x]]).toBe(x);
      }
    });
  });

  describe('Reed-Solomon encoding', () => {
    it('produces correct number of EC codewords', () => {
      const data = [32, 91, 11, 120, 209, 114, 220, 77]; // arbitrary
      const ec = rsEncode(data, 10);
      expect(ec).toHaveLength(10);
    });

    it('EC codewords are deterministic', () => {
      const data = [1, 2, 3, 4, 5];
      const ec1 = rsEncode(data, 7);
      const ec2 = rsEncode(data, 7);
      expect(ec1).toEqual(ec2);
    });
  });

  describe('Version selection', () => {
    it('selects Version 1 for short data', () => {
      expect(selectVersion(10)).toBe(1);
    });

    it('selects Version 2 for medium data', () => {
      expect(selectVersion(20)).toBe(2);
    });

    it('selects Version 3 for longer data', () => {
      expect(selectVersion(40)).toBe(3);
    });

    it('selects Version 4 for max supported data', () => {
      expect(selectVersion(60)).toBe(4);
    });

    it('throws for data exceeding Version 4 capacity', () => {
      expect(() => selectVersion(100)).toThrow('Data too long');
    });
  });

  describe('QR matrix generation', () => {
    it('generates a square matrix for a short URL', () => {
      const matrix = generateQRMatrix('https://flowhelm.to/x3K9m');
      expect(matrix.length).toBeGreaterThanOrEqual(21); // min Version 1
      expect(matrix.length).toBe(matrix[0].length); // square
    });

    it('matrix contains only booleans', () => {
      const matrix = generateQRMatrix('https://flowhelm.to/abc');
      for (const row of matrix) {
        for (const cell of row) {
          expect(typeof cell).toBe('boolean');
        }
      }
    });

    it('finder patterns are present at three corners', () => {
      const matrix = generateQRMatrix('test');
      const size = matrix.length;

      // Top-left: 7x7 with known pattern
      expect(matrix[0][0]).toBe(true); // top-left corner of finder
      expect(matrix[0][6]).toBe(true);
      expect(matrix[6][0]).toBe(true);
      expect(matrix[3][3]).toBe(true); // center of finder

      // Top-right
      expect(matrix[0][size - 1]).toBe(true);
      expect(matrix[0][size - 7]).toBe(true);

      // Bottom-left
      expect(matrix[size - 1][0]).toBe(true);
      expect(matrix[size - 7][0]).toBe(true);
    });
  });

  describe('QR text rendering', () => {
    it('renders to UTF-8 block characters', () => {
      const text = generateQR('hello');
      expect(text).toContain('\u2588'); // Full block
      expect(text.length).toBeGreaterThan(0);
    });

    it('output has multiple lines', () => {
      const text = generateQR('https://flowhelm.to/x3K9m');
      const lines = text.split('\n');
      expect(lines.length).toBeGreaterThan(5);
    });

    it('all characters are valid QR display characters', () => {
      const text = generateQR('test');
      const validChars = new Set([
        '\u2588', // █ Full Block
        '\u2580', // ▀ Upper Half Block
        '\u2584', // ▄ Lower Half Block
        ' ', // Space
        '\n', // Newline
      ]);
      for (const char of text) {
        expect(validChars.has(char)).toBe(true);
      }
    });

    it('renders a compact representation (2 modules per row)', () => {
      const matrix = generateQRMatrix('test');
      const rendered = renderQRText(matrix);
      const lines = rendered.split('\n');
      // With quiet zone: ceil((size + 2) / 2) lines
      const expectedLines = Math.ceil((matrix.length + 2) / 2);
      expect(lines.length).toBe(expectedLines);
    });
  });
});

// ─── Bridge Server (HTTP) ───────────────────────────────────────────────────

import { createBridgeServer } from '../services/auth-bridge/server.js';
import http from 'node:http';

describe('Bridge Server', () => {
  let bridge: ReturnType<typeof createBridgeServer>;
  let baseUrl: string;

  beforeEach(async () => {
    bridge = createBridgeServer({
      port: 0, // random port
      host: '127.0.0.1',
      baseUrl: 'https://flowhelm.to',
      store: { ttlMs: 5000, maxSessions: 100, cleanupIntervalMs: 60_000 },
    });

    await new Promise<void>((resolve) => {
      bridge.server.listen(0, '127.0.0.1', () => resolve());
    });

    const addr = bridge.server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await bridge.stop();
  });

  async function request(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<{ status: number; data: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const url = new URL(path, baseUrl);
      const options = {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: body ? { 'Content-Type': 'application/json' } : {},
      };

      const req = http.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          try {
            resolve({ status: res.statusCode!, data: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode!, data: { raw } });
          }
        });
      });

      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  it('health endpoint returns ok', async () => {
    const { status, data } = await request('GET', '/health');
    expect(status).toBe(200);
    expect(data.status).toBe('ok');
    expect(data.sessions).toBe(0);
  });

  it('creates a session and returns token', async () => {
    const { status, data } = await request('POST', '/api/session', {
      publicKey: 'dGVzdHB1YmxpY2tleQ==',
    });
    expect(status).toBe(201);
    expect(data.token).toBeDefined();
    expect(typeof data.token).toBe('string');
    expect((data.token as string).length).toBe(5);
    expect(data.expiresAt).toBeDefined();
  });

  it('rejects session creation without publicKey', async () => {
    const { status } = await request('POST', '/api/session', {});
    expect(status).toBe(400);
  });

  it('full session lifecycle: create → submit → poll → delete', async () => {
    // Create
    const { data: createData } = await request('POST', '/api/session', {
      publicKey: 'cHVia2V5',
    });
    const token = createData.token as string;

    // Poll — should be pending
    const { data: pendingData } = await request('GET', `/api/session/${token}/poll`);
    expect(pendingData.status).toBe('pending');

    // Submit credentials
    const { status: submitStatus } = await request('POST', `/api/session/${token}`, {
      encrypted: 'ZW5jcnlwdGVk',
      ephemeralPublicKey: 'ZXBoZW1lcmFs',
      nonce: 'bm9uY2U=',
    });
    expect(submitStatus).toBe(200);

    // Poll — should be ready
    const { data: readyData } = await request('GET', `/api/session/${token}/poll`);
    expect(readyData.status).toBe('ready');
    expect(readyData.encrypted).toBe('ZW5jcnlwdGVk');
    expect(readyData.ephemeralPublicKey).toBe('ZXBoZW1lcmFs');
    expect(readyData.nonce).toBe('bm9uY2U=');

    // Delete
    const { status: delStatus, data: delData } = await request('DELETE', `/api/session/${token}`);
    expect(delStatus).toBe(200);
    expect(delData.status).toBe('deleted');

    // Poll after delete — should be 404
    const { status: goneStatus } = await request('GET', `/api/session/${token}/poll`);
    expect(goneStatus).toBe(404);
  });

  it('rejects double credential submission', async () => {
    const { data: createData } = await request('POST', '/api/session', {
      publicKey: 'cGs=',
    });
    const token = createData.token as string;

    await request('POST', `/api/session/${token}`, {
      encrypted: 'ZQ==',
      ephemeralPublicKey: 'ZQ==',
      nonce: 'bg==',
    });

    const { status } = await request('POST', `/api/session/${token}`, {
      encrypted: 'Zg==',
      ephemeralPublicKey: 'Zg==',
      nonce: 'cA==',
    });
    expect(status).toBe(404);
  });

  it('returns 404 for expired/missing sessions on poll', async () => {
    const { status } = await request('GET', '/api/session/XXXXX/poll');
    expect(status).toBe(404);
  });

  it('returns 404 for unknown paths', async () => {
    const { status } = await request('GET', '/unknown/path');
    expect(status).toBe(404);
  });

  it('redirects short URL to auth page with public key in hash', async () => {
    const { data: createData } = await request('POST', '/api/session', {
      publicKey: 'dGVzdA==',
    });
    const token = createData.token as string;

    // Manual redirect test (http.request doesn't follow redirects)
    const { status, data } = await new Promise<{
      status: number;
      data: { location?: string };
    }>((resolve, reject) => {
      const url = new URL(`/${token}`, baseUrl);
      http
        .get(url, (res) => {
          resolve({
            status: res.statusCode!,
            data: { location: res.headers.location },
          });
          res.resume();
        })
        .on('error', reject);
    });

    expect(status).toBe(302);
    expect(data.location).toContain(`/a/${token}`);
    expect(data.location).toContain('#pk=');
  });

  it('serves QR code as text/plain', async () => {
    const { data: createData } = await request('POST', '/api/session', {
      publicKey: 'dGVzdA==',
    });
    const token = createData.token as string;

    const result = await new Promise<{ status: number; contentType: string; body: string }>(
      (resolve, reject) => {
        const url = new URL(`/qr/${token}`, baseUrl);
        http
          .get(url, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
              resolve({
                status: res.statusCode!,
                contentType: res.headers['content-type'] ?? '',
                body: Buffer.concat(chunks).toString('utf-8'),
              });
            });
          })
          .on('error', reject);
      },
    );

    expect(result.status).toBe(200);
    expect(result.contentType).toContain('text/plain');
    expect(result.body).toContain('\u2588'); // QR block characters
  });
});
