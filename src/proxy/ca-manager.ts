/**
 * Per-user CA certificate manager.
 *
 * Generates and manages a self-signed CA certificate for the MITM TLS proxy.
 * Each FlowHelm user gets their own CA — compromise of one user's CA
 * does not affect others. The CA is auto-generated on first proxy start.
 *
 * CA files:
 *   ~/.flowhelm/secrets/ca.key   — RSA 2048 private key (mode 0400)
 *   ~/.flowhelm/secrets/ca.crt   — Self-signed CA cert (mode 0644)
 *
 * Per-domain certificates are generated on-the-fly via SNI callback
 * and cached in memory (see cert-cache.ts).
 */

import forge from 'node-forge';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { join, dirname } from 'node:path';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CACertificate {
  key: forge.pki.rsa.PrivateKey;
  cert: forge.pki.Certificate;
  keyPem: string;
  certPem: string;
}

export interface HostCertificate {
  key: forge.pki.rsa.PrivateKey;
  cert: forge.pki.Certificate;
  keyPem: string;
  certPem: string;
}

// ─── CA Generation ──────────────────────────────────────────────────────────

/**
 * Generate a self-signed CA certificate.
 *
 * RSA 2048-bit key, 10-year validity, basicConstraints CA=true.
 * Used to sign per-domain certificates for MITM interception.
 */
export function generateCA(username: string): CACertificate {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = generateSerialNumber();
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + 10);

  const attrs: forge.pki.CertificateField[] = [
    { name: 'commonName', value: `FlowHelm Proxy CA (${username})` },
    { name: 'organizationName', value: 'FlowHelm' },
  ];

  cert.setSubject(attrs);
  cert.setIssuer(attrs); // Self-signed

  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    {
      name: 'keyUsage',
      keyCertSign: true,
      cRLSign: true,
      critical: true,
    },
    {
      name: 'subjectKeyIdentifier',
    },
  ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());

  return {
    key: keys.privateKey,
    cert,
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    certPem: forge.pki.certificateToPem(cert),
  };
}

/**
 * Generate a per-domain certificate signed by the CA.
 *
 * RSA 2048-bit key, 7-day validity, SAN=DNS:{hostname},
 * keyUsage=digitalSignature+keyEncipherment, extKeyUsage=serverAuth.
 */
export function generateHostCert(hostname: string, ca: CACertificate): HostCertificate {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = generateSerialNumber();
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setDate(cert.validity.notAfter.getDate() + 7);

  cert.setSubject([{ name: 'commonName', value: hostname }]);
  cert.setIssuer(ca.cert.subject.attributes);

  // Extract CA's Subject Key Identifier for the Authority Key Identifier extension.
  // node-forge's `keyIdentifier: true` produces an empty value, so we pass the
  // explicit SKI bytes from the CA cert to ensure proper chain validation.
  const caSkiExt = ca.cert.getExtension('subjectKeyIdentifier') as {
    subjectKeyIdentifier: string;
  } | null;
  const caSkiBytes = caSkiExt?.subjectKeyIdentifier
    ? forge.util.hexToBytes(caSkiExt.subjectKeyIdentifier)
    : undefined;

  cert.setExtensions([
    {
      name: 'basicConstraints',
      cA: false,
    },
    {
      name: 'keyUsage',
      digitalSignature: true,
      keyEncipherment: true,
      critical: true,
    },
    {
      name: 'extKeyUsage',
      serverAuth: true,
    },
    {
      name: 'subjectAltName',
      altNames: [{ type: 2, value: hostname }], // type 2 = DNS
    },
    {
      name: 'subjectKeyIdentifier',
    },
    ...(caSkiBytes ? [{ name: 'authorityKeyIdentifier', keyIdentifier: caSkiBytes }] : []),
  ]);

  cert.sign(ca.key, forge.md.sha256.create());

  return {
    key: keys.privateKey,
    cert,
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    certPem: forge.pki.certificateToPem(cert),
  };
}

// ─── Persistence ────────────────────────────────────────────────────────────

/**
 * Ensure a CA certificate exists on disk. If not, generate and write.
 * Returns the loaded or newly generated CA.
 */
export async function ensureCA(secretsDir: string, username: string): Promise<CACertificate> {
  const keyPath = join(secretsDir, 'ca.key');
  const certPath = join(secretsDir, 'ca.crt');

  try {
    return await loadCA(secretsDir);
  } catch {
    // CA doesn't exist yet — generate
    const ca = generateCA(username);
    await mkdir(dirname(keyPath), { recursive: true });
    await writeFile(keyPath, ca.keyPem, { mode: 0o400 });
    await writeFile(certPath, ca.certPem, { mode: 0o644 });
    await chmod(keyPath, 0o400);
    return ca;
  }
}

/**
 * Load an existing CA from PEM files on disk.
 * Throws if files don't exist or are invalid.
 */
export async function loadCA(secretsDir: string): Promise<CACertificate> {
  const keyPath = join(secretsDir, 'ca.key');
  const certPath = join(secretsDir, 'ca.crt');

  const keyPem = await readFile(keyPath, 'utf-8');
  const certPem = await readFile(certPath, 'utf-8');

  const key = forge.pki.privateKeyFromPem(keyPem);
  const cert = forge.pki.certificateFromPem(certPem);

  return { key, cert, keyPem, certPem };
}

/**
 * Get paths for CA files.
 */
export function caPaths(secretsDir: string): { keyPath: string; certPath: string } {
  return {
    keyPath: join(secretsDir, 'ca.key'),
    certPath: join(secretsDir, 'ca.crt'),
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function generateSerialNumber(): string {
  const bytes = forge.random.getBytesSync(16);
  return forge.util.bytesToHex(bytes);
}
