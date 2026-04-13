/**
 * HTTP CONNECT proxy server with MITM TLS credential injection.
 *
 * Handles both plaintext HTTP (forward proxy) and HTTPS (CONNECT method).
 * When a CA certificate is provided, the proxy performs MITM TLS interception
 * for hosts with matching credential rules — terminating the agent's TLS,
 * reading plaintext HTTP, injecting real credentials, and forwarding over
 * a new TLS connection to the real server.
 *
 * For hosts without credential rules, CONNECT requests pass through as raw
 * TCP tunnels (unchanged from pre-MITM behavior).
 *
 * Architecture:
 *   Agent → CONNECT → Proxy (MITM if credential rule, passthrough otherwise) → Target
 *   Agent → HTTP request → Proxy (inject credential) → Target (HTTPS)
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { request as httpsRequest } from 'node:https';
import {
  findCredentialForHost,
  findAllCredentialsForHost,
  filterByCredentialMethod,
  type CredentialRule,
} from './credential-schema.js';
import { type RateLimiter } from './rate-limiter.js';
import { type AuditLog } from './audit-log.js';
import { MitmHandler } from './mitm-handler.js';
import type { CACertificate } from './ca-manager.js';
import { type KeyRotator } from './key-rotator.js';
import { type ProxyMetrics } from './metrics.js';
import { type CostLog } from './cost-log.js';

export interface ProxyServerOptions {
  /** Credential rules (loaded from encrypted file at startup). */
  credentials: CredentialRule[];
  /** Rate limiter instance with rules pre-registered. */
  rateLimiter: RateLimiter;
  /** Audit log instance. */
  auditLog: AuditLog;
  /** Port to listen on (default: 10255). */
  port?: number;
  /** Hostname to bind to (default: 0.0.0.0 — accessible within Podman network). */
  host?: string;
  /** CA certificate for MITM TLS interception. If not provided, CONNECT uses passthrough. */
  ca?: CACertificate;
  /** Key rotator for multi-key round-robin. */
  keyRotator?: KeyRotator;
  /** Metrics collector. */
  metrics?: ProxyMetrics;
  /** Cost logger for Anthropic API responses. */
  costLog?: CostLog;
  /** Hostnames that skip MITM even when a credential rule matches. */
  pinningBypass?: string[];
  /**
   * Active billing/credential method. When set, the proxy only injects
   * credentials tagged with this method (or untagged credentials).
   * 'oauth' → only inject OAuth tokens; 'api_key' → only inject API keys.
   */
  activeCredentialMethod?: 'oauth' | 'api_key';
}

/**
 * HTTP forward proxy that intercepts requests, injects credentials,
 * and forwards to the real HTTPS endpoint.
 *
 * Agent containers set HTTP_PROXY to point here. The proxy receives
 * plaintext HTTP requests on the trusted Podman network, swaps
 * placeholder credentials for real ones, and forwards over HTTPS.
 */
export class ProxyServer {
  private readonly server: Server;
  private credentials: CredentialRule[];
  private rateLimiter: RateLimiter;
  private readonly auditLog: AuditLog;
  private readonly port: number;
  private readonly host: string;
  private mitmHandler: MitmHandler | undefined;
  private keyRotator: KeyRotator | undefined;
  private metrics: ProxyMetrics | undefined;
  private costLog: CostLog | undefined;
  private pinningBypassSet: Set<string>;
  private readonly activeCredentialMethod: 'oauth' | 'api_key' | undefined;

  constructor(options: ProxyServerOptions) {
    this.credentials = options.credentials;
    this.rateLimiter = options.rateLimiter;
    this.auditLog = options.auditLog;
    this.port = options.port ?? 10255;
    this.host = options.host ?? '0.0.0.0';
    this.keyRotator = options.keyRotator;
    this.metrics = options.metrics;
    this.costLog = options.costLog;
    this.pinningBypassSet = new Set(options.pinningBypass ?? []);
    this.activeCredentialMethod = options.activeCredentialMethod;

    // Initialize MITM handler if CA is available
    if (options.ca) {
      this.mitmHandler = new MitmHandler({
        ca: options.ca,
        rateLimiter: this.rateLimiter,
        auditLog: this.auditLog,
        keyRotator: this.keyRotator,
        metrics: this.metrics,
        costLog: this.costLog,
      });
    }

    this.server = createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    // Handle CONNECT for true HTTPS tunneling (passthrough without injection)
    this.server.on('connect', (req: IncomingMessage, clientSocket: Duplex) => {
      void this.handleConnect(req, clientSocket as Socket);
    });
  }

