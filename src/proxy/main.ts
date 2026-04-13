/**
 * Proxy container entrypoint.
 *
 * Reads encrypted credentials from /secrets/credentials.enc,
 * decrypts with PROXY_DECRYPTION_KEY, creates the ProxyServer,
 * and starts listening.
 *
 * If no credentials file exists (first boot before any credentials
 * are stored), the proxy runs with an empty ruleset — it still
 * provides CONNECT tunneling for HTTPS passthrough.
 */

import { readFileSync } from 'node:fs';
import { ProxyServer } from './proxy-server.js';
import { decrypt } from './credential-store.js';
import { RateLimiter } from './rate-limiter.js';
import { AuditLog } from './audit-log.js';
import {
  parseCredentialRules,
  type CredentialRule,
  type CredentialRules,
} from './credential-schema.js';
import { loadCA, type CACertificate } from './ca-manager.js';
import { KeyRotator } from './key-rotator.js';
import { ProxyMetrics } from './metrics.js';
import { CostLog } from './cost-log.js';

const port = Number(process.env['PROXY_PORT']) || 10255;
const keyHex = process.env['PROXY_DECRYPTION_KEY'] ?? '';

/** Expiration check interval: 5 minutes. */
const EXPIRY_CHECK_INTERVAL = 5 * 60 * 1000;
/** Warn when a credential expires within 1 hour. */
const EXPIRY_WARN_THRESHOLD = 60 * 60 * 1000;

/**
 * Load and decrypt credential rules from the encrypted file.
 * Returns empty rules on any failure (first boot, missing file, etc.).
 */
function loadCredentialRules(): CredentialRules {
  if (!keyHex) {
    console.log('[proxy] No decryption key — running in passthrough mode');
    return { credentials: [], pinningBypass: [], secrets: {} };
  }

  try {
    const encryptedData = readFileSync('/secrets/credentials.enc');
    const key = Buffer.from(keyHex, 'hex');
    const decrypted = decrypt(encryptedData, key);
    const json: unknown = JSON.parse(decrypted.toString('utf-8'));
    const rules = parseCredentialRules(json);
    console.log(`[proxy] Loaded ${String(rules.credentials.length)} credential rule(s)`);
    return rules;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[proxy] No credentials loaded (${msg}) — running in passthrough mode`);
    return { credentials: [], pinningBypass: [], secrets: {} };
  }
}

/**
 * Build a RateLimiter from credential rules.
 */
function buildRateLimiter(credentials: CredentialRule[]): RateLimiter {
  const rateLimiter = new RateLimiter();
  for (const cred of credentials) {
    if (cred.rateLimit) {
      rateLimiter.register(cred.name, cred.rateLimit);
    }
  }
  return rateLimiter;
}

/**
 * Check for credentials approaching expiration and log warnings.
 */
function checkExpirations(credentials: CredentialRule[]): void {
  const now = Date.now();
  for (const cred of credentials) {
    if (cred.expiresAt) {
      const timeLeft = cred.expiresAt - now;
      if (timeLeft <= 0) {
        console.warn(
          `[proxy] Credential "${cred.name}" has EXPIRED (expired ${String(Math.round(-timeLeft / 1000))}s ago)`,
        );
      } else if (timeLeft <= EXPIRY_WARN_THRESHOLD) {
        console.warn(
          `[proxy] Credential "${cred.name}" expires in ${String(Math.round(timeLeft / 60000))} minutes`,
        );
      }
    }
  }
}

async function main(): Promise<void> {
  const rules = loadCredentialRules();
  let rateLimiter = buildRateLimiter(rules.credentials);

  const auditLog = new AuditLog('/var/log/flowhelm/proxy-audit.log');
  const keyRotator = new KeyRotator();
  const metrics = new ProxyMetrics();
  const costLog = new CostLog('/var/log/flowhelm/proxy-cost.log');

  // Load CA for MITM TLS interception (optional — falls back to passthrough)
  let ca: CACertificate | undefined;
  try {
    ca = await loadCA('/secrets');
    console.log('[proxy] CA loaded — MITM TLS interception enabled');
  } catch {
    console.log('[proxy] No CA found — CONNECT requests will use passthrough mode');
  }

  // Active billing method — filters which Anthropic credential to inject
  const credentialMethodRaw = process.env['CREDENTIAL_METHOD'];
  const activeCredentialMethod =
    credentialMethodRaw === 'oauth' || credentialMethodRaw === 'api_key'
      ? credentialMethodRaw
      : undefined;

  const server = new ProxyServer({
    credentials: rules.credentials,
    rateLimiter,
    auditLog,
    port,
    ca,
    keyRotator,
    metrics,
    costLog,
    pinningBypass: rules.pinningBypass,
    activeCredentialMethod,
  });

  await server.listen();
  console.log(
    `[proxy] Listening on 0.0.0.0:${String(port)}${ca ? ' (MITM enabled)' : ' (passthrough only)'}`,
  );

  // Initial expiration check
  checkExpirations(rules.credentials);

  // Periodic expiration checks (every 5 minutes)
  const expiryTimer = setInterval(() => {
    checkExpirations(rules.credentials);
  }, EXPIRY_CHECK_INTERVAL);

  // SIGHUP: warm-restart — reload credentials without restarting the process
  process.on('SIGHUP', () => {
    console.log('[proxy] SIGHUP received — reloading credentials...');
    try {
      const newRules = loadCredentialRules();
      rateLimiter = buildRateLimiter(newRules.credentials);
      keyRotator.reset();

      server.reloadCredentials(newRules.credentials, rateLimiter, {
        keyRotator,
        pinningBypass: newRules.pinningBypass,
      });

      // Update expiration check closure
      checkExpirations(newRules.credentials);

      console.log('[proxy] Credentials reloaded successfully');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[proxy] Failed to reload credentials: ${msg}`);
    }
  });

  // Graceful shutdown
  const shutdown = (): void => {
    console.log('[proxy] Shutting down...');
    clearInterval(expiryTimer);
    void server.close().then(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('[proxy] Fatal error:', err);
  process.exit(1);
});
