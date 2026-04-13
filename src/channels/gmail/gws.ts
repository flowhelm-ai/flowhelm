/**
 * gws CLI wrapper for Gmail and Calendar operations.
 *
 * Provides typed, async wrappers around the `gws` (Google Workspace)
 * CLI binary. Used by the agent inside containers for email and calendar
 * operations. The orchestrator uses the Gmail REST client directly.
 *
 * gws handles OAuth token refresh silently via stored refresh tokens.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ─── Types ─────────────────────────────────────────────────────────────────

export interface GwsOptions {
  /** Path to gws binary. Default: 'gws'. */
  binaryPath?: string;
  /** Execution timeout in ms. Default: 30000. */
  timeout?: number;
  /** Custom exec function (for testing). */
  execFn?: ExecFn;
}

export type ExecFn = (
  cmd: string,
  args: string[],
  options?: { timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;

export interface GmailMessageRef {
  id: string;
  threadId: string;
}

export interface GmailMessageDetail {
  id: string;
  threadId: string;
  snippet: string;
  payload: {
    headers: Array<{ name: string; value: string }>;
  };
  labelIds: string[];
  internalDate: string;
}

export interface CalendarEvent {
  id: string;
  summary: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  status: string;
  location?: string;
  description?: string;
}

export interface CalendarEventList {
  items: CalendarEvent[];
}

// ─── gws Wrapper ───────────────────────────────────────────────────────────

export class GwsClient {
  private readonly binaryPath: string;
  private readonly timeout: number;
  private readonly execFn: ExecFn;

  constructor(options?: GwsOptions) {
    this.binaryPath = options?.binaryPath ?? 'gws';
    this.timeout = options?.timeout ?? 30_000;
    this.execFn = options?.execFn ?? defaultExec;
  }

  // ── Gmail Operations ────────────────────────────────────────────────

  /** List messages matching a Gmail search query. */
  async gmailList(query?: string, maxResults = 10): Promise<GmailMessageRef[]> {
    const args = ['gmail', 'users', 'messages', 'list', '--userId', 'me', '--format', 'json'];
    if (query) args.push('--q', query);
    args.push('--maxResults', String(maxResults));

    const result = await this.exec(args);
    const parsed = JSON.parse(result) as { messages?: GmailMessageRef[] };
    return parsed.messages ?? [];
  }

  /** Get a message by ID. */
  async gmailGet(
    messageId: string,
    format: 'metadata' | 'full' = 'metadata',
  ): Promise<GmailMessageDetail> {
    const args = [
      'gmail',
      'users',
      'messages',
      'get',
      '--userId',
      'me',
      '--id',
      messageId,
      '--format',
      format,
      '--format',
      'json', // output format
    ];
    const result = await this.exec(args);
    return JSON.parse(result) as GmailMessageDetail;
  }

  /** Send an email. */
  async gmailSend(to: string, subject: string, body: string): Promise<GmailMessageRef> {
    // Build RFC 2822 message and base64url encode
    const rawMsg = [
      `To: ${to}`,
      `Subject: ${subject}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      body,
    ].join('\r\n');

    const raw = Buffer.from(rawMsg, 'utf-8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const requestBody = JSON.stringify({ raw });
    const args = [
      'gmail',
      'users',
      'messages',
      'send',
      '--userId',
      'me',
      '--requestBody',
      requestBody,
      '--format',
      'json',
    ];

    const result = await this.exec(args);
    return JSON.parse(result) as GmailMessageRef;
  }

  /** Search messages using Gmail search syntax. */
  async gmailSearch(query: string, maxResults = 20): Promise<GmailMessageRef[]> {
    return this.gmailList(query, maxResults);
  }

  /** List labels for the user. */
  async gmailLabels(): Promise<Array<{ id: string; name: string; type: string }>> {
    const args = ['gmail', 'users', 'labels', 'list', '--userId', 'me', '--format', 'json'];
    const result = await this.exec(args);
    const parsed = JSON.parse(result) as {
      labels?: Array<{ id: string; name: string; type: string }>;
    };
    return parsed.labels ?? [];
  }

  /** List history since a given historyId. */
  async gmailHistory(startHistoryId: string): Promise<unknown> {
    const args = [
      'gmail',
      'users',
      'history',
      'list',
      '--userId',
      'me',
      '--startHistoryId',
      startHistoryId,
      '--format',
      'json',
    ];
    const result = await this.exec(args);
    return JSON.parse(result) as unknown;
  }

  // ── Calendar Operations ─────────────────────────────────────────────

  /** List upcoming calendar events. */
  async calendarList(
    maxResults = 10,
    timeMin?: string,
    timeMax?: string,
  ): Promise<CalendarEvent[]> {
    const args = [
      'calendar',
      'events',
      'list',
      '--calendarId',
      'primary',
      '--maxResults',
      String(maxResults),
      '--singleEvents',
      'true',
      '--orderBy',
      'startTime',
      '--format',
      'json',
    ];
    if (timeMin) args.push('--timeMin', timeMin);
    if (timeMax) args.push('--timeMax', timeMax);

    const result = await this.exec(args);
    const parsed = JSON.parse(result) as CalendarEventList;
    return parsed.items ?? [];
  }

  /** Create a calendar event. */
  async calendarCreate(event: {
    summary: string;
    start: string;
    end: string;
    location?: string;
    description?: string;
  }): Promise<CalendarEvent> {
    const requestBody = JSON.stringify({
      summary: event.summary,
      start: { dateTime: event.start },
      end: { dateTime: event.end },
      ...(event.location ? { location: event.location } : {}),
      ...(event.description ? { description: event.description } : {}),
    });

    const args = [
      'calendar',
      'events',
      'insert',
      '--calendarId',
      'primary',
      '--requestBody',
      requestBody,
      '--format',
      'json',
    ];

    const result = await this.exec(args);
    return JSON.parse(result) as CalendarEvent;
  }

  /** Delete a calendar event. */
  async calendarDelete(eventId: string): Promise<void> {
    const args = ['calendar', 'events', 'delete', '--calendarId', 'primary', '--eventId', eventId];
    await this.exec(args);
  }

  // ── Internal ────────────────────────────────────────────────────────

  private async exec(args: string[]): Promise<string> {
    const { stdout } = await this.execFn(this.binaryPath, args, {
      timeout: this.timeout,
    });
    return stdout.trim();
  }
}

// ─── Default exec implementation ─────────────────────────────────────────

async function defaultExec(
  cmd: string,
  args: string[],
  options?: { timeout?: number },
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(cmd, args, {
    timeout: options?.timeout,
    maxBuffer: 10 * 1024 * 1024, // 10 MB
  });
}

/**
 * Check if the gws binary is available on the system.
 */
export async function isGwsAvailable(binaryPath = 'gws'): Promise<boolean> {
  try {
    await execFileAsync(binaryPath, ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}
