/**
 * Channel container HTTP server.
 *
 * Runs inside the `flowhelm-channel-{username}` container on port 9000
 * (configurable). The orchestrator calls these endpoints to send outbound
 * messages. The server also provides health and status endpoints.
 *
 * Endpoints:
 *   POST /send         — send a message to any channel
 *   POST /gws          — execute a gws CLI command (Google Workspace)
 *   GET  /healthz      — health check with per-channel status
 *   GET  /status       — detailed per-channel status
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import type { ChannelAdapter } from '../orchestrator/types.js';
import type {
  SendRequest,
  SendResponse,
  GwsRequest,
  GwsResponse,
  HealthResponse,
  StatusResponse,
  ChannelStatus,
  ChannelStatusDetail,
  ErrorResponse,
} from './channel-types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Function that returns a fresh OAuth access token for gws CLI. */
export type GwsTokenProvider = () => Promise<string>;

export interface ChannelServerOptions {
  port: number;
  adapters: Map<string, ChannelAdapter>;
  /** Provides fresh OAuth access tokens for gws CLI execution. */
  gwsTokenProvider?: GwsTokenProvider;
}

// ─── Server ─────────────────────────────────────────────────────────────────

export class ChannelServer {
  private readonly port: number;
  private readonly adapters: Map<string, ChannelAdapter>;
  private readonly gwsTokenProvider: GwsTokenProvider | undefined;
  private server: ReturnType<typeof createServer> | undefined;
  private readonly startedAt = Date.now();

  /** Per-channel error tracking for /status. */
  private readonly errorCounts = new Map<string, number>();
  private readonly lastErrors = new Map<string, string>();
  private readonly lastMessageAt = new Map<string, number>();

  constructor(options: ChannelServerOptions) {
    this.port = options.port;
    this.adapters = options.adapters;
    this.gwsTokenProvider = options.gwsTokenProvider;
  }

