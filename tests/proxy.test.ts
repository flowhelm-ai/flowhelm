import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  parseCredentialRules,
  matchesHostPattern,
  findCredentialForHost,
  type CredentialRule,
} from '../src/proxy/credential-schema.js';
import { RateLimiter } from '../src/proxy/rate-limiter.js';
import { AuditLog } from '../src/proxy/audit-log.js';
import { ProxyServer } from '../src/proxy/proxy-server.js';
import { ProxyManager } from '../src/proxy/proxy-manager.js';
import {
  CredentialStore,
  generateKey,
  writeKeyFile,
  saveCredentials,
} from '../src/proxy/credential-store.js';
import type { ContainerRuntime, ContainerConfig } from '../src/orchestrator/types.js';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

// ─── Credential Schema Tests ────────────────────────────────────────────────

describe('parseCredentialRules', () => {
  it('validates a correct credential rules object', () => {
    const rules = parseCredentialRules({
      credentials: [
        {
          name: 'Anthropic',
          hostPattern: 'api.anthropic.com',
          header: 'x-api-key',
          value: 'sk-ant-test',
          rateLimit: { requests: 100, windowSeconds: 3600 },
        },
      ],
    });
    expect(rules.credentials).toHaveLength(1);
    expect(rules.credentials[0]!.name).toBe('Anthropic');
  });

  it('defaults credentials to empty array', () => {
    const rules = parseCredentialRules({});
    expect(rules.credentials).toEqual([]);
  });

  it('rejects empty name', () => {
    expect(() =>
      parseCredentialRules({
        credentials: [{ name: '', hostPattern: 'a.com', header: 'x', value: 'v' }],
      }),
    ).toThrow();
  });

  it('rejects invalid host pattern', () => {
    expect(() =>
      parseCredentialRules({
        credentials: [{ name: 'A', hostPattern: 'http://bad', header: 'x', value: 'v' }],
      }),
    ).toThrow();
  });

  it('allows wildcard host pattern', () => {
    const rules = parseCredentialRules({
      credentials: [{ name: 'A', hostPattern: '*.googleapis.com', header: 'Auth', value: 'v' }],
    });
    expect(rules.credentials[0]!.hostPattern).toBe('*.googleapis.com');
  });

  it('rejects rate limit with zero requests', () => {
    expect(() =>
      parseCredentialRules({
        credentials: [
          {
            name: 'A',
            hostPattern: 'a.com',
            header: 'x',
            value: 'v',
            rateLimit: { requests: 0, windowSeconds: 60 },
          },
        ],
      }),
    ).toThrow();
  });
});

describe('matchesHostPattern', () => {
  it('matches exact hostname', () => {
    expect(matchesHostPattern('api.anthropic.com', 'api.anthropic.com')).toBe(true);
  });

  it('rejects non-matching exact hostname', () => {
    expect(matchesHostPattern('other.anthropic.com', 'api.anthropic.com')).toBe(false);
  });

  it('matches wildcard pattern', () => {
    expect(matchesHostPattern('maps.googleapis.com', '*.googleapis.com')).toBe(true);
    expect(matchesHostPattern('oauth2.googleapis.com', '*.googleapis.com')).toBe(true);
  });

  it('rejects bare domain against wildcard', () => {
    // *.googleapis.com should NOT match "googleapis.com" itself
    expect(matchesHostPattern('googleapis.com', '*.googleapis.com')).toBe(false);
  });

  it('rejects partial match', () => {
    expect(matchesHostPattern('evil-googleapis.com', '*.googleapis.com')).toBe(false);
  });
});

describe('findCredentialForHost', () => {
  const rules: CredentialRule[] = [
    { name: 'Anthropic', hostPattern: 'api.anthropic.com', header: 'x-api-key', value: 'sk-ant' },
    {
      name: 'Google',
      hostPattern: '*.googleapis.com',
      header: 'Authorization',
      value: 'Bearer ya29',
    },
  ];

  it('finds exact match', () => {
    const found = findCredentialForHost('api.anthropic.com', rules);
    expect(found?.name).toBe('Anthropic');
  });

  it('finds wildcard match', () => {
    const found = findCredentialForHost('gmail.googleapis.com', rules);
    expect(found?.name).toBe('Google');
  });

  it('returns undefined for no match', () => {
    expect(findCredentialForHost('unknown.com', rules)).toBeUndefined();
  });

  it('returns first matching rule', () => {
    const dupes: CredentialRule[] = [
      { name: 'First', hostPattern: 'api.test.com', header: 'x', value: 'a' },
      { name: 'Second', hostPattern: 'api.test.com', header: 'x', value: 'b' },
    ];
    expect(findCredentialForHost('api.test.com', dupes)?.name).toBe('First');
  });
});

