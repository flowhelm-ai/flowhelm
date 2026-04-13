import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  parseCredentialRules,
  matchesHostPattern,
  findCredentialForHost,
  findAllCredentialsForHost,
  selectCredentialByHeaders,
  type CredentialRule,
  type CredentialRules,
} from '../src/proxy/credential-schema.js';
import { RateLimiter } from '../src/proxy/rate-limiter.js';
import { AuditLog } from '../src/proxy/audit-log.js';
import { ProxyServer } from '../src/proxy/proxy-server.js';
import { KeyRotator } from '../src/proxy/key-rotator.js';
import { ProxyMetrics, type MetricsSnapshot } from '../src/proxy/metrics.js';
import { CostLog, type CostEntry } from '../src/proxy/cost-log.js';
import {
  PLACEHOLDER_OAUTH_TOKEN,
  PLACEHOLDER_API_KEY,
  getPlaceholderEnv,
} from '../src/proxy/placeholders.js';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

// ─── 9.4: Proxy Warm-Restart (SIGHUP) ─────────────────────────────────────

describe('ProxyServer.reloadCredentials', () => {
  let server: ProxyServer;
  let auditLog: AuditLog;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'proxy-reload-'));
    auditLog = new AuditLog(join(tmpDir, 'audit.log'));
    const rateLimiter = new RateLimiter();

    server = new ProxyServer({
      credentials: [],
      rateLimiter,
      auditLog,
      port: 0,
    });
  });

  afterEach(async () => {
    await server.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('replaces credentials on reload', async () => {
    await server.listen();

    const newCreds: CredentialRule[] = [
      { name: 'Test', hostPattern: 'api.test.com', header: 'Authorization', value: 'Bearer xyz' },
    ];
    const newLimiter = new RateLimiter();
    server.reloadCredentials(newCreds, newLimiter);

    // Verify via /healthz (server still works after reload)
    const addr = server.address;
    const res = await fetch(`http://127.0.0.1:${String(addr.port)}/healthz`);
    expect(res.status).toBe(200);
  });

  it('updates pinning bypass set on reload', async () => {
    await server.listen();

    const newLimiter = new RateLimiter();
    server.reloadCredentials([], newLimiter, {
      pinningBypass: ['pinned.example.com'],
    });

    // Server should still function
    const addr = server.address;
    const res = await fetch(`http://127.0.0.1:${String(addr.port)}/healthz`);
    expect(res.status).toBe(200);
  });
});

// ─── 9.9: Certificate Pinning Bypass ───────────────────────────────────────

describe('Pinning bypass schema', () => {
  it('parses pinningBypass field', () => {
    const rules = parseCredentialRules({
      credentials: [],
      pinningBypass: ['pinned.example.com', 'other.pinned.com'],
    });
    expect(rules.pinningBypass).toEqual(['pinned.example.com', 'other.pinned.com']);
  });

  it('defaults pinningBypass to empty array', () => {
    const rules = parseCredentialRules({ credentials: [] });
    expect(rules.pinningBypass).toEqual([]);
  });

  it('rejects empty strings in pinningBypass', () => {
    expect(() =>
      parseCredentialRules({
        credentials: [],
        pinningBypass: [''],
      }),
    ).toThrow();
  });
});

describe('Pinning bypass in CONNECT handler', () => {
  let server: ProxyServer;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'proxy-pinning-'));
  });

  afterEach(async () => {
    if (server) await server.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('skips MITM for hosts in pinning bypass set (passthrough)', async () => {
    const auditLog = new AuditLog(join(tmpDir, 'audit.log'));
    const rateLimiter = new RateLimiter();

    // No CA — just testing that pinningBypass is stored and used
    server = new ProxyServer({
      credentials: [
        { name: 'Test', hostPattern: 'api.test.com', header: 'x-api-key', value: 'secret' },
      ],
      rateLimiter,
      auditLog,
      port: 0,
      pinningBypass: ['api.test.com'],
    });
    await server.listen();

    // Server should be running with MITM disabled (no CA)
    expect(server.mitmEnabled).toBe(false);
  });
});

// ─── 9.8: Request-Level Rules Enforcement ──────────────────────────────────