  async start(): Promise<void> {
    const httpServer = createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    this.server = httpServer;

    return new Promise<void>((resolve, reject) => {
      httpServer.listen(this.port, '0.0.0.0', () => {
        console.log(`[channel] Server listening on port ${String(this.port)}`);
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
        console.log('[channel] Server stopped');
        resolve();
      });
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';

    try {
      if (method === 'GET' && url === '/healthz') {
        this.handleHealthz(res);
      } else if (method === 'GET' && url === '/status') {
        this.handleStatus(res);
      } else if (method === 'POST' && url === '/send') {
        await this.handleSend(req, res);
      } else if (method === 'POST' && url === '/gws') {
        await this.handleGws(req, res);
      } else {
        this.sendError(res, 404, 'NOT_FOUND', `Unknown endpoint: ${method} ${url}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[channel] Request error ${method} ${url}: ${msg}`);
      this.sendError(res, 500, 'INTERNAL_ERROR', msg);
    }
  }

  // ── Send ──────────────────────────────────────────────────────────────────

  private async handleSend(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    const parsed = JSON.parse(body) as SendRequest;

    if (!parsed.channel || !parsed.userId || !parsed.text) {
      this.sendError(res, 400, 'INVALID_REQUEST', 'channel, userId, and text are required');
      return;
    }

    const adapter = this.adapters.get(parsed.channel);
    if (!adapter) {
      this.sendError(res, 404, 'CHANNEL_NOT_FOUND', `Channel "${parsed.channel}" not configured`);
      return;
    }

    if (!adapter.isConnected()) {
      this.sendError(
        res,
        503,
        'CHANNEL_DISCONNECTED',
        `Channel "${parsed.channel}" is disconnected`,
      );
      return;
    }

    try {
      await adapter.send({
        channel: parsed.channel,
        userId: parsed.userId,
        text: parsed.text,
        replyToMessageId: parsed.replyToMessageId,
      });

      this.lastMessageAt.set(parsed.channel, Date.now());
      const response: SendResponse = { success: true };
      this.sendJson(res, 200, response);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.trackError(parsed.channel, msg);
      this.sendError(res, 502, 'SEND_FAILED', msg);
    }
  }

  // ── Google Workspace CLI ────────────────────────────────────────────────

  private async handleGws(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.gwsTokenProvider) {
      this.sendError(
        res,
        503,
        'GWS_DISABLED',
        'Google Workspace CLI not configured. Gmail adapter must be active with OAuth credentials.',
      );
      return;
    }

    const body = await readBody(req);
    const parsed = JSON.parse(body) as GwsRequest;

    if (!parsed.command) {
      this.sendError(res, 400, 'INVALID_REQUEST', 'command is required');
      return;
    }

    const timeout = Math.min(parsed.timeout ?? 30_000, 60_000);

    try {
      // Get a fresh OAuth access token
      const token = await this.gwsTokenProvider();

      // Split command into args (respect quoted strings)
      const args = parseCommandArgs(parsed.command);

      const result = await new Promise<GwsResponse>((resolve) => {
        const proc = execFile(
          'gws',
          args,
          {
            env: { ...process.env, GOOGLE_WORKSPACE_CLI_TOKEN: token, HOME: '/tmp' },
            timeout,
            maxBuffer: 5 * 1024 * 1024, // 5 MB
          },
          (error, stdout, stderr) => {
            const exitCode = error && 'code' in error ? ((error.code as number) ?? 1) : 0;
            resolve({
              success: exitCode === 0,
              output: stdout,
              stderr: stderr || undefined,
              exitCode,
            });
          },
        );

        // Kill process on timeout (execFile handles this, but be safe)
        proc.on('error', () => {
          resolve({ success: false, output: '', stderr: 'Failed to spawn gws', exitCode: 1 });
        });
      });

      this.sendJson(res, 200, result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.trackError('gws', msg);
      this.sendError(res, 502, 'GWS_FAILED', msg);
    }
  }

  // ── Healthz ───────────────────────────────────────────────────────────────

  private handleHealthz(res: ServerResponse): void {
    const channels: Record<string, ChannelStatus> = {};
    let hasConnected = false;

    for (const [name, adapter] of this.adapters) {
      const connected = adapter.isConnected();
      channels[name] = connected ? 'connected' : 'disconnected';
      if (connected) hasConnected = true;
    }

    const response: HealthResponse = {
      status: hasConnected ? 'ok' : 'degraded',
      channels,
      uptimeMs: Date.now() - this.startedAt,
    };

    this.sendJson(res, 200, response);
  }

  // ── Status ────────────────────────────────────────────────────────────────

  private handleStatus(res: ServerResponse): void {
    const channels: Record<string, ChannelStatusDetail> = {};

    for (const [name, adapter] of this.adapters) {
      channels[name] = {
        status: adapter.isConnected() ? 'connected' : 'disconnected',
        lastMessageAt: this.lastMessageAt.get(name),
        errorCount: this.errorCounts.get(name) ?? 0,
        lastError: this.lastErrors.get(name),
      };
    }

    const response: StatusResponse = {
      channels,
      uptimeMs: Date.now() - this.startedAt,
    };

    this.sendJson(res, 200, response);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private trackError(channel: string, error: string): void {
    this.errorCounts.set(channel, (this.errorCounts.get(channel) ?? 0) + 1);
    this.lastErrors.set(channel, error);
  }

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

/**
 * Parse a command string into arguments, respecting single and double quotes.
 * E.g., `gmail +send --subject "Hello World" --body 'Hi there'`
 * → ['gmail', '+send', '--subject', 'Hello World', '--body', 'Hi there']
 */
function parseCommandArgs(command: string): string[] {
  const args: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command.charAt(i);

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === ' ' && !inSingle && !inDouble) {
      if (current.length > 0) {
        args.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }

  if (current.length > 0) {
    args.push(current);
  }

  return args;
}

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
