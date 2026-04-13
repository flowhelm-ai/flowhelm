/**
 * Append-only audit log for proxied requests.
 *
 * Logs metadata only — never request/response bodies. Format:
 *   2026-04-03T14:22:01.123Z CONNECT api.anthropic.com:443 200 1234ms credential=Anthropic
 *
 * The log file lives at ~/.flowhelm/secrets/audit.log on the host,
 * bind-mounted into the proxy container. The proxy appends entries;
 * the host can rotate/archive the file.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface AuditEntry {
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** HTTP method (CONNECT for tunneled HTTPS). */
  method: string;
  /** Target host (e.g., "api.anthropic.com:443"). */
  host: string;
  /** HTTP status code returned to the client. */
  statusCode: number;
  /** Request duration in milliseconds. */
  durationMs: number;
  /** Name of the matched credential rule, or "none". */
  credentialName: string;
}

/**
 * Append-only audit logger.
 *
 * Each proxied request is logged as a single line with fixed fields.
 * No request/response bodies, no query parameters — only connection metadata.
 */
export class AuditLog {
  private readonly logPath: string;
  private initialized = false;

  constructor(logPath: string) {
    this.logPath = logPath;
  }

  /**
   * Ensure the log directory exists.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    await mkdir(dirname(this.logPath), { recursive: true });
    this.initialized = true;
  }

  /**
   * Append an audit entry to the log file.
   * Each entry is a single newline-terminated line.
   */
  async log(entry: AuditEntry): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }

    const line =
      `${entry.timestamp} ${entry.method} ${entry.host} ` +
      `${String(entry.statusCode)} ${String(entry.durationMs)}ms ` +
      `credential=${entry.credentialName}\n`;

    try {
      await appendFile(this.logPath, line, { encoding: 'utf-8' });
    } catch {
      // Best-effort logging — don't crash the proxy if the log file is unavailable
    }
  }

  /**
   * Format and log a completed request.
   * Convenience method that builds the AuditEntry from raw parameters.
   */
  async logRequest(
    method: string,
    host: string,
    statusCode: number,
    startTime: number,
    credentialName: string,
  ): Promise<void> {
    await this.log({
      timestamp: new Date().toISOString(),
      method,
      host,
      statusCode,
      durationMs: Date.now() - startTime,
      credentialName,
    });
  }
}
