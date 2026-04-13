/**
 * MITM TLS interception handler.
 *
 * When the proxy receives a CONNECT request for a host with a matching
 * credential rule, the MITM handler:
 *
 *   1. Responds "200 Connection Established" to the client
 *   2. Terminates the client's TLS using a per-domain cert signed by the FlowHelm CA
 *   3. Serves HTTP/1.1 on the decrypted TLS socket via a virtual HTTP server
 *   4. For each request: injects the real credential header, forwards to upstream
 *   5. Streams the response back through the MITM TLS socket
 *
 * The virtual HTTP server approach (createServer + emit('connection')) delegates
 * all HTTP framing to Node's built-in parser — keep-alive, chunked encoding,
 * Content-Length, and backpressure are handled natively. This is the standard
 * pattern for running an HTTP server on an existing socket without binding to a
 * port, and is fundamentally more reliable than manual HTTP parsing.
 *
 * ALPN is forced to http/1.1 — Claude Code CLI uses HTTP/1.1 for API calls.
 * Hosts without credential rules are never MITM'd (passthrough).
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { TLSSocket, type SecureContext, createSecureContext } from 'node:tls';
import { request as httpsRequest } from 'node:https';
import type { Socket } from 'node:net';
import { selectCredentialByHeaders, type CredentialRule } from './credential-schema.js';
import type { CACertificate } from './ca-manager.js';
import { generateHostCert, type HostCertificate } from './ca-manager.js';
import { CertCache } from './cert-cache.js';
import type { RateLimiter } from './rate-limiter.js';
import type { AuditLog } from './audit-log.js';
import type { KeyRotator } from './key-rotator.js';
import type { ProxyMetrics } from './metrics.js';
import { CostLog, type CostLog as CostLogType } from './cost-log.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MitmHandlerOptions {
  /** Loaded CA certificate and key. */
  ca: CACertificate;
  /** Rate limiter instance. */
  rateLimiter: RateLimiter;
  /** Audit log instance. */
  auditLog: AuditLog;
  /** Key rotator for multi-key credentials. */
  keyRotator?: KeyRotator;
  /** Metrics collector. */
  metrics?: ProxyMetrics;
  /** Cost logger for API usage tracking. */
  costLog?: CostLogType;
}

interface CachedSecureContext {
  ctx: SecureContext;
  hostCert: HostCertificate;
}

/**
 * Headers that must not be forwarded between hops.
 *
 * - host: let https.request() set it from the target hostname
 * - transfer-encoding: Node's HTTP parser already decodes chunked bodies;
 *   forwarding this header would cause a framing mismatch upstream
 * - connection, keep-alive, te, trailer, upgrade: RFC 7230 hop-by-hop headers
 * - proxy-*: proxy-specific headers that don't belong on the upstream request
 */
const HOP_BY_HOP_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

// ─── MITM Handler ───────────────────────────────────────────────────────────

export class MitmHandler {
  private readonly ca: CACertificate;
  private readonly certCache: CertCache<CachedSecureContext>;
  private rateLimiter: RateLimiter;
  private readonly auditLog: AuditLog;
  private keyRotator: KeyRotator | undefined;
  private metrics: ProxyMetrics | undefined;
  private costLog: CostLogType | undefined;

  /** Max response body size to buffer for cost parsing (1 MB). */
  private static readonly MAX_COST_BODY = 1024 * 1024;

  constructor(options: MitmHandlerOptions) {
    this.ca = options.ca;
    this.certCache = new CertCache<CachedSecureContext>();
    this.rateLimiter = options.rateLimiter;
    this.auditLog = options.auditLog;
    this.keyRotator = options.keyRotator;
    this.metrics = options.metrics;
    this.costLog = options.costLog;
  }

  /**
   * Update mutable dependencies after credential reload.
   */
  reloadDependencies(deps: {
    rateLimiter: RateLimiter;
    keyRotator?: KeyRotator;
    metrics?: ProxyMetrics;
    costLog?: CostLogType;
  }): void {
    this.rateLimiter = deps.rateLimiter;
    if (deps.keyRotator !== undefined) this.keyRotator = deps.keyRotator;
    if (deps.metrics !== undefined) this.metrics = deps.metrics;
    if (deps.costLog !== undefined) this.costLog = deps.costLog;
  }

