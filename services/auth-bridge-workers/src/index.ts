/**
 * FlowHelm Auth Bridge — Cloudflare Workers entry point.
 *
 * Identical API surface to the Node.js version, running on Cloudflare's
 * global edge network. Sessions stored in Workers KV with automatic TTL.
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

import { KVSessionStore } from './store';
import { KVRateLimiter, RATE_LIMITS, GLOBAL_SESSION_LIMIT } from './rate-limit';
import { generateUniqueToken } from './token';
import { generateQR } from './qr';
import { AUTH_PAGE_HTML } from './page';

export interface Env {
  SESSIONS: KVNamespace;
  BASE_URL: string;
}

/** JSON response helper. */
function json(data: Record<string, unknown>, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** Rate-limited response. */
function rateLimited(retryAfterMs: number): Response {
  return json(
    { error: 'Too many requests' },
    429,
    { 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) },
  );
}

/** Extract client IP from request. */
function getClientIP(request: Request): string {
  return request.headers.get('cf-connecting-ip')
    ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? '0.0.0.0';
}

/** Parse URL path segments. */
function parsePath(url: URL): string[] {
  return url.pathname.split('/').filter(Boolean);
}

/** Add CORS headers to a response. */
function withCors(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Safe JSON body parser with size limit. */
async function parseBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await request.text();
    if (text.length > 65_536) return null; // 64 KB limit
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method;
  const segments = parsePath(url);
  const ip = getClientIP(request);

  const baseUrl = (env.BASE_URL || 'https://flowhelm.to').replace(/\/$/, '');
  const corsOrigin = new URL(baseUrl).origin;

  const store = new KVSessionStore(env.SESSIONS);
  const limiter = new KVRateLimiter(env.SESSIONS);

  // CORS preflight
  if (method === 'OPTIONS') {
    return withCors(new Response(null, { status: 204 }), corsOrigin);
  }

  let response: Response;

  // ─── Health Check ───
  if (url.pathname === '/health' && method === 'GET') {
    response = json({ status: 'ok' });
    return withCors(response, corsOrigin);
  }

  // ─── POST /api/session — Create session ───
  if (
    segments[0] === 'api' &&
    segments[1] === 'session' &&
    segments.length === 2 &&
    method === 'POST'
  ) {
    if (!(await limiter.check(`create:${ip}`, RATE_LIMITS.sessionCreate))) {
      response = rateLimited(60_000);
      return withCors(response, corsOrigin);
    }
    if (!(await limiter.checkGlobal(GLOBAL_SESSION_LIMIT))) {
      response = rateLimited(60_000);
      return withCors(response, corsOrigin);
    }

    const body = await parseBody(request);
    if (!body || typeof body.publicKey !== 'string' || !body.publicKey) {
      response = json({ error: 'Missing or invalid publicKey' }, 400);
      return withCors(response, corsOrigin);
    }

    // Generate token — check KV for collisions (async)
    let token: string | null = null;
    for (let i = 0; i < 10; i++) {
      const candidate = generateUniqueToken(() => false); // sync check skipped
      if (!(await store.has(candidate))) {
        token = candidate;
        break;
      }
    }
    if (!token) {
      response = json({ error: 'Server at capacity' }, 503);
      return withCors(response, corsOrigin);
    }

    await store.create(token, body.publicKey as string);
    const session = await store.get(token);

    response = json({ token, expiresAt: session!.expiresAt }, 201);
    return withCors(response, corsOrigin);
  }

  // ─── GET /api/session/:token/poll — Poll for credentials ───
  if (
    segments[0] === 'api' &&
    segments[1] === 'session' &&
    segments.length === 4 &&
    segments[3] === 'poll' &&
    method === 'GET'
  ) {
    if (!(await limiter.check(`poll:${ip}`, RATE_LIMITS.poll))) {
      response = rateLimited(60_000);
      return withCors(response, corsOrigin);
    }

    const token = segments[2]!;
    const session = await store.get(token);
    if (!session) {
      response = json({ error: 'Session not found or expired' }, 404);
      return withCors(response, corsOrigin);
    }

    if (session.encrypted) {
      response = json({
        status: 'ready',
        encrypted: session.encrypted,
        ephemeralPublicKey: session.ephemeralPublicKey,
        nonce: session.nonce,
      });
    } else {
      response = json({ status: 'pending' });
    }
    return withCors(response, corsOrigin);
  }

  // ─── POST /api/session/:token — Submit encrypted credentials ───
  if (
    segments[0] === 'api' &&
    segments[1] === 'session' &&
    segments.length === 3 &&
    method === 'POST'
  ) {
    if (!(await limiter.check(`submit:${ip}`, RATE_LIMITS.submit))) {
      response = rateLimited(60_000);
      return withCors(response, corsOrigin);
    }

    const token = segments[2]!;
    const body = await parseBody(request);
    if (
      !body ||
      typeof body.encrypted !== 'string' ||
      typeof body.ephemeralPublicKey !== 'string' ||
      typeof body.nonce !== 'string'
    ) {
      response = json({ error: 'Missing encrypted, ephemeralPublicKey, or nonce' }, 400);
      return withCors(response, corsOrigin);
    }

    const ok = await store.submitCredentials(
      token,
      body.encrypted as string,
      body.ephemeralPublicKey as string,
      body.nonce as string,
    );

    if (!ok) {
      response = json({ error: 'Session not found, expired, or already submitted' }, 404);
      return withCors(response, corsOrigin);
    }

    response = json({ status: 'ok' });
    return withCors(response, corsOrigin);
  }

  // ─── DELETE /api/session/:token — Cleanup ───
  if (
    segments[0] === 'api' &&
    segments[1] === 'session' &&
    segments.length === 3 &&
    method === 'DELETE'
  ) {
    const token = segments[2]!;
    await store.delete(token);
    response = json({ status: 'deleted' });
    return withCors(response, corsOrigin);
  }

  // ─── GET /qr/:token — QR code for terminal ───
  if (segments[0] === 'qr' && segments.length === 2 && method === 'GET') {
    if (!(await limiter.check(`qr:${ip}`, RATE_LIMITS.qr))) {
      response = rateLimited(60_000);
      return withCors(response, corsOrigin);
    }

    const token = segments[1]!;
    const session = await store.get(token);
    if (!session) {
      response = json({ error: 'Session not found or expired' }, 404);
      return withCors(response, corsOrigin);
    }

    const qrUrl = `${baseUrl}/${token}`;
    const qrText = generateQR(qrUrl);
    response = new Response(qrText, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
    return withCors(response, corsOrigin);
  }

  // ─── GET /a/:token — Serve auth page ───
  if (segments[0] === 'a' && segments.length === 2 && method === 'GET') {
    const token = segments[1]!;
    const session = await store.get(token);
    if (!session) {
      return new Response('Session not found or expired.', { status: 404 });
    }

    const html = AUTH_PAGE_HTML
      .replace('{{TOKEN}}', token)
      .replace('{{BASE_URL}}', baseUrl);

    response = new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
    return withCors(response, corsOrigin);
  }

  // ─── GET /:token — Short URL redirect ───
  if (segments.length === 1 && method === 'GET') {
    const token = segments[0]!;
    if (['favicon.ico', 'robots.txt'].includes(token)) {
      return new Response(null, { status: 404 });
    }

    const session = await store.get(token);
    if (!session) {
      response = json({ error: 'Session not found or expired' }, 404);
      return withCors(response, corsOrigin);
    }

    const redirectUrl = `${baseUrl}/a/${token}#pk=${encodeURIComponent(session.publicKey)}`;
    return Response.redirect(redirectUrl, 302);
  }

  // ─── 404 ───
  response = json({ error: 'Not found' }, 404);
  return withCors(response, corsOrigin);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch (err) {
      console.error('Request handler error:', err);
      return json({ error: 'Internal server error' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