  /**
   * Reload credentials, rate limiter, and related state without restarting.
   * Called from main.ts SIGHUP handler after re-reading credentials.enc.
   */
  reloadCredentials(
    credentials: CredentialRule[],
    rateLimiter: RateLimiter,
    options?: {
      keyRotator?: KeyRotator;
      metrics?: ProxyMetrics;
      costLog?: CostLog;
      pinningBypass?: string[];
    },
  ): void {
    this.credentials = credentials;
    this.rateLimiter = rateLimiter;
    if (options?.keyRotator !== undefined) this.keyRotator = options.keyRotator;
    if (options?.metrics !== undefined) this.metrics = options.metrics;
    if (options?.costLog !== undefined) this.costLog = options.costLog;
    if (options?.pinningBypass !== undefined) {
      this.pinningBypassSet = new Set(options.pinningBypass);
    }

    // Update MITM handler's references
    if (this.mitmHandler) {
      this.mitmHandler.reloadDependencies({
        rateLimiter,
        keyRotator: this.keyRotator,
        metrics: this.metrics,
        costLog: this.costLog,
      });
    }
  }

  /**
   * Start listening for proxy requests.
   */
  async listen(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
  }

  /**
   * Stop the proxy server gracefully.
   */
  async close(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Handle a standard HTTP request (forward proxy mode).
   *
   * The agent sends:
   *   GET http://api.anthropic.com/v1/messages HTTP/1.1
   *   x-api-key: placeholder
   *
   * The proxy:
   *   1. Extracts hostname from the absolute URL
   *   2. Finds matching credential rule
   *   3. Checks rate limit
   *   4. Swaps placeholder header for real credential
   *   5. Forwards as HTTPS to the real endpoint
   */
  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startTime = Date.now();
    const url = req.url ?? '/';

    // Health check endpoint (used by proxy manager)
    if (url === '/healthz' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    // Metrics endpoint
    if (url === '/metrics' && req.method === 'GET') {
      const snapshot = this.metrics?.snapshot() ?? {
        uptime: 0,
        totalRequests: 0,
        perCredential: {},
        statusCodes: {},
        rateLimitHits: 0,
        latency: { p50: 0, p90: 0, p99: 0, count: 0 },
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(snapshot));
      return;
    }

    // Parse the target from the absolute URL (e.g., http://api.anthropic.com/v1/messages)
    let targetUrl: URL;
    try {
      targetUrl = new URL(url);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad Request: invalid URL');
      await this.auditLog.logRequest(req.method ?? 'UNKNOWN', url, 400, startTime, 'none');
      return;
    }

    const hostname = targetUrl.hostname;
    const path = targetUrl.pathname + targetUrl.search;

    // Find matching credential
    const credential = findCredentialForHost(hostname, this.credentials);
    const credentialName = credential?.name ?? 'none';

    // Check rate limit
    if (credential?.rateLimit) {
      const result = this.rateLimiter.consume(credential.name);
      if (!result.allowed) {
        this.metrics?.recordRateLimitHit();
        res.writeHead(429, {
          'Content-Type': 'text/plain',
          'Retry-After': String(Math.ceil(result.retryAfterMs / 1000)),
        });
        res.end(
          `Rate limited: ${credential.name}. Retry after ${String(Math.ceil(result.retryAfterMs / 1000))}s`,
        );
        await this.auditLog.logRequest(
          req.method ?? 'UNKNOWN',
          hostname,
          429,
          startTime,
          credentialName,
        );
        return;
      }
    }

    // Enforce request-level rules (methods, path prefixes, body size)
    if (credential?.rules) {
      const method = req.method ?? 'GET';
      if (credential.rules.methods && credential.rules.methods.length > 0) {
        if (!credential.rules.methods.includes(method)) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end(`Forbidden: method ${method} not allowed for ${credentialName}`);
          await this.auditLog.logRequest(method, hostname, 403, startTime, credentialName);
          return;
        }
      }
      if (credential.rules.pathPrefixes && credential.rules.pathPrefixes.length > 0) {
        const reqPath = targetUrl.pathname;
        if (!credential.rules.pathPrefixes.some((prefix) => reqPath.startsWith(prefix))) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end(`Forbidden: path ${reqPath} not allowed for ${credentialName}`);
          await this.auditLog.logRequest(method, hostname, 403, startTime, credentialName);
          return;
        }
      }
      if (credential.rules.maxBodySize !== undefined) {
        const contentLength = Number(req.headers['content-length'] ?? 0);
        if (contentLength > credential.rules.maxBodySize) {
          res.writeHead(413, { 'Content-Type': 'text/plain' });
          res.end(
            `Payload too large: ${String(contentLength)} exceeds ${String(credential.rules.maxBodySize)} bytes`,
          );
          await this.auditLog.logRequest(method, hostname, 413, startTime, credentialName);
          return;
        }
      }
    }

