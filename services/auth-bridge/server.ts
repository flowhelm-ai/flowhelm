/**
 * Auth Bridge HTTP server.
 *
 * Lightweight relay for Tailscale-like headless VM authentication.
 * Zero external dependencies — uses only node:http and node:fs.
 *
 * Endpoints:
 *   POST   /api/session              — create session (VM)
 *   GET    /api/session/:token/poll   — poll for credentials (VM)
 *   POST   /api/session/:token        — submit encrypted credentials (browser)
 *   DELETE /api/session/:token         — cleanup (VM)
 *   GET    /qr/:token                 — QR code for terminal display
 *   GET    /:token                    — redirect to auth page
 *   GET    /a/:token                  — serve auth page
 *   GET    /health                    — health check
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SessionStore, type StoreOptions } from './store.js';
import { generateUniqueToken } from './token.js';
import {
  RateLimiter,
  RATE_LIMITS,
  GLOBAL_SESSION_LIMIT,
} from './rate-limit.js';
import { generateQR } from './qr.js';

export interface BridgeServerOptions {
  /** Port to listen on. Default: 3456. */
  port?: number;
  /** Hostname to bind. Default: '0.0.0.0'. */
  host?: string;
  /** Public base URL for redirects and QR codes. Default: 'https://flowhelm.to'. */
  baseUrl?: string;
  /** Session store options. */
  store?: StoreOptions;
  /** CORS origin for credential submission. Default: matches baseUrl. */
  corsOrigin?: string;
}

const DEFAULT_PORT = 3456;
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_BASE_URL = 'https://flowhelm.to';

// Load static HTML at module load time.
// Try multiple paths: same dir (container), ../static (compiled from dist/), ./static (source).
let authPageHtml: string = '';
{
  const base = import.meta.dirname ?? new URL('.', import.meta.url).pathname;
  const candidates = [
    join(base, 'static', 'index.html'),       // container layout: /app/static/
    join(base, '..', 'static', 'index.html'),  // compiled: dist/ → ../static/
  ];
  for (const candidate of candidates) {
    try {
      authPageHtml = readFileSync(candidate, 'utf-8');
      break;
    } catch {
      // try next
    }
  }
}

/** Extract client IP from request, respecting X-Forwarded-For (behind Caddy/Cloudflare). */
function getClientIP(req: IncomingMessage): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string') {
    return xff.split(',')[0].trim();
  }
  return req.socket.remoteAddress ?? '0.0.0.0';
}

/** Parse JSON body from request. Returns null on failure. */
async function parseBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const maxSize = 65_536; // 64 KB

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxSize) {
        resolve(null);
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });

    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf-8');
        resolve(JSON.parse(body));
      } catch {
        resolve(null);
      }
    });

    req.on('error', () => resolve(null));
  });
}

/** Send JSON response. */
function json(
  res: ServerResponse,
  status: number,
  data: Record<string, unknown>,
): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** Send rate-limit error. */
function rateLimited(res: ServerResponse, retryAfterMs: number): void {
  res.writeHead(429, {
    'Content-Type': 'application/json',
    'Retry-After': String(Math.ceil(retryAfterMs / 1000)),
  });
  res.end(JSON.stringify({ error: 'Too many requests' }));
}

/** Parse URL path segments. Returns [path, token?]. */
function parsePath(url: string): { path: string; segments: string[] } {
  const [path] = url.split('?');
  const segments = path.split('/').filter(Boolean);
  return { path, segments };
}

