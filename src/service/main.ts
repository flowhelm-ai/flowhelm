#!/usr/bin/env node

/**
 * Service container entrypoint.
 *
 * Reads provider configuration from environment variables, initializes
 * the appropriate providers, and starts the HTTP server.
 *
 * When HTTPS_PROXY is set, all outbound HTTPS requests are tunneled
 * through the credential proxy via HTTP CONNECT. The proxy performs
 * MITM TLS interception and injects real API keys, so the service container
 * only needs placeholder credentials.
 *
 * Environment variables:
 *   SERVICE_PORT             — HTTP server port (default: 8787)
 *   SERVICE_STT_ENABLED      — Enable STT provider (default: "true")
 *   SERVICE_STT_PROVIDER     — STT backend: "whisper_cpp" (default) or "openai_whisper"
 *   SERVICE_STT_MODEL        — Path to GGML model file (whisper_cpp only)
 *   SERVICE_STT_LANGUAGE     — Default language code (default: "en")
 *   SERVICE_STT_THREADS      — CPU threads for inference (whisper_cpp only, default: "2")
 *   SERVICE_OPENAI_API_KEY   — OpenAI API key or placeholder (openai_whisper only)
 *   HTTPS_PROXY           — Credential proxy URL (e.g., http://flowhelm-proxy-user:10255)
 *   NODE_EXTRA_CA_CERTS   — FlowHelm CA cert path (for MITM TLS trust)
 */

import type { Socket } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import { readFileSync } from 'node:fs';
import { ServiceServer } from './service-server.js';
import { WhisperCppSttProvider } from './stt-provider.js';
import { OpenAiSttProvider, type FetchFn } from './openai-stt-provider.js';
import type { SttProvider } from './types.js';

// ─── Proxy-Aware Fetch ─────────────────────────────────────────────────────

/**
 * Create a fetch function that tunnels HTTPS requests through an HTTP proxy
 * using the CONNECT method. This enables the credential proxy's MITM TLS
 * interception to inject real API keys.
 *
 * For non-HTTPS URLs (e.g., the mock test server at http://...), falls back
 * to the global fetch.
 */
