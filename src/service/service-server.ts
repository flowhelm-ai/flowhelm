/**
 * Service container HTTP server.
 *
 * Provides local media inference APIs on the per-user Podman network.
 * The orchestrator calls these endpoints instead of doing inference
 * in its own process — each user's media processing runs in its own
 * isolated container with dedicated CPU/memory limits.
 *
 * Endpoints:
 *   POST /transcribe  — speech-to-text (whisper.cpp)
 *   POST /understand   — vision/OCR (stub — pass-through to Claude)
 *   POST /synthesize   — text-to-speech (stub)
 *   GET  /healthz      — provider readiness check
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type {
  SttProvider,
  VisionProvider,
  TtsProvider,
  TranscribeRequest,
  TranscribeResponse,
  UnderstandRequest,
  UnderstandResponse,
  HealthResponse,
  ErrorResponse,
} from './types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ServiceServerOptions {
  port: number;
  sttProvider?: SttProvider;
  visionProvider?: VisionProvider;
  ttsProvider?: TtsProvider;
}

// ─── Server ─────────────────────────────────────────────────────────────────

export class ServiceServer {
  private readonly port: number;
  private readonly stt: SttProvider | undefined;
  private readonly vision: VisionProvider | undefined;
  private readonly tts: TtsProvider | undefined;
  private server: ReturnType<typeof createServer> | undefined;
  private readonly startedAt = Date.now();

  constructor(options: ServiceServerOptions) {
    this.port = options.port;
    this.stt = options.sttProvider;
    this.vision = options.visionProvider;
    this.tts = options.ttsProvider;
  }

  async start(): Promise<void> {
    const httpServer = createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    this.server = httpServer;

    return new Promise<void>((resolve, reject) => {
      httpServer.listen(this.port, '0.0.0.0', () => {
        console.log(`[service] Server listening on port ${String(this.port)}`);
        resolve();
      });
      httpServer.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    const httpServer = this.server;
    if (!httpServer) return;
    return new Promise<void>((resolve) => {
      httpServer.close(() => {
        console.log('[service] Server stopped');
        resolve();
      });
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';

    try {
      if (method === 'GET' && url === '/healthz') {
        await this.handleHealthz(res);
      } else if (method === 'POST' && url === '/transcribe') {
        await this.handleTranscribe(req, res);
      } else if (method === 'POST' && url === '/understand') {
        await this.handleUnderstand(req, res);
      } else if (method === 'POST' && url === '/synthesize') {
        this.sendError(res, 501, 'NOT_IMPLEMENTED', 'TTS not yet implemented');
      } else {
        this.sendError(res, 404, 'NOT_FOUND', `Unknown endpoint: ${method} ${url}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[service] Request error ${method} ${url}: ${msg}`);
      this.sendError(res, 500, 'INTERNAL_ERROR', msg);
    }
  }

  // ── Transcribe ────────────────────────────────────────────────────────────

  private async handleTranscribe(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.stt) {
      this.sendError(res, 503, 'STT_DISABLED', 'STT provider not configured');
      return;
    }

    const body = await readBody(req);
    const parsed = JSON.parse(body) as TranscribeRequest;

    if (!parsed.audioPath) {
      this.sendError(res, 400, 'INVALID_REQUEST', 'audioPath is required');
      return;
    }

    const result = await this.stt.transcribe(parsed.audioPath, parsed.language);

    const response: TranscribeResponse = {
      text: result.text,
      provider: result.provider,
      durationMs: result.durationMs,
      language: result.language,
    };

    this.sendJson(res, 200, response);
  }

  // ── Understand (Vision) ───────────────────────────────────────────────────

  private async handleUnderstand(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.vision) {
      this.sendError(res, 503, 'VISION_DISABLED', 'Vision provider not configured');
      return;
    }

    const body = await readBody(req);
    const parsed = JSON.parse(body) as UnderstandRequest;

    if (!parsed.imagePath) {
      this.sendError(res, 400, 'INVALID_REQUEST', 'imagePath is required');
      return;
    }

    const result = await this.vision.understand(parsed.imagePath);

    const response: UnderstandResponse = {
      text: result.text,
      provider: result.provider,
      durationMs: result.durationMs,
    };

    this.sendJson(res, 200, response);
  }

  // ── Healthz ───────────────────────────────────────────────────────────────

  private async handleHealthz(res: ServerResponse): Promise<void> {
    const sttReady = this.stt ? await this.stt.isReady() : false;
    const visionReady = this.vision ? await this.vision.isReady() : false;
    const ttsReady = this.tts ? await this.tts.isReady() : false;

    const allReady = sttReady || visionReady || ttsReady;
    const response: HealthResponse = {
      status: allReady ? 'ok' : 'degraded',
      providers: {
        stt: { ready: sttReady, provider: this.stt?.name ?? 'whisper_cpp' },
        vision: { ready: visionReady, provider: this.vision?.name ?? 'none' },
        tts: { ready: ttsReady, provider: this.tts?.name ?? 'none' },
      },
      uptimeMs: Date.now() - this.startedAt,
    };

    this.sendJson(res, 200, response);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private sendJson(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  private sendError(res: ServerResponse, status: number, code: string, message: string): void {
    const error: ErrorResponse = { error: message, code };
    this.sendJson(res, status, error);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX_BODY = 1024 * 1024; // 1 MB

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}
