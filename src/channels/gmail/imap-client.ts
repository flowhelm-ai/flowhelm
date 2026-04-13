/**
 * IMAP IDLE + SMTP client for Gmail.
 *
 * Alternative transport to Pub/Sub for users who cannot set up GCP
 * (restricted Workspace accounts, no GCP project). Uses node:tls
 * directly — no external IMAP/SMTP dependencies.
 *
 * IMAP IDLE provides near-real-time push notifications (~1-5s latency).
 * Connection is re-established with IDLE every 29 minutes (RFC 2177
 * recommends servers MAY drop IDLE after 30 minutes).
 */

import * as tls from 'node:tls';
import { EventEmitter } from 'node:events';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ImapClientOptions {
  /** IMAP server hostname. */
  host: string;
  /** IMAP port (993 for TLS). */
  port: number;
  /** Gmail email address. */
  emailAddress: string;
  /** OAuth2 access token for XOAUTH2 SASL. */
  accessToken: string;
  /** Reconnect on disconnect. Default: true. */
  autoReconnect?: boolean;
  /** Max reconnection attempts. 0 = unlimited. Default: 0. */
  maxReconnectAttempts?: number;
  /** Base delay for reconnection backoff (ms). Default: 5000. */
  reconnectBaseDelay?: number;
}

export interface ImapMessage {
  uid: number;
  flags: string[];
}

export interface SmtpClientOptions {
  /** SMTP server hostname. */
  host: string;
  /** SMTP port (465 for TLS, 587 for STARTTLS). */
  port: number;
  /** Gmail email address. */
  emailAddress: string;
  /** OAuth2 access token for XOAUTH2 SASL. */
  accessToken: string;
}

// IMAP IDLE re-issue interval (29 min to stay under 30 min RFC limit)
const IDLE_REFRESH_MS = 29 * 60 * 1000;

// ─── IMAP Client ───────────────────────────────────────────────────────────

/**
 * Minimal IMAP client implementing IDLE for real-time Gmail notifications.
 *
 * Emits 'newMail' events when new messages arrive in the selected mailbox.
 * Uses XOAUTH2 for authentication (compatible with Gmail's OAuth2).
 */
export class ImapIdleClient extends EventEmitter {
  private readonly host: string;
  private readonly port: number;
  private readonly emailAddress: string;
  private accessToken: string;
  private readonly autoReconnect: boolean;
  private readonly maxReconnectAttempts: number;
  private readonly reconnectBaseDelay: number;

  private socket: tls.TLSSocket | null = null;
  private connected = false;
  private idling = false;
  private tagCounter = 0;
  private buffer = '';
  private reconnectAttempts = 0;
  private idleRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;

  constructor(options: ImapClientOptions) {
    super();
    this.host = options.host;
    this.port = options.port;
    this.emailAddress = options.emailAddress;
    this.accessToken = options.accessToken;
    this.autoReconnect = options.autoReconnect ?? true;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 0;
    this.reconnectBaseDelay = options.reconnectBaseDelay ?? 5000;
  }

  /** Update the access token (after refresh). */
  updateAccessToken(token: string): void {
    this.accessToken = token;
  }

  /** Connect, authenticate, select INBOX, and start IDLE. */
  async connect(): Promise<void> {
    this.stopping = false;
    await this.doConnect();
    this.reconnectAttempts = 0;
    console.log(`[imap] Connected to ${this.host}:${String(this.port)}`);
  }

  /** Gracefully disconnect. */
  async disconnect(): Promise<void> {
    this.stopping = true;
    this.cancelIdleRefresh();

    if (this.idling) {
      this.sendRaw('DONE\r\n');
      this.idling = false;
    }

    if (this.connected) {
      try {
        await this.sendCommand('LOGOUT');
      } catch {
        // Best-effort logout
      }
    }

    this.destroySocket();
    this.connected = false;
    console.log('[imap] Disconnected');
  }

  /** Whether the client is connected and idling. */
  isConnected(): boolean {
    return this.connected;
  }

  // ── Connection ──────────────────────────────────────────────────────

  private doConnect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.socket = tls.connect({ host: this.host, port: this.port, servername: this.host }, () => {
        // TLS connected — wait for IMAP greeting
      });

      this.buffer = '';

      this.socket.on('error', (err: Error) => {
        if (!this.connected) {
          reject(err);
          return;
        }
        console.error('[imap] Socket error:', err.message);
        this.handleDisconnect();
      });

      this.socket.on('close', () => {
        if (this.connected) {
          this.handleDisconnect();
        }
      });

      // Authentication flow: greeting → auth → select → IDLE
      // During this phase, sendCommand() manages its own data listeners.
      // After auth completes, we install the persistent IDLE data listener.
      const authFlow = async (): Promise<void> => {
        try {
          // Wait for server greeting (uses its own data listener)
          await this.waitForGreeting();

          // Authenticate with XOAUTH2
          await this.authenticate();

          // Select INBOX
          await this.selectInbox();

          this.connected = true;

          // Install persistent data listener for IDLE EXISTS notifications
          this.installIdleListener();

          // Start IDLE
          await this.startIdle();

          resolve();
        } catch (err) {
          this.destroySocket();
          reject(err);
        }
      };