function createProxyFetch(proxyUrl: string): FetchFn {
  const proxy = new URL(proxyUrl);
  const proxyHost = proxy.hostname;
  const proxyPort = parseInt(proxy.port || '80', 10);

  // Load FlowHelm CA for MITM TLS trust
  const caPath = process.env['NODE_EXTRA_CA_CERTS'];
  const ca = caPath ? readFileSync(caPath) : undefined;

  return async function proxyFetch(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const url =
      typeof input === 'string'
        ? new URL(input)
        : input instanceof URL
          ? input
          : new URL(input.url);

    // Only proxy HTTPS requests
    if (url.protocol !== 'https:') {
      return globalThis.fetch(input, init);
    }

    const targetHost = url.hostname;
    const targetPort = parseInt(url.port || '443', 10);

    // Establish CONNECT tunnel through the proxy
    const tunnelSocket = await new Promise<Socket>((resolve, reject) => {
      const connectReq = httpRequest({
        host: proxyHost,
        port: proxyPort,
        method: 'CONNECT',
        path: `${targetHost}:${String(targetPort)}`,
      });

      connectReq.on('connect', (_res, socket) => {
        resolve(socket);
      });
      connectReq.on('error', reject);
      connectReq.end();
    });

    // Create HTTPS agent that uses the tunneled socket
    const agent = new HttpsAgent({
      socket: tunnelSocket,
      // Trust FlowHelm CA for MITM-signed certificates
      ca,
      // Don't reject the MITM cert
      rejectUnauthorized: !!ca,
    });

    // Make the HTTPS request through the tunnel using node:https,
    // then convert to a Response object compatible with fetch API
    return new Promise<Response>((resolve, reject) => {
      const reqOptions = {
        hostname: targetHost,
        port: targetPort,
        path: url.pathname + url.search,
        method: init?.method ?? 'GET',
        headers: {} as Record<string, string>,
        agent,
      };

      // Copy headers from init
      if (init?.headers) {
        const headers = init.headers;
        if (headers instanceof Headers) {
          headers.forEach((value, key) => {
            reqOptions.headers[key] = value;
          });
        } else if (Array.isArray(headers)) {
          for (const entry of headers) {
            const [key, value] = entry as [string, string];
            reqOptions.headers[key] = value;
          }
        } else {
          Object.assign(reqOptions.headers, headers);
        }
      }

      // For multipart/form-data with FormData body, we need to
      // serialize it and get the content-type with boundary
      const handleBody = async (): Promise<Buffer | undefined> => {
        if (!init?.body) return undefined;
        if (init.body instanceof FormData) {
          // Use the global fetch's ability to serialize FormData by
          // creating a Request object and reading its body
          const tempReq = new Request('http://localhost', {
            method: 'POST',
            body: init.body,
          });
          reqOptions.headers['content-type'] = tempReq.headers.get('content-type') ?? '';
          const arrayBuffer = await tempReq.arrayBuffer();
          return Buffer.from(arrayBuffer);
        }
        if (typeof init.body === 'string') return Buffer.from(init.body);
        if (init.body instanceof ArrayBuffer) return Buffer.from(init.body);
        if (Buffer.isBuffer(init.body)) return init.body;
        return undefined;
      };

      handleBody()
        .then((bodyBuffer) => {
          if (bodyBuffer) {
            reqOptions.headers['content-length'] = String(bodyBuffer.length);
          }

          const req = httpsRequest(reqOptions, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
              const body = Buffer.concat(chunks);
              const responseHeaders = new Headers();
              for (const [key, value] of Object.entries(res.headers)) {
                if (value) {
                  const values = Array.isArray(value) ? value : [value];
                  for (const v of values) {
                    responseHeaders.append(key, v);
                  }
                }
              }

              resolve(
                new Response(body, {
                  status: res.statusCode ?? 500,
                  statusText: res.statusMessage ?? '',
                  headers: responseHeaders,
                }),
              );
            });
            res.on('error', reject);
          });

          // Handle abort signal
          if (init?.signal) {
            init.signal.addEventListener('abort', () => {
              req.destroy();
              reject(new DOMException('The operation was aborted', 'AbortError'));
            });
          }

          req.on('error', reject);
          if (bodyBuffer) {
            req.write(bodyBuffer);
          }
          req.end();
        })
        .catch(reject);
    });
  };
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const port = parseInt(process.env['SERVICE_PORT'] ?? '8787', 10);

  // Create proxy-aware fetch if HTTPS_PROXY is set
  const proxyUrl = process.env['HTTPS_PROXY'];
  let proxyFetch: FetchFn | undefined;
  if (proxyUrl) {
    proxyFetch = createProxyFetch(proxyUrl);
    console.log(`[service] HTTPS proxy configured: ${proxyUrl}`);
  }

  // Initialize STT provider
  let sttProvider: SttProvider | undefined;
  if (process.env['SERVICE_STT_ENABLED'] !== 'false') {
    const providerName = process.env['SERVICE_STT_PROVIDER'] ?? 'whisper_cpp';
    const language = process.env['SERVICE_STT_LANGUAGE'] ?? 'en';

    if (providerName === 'openai_whisper') {
      const apiKey = process.env['SERVICE_OPENAI_API_KEY'] ?? '';
      if (!apiKey) {
        console.error('[service] openai_whisper requires SERVICE_OPENAI_API_KEY');
        process.exit(1);
      }
      sttProvider = new OpenAiSttProvider({
        apiKey,
        language,
        fetchFn: proxyFetch,
      });
      console.log('[service] STT provider ready: openai_whisper');
    } else {
      const modelPath = process.env['SERVICE_STT_MODEL'] ?? '/models/ggml-small.bin';
      const threads = parseInt(process.env['SERVICE_STT_THREADS'] ?? '2', 10);

      sttProvider = new WhisperCppSttProvider({ modelPath, language, threads });

      const ready = await sttProvider.isReady();
      if (ready) {
        console.log(
          `[service] STT provider ready: whisper_cpp (model=${modelPath}, threads=${String(threads)})`,
        );
      } else {
        console.warn('[service] STT provider not ready — model or binary missing');
      }
    }
  }

  // Vision and TTS providers are stubs — not initialized
  // Vision images pass through to the Claude agent
  // TTS is not yet implemented

  const server = new ServiceServer({
    port,
    sttProvider,
  });

  await server.start();
  console.log(`[service] Service container ready on port ${String(port)}`);

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[service] Received ${signal}, shutting down...`);
    await server.stop();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[service] Fatal error:', err);
  process.exit(1);
});