// ─── Rate Limiter Tests ─────────────────────────────────────────────────────

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter();
  });

  it('allows requests when no rule is registered', () => {
    const result = limiter.check('unregistered');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(Infinity);
  });

  it('allows requests within the limit', () => {
    limiter.register('test', { requests: 3, windowSeconds: 60 });
    const now = 1000000;

    expect(limiter.consume('test', now).allowed).toBe(true);
    expect(limiter.consume('test', now + 1).allowed).toBe(true);
    expect(limiter.consume('test', now + 2).allowed).toBe(true);
  });

  it('blocks requests exceeding the limit', () => {
    limiter.register('test', { requests: 2, windowSeconds: 60 });
    const now = 1000000;

    limiter.consume('test', now);
    limiter.consume('test', now + 1);
    const result = limiter.consume('test', now + 2);

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('allows requests after window expires', () => {
    limiter.register('test', { requests: 1, windowSeconds: 10 });
    const now = 1000000;

    limiter.consume('test', now);
    const blocked = limiter.consume('test', now + 1000);
    expect(blocked.allowed).toBe(false);

    // 11 seconds later — window expired
    const allowed = limiter.consume('test', now + 11_000);
    expect(allowed.allowed).toBe(true);
  });

  it('tracks limits independently per credential', () => {
    limiter.register('a', { requests: 1, windowSeconds: 60 });
    limiter.register('b', { requests: 1, windowSeconds: 60 });

    const now = 1000000;
    limiter.consume('a', now);
    expect(limiter.consume('a', now + 1).allowed).toBe(false);
    expect(limiter.consume('b', now + 1).allowed).toBe(true);
  });

  it('reset clears all state', () => {
    limiter.register('test', { requests: 1, windowSeconds: 60 });
    limiter.consume('test');
    limiter.reset();
    expect(limiter.consume('test').allowed).toBe(true);
  });

  it('stats returns current usage', () => {
    limiter.register('test', { requests: 10, windowSeconds: 60 });
    limiter.consume('test');
    limiter.consume('test');
    const s = limiter.stats('test');
    expect(s?.current).toBe(2);
    expect(s?.limit).toBe(10);
  });

  it('stats returns undefined for unregistered credential', () => {
    expect(limiter.stats('ghost')).toBeUndefined();
  });

  it('retryAfterMs is computed correctly', () => {
    limiter.register('test', { requests: 1, windowSeconds: 10 });
    const now = 1000000;

    limiter.consume('test', now);
    const result = limiter.check('test', now + 3000);
    expect(result.allowed).toBe(false);
    // Oldest request at 1000000, window is 10s. Retry after: 1000000 + 10000 - 1003000 = 7000
    expect(result.retryAfterMs).toBe(7000);
  });
});

// ─── Audit Log Tests ────────────────────────────────────────────────────────

describe('AuditLog', () => {
  let tmpDir: string;
  let logPath: string;
  let log: AuditLog;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'flowhelm-test-'));
    logPath = join(tmpDir, 'audit.log');
    log = new AuditLog(logPath);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('creates the log file on first write', async () => {
    await log.log({
      timestamp: '2026-04-03T14:22:01.000Z',
      method: 'CONNECT',
      host: 'api.anthropic.com:443',
      statusCode: 200,
      durationMs: 1234,
      credentialName: 'Anthropic',
    });

    const content = await readFile(logPath, 'utf-8');
    expect(content).toContain('CONNECT');
    expect(content).toContain('api.anthropic.com:443');
    expect(content).toContain('credential=Anthropic');
  });

  it('appends multiple entries', async () => {
    await log.logRequest('POST', 'api.anthropic.com', 200, Date.now() - 100, 'Anthropic');
    await log.logRequest('GET', 'gmail.googleapis.com', 200, Date.now() - 50, 'Google');

    const content = await readFile(logPath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('credential=Anthropic');
    expect(lines[1]).toContain('credential=Google');
  });

  it('log entries are single lines', async () => {
    await log.logRequest('POST', 'a.com', 200, Date.now(), 'Test');
    const content = await readFile(logPath, 'utf-8');
    // Should have exactly one newline at the end
    expect(content.split('\n').filter(Boolean)).toHaveLength(1);
  });
});