      void authFlow();
    });
  }

  /** Install the persistent listener that detects new mail during IDLE. */
  private installIdleListener(): void {
    this.socket?.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf-8');

      // Process complete lines
      while (true) {
        const newlineIdx = this.buffer.indexOf('\r\n');
        if (newlineIdx === -1) break;

        const line = this.buffer.slice(0, newlineIdx);
        this.buffer = this.buffer.slice(newlineIdx + 2);

        // Untagged EXISTS = new mail arrived
        if (this.idling && line.match(/^\* \d+ EXISTS/)) {
          this.emit('newMail');
        }
      }
    });
  }

  private waitForGreeting(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.socket) {
        reject(new Error('No socket'));
        return;
      }

      const timeout = setTimeout(() => {
        this.socket?.removeListener('data', handler);
        reject(new Error('IMAP greeting timeout'));
      }, 10_000);

      const handler = (chunk: Buffer): void => {
        this.buffer += chunk.toString('utf-8');

        // Check for greeting line
        const idx = this.buffer.indexOf('\r\n');
        if (idx >= 0) {
          const line = this.buffer.slice(0, idx);
          if (line.startsWith('* OK')) {
            clearTimeout(timeout);
            this.socket?.removeListener('data', handler);
            this.buffer = this.buffer.slice(idx + 2);
            resolve();
          }
        }
      };

      // Check if greeting already arrived in buffer
      const existingIdx = this.buffer.indexOf('* OK');
      if (existingIdx >= 0) {
        const lineEnd = this.buffer.indexOf('\r\n', existingIdx);
        if (lineEnd >= 0) {
          clearTimeout(timeout);
          this.buffer = this.buffer.slice(lineEnd + 2);
          resolve();
          return;
        }
      }

      this.socket.on('data', handler);
    });
  }

  private async authenticate(): Promise<void> {
    const xoauth2Token = buildXOAuth2Token(this.emailAddress, this.accessToken);
    await this.sendCommand(`AUTHENTICATE XOAUTH2 ${xoauth2Token}`);
  }

  private async selectInbox(): Promise<void> {
    await this.sendCommand('SELECT INBOX');
  }

  private async startIdle(): Promise<void> {
    const tag = this.nextTag();
    this.sendRaw(`${tag} IDLE\r\n`);
    this.idling = true;

    // Refresh IDLE every 29 min (RFC 2177 allows servers to drop after 30 min)
    this.scheduleIdleRefresh();
  }

  /** Send DONE to end IDLE, then re-issue IDLE. */
  private async refreshIdle(): Promise<void> {
    if (!this.idling || !this.connected) return;

    this.sendRaw('DONE\r\n');
    this.idling = false;

    // Small delay for server to process DONE
    await sleep(200);

    // NOOP to keep connection alive
    await this.sendCommand('NOOP');

    // Re-enter IDLE
    await this.startIdle();
  }

  private scheduleIdleRefresh(): void {
    this.cancelIdleRefresh();
    this.idleRefreshTimer = setTimeout(() => {
      void this.refreshIdle().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[imap] IDLE refresh failed:', msg);
        this.handleDisconnect();
      });
    }, IDLE_REFRESH_MS);
  }

  private cancelIdleRefresh(): void {
    if (this.idleRefreshTimer) {
      clearTimeout(this.idleRefreshTimer);
      this.idleRefreshTimer = null;
    }
  }

  // ── Command I/O ─────────────────────────────────────────────────────

  private sendCommand(command: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const tag = this.nextTag();
      const fullCommand = `${tag} ${command}\r\n`;

      const timeout = setTimeout(() => {
        this.socket?.removeListener('data', responseHandler);
        reject(new Error(`IMAP command timeout: ${command}`));
      }, 30_000);

      const responseHandler = (chunk: Buffer): void => {
        this.buffer += chunk.toString('utf-8');
        while (true) {
          const idx = this.buffer.indexOf('\r\n');
          if (idx === -1) break;
          const line = this.buffer.slice(0, idx);
          this.buffer = this.buffer.slice(idx + 2);

          if (line.startsWith(`${tag} OK`)) {
            clearTimeout(timeout);
            this.socket?.removeListener('data', responseHandler);
            resolve(line);
            return;
          }
          if (line.startsWith(`${tag} NO`) || line.startsWith(`${tag} BAD`)) {
            clearTimeout(timeout);
            this.socket?.removeListener('data', responseHandler);
            reject(new Error(`IMAP error: ${line}`));
            return;
          }
          // Ignore untagged responses (* ...) — they're informational
        }
      };

      this.socket?.on('data', responseHandler);
      this.sendRaw(fullCommand);
    });
  }

  private sendRaw(data: string): void {
    this.socket?.write(data);
  }

  private nextTag(): string {
    this.tagCounter++;
    return `A${String(this.tagCounter).padStart(4, '0')}`;
  }

  // ── Reconnection ───────────────────────────────────────────────────

  private handleDisconnect(): void {
    this.connected = false;
    this.idling = false;
    this.cancelIdleRefresh();
    this.destroySocket();

    if (this.stopping || !this.autoReconnect) return;

    this.reconnectAttempts++;
    if (this.maxReconnectAttempts > 0 && this.reconnectAttempts > this.maxReconnectAttempts) {
      console.error(
        `[imap] Max reconnection attempts (${String(this.maxReconnectAttempts)}) reached`,
      );
      this.emit('disconnected');
      return;
    }

    const delay = Math.min(
      this.reconnectBaseDelay * Math.pow(2, this.reconnectAttempts - 1),
      300_000, // Max 5 min
    );
    console.log(
      `[imap] Reconnecting in ${String(delay)}ms (attempt ${String(this.reconnectAttempts)})`,
    );

    setTimeout(() => {
      void this.doConnect()
        .then(() => {
          this.reconnectAttempts = 0;
          console.log('[imap] Reconnected');
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error('[imap] Reconnection failed:', msg);
          this.handleDisconnect();
        });
    }, delay);
  }

  private destroySocket(): void {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
  }
}

