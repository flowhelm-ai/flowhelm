/**
 * Abstract Telegram transport layer.
 *
 * Decouples the Telegram adapter from any specific library (grammY, etc.).
 * The transport handles long-polling, message sending/receiving, file
 * downloads, and connection management. The adapter handles message
 * normalization, access control, and ChannelAdapter interface compliance.
 *
 * To swap libraries: implement TelegramTransport with a different backend.
 */

import { Bot, type Context } from 'grammy';
import type { Update } from '@grammyjs/types';

// ─── Abstract Transport Interface ───────────────────────────────────────────

/** Normalized inbound message from the transport layer. */
export interface TelegramTransportMessage {
  /** Telegram message ID. */
  messageId: number;
  /** Chat ID. */
  chatId: number;
  /** Chat type (private, group, supergroup, channel). */
  chatType: string;
  /** Sender user ID. */
  fromId: number;
  /** Sender first name. */
  firstName: string;
  /** Sender last name (may be empty). */
  lastName?: string;
  /** Sender username (may be empty). */
  username?: string;
  /** Text content. */
  text?: string;
  /** Caption for media messages. */
  caption?: string;
  /** Message entities (bold, link, etc.). */
  entities?: unknown[];
  /** Voice note metadata. */
  voice?: { duration: number; mimeType?: string };
  /** Photo metadata (highest resolution). */
  photo?: { width: number; height: number; fileSize?: number };
  /** File path for media downloads (from Telegram API). */
  filePath?: string;
  /** ID of the message being replied to. */
  replyToMessageId?: number;
  /** Unix timestamp in seconds. */
  timestamp: number;
}

/** Options for sending a message. */
export interface TelegramSendOptions {
  chatId: number;
  text: string;
  parseMode?: 'MarkdownV2';
  replyToMessageId?: number;
}

/** Transport connection state. */
export type TelegramConnectionState = 'disconnected' | 'connecting' | 'connected';

/** Event handlers the transport calls. */
export interface TelegramTransportHandlers {
  onMessage: (msg: TelegramTransportMessage) => void;
  onConnectionState: (state: TelegramConnectionState) => void;
  onError: (error: Error) => void;
}

/**
 * Abstract Telegram transport interface.
 *
 * Implement this to swap the underlying Telegram library.
 * The current implementation uses grammY.
 */
export interface TelegramTransport {
  /** Start polling for messages. */
  connect(handlers: TelegramTransportHandlers): Promise<void>;
  /** Stop polling and disconnect. */
  disconnect(): Promise<void>;
  /** Send a text message. Throws on failure. */
  sendMessage(options: TelegramSendOptions): Promise<void>;
  /** Download a file by its Telegram file path. Returns the file buffer. */
  downloadFile(filePath: string): Promise<Buffer>;
  /** Current connection state. */
  connectionState(): TelegramConnectionState;
}

// ─── grammY Implementation ──────────────────────────────────────────────────

export interface GrammyTransportOptions {
  /** Bot token from @BotFather. */
  botToken: string;
  /** Telegram API base URL (for testing). */
  apiRoot?: string;
  /** Optional fetch function override (for testing). */
  fetchFn?: typeof fetch;
}

/**
 * Long-poll timeout in seconds. Each getUpdates call blocks for this long.
 * Shorter values mean faster reconnection after errors but more API calls.
 */
const POLLING_TIMEOUT_SECONDS = 10;

/**
 * Telegram transport backed by grammY.
 *
 * Uses a manual fetch-based polling loop instead of Grammy's bot.start()
 * to avoid 409 Conflict cycles. Grammy's bot.stop() sends a final
 * getUpdates to confirm offsets, which creates a new session that conflicts
 * with the next bot.start(). By controlling the polling loop ourselves,
 * we guarantee exactly one getUpdates request at a time and handle 409
 * as a transient retry instead of a fatal reconnection trigger.
 *
 * Grammy is still used for: update processing (middleware, handlers),
 * message sending (bot.api), and file downloads.
 */