    // Build outbound headers — copy from agent request, inject real credential
    const outboundHeaders: Record<string, string | string[] | undefined> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      // Skip proxy-specific and hop-by-hop headers
      if (['host', 'proxy-authorization', 'proxy-connection'].includes(key.toLowerCase())) {
        continue;
      }
      outboundHeaders[key] = value;
    }

    // Inject real credential (with key rotation if multiple values available)
    if (credential) {
      const credValue = this.keyRotator
        ? this.keyRotator.getNextValue(credential)
        : credential.value;
      outboundHeaders[credential.header.toLowerCase()] = credValue;

      // Strip competing auth headers to prevent conflicts
      if (credential.header.toLowerCase() === 'authorization') {
        delete outboundHeaders['x-api-key'];
      } else if (credential.header.toLowerCase() === 'x-api-key') {
        delete outboundHeaders['authorization'];
      }
    }

    // Forward as HTTPS to the real endpoint
    try {
      const proxyReq = httpsRequest(
        {
          hostname,
          port: 443,
          path,
          method: req.method,
          headers: outboundHeaders,
        },
        (proxyRes) => {
          const statusCode = proxyRes.statusCode ?? 502;
          res.writeHead(statusCode, proxyRes.headers);
          proxyRes.pipe(res);

          // Warn on 401 — possible credential expiry
          if (statusCode === 401 && credential) {
            console.warn(
              `[proxy] 401 from ${hostname} using credential "${credential.name}" — credential may be expired`,
            );
          }

          proxyRes.on('end', () => {
            const durationMs = Date.now() - startTime;
            this.metrics?.record(credentialName, statusCode, durationMs);
            void this.auditLog.logRequest(
              req.method ?? 'UNKNOWN',
              hostname,
              statusCode,
              startTime,
              credentialName,
            );
          });
        },
      );

      proxyReq.on('error', (err) => {
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain' });
          res.end(`Bad Gateway: ${err.message}`);
        }
        void this.auditLog.logRequest(
          req.method ?? 'UNKNOWN',
          hostname,
          502,
          startTime,
          credentialName,
        );
      });

      req.pipe(proxyReq);
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal proxy error');
      }
      void this.auditLog.logRequest(
        req.method ?? 'UNKNOWN',
        hostname,
        500,
        startTime,
        credentialName,
      );
    }
  }

  /**
   * Handle CONNECT requests (HTTPS tunneling).
   *
   * If a credential rule matches AND the MITM handler is available:
   *   → MITM path: terminate TLS, inject credentials, forward to real server.
   *
   * Otherwise:
   *   → Passthrough: raw TCP tunnel (no credential injection possible).
   */
  private async handleConnect(req: IncomingMessage, clientSocket: Socket): Promise<void> {
    const startTime = Date.now();
    const target = req.url ?? '';
    const [hostname, portStr] = target.split(':');
    const port = Number(portStr) || 443;

    if (!hostname) {
      clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      clientSocket.end();
      return;
    }

    // Find ALL matching credentials for this host, then filter by the active billing method.
    // This ensures that when credentialMethod is 'oauth', API key credentials are never injected
    // (and vice versa), even if the CLI sends headers for both auth methods.
    const allCredentials = filterByCredentialMethod(
      findAllCredentialsForHost(hostname, this.credentials),
      this.activeCredentialMethod,
    );

    // MITM path: at least one credential rule AND CA loaded AND host not in pinning bypass
    if (allCredentials.length > 0 && this.mitmHandler && !this.pinningBypassSet.has(hostname)) {
      await this.mitmHandler.handleConnect(clientSocket, hostname, port, allCredentials);
      return;
    }

    // For non-MITM paths, use the first matching credential (rate limiting, passthrough audit)
    const credential = allCredentials[0];

    // Passthrough path: raw TCP tunnel (no credential injection)
    if (credential?.rateLimit) {
      const result = this.rateLimiter.consume(credential.name);
      if (!result.allowed) {
        clientSocket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
        clientSocket.end();
        await this.auditLog.logRequest('CONNECT', target, 429, startTime, credential.name);
        return;
      }
    }

    const { connect } = await import('node:net');
    const serverSocket = connect(port, hostname, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });

    serverSocket.on('error', (_err) => {
      clientSocket.write(`HTTP/1.1 502 Bad Gateway\r\n\r\n`);
      clientSocket.end();
      void this.auditLog.logRequest('CONNECT', target, 502, startTime, credential?.name ?? 'none');
    });

    clientSocket.on('error', () => {
      serverSocket.destroy();
    });

    serverSocket.on('end', () => {
      void this.auditLog.logRequest('CONNECT', target, 200, startTime, credential?.name ?? 'none');
    });
  }

  /** Get the bound address (useful for tests). */
  get address(): { port: number; host: string } {
    const addr = this.server.address();
    if (addr && typeof addr === 'object') {
      return { port: addr.port, host: addr.address };
    }
    return { port: this.port, host: this.host };
  }

  /** Whether MITM TLS interception is enabled. */
  get mitmEnabled(): boolean {
    return this.mitmHandler !== undefined;
  }
}