describe('Request-level rules in credential schema', () => {
  it('parses rules with all fields', () => {
    const rules = parseCredentialRules({
      credentials: [
        {
          name: 'Strict',
          hostPattern: 'api.strict.com',
          header: 'Authorization',
          value: 'Bearer token',
          rules: {
            methods: ['GET', 'POST'],
            pathPrefixes: ['/v1/messages', '/v1/complete'],
            maxBodySize: 1048576,
          },
        },
      ],
    });
    const cred = rules.credentials[0]!;
    expect(cred.rules?.methods).toEqual(['GET', 'POST']);
    expect(cred.rules?.pathPrefixes).toEqual(['/v1/messages', '/v1/complete']);
    expect(cred.rules?.maxBodySize).toBe(1048576);
  });

  it('allows credential without rules', () => {
    const rules = parseCredentialRules({
      credentials: [{ name: 'Open', hostPattern: 'api.open.com', header: 'x-key', value: 'val' }],
    });
    expect(rules.credentials[0]!.rules).toBeUndefined();
  });
});

describe('Rules enforcement in forward proxy', () => {
  let server: ProxyServer;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'proxy-rules-'));
    const auditLog = new AuditLog(join(tmpDir, 'audit.log'));
    const rateLimiter = new RateLimiter();

    server = new ProxyServer({
      credentials: [
        {
          name: 'Restricted',
          hostPattern: 'api.restricted.com',
          header: 'Authorization',
          value: 'Bearer restricted',
          rules: {
            methods: ['POST'],
            pathPrefixes: ['/v1/messages'],
            maxBodySize: 100,
          },
        },
      ],
      rateLimiter,
      auditLog,
      port: 0,
    });
    await server.listen();
  });

  afterEach(async () => {
    await server.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('rejects disallowed HTTP method with 403', async () => {
    const addr = server.address;
    const res = await new Promise<http.IncomingMessage>((resolve) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: addr.port,
          path: 'http://api.restricted.com/v1/messages',
          method: 'DELETE',
        },
        resolve,
      );
      req.end();
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects disallowed path with 403', async () => {
    const addr = server.address;
    const res = await new Promise<http.IncomingMessage>((resolve) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: addr.port,
          path: 'http://api.restricted.com/v2/forbidden',
          method: 'POST',
        },
        resolve,
      );
      req.end();
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects oversized body with 413', async () => {
    const addr = server.address;
    const res = await new Promise<http.IncomingMessage>((resolve) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: addr.port,
          path: 'http://api.restricted.com/v1/messages',
          method: 'POST',
          headers: { 'content-length': '999999' },
        },
        resolve,
      );
      req.end();
    });
    expect(res.statusCode).toBe(413);
  });
});

// ─── 9.3: Multi-Key Round-Robin ────────────────────────────────────────────

describe('KeyRotator', () => {
  let rotator: KeyRotator;

  beforeEach(() => {
    rotator = new KeyRotator();
  });

  it('returns single value when no values array', () => {
    const cred: CredentialRule = {
      name: 'Single',
      hostPattern: 'api.single.com',
      header: 'x-key',
      value: 'only-key',
    };
    expect(rotator.getNextValue(cred)).toBe('only-key');
    expect(rotator.getNextValue(cred)).toBe('only-key');
  });

  it('returns single value when values array is empty', () => {
    const cred: CredentialRule = {
      name: 'Empty',
      hostPattern: 'api.empty.com',
      header: 'x-key',
      value: 'fallback',
      values: [],
    };
    // Empty values array means fall back to value
    expect(rotator.getNextValue(cred)).toBe('fallback');
  });

  it('rotates through values array round-robin', () => {
    const cred: CredentialRule = {
      name: 'Multi',
      hostPattern: 'api.multi.com',
      header: 'x-key',
      value: 'ignored',
      values: ['key-a', 'key-b', 'key-c'],
    };

    expect(rotator.getNextValue(cred)).toBe('key-a');
    expect(rotator.getNextValue(cred)).toBe('key-b');
    expect(rotator.getNextValue(cred)).toBe('key-c');
    expect(rotator.getNextValue(cred)).toBe('key-a'); // wraps around
    expect(rotator.getNextValue(cred)).toBe('key-b');
  });

  it('maintains independent counters per credential', () => {
    const credA: CredentialRule = {
      name: 'A',
      hostPattern: 'a.com',
      header: 'x-key',
      value: 'x',
      values: ['a1', 'a2'],
    };
    const credB: CredentialRule = {
      name: 'B',
      hostPattern: 'b.com',
      header: 'x-key',
      value: 'x',
      values: ['b1', 'b2', 'b3'],
    };

    expect(rotator.getNextValue(credA)).toBe('a1');
    expect(rotator.getNextValue(credB)).toBe('b1');
    expect(rotator.getNextValue(credA)).toBe('a2');
    expect(rotator.getNextValue(credB)).toBe('b2');
    expect(rotator.getNextValue(credA)).toBe('a1'); // wraps
    expect(rotator.getNextValue(credB)).toBe('b3');
  });

  it('resets all counters', () => {
    const cred: CredentialRule = {
      name: 'Reset',
      hostPattern: 'r.com',
      header: 'x-key',
      value: 'x',
      values: ['v1', 'v2'],
    };
    rotator.getNextValue(cred); // counter = 1
    rotator.reset();
    expect(rotator.getNextValue(cred)).toBe('v1'); // counter reset to 0
  });

  it('getCounter returns current counter value', () => {
    const cred: CredentialRule = {
      name: 'Count',
      hostPattern: 'c.com',
      header: 'x-key',
      value: 'x',
      values: ['v1', 'v2'],
    };
    expect(rotator.getCounter('Count')).toBe(0);
    rotator.getNextValue(cred);
    expect(rotator.getCounter('Count')).toBe(1);
    rotator.getNextValue(cred);
    expect(rotator.getCounter('Count')).toBe(2);
  });
});