export class GrammyTransport implements TelegramTransport {
  private bot: Bot;
  private readonly botToken: string;
  private readonly apiRoot: string | undefined;
  private readonly fetchFn: typeof fetch;
  private state: TelegramConnectionState = 'disconnected';
  private handlers: TelegramTransportHandlers | undefined;
  private shouldPoll = false;
  private pollOffset = 0;

  constructor(options: GrammyTransportOptions) {
    this.botToken = options.botToken;
    this.apiRoot = options.apiRoot;
    this.bot = new Bot(options.botToken, {
      client: { apiRoot: options.apiRoot },
    });
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  async connect(handlers: TelegramTransportHandlers): Promise<void> {
    this.handlers = handlers;
    this.state = 'connecting';
    this.shouldPoll = true;

    // Create a fresh Bot instance for update processing and API calls.
    // We never call bot.start() — polling is handled by our own loop.
    this.bot = new Bot(this.botToken, {
      client: { apiRoot: this.apiRoot },
    });
    this.setupBotHandlers();

    // Initialize bot info (required before handleUpdate works).
    await this.bot.init();

    // Clear any stale webhook so Telegram allows long-polling.
    await this.bot.api.deleteWebhook({ drop_pending_updates: false });

    this.state = 'connected';
    handlers.onConnectionState('connected');

    // Start the polling loop in the background. Errors are handled
    // internally (409 → retry) or escalated to the adapter (fatal).
    this.pollLoop(handlers);
  }

  async disconnect(): Promise<void> {
    this.shouldPoll = false;
    this.state = 'disconnected';
    this.handlers?.onConnectionState('disconnected');
    console.log('[telegram-transport] Disconnected');
  }

  async sendMessage(options: TelegramSendOptions): Promise<void> {
    if (this.state !== 'connected') {
      throw new Error('Telegram transport not connected');
    }

    await this.bot.api.sendMessage(options.chatId, options.text, {
      ...(options.parseMode ? { parse_mode: options.parseMode } : {}),
      ...(options.replyToMessageId
        ? { reply_parameters: { message_id: options.replyToMessageId } }
        : {}),
    });
  }

  async downloadFile(filePath: string): Promise<Buffer> {
    const apiBase = this.apiRoot ?? 'https://api.telegram.org';
    const url = `${apiBase}/file/bot${this.botToken}/${filePath}`;
    const response = await this.fetchFn(url);
    if (!response.ok) {
      throw new Error(`Failed to download file: ${response.status} ${response.statusText}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  connectionState(): TelegramConnectionState {
    return this.state;
  }

  // ── Polling Loop ────────────────────────────────────────────────────────

  /**
   * Manual long-polling loop using fetch. Guarantees exactly one getUpdates
   * request at a time. Handles 409 as a transient condition (wait + retry)
   * instead of triggering a full reconnection cycle.
   */
  private pollLoop(handlers: TelegramTransportHandlers): void {
    const run = async () => {
      while (this.shouldPoll) {
        try {
          const updates = await this.getUpdates();

          for (const update of updates) {
            this.pollOffset = update.update_id + 1;
            try {
              await this.bot.handleUpdate(update);
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              console.error(`[telegram-transport] Update handler error: ${msg}`);
            }
          }
        } catch (err: unknown) {
          if (!this.shouldPoll) break;

          const message = err instanceof Error ? err.message : String(err);

          const statusCode = (err as { statusCode?: number }).statusCode;
          if (statusCode === 409 || message.includes('Conflict')) {
            // 409 Conflict — another getUpdates session exists (stale).
            // Wait for it to expire naturally, then retry. Do NOT escalate
            // to the adapter — that triggers bot.stop() which perpetuates 409s.
            console.log(
              `[telegram-transport] 409 conflict, waiting ${POLLING_TIMEOUT_SECONDS}s for stale session to expire...`,
            );
            await new Promise((resolve) => setTimeout(resolve, POLLING_TIMEOUT_SECONDS * 1000));
            continue;
          }

          // Non-409 error — escalate to adapter for reconnection
          console.error(`[telegram-transport] Polling error: ${message}`);
          this.state = 'disconnected';
          handlers.onConnectionState('disconnected');
          handlers.onError(err instanceof Error ? err : new Error(message));
          return;
        }
      }
    };

    void run();
  }

  /**
   * Single getUpdates call via fetch. Returns the array of Update objects.
   * Throws on API errors (including 409).
   */
  private async getUpdates(): Promise<Update[]> {
    const apiBase = this.apiRoot ?? 'https://api.telegram.org';
    const params = new URLSearchParams({
      timeout: String(POLLING_TIMEOUT_SECONDS),
      offset: String(this.pollOffset),
      allowed_updates: JSON.stringify(['message']),
    });
    const url = `${apiBase}/bot${this.botToken}/getUpdates?${params}`;

    const response = await this.fetchFn(url);
    const data = (await response.json()) as {
      ok: boolean;
      result?: Update[];
      description?: string;
    };

    if (!data.ok) {
      const err = new Error(data.description ?? `getUpdates failed: HTTP ${response.status}`);
      // Attach the HTTP status so callers can distinguish 409 from other errors.
      (err as Error & { statusCode: number }).statusCode = response.status;
      throw err;
    }

    return data.result ?? [];
  }

  // ── Grammy Handlers ─────────────────────────────────────────────────────

  private setupBotHandlers(): void {
    if (!this.handlers) return;
    const handlers = this.handlers;

    // Debug: trace all incoming updates
    this.bot.use((ctx, next) => {
      console.log(
        `[telegram-transport] Update: hasMsg=${!!ctx.message}, text=${ctx.message?.text}, from=${ctx.from?.id}`,
      );
      return next();
    });

    // Error handler
    this.bot.catch((err) => {
      console.error('[telegram-transport] Bot error:', err.message);
      handlers.onError(err.error instanceof Error ? err.error : new Error(err.message));
    });

    // Text messages
    this.bot.on('message:text', (ctx) => {
      handlers.onMessage(this.normalizeCtx(ctx, { text: ctx.message.text }));
    });

    // Voice notes
    this.bot.on('message:voice', async (ctx) => {
      const file = await ctx.getFile();
      handlers.onMessage(
        this.normalizeCtx(ctx, {
          caption: ctx.message.caption,
          voice: {
            duration: ctx.message.voice.duration,
            mimeType: ctx.message.voice.mime_type,
          },
          filePath: file.file_path,
        }),
      );
    });

    // Photos
    this.bot.on('message:photo', async (ctx) => {
      const photos = ctx.message.photo;
      const photo = photos[photos.length - 1];
      if (!photo) return;
      const file = await ctx.getFile();
      handlers.onMessage(
        this.normalizeCtx(ctx, {
          caption: ctx.message.caption,
          photo: {
            width: photo.width,
            height: photo.height,
            fileSize: photo.file_size,
          },
          filePath: file.file_path,
        }),
      );
    });
  }

  private normalizeCtx(
    ctx: Context,
    extra: Partial<TelegramTransportMessage>,
  ): TelegramTransportMessage {
    const msg = ctx.message;
    const chat = ctx.chat;
    const from = ctx.from;
    return {
      messageId: msg?.message_id ?? 0,
      chatId: chat?.id ?? 0,
      chatType: chat?.type ?? 'private',
      fromId: from?.id ?? 0,
      firstName: from?.first_name ?? '',
      lastName: from?.last_name,
      username: from?.username,
      entities: msg?.entities,
      replyToMessageId: msg?.reply_to_message?.message_id,
      timestamp: msg?.date ?? 0,
      ...extra,
    };
  }
}
