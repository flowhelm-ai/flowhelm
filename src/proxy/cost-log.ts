/**
 * Append-only cost/usage log for proxied API requests.
 *
 * The proxy has no database access by design. Cost data is written to a
 * structured log file that the orchestrator can ingest into PostgreSQL later.
 *
 * Format (one JSON object per line):
 *   {"ts":"2026-04-08T...","credential":"anthropic-api-key","model":"claude-sonnet-4-6-20250514","inputTokens":1200,"outputTokens":340}
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface CostEntry {
  /** ISO 8601 timestamp. */
  ts: string;
  /** Credential rule name. */
  credential: string;
  /** Model identifier (from response body). */
  model: string;
  /** Input tokens consumed (non-cached). */
  inputTokens: number;
  /** Output tokens generated. */
  outputTokens: number;
  /** Tokens used to create new cache entries (prompt caching). */
  cacheCreationInputTokens?: number;
  /** Tokens served from cache (prompt caching). */
  cacheReadInputTokens?: number;
}

/**
 * Append-only cost logger.
 *
 * Writes one JSON line per API response that includes usage data.
 * The proxy buffers Anthropic API response bodies (up to 1 MB) and
 * parses the `usage` field to extract token counts.
 */
export class CostLog {
  private readonly logPath: string;
  private initialized = false;

  constructor(logPath: string) {
    this.logPath = logPath;
  }

  /** Ensure the log directory exists. */
  private async ensureDir(): Promise<void> {
    if (this.initialized) return;
    await mkdir(dirname(this.logPath), { recursive: true });
    this.initialized = true;
  }

  /** Append a cost entry. */
  async log(entry: CostEntry): Promise<void> {
    await this.ensureDir();
    try {
      await appendFile(this.logPath, JSON.stringify(entry) + '\n', { encoding: 'utf-8' });
    } catch (err) {
      // Best-effort — don't crash the proxy for logging failures
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[cost-log] Write failed: ${msg}`);
    }
  }

  /**
   * Try to extract cost data from an Anthropic API response body.
   * Handles both non-streaming (single JSON) and streaming (SSE) formats.
   *
   * Non-streaming: single JSON object with top-level `usage` field.
   * Streaming: SSE events where `message_start` has input_tokens in
   * `message.usage` and `message_delta` has output_tokens in `usage`.
   * The model is in `message_start.message.model`.
   */
  static parseAnthropicUsage(body: string, credentialName: string): CostEntry | undefined {
    try {
      // Try non-streaming first (single JSON object)
      if (body.trimStart().startsWith('{')) {
        return CostLog.parseJsonUsage(body, credentialName);
      }

      // SSE streaming format: extract usage from event data lines
      return CostLog.parseSseUsage(body, credentialName);
    } catch {
      return undefined;
    }
  }

  /** Parse a non-streaming JSON response body. */
  private static parseJsonUsage(body: string, credentialName: string): CostEntry | undefined {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null) return undefined;

    const obj = parsed as Record<string, unknown>;
    const usage = obj['usage'] as Record<string, unknown> | undefined;
    if (!usage) return undefined;

    const inputTokens = typeof usage['input_tokens'] === 'number' ? usage['input_tokens'] : 0;
    const outputTokens = typeof usage['output_tokens'] === 'number' ? usage['output_tokens'] : 0;
    const cacheCreation =
      typeof usage['cache_creation_input_tokens'] === 'number'
        ? usage['cache_creation_input_tokens']
        : undefined;
    const cacheRead =
      typeof usage['cache_read_input_tokens'] === 'number'
        ? usage['cache_read_input_tokens']
        : undefined;
    const model = typeof obj['model'] === 'string' ? obj['model'] : 'unknown';

    if (inputTokens === 0 && outputTokens === 0 && !cacheCreation && !cacheRead) return undefined;

    return {
      ts: new Date().toISOString(),
      credential: credentialName,
      model,
      inputTokens,
      outputTokens,
      ...(cacheCreation !== undefined ? { cacheCreationInputTokens: cacheCreation } : {}),
      ...(cacheRead !== undefined ? { cacheReadInputTokens: cacheRead } : {}),
    };
  }

  /**
   * Parse an SSE streaming response body.
   *
   * Claude CLI uses streaming by default. The Anthropic API SSE format has:
   * - `message_start` event: contains `message.usage.input_tokens` and `message.model`
   * - `message_delta` event: contains `usage.output_tokens`
   *
   * We scan all `data:` lines for these two events.
   */
  private static parseSseUsage(body: string, credentialName: string): CostEntry | undefined {
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheCreation: number | undefined;
    let cacheRead: number | undefined;
    let model = 'unknown';

    for (const line of body.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const jsonStr = line.slice(6);
      if (!jsonStr.trimStart().startsWith('{')) continue;

      try {
        const event = JSON.parse(jsonStr) as Record<string, unknown>;

        if (event['type'] === 'message_start') {
          const message = event['message'] as Record<string, unknown> | undefined;
          if (message) {
            if (typeof message['model'] === 'string') model = message['model'];
            const usage = message['usage'] as Record<string, unknown> | undefined;
            if (usage) {
              if (typeof usage['input_tokens'] === 'number') {
                inputTokens = usage['input_tokens'];
              }
              if (typeof usage['cache_creation_input_tokens'] === 'number') {
                cacheCreation = usage['cache_creation_input_tokens'];
              }
              if (typeof usage['cache_read_input_tokens'] === 'number') {
                cacheRead = usage['cache_read_input_tokens'];
              }
            }
          }
        }

        if (event['type'] === 'message_delta') {
          const usage = event['usage'] as Record<string, unknown> | undefined;
          if (usage && typeof usage['output_tokens'] === 'number') {
            outputTokens = usage['output_tokens'];
          }
        }
      } catch {
        // Skip malformed SSE data lines
      }
    }

    if (inputTokens === 0 && outputTokens === 0 && !cacheCreation && !cacheRead) return undefined;

    return {
      ts: new Date().toISOString(),
      credential: credentialName,
      model,
      inputTokens,
      outputTokens,
      ...(cacheCreation !== undefined ? { cacheCreationInputTokens: cacheCreation } : {}),
      ...(cacheRead !== undefined ? { cacheReadInputTokens: cacheRead } : {}),
    };
  }
}