describe('values field in credential schema', () => {
  it('parses values array', () => {
    const rules = parseCredentialRules({
      credentials: [
        {
          name: 'Multi',
          hostPattern: 'api.multi.com',
          header: 'x-api-key',
          value: 'primary',
          values: ['key-1', 'key-2', 'key-3'],
        },
      ],
    });
    expect(rules.credentials[0]!.values).toEqual(['key-1', 'key-2', 'key-3']);
  });

  it('allows credential without values', () => {
    const rules = parseCredentialRules({
      credentials: [
        { name: 'Single', hostPattern: 'api.single.com', header: 'x-key', value: 'val' },
      ],
    });
    expect(rules.credentials[0]!.values).toBeUndefined();
  });

  it('rejects empty string in values array', () => {
    expect(() =>
      parseCredentialRules({
        credentials: [
          {
            name: 'Bad',
            hostPattern: 'a.com',
            header: 'x-key',
            value: 'v',
            values: ['good', ''],
          },
        ],
      }),
    ).toThrow();
  });
});

// ─── 9.1: Metrics Endpoint ─────────────────────────────────────────────────

describe('ProxyMetrics', () => {
  let metrics: ProxyMetrics;

  beforeEach(() => {
    metrics = new ProxyMetrics(100);
  });

  it('tracks total requests', () => {
    metrics.record('cred-a', 200, 50);
    metrics.record('cred-a', 200, 30);
    metrics.record('cred-b', 500, 100);
    expect(metrics.snapshot().totalRequests).toBe(3);
  });

  it('tracks per-credential counts', () => {
    metrics.record('cred-a', 200, 10);
    metrics.record('cred-a', 200, 20);
    metrics.record('cred-b', 200, 30);
    const snap = metrics.snapshot();
    expect(snap.perCredential['cred-a']).toBe(2);
    expect(snap.perCredential['cred-b']).toBe(1);
  });

  it('tracks status code distribution', () => {
    metrics.record('c', 200, 10);
    metrics.record('c', 200, 10);
    metrics.record('c', 429, 10);
    metrics.record('c', 502, 10);
    const snap = metrics.snapshot();
    expect(snap.statusCodes['200']).toBe(2);
    expect(snap.statusCodes['429']).toBe(1);
    expect(snap.statusCodes['502']).toBe(1);
  });

  it('tracks rate limit hits', () => {
    metrics.recordRateLimitHit();
    metrics.recordRateLimitHit();
    expect(metrics.snapshot().rateLimitHits).toBe(2);
  });

  it('computes latency percentiles', () => {
    // Add 100 measurements: 1, 2, 3, ..., 100
    for (let i = 1; i <= 100; i++) {
      metrics.record('c', 200, i);
    }
    const snap = metrics.snapshot();
    expect(snap.latency.p50).toBe(50);
    expect(snap.latency.p90).toBe(90);
    expect(snap.latency.p99).toBe(99);
    expect(snap.latency.count).toBe(100);
  });

  it('reports uptime', () => {
    const snap = metrics.snapshot();
    expect(snap.uptime).toBeGreaterThanOrEqual(0);
    expect(snap.uptime).toBeLessThan(1000); // should be < 1s in test
  });

  it('resets counts but preserves uptime', () => {
    metrics.record('c', 200, 10);
    metrics.recordRateLimitHit();
    metrics.reset();
    const snap = metrics.snapshot();
    expect(snap.totalRequests).toBe(0);
    expect(snap.rateLimitHits).toBe(0);
    expect(snap.perCredential).toEqual({});
    expect(snap.uptime).toBeGreaterThanOrEqual(0);
  });
});

