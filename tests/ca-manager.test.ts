import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import forge from 'node-forge';
import {
  generateCA,
  generateHostCert,
  ensureCA,
  loadCA,
  caPaths,
  type CACertificate,
} from '../src/proxy/ca-manager.js';

describe('CA Manager', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'flowhelm-ca-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('generateCA', () => {
    it('creates a valid self-signed CA certificate', () => {
      const ca = generateCA('test-user');

      expect(ca.key).toBeDefined();
      expect(ca.cert).toBeDefined();
      expect(ca.keyPem).toContain('-----BEGIN RSA PRIVATE KEY-----');
      expect(ca.certPem).toContain('-----BEGIN CERTIFICATE-----');
    });

    it('sets correct subject CN', () => {
      const ca = generateCA('stan');

      const cn = ca.cert.subject.getField('CN');
      expect(cn.value).toBe('FlowHelm Proxy CA (stan)');
    });

    it('sets correct organization', () => {
      const ca = generateCA('stan');

      const org = ca.cert.subject.getField('O');
      expect(org.value).toBe('FlowHelm');
    });

    it('marks as CA with basicConstraints', () => {
      const ca = generateCA('test');

      const bc = ca.cert.getExtension('basicConstraints') as { cA: boolean } | null;
      expect(bc).toBeDefined();
      expect(bc!.cA).toBe(true);
    });

    it('has 10-year validity', () => {
      const ca = generateCA('test');

      const now = new Date();
      const notAfter = ca.cert.validity.notAfter;
      const yearsDiff = notAfter.getFullYear() - now.getFullYear();
      expect(yearsDiff).toBeGreaterThanOrEqual(9);
      expect(yearsDiff).toBeLessThanOrEqual(10);
    });

    it('cert verifies against its own key', () => {
      const ca = generateCA('test');

      // Verify the cert was signed by the private key
      const verified = ca.cert.verify(ca.cert);
      expect(verified).toBe(true);
    });

    it('generates unique serial numbers', () => {
      const ca1 = generateCA('user1');
      const ca2 = generateCA('user2');

      expect(ca1.cert.serialNumber).not.toBe(ca2.cert.serialNumber);
    });
  });

  describe('generateHostCert', () => {
    let ca: CACertificate;

    beforeEach(() => {
      ca = generateCA('test');
    });

    it('generates a cert for the given hostname', () => {
      const host = generateHostCert('api.anthropic.com', ca);

      expect(host.keyPem).toContain('-----BEGIN RSA PRIVATE KEY-----');
      expect(host.certPem).toContain('-----BEGIN CERTIFICATE-----');

      const cn = host.cert.subject.getField('CN');
      expect(cn.value).toBe('api.anthropic.com');
    });

    it('includes hostname in SAN', () => {
      const host = generateHostCert('api.anthropic.com', ca);

      const san = host.cert.getExtension('subjectAltName') as
        | { altNames: Array<{ type: number; value: string }> }
        | undefined;
      expect(san).toBeDefined();
      expect(san!.altNames).toContainEqual({ type: 2, value: 'api.anthropic.com' });
    });

    it('is signed by the CA', () => {
      const host = generateHostCert('example.com', ca);

      // Verify the host cert against the CA cert
      const caStore = forge.pki.createCaStore([ca.cert]);
      const verified = forge.pki.verifyCertificateChain(caStore, [host.cert]);
      expect(verified).toBe(true);
    });

    it('is not a CA itself', () => {
      const host = generateHostCert('example.com', ca);

      const bc = host.cert.getExtension('basicConstraints') as { cA: boolean } | null;
      expect(bc).toBeDefined();
      expect(bc!.cA).toBe(false);
    });

    it('has 7-day validity', () => {
      const host = generateHostCert('example.com', ca);

      const notBefore = host.cert.validity.notBefore;
      const notAfter = host.cert.validity.notAfter;
      const diffMs = notAfter.getTime() - notBefore.getTime();
      const diffDays = diffMs / (1000 * 60 * 60 * 24);
      expect(diffDays).toBeGreaterThanOrEqual(6.9);
      expect(diffDays).toBeLessThanOrEqual(7.1);
    });

    it('has serverAuth extended key usage', () => {
      const host = generateHostCert('example.com', ca);

      const eku = host.cert.getExtension('extKeyUsage') as { serverAuth: boolean } | null;
      expect(eku).toBeDefined();
      expect(eku!.serverAuth).toBe(true);
    });

    it('uses the CA issuer as the cert issuer', () => {
      const host = generateHostCert('example.com', ca);

      const issuerCN = host.cert.issuer.getField('CN');
      expect(issuerCN.value).toBe('FlowHelm Proxy CA (test)');
    });

    it('generates unique serial numbers for different domains', () => {
      const h1 = generateHostCert('a.com', ca);
      const h2 = generateHostCert('b.com', ca);

      expect(h1.cert.serialNumber).not.toBe(h2.cert.serialNumber);
    });
  });

  describe('ensureCA', () => {
    it('generates and persists CA on first call', async () => {
      const ca = await ensureCA(tempDir, 'stan');

      expect(ca.keyPem).toContain('-----BEGIN RSA PRIVATE KEY-----');
      expect(ca.certPem).toContain('-----BEGIN CERTIFICATE-----');

      // Verify files exist
      const keyContent = await readFile(join(tempDir, 'ca.key'), 'utf-8');
      const certContent = await readFile(join(tempDir, 'ca.crt'), 'utf-8');
      expect(keyContent).toBe(ca.keyPem);
      expect(certContent).toBe(ca.certPem);
    });

    it('sets restrictive permissions on key file', async () => {
      await ensureCA(tempDir, 'stan');

      const keyStat = await stat(join(tempDir, 'ca.key'));
      // 0o400 = owner read only
      expect(keyStat.mode & 0o777).toBe(0o400);
    });

    it('returns existing CA on subsequent calls', async () => {
      const ca1 = await ensureCA(tempDir, 'stan');
      const ca2 = await ensureCA(tempDir, 'stan');

      expect(ca1.keyPem).toBe(ca2.keyPem);
      expect(ca1.certPem).toBe(ca2.certPem);
    });
  });

  describe('loadCA', () => {
    it('loads a previously persisted CA', async () => {
      const original = await ensureCA(tempDir, 'stan');
      const loaded = await loadCA(tempDir);

      expect(loaded.keyPem).toBe(original.keyPem);
      expect(loaded.certPem).toBe(original.certPem);
    });

    it('throws if CA files do not exist', async () => {
      await expect(loadCA(tempDir)).rejects.toThrow();
    });
  });

  describe('caPaths', () => {
    it('returns correct paths', () => {
      const paths = caPaths('/home/user/.flowhelm/secrets');
      expect(paths.keyPath).toBe('/home/user/.flowhelm/secrets/ca.key');
      expect(paths.certPath).toBe('/home/user/.flowhelm/secrets/ca.crt');
    });
  });
});