export function createBridgeServer(options: BridgeServerOptions = {}) {
  const port = options.port ?? DEFAULT_PORT;
  const host = options.host ?? DEFAULT_HOST;
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const corsOrigin = options.corsOrigin ?? new URL(baseUrl).origin;

  const store = new SessionStore(options.store);
  const limiter = new RateLimiter();

  if (!authPageHtml) {
    authPageHtml = '<!DOCTYPE html><html><body><p>Auth page not found. Check static/ directory.</p></body></html>';
  }

  /** Add CORS headers for browser requests. */
  function setCorsHeaders(res: ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
  }

  async function handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const method = req.method ?? 'GET';
    const { path, segments } = parsePath(req.url ?? '/');
    const ip = getClientIP(req);

    // CORS preflight
    if (method === 'OPTIONS') {
      setCorsHeaders(res);
      res.writeHead(204);
      res.end();
      return;
    }

    setCorsHeaders(res);

    // ─── Health Check ───
    if (path === '/health' && method === 'GET') {
      json(res, 200, { status: 'ok', sessions: store.size });
      return;
    }

    // ─── POST /api/session — Create session ───
    if (
      segments[0] === 'api' &&
      segments[1] === 'session' &&
      segments.length === 2 &&
      method === 'POST'
    ) {
      if (!limiter.check(`create:${ip}`, RATE_LIMITS.sessionCreate)) {
        rateLimited(res, limiter.retryAfterMs(`create:${ip}`, RATE_LIMITS.sessionCreate));
        return;
      }
      if (!limiter.checkGlobal(GLOBAL_SESSION_LIMIT)) {
        rateLimited(res, 60_000);
        return;
      }

      const body = await parseBody(req);
      if (!body || typeof body.publicKey !== 'string' || !body.publicKey) {
        json(res, 400, { error: 'Missing or invalid publicKey' });
        return;
      }

      const token = generateUniqueToken((t) => store.has(t));
      const created = store.create(token, body.publicKey as string);
      if (!created) {
        json(res, 503, { error: 'Server at capacity' });
        return;
      }

      const session = store.get(token)!;
      json(res, 201, {
        token,
        expiresAt: session.expiresAt,
      });
      return;
    }

    // ─── GET /api/session/:token/poll — Poll for credentials ───
    if (
      segments[0] === 'api' &&
      segments[1] === 'session' &&
      segments.length === 4 &&
      segments[3] === 'poll' &&
      method === 'GET'
    ) {
      if (!limiter.check(`poll:${ip}`, RATE_LIMITS.poll)) {
        rateLimited(res, limiter.retryAfterMs(`poll:${ip}`, RATE_LIMITS.poll));
        return;
      }

      const token = segments[2];
      const session = store.get(token);
      if (!session) {
        json(res, 404, { error: 'Session not found or expired' });
        return;
      }

      if (session.encrypted) {
        json(res, 200, {
          status: 'ready',
          encrypted: session.encrypted,
          ephemeralPublicKey: session.ephemeralPublicKey,
          nonce: session.nonce,
        });
      } else {
        json(res, 200, { status: 'pending' });
      }
      return;
    }

    // ─── POST /api/session/:token — Submit encrypted credentials ───
    if (
      segments[0] === 'api' &&
      segments[1] === 'session' &&
      segments.length === 3 &&
      method === 'POST'
    ) {
      if (!limiter.check(`submit:${ip}`, RATE_LIMITS.submit)) {
        rateLimited(res, limiter.retryAfterMs(`submit:${ip}`, RATE_LIMITS.submit));
        return;
      }

      const token = segments[2];
      const body = await parseBody(req);
      if (
        !body ||
        typeof body.encrypted !== 'string' ||
        typeof body.ephemeralPublicKey !== 'string' ||
        typeof body.nonce !== 'string'
      ) {
        json(res, 400, {
          error: 'Missing encrypted, ephemeralPublicKey, or nonce',
        });
        return;
      }

      const ok = store.submitCredentials(
        token,
        body.encrypted as string,
        body.ephemeralPublicKey as string,
        body.nonce as string,
      );

      if (!ok) {
        json(res, 404, { error: 'Session not found, expired, or already submitted' });
        return;
      }

      json(res, 200, { status: 'ok' });
      return;
    }

    // ─── DELETE /api/session/:token — Cleanup ───
    if (
      segments[0] === 'api' &&
      segments[1] === 'session' &&
      segments.length === 3 &&
      method === 'DELETE'
    ) {
      const token = segments[2];
      store.delete(token);
      json(res, 200, { status: 'deleted' });
      return;
    }

    // ─── GET /qr/:token — QR code for terminal ───
    if (segments[0] === 'qr' && segments.length === 2 && method === 'GET') {
      if (!limiter.check(`qr:${ip}`, RATE_LIMITS.qr)) {
        rateLimited(res, limiter.retryAfterMs(`qr:${ip}`, RATE_LIMITS.qr));
        return;
      }

      const token = segments[1];
      const session = store.get(token);
      if (!session) {
        json(res, 404, { error: 'Session not found or expired' });
        return;
      }

      const url = `${baseUrl}/${token}`;
      const qrText = generateQR(url);
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(qrText);
      return;
    }

    // ─── GET /a/:token — Serve auth page ───
    if (segments[0] === 'a' && segments.length === 2 && method === 'GET') {
      const token = segments[1];
      const session = store.get(token);
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Session not found or expired.');
        return;
      }

      // Inject token and base URL into the page
      const html = authPageHtml
        .replace('{{TOKEN}}', token)
        .replace('{{BASE_URL}}', baseUrl);

      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(html);
      return;
    }

    // ─── GET /:token — Short URL redirect ───
    if (segments.length === 1 && method === 'GET') {
      const token = segments[0];
      // Ignore common paths that are not tokens
      if (['favicon.ico', 'robots.txt'].includes(token)) {
        res.writeHead(404);
        res.end();
        return;
      }

      const session = store.get(token);
      if (!session) {
        json(res, 404, { error: 'Session not found or expired' });
        return;
      }

      // Redirect to auth page with public key in URL hash (never sent to server)
      const redirectUrl = `${baseUrl}/a/${token}#pk=${encodeURIComponent(session.publicKey)}`;
      res.writeHead(302, { Location: redirectUrl });
      res.end();
      return;
    }

    // ─── 404 ───
    json(res, 404, { error: 'Not found' });
  }

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error('Request handler error:', err);
      if (!res.headersSent) {
        json(res, 500, { error: 'Internal server error' });
      }
    });
  });

  function start(): Promise<void> {
    return new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(port, host, () => {
        console.log(`Auth bridge listening on ${host}:${port}`);
        resolve();
      });
    });
  }

  function stop(): Promise<void> {
    return new Promise((resolve) => {
      store.destroy();
      limiter.destroy();
      server.close(() => resolve());
    });
  }

  return { server, store, limiter, start, stop, handleRequest };
}

// ─── CLI Entry Point ────────────────────────────────────────────────────────

if (
  process.argv[1] &&
  (process.argv[1].endsWith('server.ts') || process.argv[1].endsWith('server.js'))
) {
  const port = parseInt(process.env.PORT ?? '3456', 10);
  const baseUrl = process.env.BASE_URL ?? DEFAULT_BASE_URL;

  const bridge = createBridgeServer({ port, baseUrl });
  bridge.start().catch((err) => {
    console.error('Failed to start auth bridge:', err);
    process.exit(1);
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      console.log(`\nReceived ${signal}, shutting down...`);
      bridge.stop().then(() => process.exit(0));
    });
  }
}