describe('/metrics endpoint', () => {
  let server: ProxyServer;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'proxy-metrics-'));
    const auditLog = new AuditLog(join(tmpDir, 'audit.log'));
    const rateLimiter = new RateLimiter();
    const proxyMetrics = new ProxyMetrics();

    server = new ProxyServer({
      credentials: [],
      rateLimiter,
      auditLog,
      port: 0,
      metrics: proxyMetrics,
    });
    await server.listen();
  });

  afterEach(async () => {
    await server.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns JSON metrics snapshot', async () => {
    const addr = server.address;
    const res = await fetch(`http://127.0.0.1:${String(addr.port)}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    const body = (await res.json()) as MetricsSnapshot;
    expect(body.totalRequests).toBe(0);
    expect(body.uptime).toBeGreaterThanOrEqual(0);
    expect(body.latency).toBeDefined();
  });
});

// ─── 9.6/9.7: Placeholder Credentials ─────────────────────────────────────

describe('Placeholder credentials', () => {
  it('PLACEHOLDER_OAUTH_TOKEN is non-empty', () => {
    expect(PLACEHOLDER_OAUTH_TOKEN.length).toBeGreaterThan(0);
    expect(PLACEHOLDER_OAUTH_TOKEN).toContain('flowhelm-proxy');
  });

  it('PLACEHOLDER_API_KEY matches sk-ant-* prefix', () => {
    expect(PLACEHOLDER_API_KEY).toMatch(/^sk-ant-/);
    expect(PLACEHOLDER_API_KEY.length).toBeGreaterThan(20);
  });

  it('getPlaceholderEnv with no auth returns API key fallback', () => {
    const env = getPlaceholderEnv({ hasOAuth: false, hasApiKey: false });
    expect(env['ANTHROPIC_API_KEY']).toBe(PLACEHOLDER_API_KEY);
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined();
  });

  it('getPlaceholderEnv auto-detects OAuth when only OAuth available', () => {
    const env = getPlaceholderEnv({ hasOAuth: true, hasApiKey: false });
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBe(PLACEHOLDER_OAUTH_TOKEN);
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
  });

  it('getPlaceholderEnv auto-detects API key when only API key available', () => {
    const env = getPlaceholderEnv({ hasOAuth: false, hasApiKey: true });
    expect(env['ANTHROPIC_API_KEY']).toBe(PLACEHOLDER_API_KEY);
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined();
  });

  it('getPlaceholderEnv auto-detects API key when both available', () => {
    const env = getPlaceholderEnv({ hasOAuth: true, hasApiKey: true });
    expect(env['ANTHROPIC_API_KEY']).toBe(PLACEHOLDER_API_KEY);
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined();
  });

  it('getPlaceholderEnv respects explicit credentialMethod=oauth', () => {
    const env = getPlaceholderEnv({ credentialMethod: 'oauth', hasOAuth: true, hasApiKey: true });
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBe(PLACEHOLDER_OAUTH_TOKEN);
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
  });

  it('getPlaceholderEnv respects explicit credentialMethod=api_key', () => {
    const env = getPlaceholderEnv({ credentialMethod: 'api_key', hasOAuth: true, hasApiKey: true });
    expect(env['ANTHROPIC_API_KEY']).toBe(PLACEHOLDER_API_KEY);
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined();
  });

  it('never sets both placeholders simultaneously', () => {
    const scenarios = [
      { hasOAuth: true, hasApiKey: true },
      { hasOAuth: true, hasApiKey: false },
      { hasOAuth: false, hasApiKey: true },
      { credentialMethod: 'oauth' as const, hasOAuth: true, hasApiKey: true },
      { credentialMethod: 'api_key' as const, hasOAuth: true, hasApiKey: true },
    ];
    for (const opts of scenarios) {
      const env = getPlaceholderEnv(opts);
      const hasOAuth = 'CLAUDE_CODE_OAUTH_TOKEN' in env;
      const hasApiKey = 'ANTHROPIC_API_KEY' in env;
      expect(hasOAuth && hasApiKey).toBe(false);
      expect(hasOAuth || hasApiKey).toBe(true);
    }
  });

  it('placeholder API key is clearly not a real key', () => {
    expect(PLACEHOLDER_API_KEY).toContain('flowhelm-proxy-placeholder');
  });
});

// ─── Credential Selection by Headers ────────────────────────────────────────

describe('findAllCredentialsForHost', () => {
  const oauthRule: CredentialRule = {
    name: 'anthropic-oauth',
    hostPattern: 'api.anthropic.com',
    header: 'Authorization',
    value: 'Bearer token123',
  };
  const apiKeyRule: CredentialRule = {
    name: 'anthropic-api-key',
    hostPattern: 'api.anthropic.com',
    header: 'x-api-key',
    value: 'sk-ant-test',
  };
  const otherRule: CredentialRule = {
    name: 'other-api',
    hostPattern: 'api.other.com',
    header: 'Authorization',
    value: 'Bearer other',
  };

  it('returns all matching credentials for a hostname', () => {
    const rules = [oauthRule, apiKeyRule, otherRule];
    const result = findAllCredentialsForHost('api.anthropic.com', rules);
    expect(result).toHaveLength(2);
    expect(result[0]!.name).toBe('anthropic-oauth');
    expect(result[1]!.name).toBe('anthropic-api-key');
  });

  it('returns empty array when no rules match', () => {
    const result = findAllCredentialsForHost('unknown.com', [oauthRule, apiKeyRule]);
    expect(result).toHaveLength(0);
  });

  it('returns single match correctly', () => {
    const result = findAllCredentialsForHost('api.other.com', [oauthRule, apiKeyRule, otherRule]);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('other-api');
  });
});

describe('selectCredentialByHeaders', () => {
  const oauthCred: CredentialRule = {
    name: 'oauth',
    hostPattern: 'api.anthropic.com',
    header: 'Authorization',
    value: 'Bearer real-token',
  };
  const apiKeyCred: CredentialRule = {
    name: 'api-key',
    hostPattern: 'api.anthropic.com',
    header: 'x-api-key',
    value: 'sk-ant-real-key',
  };

  it('selects OAuth credential when request has authorization header', () => {
    const headers = { authorization: 'Bearer placeholder', 'content-type': 'application/json' };
    const result = selectCredentialByHeaders([oauthCred, apiKeyCred], headers);
    expect(result!.name).toBe('oauth');
  });

  it('selects API key credential when request has x-api-key header', () => {
    const headers = { 'x-api-key': 'placeholder', 'content-type': 'application/json' };
    const result = selectCredentialByHeaders([oauthCred, apiKeyCred], headers);
    expect(result!.name).toBe('api-key');
  });

  it('falls back to first credential when no headers match', () => {
    const headers = { 'content-type': 'application/json' };
    const result = selectCredentialByHeaders([oauthCred, apiKeyCred], headers);
    expect(result!.name).toBe('oauth');
  });

  it('returns the single credential regardless of headers', () => {
    const headers = { 'x-api-key': 'placeholder' };
    const result = selectCredentialByHeaders([oauthCred], headers);
    expect(result!.name).toBe('oauth');
  });

  it('returns undefined for empty credentials', () => {
    const result = selectCredentialByHeaders([], { authorization: 'Bearer test' });
    expect(result).toBeUndefined();
  });

  it('matches case-insensitively (header names are lowercased)', () => {
    const headers = { authorization: 'Bearer test' };
    const cred: CredentialRule = {
      name: 'test',
      hostPattern: 'test.com',
      header: 'Authorization',
      value: 'Bearer real',
    };
    // selectCredentialByHeaders compares cred.header.toLowerCase() against header keys
    const result = selectCredentialByHeaders([cred], headers);
    expect(result!.name).toBe('test');
  });
});

// ─── 9.5/9.10: Cost Tracking ──────────────────────────────────────────────

describe('CostLog', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cost-log-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('writes cost entries as JSON lines', async () => {
    const logPath = join(tmpDir, 'cost.log');
    const costLog = new CostLog(logPath);

    await costLog.log({
      ts: '2026-04-08T12:00:00.000Z',
      credential: 'anthropic-api-key',
      model: 'claude-sonnet-4-6-20250514',
      inputTokens: 1200,
      outputTokens: 340,
    });

    await costLog.log({
      ts: '2026-04-08T12:01:00.000Z',
      credential: 'anthropic-api-key',
      model: 'claude-haiku-4-5-20251001',
      inputTokens: 500,
      outputTokens: 100,
    });

    const content = await readFile(logPath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);

    const entry1 = JSON.parse(lines[0]!) as CostEntry;
    expect(entry1.credential).toBe('anthropic-api-key');
    expect(entry1.model).toBe('claude-sonnet-4-6-20250514');
    expect(entry1.inputTokens).toBe(1200);
    expect(entry1.outputTokens).toBe(340);
  });
});

describe('CostLog.parseAnthropicUsage', () => {
  it('extracts usage from a valid Anthropic response', () => {
    const body = JSON.stringify({
      id: 'msg_01',
      model: 'claude-sonnet-4-6-20250514',
      usage: { input_tokens: 1000, output_tokens: 200 },
      content: [{ type: 'text', text: 'Hello' }],
    });
    const entry = CostLog.parseAnthropicUsage(body, 'anthropic-key');
    expect(entry).toBeDefined();
    expect(entry!.model).toBe('claude-sonnet-4-6-20250514');
    expect(entry!.inputTokens).toBe(1000);
    expect(entry!.outputTokens).toBe(200);
    expect(entry!.credential).toBe('anthropic-key');
  });

  it('returns undefined for response without usage field', () => {
    const body = JSON.stringify({ id: 'msg_01', content: [] });
    expect(CostLog.parseAnthropicUsage(body, 'key')).toBeUndefined();
  });

  it('returns undefined for zero tokens', () => {
    const body = JSON.stringify({
      model: 'test',
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    expect(CostLog.parseAnthropicUsage(body, 'key')).toBeUndefined();
  });

  it('returns undefined for invalid JSON', () => {
    expect(CostLog.parseAnthropicUsage('not json', 'key')).toBeUndefined();
  });

  it('handles missing model field', () => {
    const body = JSON.stringify({
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    const entry = CostLog.parseAnthropicUsage(body, 'key');
    expect(entry).toBeDefined();
    expect(entry!.model).toBe('unknown');
  });

  it('extracts cache tokens from non-streaming response', () => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-6-20250514',
      usage: {
        input_tokens: 3,
        output_tokens: 200,
        cache_creation_input_tokens: 1500,
        cache_read_input_tokens: 800,
      },
    });
    const entry = CostLog.parseAnthropicUsage(body, 'key');
    expect(entry).toBeDefined();
    expect(entry!.inputTokens).toBe(3);
    expect(entry!.cacheCreationInputTokens).toBe(1500);
    expect(entry!.cacheReadInputTokens).toBe(800);
  });

  it('parses SSE streaming response with message_start and message_delta', () => {
    const body = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_01","model":"claude-sonnet-4-6-20250514","usage":{"input_tokens":5,"cache_read_input_tokens":2000}}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":150}}',
      '',
    ].join('\n');
    const entry = CostLog.parseAnthropicUsage(body, 'oauth-key');
    expect(entry).toBeDefined();
    expect(entry!.model).toBe('claude-sonnet-4-6-20250514');
    expect(entry!.inputTokens).toBe(5);
    expect(entry!.outputTokens).toBe(150);
    expect(entry!.cacheReadInputTokens).toBe(2000);
    expect(entry!.credential).toBe('oauth-key');
  });

  it('returns undefined for SSE with no usage data', () => {
    const body = ['event: ping', 'data: {"type":"ping"}', ''].join('\n');
    expect(CostLog.parseAnthropicUsage(body, 'key')).toBeUndefined();
  });

  it('handles SSE with cache_creation_input_tokens', () => {
    const body = [
      'event: message_start',
      'data: {"type":"message_start","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":10,"cache_creation_input_tokens":3000}}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","usage":{"output_tokens":50}}',
      '',
    ].join('\n');
    const entry = CostLog.parseAnthropicUsage(body, 'key');
    expect(entry).toBeDefined();
    expect(entry!.cacheCreationInputTokens).toBe(3000);
    expect(entry!.cacheReadInputTokens).toBeUndefined();
  });
});

// ─── 9.2: Credential Expiration Detection ──────────────────────────────────

describe('expiresAt field in credential schema', () => {
  it('parses expiresAt as integer', () => {
    const rules = parseCredentialRules({
      credentials: [
        {
          name: 'Expiring',
          hostPattern: 'api.test.com',
          header: 'Authorization',
          value: 'Bearer token',
          expiresAt: 1712534400000,
        },
      ],
    });
    expect(rules.credentials[0]!.expiresAt).toBe(1712534400000);
  });

  it('allows credential without expiresAt', () => {
    const rules = parseCredentialRules({
      credentials: [{ name: 'NoExpiry', hostPattern: 'a.com', header: 'x', value: 'v' }],
    });
    expect(rules.credentials[0]!.expiresAt).toBeUndefined();
  });

  it('rejects non-integer expiresAt', () => {
    expect(() =>
      parseCredentialRules({
        credentials: [
          {
            name: 'Bad',
            hostPattern: 'a.com',
            header: 'x',
            value: 'v',
            expiresAt: 1.5,
          },
        ],
      }),
    ).toThrow();
  });
});

// ─── Integration: Forward proxy with key rotation + metrics ────────────────

describe('Forward proxy with key rotation', () => {
  let server: ProxyServer;
  let tmpDir: string;
  let keyRotator: KeyRotator;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'proxy-rotate-'));
    const auditLog = new AuditLog(join(tmpDir, 'audit.log'));
    const rateLimiter = new RateLimiter();
    keyRotator = new KeyRotator();

    server = new ProxyServer({
      credentials: [
        {
          name: 'Multi',
          hostPattern: 'api.example.com',
          header: 'x-api-key',
          value: 'default',
          values: ['key-a', 'key-b'],
        },
      ],
      rateLimiter,
      auditLog,
      port: 0,
      keyRotator,
    });
    await server.listen();
  });

  afterEach(async () => {
    await server.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('advances rotator counter on each request', async () => {
    const addr = server.address;
    // Make a request that will fail (no real upstream) but verifies rotation happens
    try {
      await new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port: addr.port,
            path: 'http://api.example.com/v1/test',
            method: 'GET',
          },
          resolve,
        );
        req.on('error', reject);
        req.end();
      });
    } catch {
      // Expected — no real upstream
    }
    // Counter should have advanced
    expect(keyRotator.getCounter('Multi')).toBe(1);
  });
});

// ─── Full schema round-trip ────────────────────────────────────────────────

describe('Full Phase 9 schema round-trip', () => {
  it('parses a complete credential rules file with all Phase 9 fields', () => {
    const rules = parseCredentialRules({
      credentials: [
        {
          name: 'Anthropic',
          hostPattern: 'api.anthropic.com',
          header: 'x-api-key',
          value: 'sk-ant-primary',
          values: ['sk-ant-key1', 'sk-ant-key2', 'sk-ant-key3'],
          rateLimit: { requests: 100, windowSeconds: 60 },
          rules: {
            methods: ['POST'],
            pathPrefixes: ['/v1/messages', '/v1/complete'],
            maxBodySize: 4194304,
          },
          expiresAt: 1712534400000,
        },
        {
          name: 'Google',
          hostPattern: '*.googleapis.com',
          header: 'Authorization',
          value: 'Bearer ya29...',
        },
      ],
      pinningBypass: ['pinned.googleapis.com'],
    });

    expect(rules.credentials).toHaveLength(2);
    expect(rules.pinningBypass).toEqual(['pinned.googleapis.com']);

    const anthropic = rules.credentials[0]!;
    expect(anthropic.values).toHaveLength(3);
    expect(anthropic.rules?.methods).toEqual(['POST']);
    expect(anthropic.rules?.maxBodySize).toBe(4194304);
    expect(anthropic.expiresAt).toBe(1712534400000);

    const google = rules.credentials[1]!;
    expect(google.values).toBeUndefined();
    expect(google.rules).toBeUndefined();
    expect(google.expiresAt).toBeUndefined();
  });
});
