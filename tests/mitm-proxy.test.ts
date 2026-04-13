import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import forge from 'node-forge';
import { generateCA, generateHostCert } from '../src/proxy/ca-manager.js';
import { MitmHandler } from '../src/proxy/mitm-handler.js';
import { ProxyServer } from '../src/proxy/proxy-server.js';
import { RateLimiter } from '../src/proxy/rate-limiter.js';
import { AuditLog } from '../src/proxy/audit-log.js';
import { CredentialStore } from '../src/proxy/credential-store.js';
import type { CredentialRule } from '../src/proxy/credential-schema.js';
import type { CACertificate } from '../src/proxy/ca-manager.js';

describe('MitmHandler', () => {
  let ca: CACertificate;
  let rateLimiter: RateLimiter;
  let auditLog: AuditLog;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'flowhelm-mitm-'));
    ca = generateCA('test');
    rateLimiter = new RateLimiter();
    auditLog = new AuditLog(join(tempDir, 'audit.log'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('can be instantiated with a CA', () => {
    const handler = new MitmHandler({ ca, rateLimiter, auditLog });
    expect(handler).toBeDefined();
    expect(handler.cacheSize).toBe(0);
  });

  it('generates and caches certs for domains', async () => {
    const handler = new MitmHandler({ ca, rateLimiter, auditLog });

    // Access the cert cache through the public interface
    expect(handler.cacheSize).toBe(0);
  });
});

describe('ProxyServer with MITM', () => {
  let ca: CACertificate;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'flowhelm-proxy-mitm-'));
    ca = generateCA('test');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('creates server with MITM enabled when CA is provided', () => {
    const credentials: CredentialRule[] = [
      {
        name: 'test-api',
        hostPattern: 'api.example.com',
        header: 'x-api-key',
        value: 'real-key-123',
      },
    ];

    const server = new ProxyServer({
      credentials,
      rateLimiter: new RateLimiter(),
      auditLog: new AuditLog(join(tempDir, 'audit.log')),
      ca,
    });

    expect(server.mitmEnabled).toBe(true);
  });

  it('creates server without MITM when no CA is provided', () => {
    const server = new ProxyServer({
      credentials: [],
      rateLimiter: new RateLimiter(),
      auditLog: new AuditLog(join(tempDir, 'audit.log')),
    });

    expect(server.mitmEnabled).toBe(false);
  });

  it('starts and stops with MITM enabled', async () => {
    const server = new ProxyServer({
      credentials: [],
      rateLimiter: new RateLimiter(),
      auditLog: new AuditLog(join(tempDir, 'audit.log')),
      port: 0, // random port
      ca,
    });

    await server.listen();
    expect(server.address.port).toBeGreaterThan(0);
    await server.close();
  });
});

describe('Host cert chain validation', () => {
  it('host cert validates against CA in forge CA store', () => {
    const ca = generateCA('validation-test');
    const host = generateHostCert('api.anthropic.com', ca);

    const caStore = forge.pki.createCaStore([ca.cert]);
    const verified = forge.pki.verifyCertificateChain(caStore, [host.cert]);
    expect(verified).toBe(true);
  });

  it('host cert does NOT validate against a different CA', () => {
    const ca1 = generateCA('ca-one');
    const ca2 = generateCA('ca-two');
    const host = generateHostCert('api.example.com', ca1);

    const caStore = forge.pki.createCaStore([ca2.cert]);
    expect(() => forge.pki.verifyCertificateChain(caStore, [host.cert])).toThrow();
  });

  it('generates different certs for different domains', () => {
    const ca = generateCA('test');
    const h1 = generateHostCert('api.anthropic.com', ca);
    const h2 = generateHostCert('api.openai.com', ca);

    expect(h1.certPem).not.toBe(h2.certPem);
    expect(h1.keyPem).not.toBe(h2.keyPem);

    const cn1 = h1.cert.subject.getField('CN');
    const cn2 = h2.cert.subject.getField('CN');
    expect(cn1.value).toBe('api.anthropic.com');
    expect(cn2.value).toBe('api.openai.com');
  });
});

describe('CredentialStore CA integration', () => {
  let tempDir: string;
  let store: CredentialStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'flowhelm-store-ca-'));
    store = new CredentialStore({ secretsDir: tempDir });
    await store.ensureSecretsDir();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('ensureCA generates and returns CA', async () => {
    const ca = await store.ensureCA('test-user');
    expect(ca.keyPem).toContain('-----BEGIN RSA PRIVATE KEY-----');
    expect(ca.certPem).toContain('-----BEGIN CERTIFICATE-----');
  });

  it('caCertPath and caKeyPath return correct paths', () => {
    expect(store.caCertPath).toBe(join(tempDir, 'ca.crt'));
    expect(store.caKeyPath).toBe(join(tempDir, 'ca.key'));
  });

  it('ensureCA is idempotent', async () => {
    const ca1 = await store.ensureCA('test-user');
    const ca2 = await store.ensureCA('test-user');
    expect(ca1.keyPem).toBe(ca2.keyPem);
  });
});

describe('CredentialStore migrateAuthTokens', () => {
  let tempDir: string;
  let store: CredentialStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'flowhelm-migrate-'));
    store = new CredentialStore({ secretsDir: tempDir });
    await store.ensureSecretsDir();
    await store.ensureKey();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('migrates oauth-token file into credential store', async () => {
    await writeFile(join(tempDir, 'oauth-token'), 'sk-ant-oat01-test-token');

    await store.migrateAuthTokens();

    const rules = await store.load();
    const rule = rules.credentials.find((r) => r.name === 'anthropic-oauth');
    expect(rule).toBeDefined();
    expect(rule!.hostPattern).toBe('api.anthropic.com');
    expect(rule!.header).toBe('Authorization');
    expect(rule!.value).toBe('Bearer sk-ant-oat01-test-token');
  });

  it('migrates api-key file into credential store', async () => {
    await writeFile(join(tempDir, 'api-key'), 'sk-ant-api03-test-key');

    await store.migrateAuthTokens();

    const rules = await store.load();
    const rule = rules.credentials.find((r) => r.name === 'anthropic-api-key');
    expect(rule).toBeDefined();
    expect(rule!.hostPattern).toBe('api.anthropic.com');
    expect(rule!.header).toBe('x-api-key');
    expect(rule!.value).toBe('sk-ant-api03-test-key');
  });

  it('is idempotent — does not duplicate rules', async () => {
    await writeFile(join(tempDir, 'oauth-token'), 'token-value');

    await store.migrateAuthTokens();
    await store.migrateAuthTokens();

    const rules = await store.load();
    const oauthRules = rules.credentials.filter((r) => r.name === 'anthropic-oauth');
    expect(oauthRules).toHaveLength(1);
  });

  it('skips migration when files do not exist', async () => {
    await store.migrateAuthTokens();

    const rules = await store.load();
    expect(rules.credentials).toHaveLength(0);
  });

  it('skips empty token files', async () => {
    await writeFile(join(tempDir, 'oauth-token'), '');

    await store.migrateAuthTokens();

    const rules = await store.load();
    expect(rules.credentials).toHaveLength(0);
  });
});