  /**
   * Handle a CONNECT request by performing MITM TLS interception.
   *
   * The clientSocket is the raw TCP socket from the HTTP CONNECT request.
   * Accepts ALL matching credentials for this hostname — the actual credential
   * is selected per-request based on the agent's HTTP headers (e.g., whether it
   * sends Authorization or x-api-key). This supports multi-credential hosts
   * like api.anthropic.com with both OAuth and API key rules.
   */
  async handleConnect(
    clientSocket: Socket,
    hostname: string,
    port: number,
    credentials: CredentialRule[],
  ): Promise<void> {
    const startTime = Date.now();

    // Rate limit check against the first credential (rate limits are per-host)
    const primaryCredential = credentials[0];
    if (!primaryCredential) return;
    if (primaryCredential.rateLimit) {
      const result = this.rateLimiter.consume(primaryCredential.name);
      if (!result.allowed) {
        this.metrics?.recordRateLimitHit();
        clientSocket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
        clientSocket.end();
        await this.auditLog.logRequest(
          'CONNECT-MITM',
          hostname,
          429,
          startTime,
          primaryCredential.name,
        );
        return;
      }
    }

    // Step 1: Respond 200 to establish the tunnel
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

    // Step 2: Get or generate the per-domain TLS context
    const cached = await this.certCache.getOrCreate(hostname, () =>
      this.generateSecureContext(hostname),
    );

    // Step 3: Wrap the client socket in TLS (MITM termination)
    const tlsSocket = new TLSSocket(clientSocket, {
      isServer: true,
      secureContext: cached.ctx,
      ALPNProtocols: ['http/1.1'],
    });

    tlsSocket.on('error', (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[mitm] TLS error for ${hostname}: ${msg}`);
      tlsSocket.destroy();
    });

    // Step 4: Serve HTTP/1.1 on the decrypted TLS socket.
    //
    // Instead of manually parsing HTTP (fragile with keep-alive, chunked
    // encoding, and body boundaries), we create a virtual HTTP server and
    // feed the TLS socket to it as a connection. Node's HTTP parser handles
    // all protocol framing natively — each request arrives as a standard
    // (IncomingMessage, ServerResponse) pair, with keep-alive managed by
    // the server's connection lifecycle.
    const virtualServer = createServer((req, res) => {
      void this.handleMitmRequest(req, res, hostname, port, credentials);
    });

    // Disable timeouts — API calls can take minutes, and the agent controls
    // connection lifetime. The socket will close when the client disconnects.
    virtualServer.keepAliveTimeout = 0;
    virtualServer.headersTimeout = 0;
    virtualServer.requestTimeout = 0;

    // Feed the TLS socket as if it were a new inbound connection.
    // The HTTP server sets up its parser and listeners on this socket,
    // then processes requests as decrypted data arrives after the TLS handshake.
    virtualServer.emit('connection', tlsSocket);
  }

  /**
   * Handle a single HTTP request over the MITM'd TLS connection.
   *
   * This is called by the virtual HTTP server for each request. The server
   * handles keep-alive automatically — if the client sends multiple requests
   * on the same connection, this method is called for each one.
   */
  private async handleMitmRequest(
    req: IncomingMessage,
    res: ServerResponse,
    hostname: string,
    port: number,
    credentials: CredentialRule[],
  ): Promise<void> {
    const startTime = Date.now();
    const method = req.method ?? 'GET';
    const reqPath = req.url ?? '/';

    // Select credential based on the agent's actual request headers.
    // When multiple credentials match a host (e.g., OAuth + API key for
    // api.anthropic.com), we pick the one whose header name appears in
    // the request — the agent chose that auth method via the placeholder.
    const credential = selectCredentialByHeaders(credentials, req.headers);
    if (!credential) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Bad Gateway: no matching credential');
      return;
    }

    // Enforce request-level rules (allowed methods, path prefixes, body size)
    if (credential.rules) {
      const contentLength = Number(req.headers['content-length'] ?? 0);
      const violationStatus = this.enforceRules(credential, method, reqPath, contentLength);
      if (violationStatus !== undefined) {
        res.writeHead(violationStatus);
        res.end();
        void this.auditLog.logRequest(
          `${method}-MITM`,
          hostname,
          violationStatus,
          startTime,
          credential.name,
        );
        return;
      }
    }

    // Build outbound headers: copy originals, strip hop-by-hop, inject credential
    const outboundHeaders: Record<string, string | string[] | undefined> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (HOP_BY_HOP_HEADERS.has(key)) continue;
      outboundHeaders[key] = value;
    }

    // Inject real credential (with key rotation if multiple values available)
    const credValue = this.keyRotator ? this.keyRotator.getNextValue(credential) : credential.value;
    outboundHeaders[credential.header.toLowerCase()] = credValue;

    // Strip competing auth headers to prevent ambiguity at the upstream API
    if (credential.header.toLowerCase() === 'authorization') {
      delete outboundHeaders['x-api-key'];
    } else if (credential.header.toLowerCase() === 'x-api-key') {
      delete outboundHeaders['authorization'];
    }

    // Determine whether to buffer response for cost tracking
    const shouldTrackCost = this.costLog && credential.hostPattern.includes('anthropic');

    // When cost tracking is active, strip Accept-Encoding so the API returns
    // uncompressed text that we can parse for token usage. This avoids needing
    // to decompress gzip/br in the proxy, and the compression overhead between
    // containers on the same machine is wasted anyway.
    if (shouldTrackCost) {
      delete outboundHeaders['accept-encoding'];
    }

    // Forward to upstream over TLS
    const proxyReq = httpsRequest(
      { hostname, port, path: reqPath, method, headers: outboundHeaders },
      (proxyRes) => {
        const statusCode = proxyRes.statusCode ?? 502;

        if (statusCode === 401) {
          console.warn(
            `[mitm] 401 from ${hostname} using credential "${credential.name}" — credential may be expired`,
          );
        }

        // Write upstream status and headers back to the agent
        res.writeHead(statusCode, proxyRes.headers);

        if (shouldTrackCost && statusCode >= 200 && statusCode < 300) {
          // Buffer response body for cost extraction while streaming to client
          const chunks: Buffer[] = [];
          let totalSize = 0;

          proxyRes.on('data', (chunk: Buffer) => {
            res.write(chunk);
            if (totalSize < MitmHandler.MAX_COST_BODY) {
              chunks.push(chunk);
              totalSize += chunk.length;
            }
          });

          proxyRes.on('end', () => {
            res.end();
            const body = Buffer.concat(chunks).toString('utf-8');
            const costEntry = CostLog.parseAnthropicUsage(body, credential.name);
            if (costEntry && this.costLog) {
              void this.costLog.log(costEntry);
            }
            const durationMs = Date.now() - startTime;
            this.metrics?.record(credential.name, statusCode, durationMs);
            void this.auditLog.logRequest(
              `${method}-MITM`,
              hostname,
              statusCode,
              startTime,
              credential.name,
            );
          });
        } else {
          // Stream response directly — pipe handles backpressure and ends res
          proxyRes.pipe(res);

          proxyRes.on('end', () => {
            const durationMs = Date.now() - startTime;
            this.metrics?.record(credential.name, statusCode, durationMs);
            void this.auditLog.logRequest(
              `${method}-MITM`,
              hostname,
              statusCode,
              startTime,
              credential.name,
            );
          });
        }

        proxyRes.on('error', (err) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[mitm] Upstream response error for ${hostname}: ${msg}`);
          if (!res.writableEnded) res.end();
        });
      },
    );

    proxyReq.on('error', (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[mitm] Upstream request error for ${hostname}: ${msg}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end(`Bad Gateway: ${msg}`);
      }
      this.metrics?.record(credential.name, 502, Date.now() - startTime);
      void this.auditLog.logRequest(`${method}-MITM`, hostname, 502, startTime, credential.name);
    });

    // Stream the agent's request body to upstream.
    // Node's HTTP server already parsed Content-Length and chunked TE —
    // req is a standard Readable that yields the decoded body bytes.
    req.pipe(proxyReq);
  }

  /**
   * Check request-level rules. Returns an HTTP status code if the request
   * violates a rule, or undefined if the request is allowed.
   */
  private enforceRules(
    credential: CredentialRule,
    method: string,
    path: string,
    contentLength: number,
  ): number | undefined {
    const rules = credential.rules;
    if (!rules) return undefined;

    if (rules.methods && rules.methods.length > 0 && !rules.methods.includes(method)) {
      return 403;
    }

    if (rules.pathPrefixes && rules.pathPrefixes.length > 0) {
      if (!rules.pathPrefixes.some((prefix) => path.startsWith(prefix))) {
        return 403;
      }
    }

    if (rules.maxBodySize !== undefined && contentLength > rules.maxBodySize) {
      return 413;
    }

    return undefined;
  }

  /**
   * Generate a SecureContext for a hostname (leaf cert signed by the CA).
   */
  private generateSecureContext(hostname: string): CachedSecureContext {
    const hostCert = generateHostCert(hostname, this.ca);
    const ctx = createSecureContext({
      key: hostCert.keyPem,
      // Include CA cert in chain so the agent's TLS stack can verify the
      // leaf cert without needing the CA pre-installed in the system trust store.
      cert: hostCert.certPem + this.ca.certPem,
    });
    return { ctx, hostCert };
  }

  /** Number of cached certificates. */
  get cacheSize(): number {
    return this.certCache.size;
  }
}