// ─── Proxy Server Tests ─────────────────────────────────────────────────────

describe('ProxyServer', () => {
  let tmpDir: string;
  let server: ProxyServer;
  let rateLimiter: RateLimiter;
  let auditLog: AuditLog;
  const credentials: CredentialRule[] = [
    {
      name: 'Test',
      hostPattern: 'api.test.com',
      header: 'x-api-key',
      value: 'real-key',
      rateLimit: { requests: 100, windowSeconds: 3600 },
    },
  ];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'flowhelm-test-'));
    rateLimiter = new RateLimiter();
    auditLog = new AuditLog(join(tmpDir, 'audit.log'));

    server = new ProxyServer({
      credentials,
      rateLimiter,
      auditLog,
      port: 0, // Random available port
    });
    await server.listen();
  });

  afterEach(async () => {
    await server.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('responds to /healthz with 200', async () => {
    const { port } = server.address;
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('returns 400 for invalid URL', async () => {
    const { port } = server.address;
    const res = await new Promise<http.IncomingMessage>((resolve) => {
      const req = http.request(
        { hostname: '127.0.0.1', port, method: 'GET', path: 'not-a-url' },
        resolve,
      );
      req.end();
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 429 when rate limited', async () => {
    // Register rate limit: 0 requests allowed (immediately rate limited)
    rateLimiter.register('Test', { requests: 1, windowSeconds: 60 });
    // Pre-consume the single slot so next request is rate limited
    rateLimiter.record('Test');
    const { port } = server.address;

    const res = await new Promise<http.IncomingMessage>((resolve) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          method: 'GET',
          path: 'http://api.test.com/v1/test',
        },
        resolve,
      );
      req.end();
    });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
  });
});

// ─── Proxy Manager Tests ────────────────────────────────────────────────────

describe('ProxyManager', () => {
  let tmpDir: string;

  // Track calls to mock runtime
  let createCalls: ContainerConfig[];
  let startCalls: string[];
  let stopCalls: string[];
  let removeCalls: string[];
  let existsResult: boolean;
  let healthyResult: boolean;

  const mockRuntime: ContainerRuntime = {
    create: async (config) => {
      createCalls.push(config);
      return config.name;
    },
    start: async (id) => {
      startCalls.push(id);
    },
    stop: async (id) => {
      stopCalls.push(id);
    },
    remove: async (id) => {
      removeCalls.push(id);
    },
    exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    logs: async () => '',
    isHealthy: async () => healthyResult,
    exists: async () => existsResult,
    list: async () => [],
    createNetwork: async () => {},
    removeNetwork: async () => {},
    networkExists: async () => true,
    imageExists: async () => true,
  };

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'flowhelm-test-'));
    createCalls = [];
    startCalls = [];
    stopCalls = [];
    removeCalls = [];
    existsResult = false;
    healthyResult = false;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function createManager(): ProxyManager {
    // Write a key file so the manager can read it
    const store = new CredentialStore({ secretsDir: tmpDir });
    return new ProxyManager({
      runtime: mockRuntime,
      username: 'testuser',
      credentialStore: store,
      healthCheckInterval: 999_999, // Don't trigger during tests
    });
  }

  it('creates and starts a new container on first start()', async () => {
    const key = generateKey();
    await writeKeyFile(join(tmpDir, 'credentials.key'), key);
    await saveCredentials({ credentials: [] }, join(tmpDir, 'credentials.enc'), key);

    existsResult = false;
    healthyResult = true; // Will be healthy after start

    const manager = createManager();
    await manager.start();
    await manager.stop();

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]!.name).toBe('flowhelm-proxy-testuser');
    expect(createCalls[0]!.readOnly).toBe(true);
    expect(createCalls[0]!.securityOpts).toContain('no-new-privileges');
    expect(startCalls).toHaveLength(1);
  });

  it('skips creation if container already exists and is healthy', async () => {
    const key = generateKey();
    await writeKeyFile(join(tmpDir, 'credentials.key'), key);
    await saveCredentials({ credentials: [] }, join(tmpDir, 'credentials.enc'), key);

    existsResult = true;
    healthyResult = true;

    const manager = createManager();
    await manager.start();
    await manager.stop();

    expect(createCalls).toHaveLength(0);
    expect(startCalls).toHaveLength(0);
  });

  it('removes and recreates unhealthy container', async () => {
    const key = generateKey();
    await writeKeyFile(join(tmpDir, 'credentials.key'), key);
    await saveCredentials({ credentials: [] }, join(tmpDir, 'credentials.enc'), key);

    existsResult = true;
    healthyResult = false;
    let callCount = 0;
    // After recreation, isHealthy returns true
    mockRuntime.isHealthy = async () => {
      callCount++;
      return callCount > 2; // Unhealthy initially, healthy after recreation
    };

    const manager = createManager();
    await manager.start();
    await manager.stop();

    // Should have stopped, removed, then created a new one
    expect(stopCalls.length).toBeGreaterThanOrEqual(1);
    expect(removeCalls.length).toBeGreaterThanOrEqual(1);
    expect(createCalls).toHaveLength(1);

    // Reset mock
    mockRuntime.isHealthy = async () => healthyResult;
  });

  it('proxyUrl uses correct format', () => {
    const store = new CredentialStore({ secretsDir: tmpDir });
    const manager = new ProxyManager({
      runtime: mockRuntime,
      username: 'stan',
      credentialStore: store,
    });
    expect(manager.proxyUrl).toBe('http://flowhelm-proxy-stan:10255');
  });

  it('containerName follows naming convention', () => {
    const store = new CredentialStore({ secretsDir: tmpDir });
    const manager = new ProxyManager({
      runtime: mockRuntime,
      username: 'stan',
      credentialStore: store,
    });
    expect(manager.containerName).toBe('flowhelm-proxy-stan');
  });

  it('stop removes container', async () => {
    existsResult = true;
    const store = new CredentialStore({ secretsDir: tmpDir });
    const manager = new ProxyManager({
      runtime: mockRuntime,
      username: 'testuser',
      credentialStore: store,
    });

    await manager.stop();
    expect(stopCalls).toHaveLength(1);
    expect(removeCalls).toHaveLength(1);
  });

  it('stop is no-op if container does not exist', async () => {
    existsResult = false;
    const store = new CredentialStore({ secretsDir: tmpDir });
    const manager = new ProxyManager({
      runtime: mockRuntime,
      username: 'testuser',
      credentialStore: store,
    });

    await manager.stop();
    expect(stopCalls).toHaveLength(0);
    expect(removeCalls).toHaveLength(0);
  });

  it('buildContainerConfig includes all security options', () => {
    const store = new CredentialStore({ secretsDir: tmpDir });
    const manager = new ProxyManager({
      runtime: mockRuntime,
      username: 'testuser',
      credentialStore: store,
      proxyImage: 'custom-proxy:v1',
      memoryLimit: '128m',
      cpuLimit: '0.5',
    });

    const key = Buffer.alloc(32, 'A');
    const config = manager.buildContainerConfig(key);

    expect(config.image).toBe('custom-proxy:v1');
    expect(config.memoryLimit).toBe('128m');
    expect(config.cpuLimit).toBe('0.5');
    expect(config.readOnly).toBe(true);
    expect(config.securityOpts).toContain('no-new-privileges');
    expect(config.env['PROXY_DECRYPTION_KEY']).toBe(key.toString('hex'));
    expect(config.env['PROXY_PORT']).toBe('10255');
    expect(config.network).toBe('flowhelm-network-testuser');
    expect(config.mounts[0]!.readOnly).toBe(true);
    // /tmp is tmpfs, /var/log/flowhelm is a bind mount (persistent logs)
    expect(config.tmpfs).toHaveLength(1);
    expect(config.tmpfs[0]!.target).toBe('/tmp');
    // Logs bind mount: 4th mount (after credentials.enc, ca.key, ca.crt)
    const logMount = config.mounts.find((m) => m.target === '/var/log/flowhelm');
    expect(logMount).toBeDefined();
    expect(logMount!.readOnly).toBe(false);
    // --userns=keep-id:uid=1000,gid=1000 for rootless Podman UID mapping
    expect(config.userNamespace).toBe('keep-id:uid=1000,gid=1000');
  });
});