// ─── SMTP Client ────────────────────────────────────────────────────────────

/**
 * Minimal SMTP client for sending email via Gmail.
 *
 * Uses implicit TLS (port 465) and XOAUTH2 for authentication.
 * Designed for single-message sending — connect, send, disconnect.
 */
export class SmtpClient {
  private readonly host: string;
  private readonly port: number;
  private readonly emailAddress: string;
  private readonly accessToken: string;

  constructor(options: SmtpClientOptions) {
    this.host = options.host;
    this.port = options.port;
    this.emailAddress = options.emailAddress;
    this.accessToken = options.accessToken;
  }

  /**
   * Send a raw RFC 2822 email message.
   *
   * Opens a TLS connection, authenticates, sends, and disconnects.
   */
  async send(to: string, rawMessage: string): Promise<void> {
    const socket = await this.connectTls();
    try {
      await this.readResponse(socket, 220);

      await this.writeAndExpect(socket, `EHLO flowhelm\r\n`, 250);

      // XOAUTH2 auth
      const xoauth2 = buildXOAuth2Token(this.emailAddress, this.accessToken);
      await this.writeAndExpect(socket, `AUTH XOAUTH2 ${xoauth2}\r\n`, 235);

      // Envelope
      await this.writeAndExpect(socket, `MAIL FROM:<${this.emailAddress}>\r\n`, 250);
      await this.writeAndExpect(socket, `RCPT TO:<${to}>\r\n`, 250);

      // Data
      await this.writeAndExpect(socket, 'DATA\r\n', 354);
      // Dot-stuff the message body
      const stuffed = rawMessage.replace(/^\.$/gm, '..');
      await this.writeAndExpect(socket, `${stuffed}\r\n.\r\n`, 250);

      await this.writeAndExpect(socket, 'QUIT\r\n', 221);
    } finally {
      socket.destroy();
    }
  }

  private connectTls(): Promise<tls.TLSSocket> {
    return new Promise<tls.TLSSocket>((resolve, reject) => {
      const socket = tls.connect({ host: this.host, port: this.port, servername: this.host }, () =>
        resolve(socket),
      );
      socket.on('error', reject);
    });
  }

  private readResponse(socket: tls.TLSSocket, expectedCode: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('SMTP response timeout')), 30_000);
      let buf = '';
      const handler = (chunk: Buffer): void => {
        buf += chunk.toString('utf-8');
        // Multi-line responses end with "XXX " (code + space)
        const lines = buf.split('\r\n');
        for (const line of lines) {
          if (line.length >= 4 && line[3] === ' ') {
            clearTimeout(timeout);
            socket.removeListener('data', handler);
            const code = parseInt(line.slice(0, 3), 10);
            if (code === expectedCode) {
              resolve(buf);
            } else {
              reject(new Error(`SMTP error: expected ${String(expectedCode)}, got: ${line}`));
            }
            return;
          }
        }
      };
      socket.on('data', handler);
    });
  }

  private async writeAndExpect(
    socket: tls.TLSSocket,
    command: string,
    expectedCode: number,
  ): Promise<string> {
    socket.write(command);
    return this.readResponse(socket, expectedCode);
  }
}

// ─── Utilities ──────────────────────────────────────────────────────────────

/**
 * Build an XOAUTH2 SASL token for Gmail.
 * Format: base64("user=" + email + "\x01auth=Bearer " + token + "\x01\x01")
 */
export function buildXOAuth2Token(email: string, accessToken: string): string {
  const raw = `user=${email}\x01auth=Bearer ${accessToken}\x01\x01`;
  return Buffer.from(raw, 'utf-8').toString('base64');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
