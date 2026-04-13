/**
 * Telegram channel adapter.
 *
 * Implements ChannelAdapter using the abstract TelegramTransport layer.
 * Handles message normalization (text, voice notes, images), access control,
 * MarkdownV2 formatting with fallback, message splitting, and reconnection
 * with exponential backoff.
 *
 * To swap the underlying library: provide a different TelegramTransport
 * implementation. The current default is GrammyTransport.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ChannelAdapter, InboundMessage, OutboundMessage } from '../../orchestrator/types.js';
import {
  GrammyTransport,
  type TelegramTransport,
  type TelegramTransportMessage,
  type TelegramConnectionState,
} from './transport.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TelegramAdapterOptions {
  /** Transport implementation (GrammyTransport or any TelegramTransport). */
  transport: TelegramTransport;
  /** Allowed Telegram user IDs. Empty array = allow all. */
  allowedUsers: number[];
  /** Directory for downloaded media files. */
  downloadDir: string;
  /** Max reconnection attempts before giving up. 0 = unlimited. */
  maxReconnectAttempts?: number;
  /** Base delay for exponential backoff (ms). Default: 5000. */
  reconnectBaseDelay?: number;
  /** Max backoff delay (ms). Default: 60000. */
  reconnectMaxDelay?: number;
}

type MessageHandler = (msg: InboundMessage) => void;

// Telegram MarkdownV2 special characters that need escaping
const MARKDOWN_V2_SPECIAL = /([_*[\]()~`>#+\-=|{}.!\\])/g;

// ─── Adapter ────────────────────────────────────────────────────────────────

export class TelegramAdapter implements ChannelAdapter {
  readonly name = 'Telegram';
  readonly type = 'telegram' as const;

  private readonly transport: TelegramTransport;
  private readonly allowedUsers: Set<number>;
  private readonly downloadDir: string;
  private readonly maxReconnectAttempts: number;
  private readonly reconnectBaseDelay: number;
  private readonly reconnectMaxDelay: number;
  private handlers: MessageHandler[] = [];
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: TelegramAdapterOptions) {
    this.transport = options.transport;
    this.allowedUsers = new Set(options.allowedUsers);
    this.downloadDir = options.downloadDir;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 0;
    this.reconnectBaseDelay = options.reconnectBaseDelay ?? 5000;
    this.reconnectMaxDelay = options.reconnectMaxDelay ?? 60_000;
  }

  // ── ChannelAdapter interface ─────────────────────────────────────────────

  async connect(): Promise<void> {
    await mkdir(this.downloadDir, { recursive: true });

    await this.transport.connect({
      onMessage: (msg) => {
        void this.handleTransportMessage(msg);
      },
      onConnectionState: (state) => {
        this.handleConnectionState(state);
      },
      onError: (err) => {
        console.error('[telegram] Transport error:', err.message);
        this.handleReconnection();
      },
    });
  }

  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    await this.transport.disconnect();
    console.log('[telegram] Disconnected');
  }

  async send(message: OutboundMessage): Promise<void> {
    if (!this.isConnected()) throw new Error('Telegram adapter not connected');

    const chatId = parseTelegramChatId(message.userId);
    const chunks = splitMessage(message.text);

    for (const chunk of chunks) {
      try {
        // Try MarkdownV2 first
        await this.transport.sendMessage({
          chatId,
          text: chunk,
          parseMode: 'MarkdownV2',
          replyToMessageId: message.replyToMessageId ? Number(message.replyToMessageId) : undefined,
        });
      } catch {
        // Fall back to plain text if MarkdownV2 parsing fails
        await this.transport.sendMessage({
          chatId,
          text: stripMarkdown(chunk),
          replyToMessageId: message.replyToMessageId ? Number(message.replyToMessageId) : undefined,
        });
      }
    }
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  isConnected(): boolean {
    return this.transport.connectionState() === 'connected';
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private handleConnectionState(state: TelegramConnectionState): void {
    if (state === 'connected') {
      this.reconnectAttempts = 0;
      console.log('[telegram] Connected and polling');
    } else if (state === 'disconnected') {
      console.log('[telegram] Connection closed');
    }
  }

  private async handleTransportMessage(msg: TelegramTransportMessage): Promise<void> {
    // Access control
    if (!this.isUserAllowed(msg.fromId)) {
      console.log(`[telegram] User ${msg.fromId} not allowed`);
      // Send access denied reply via transport
      try {
        await this.transport.sendMessage({
          chatId: msg.chatId,
          text: 'Access denied. Contact the administrator to get access.',
        });
      } catch {
        // Best-effort reply
      }
      return;
    }

    // Handle /start — Telegram sends this when a user first opens the bot.
    // Reply with a friendly greeting instead of forwarding to the agent.
    if (msg.text?.trim() === '/start') {
      const name = msg.firstName || msg.username || 'there';
      await this.transport.sendMessage({
        chatId: msg.chatId,
        text: `Hi ${name}! I'm your FlowHelm assistant. Send me a message and I'll help you out.`,
      });
      return;
    }

    // Normalize to InboundMessage
    const inbound: InboundMessage = {
      id: String(msg.messageId),
      channel: 'telegram',
      userId: `tg:${msg.chatId}`,
      senderName: buildSenderName(msg),
      text: msg.text ?? msg.caption,
      replyToMessageId: msg.replyToMessageId ? String(msg.replyToMessageId) : undefined,
      timestamp: msg.timestamp * 1000, // Telegram uses seconds, FlowHelm uses ms
      isFromMe: false,
      metadata: {
        telegramUserId: msg.fromId,
        chatType: msg.chatType,
        ...(msg.entities ? { entities: msg.entities } : {}),
      },
    };

    // Voice note — download and save
    if (msg.voice && msg.filePath) {
      const buffer = await this.transport.downloadFile(msg.filePath);
      const audioPath = join(this.downloadDir, `${randomUUID()}.ogg`);
      await writeFile(audioPath, buffer);
      inbound.audioPath = audioPath;
      inbound.text = msg.caption;
      inbound.metadata['duration'] = msg.voice.duration;
      inbound.metadata['mimeType'] = msg.voice.mimeType;
    }

    // Photo — download and save
    if (msg.photo && msg.filePath) {
      const buffer = await this.transport.downloadFile(msg.filePath);
      const imagePath = join(this.downloadDir, `${randomUUID()}.jpg`);
      await writeFile(imagePath, buffer);
      inbound.imagePath = imagePath;
      inbound.text = msg.caption;
      inbound.metadata['width'] = msg.photo.width;
      inbound.metadata['height'] = msg.photo.height;
      inbound.metadata['fileSize'] = msg.photo.fileSize;
    }

    this.emit(inbound);
  }

  private isUserAllowed(userId: number): boolean {
    if (this.allowedUsers.size === 0) return true;
    return this.allowedUsers.has(userId);
  }

  private emit(msg: InboundMessage): void {
    for (const handler of this.handlers) {
      handler(msg);
    }
  }

  // ── Reconnection ─────────────────────────────────────────────────────

  private handleReconnection(): void {
    if (this.transport.connectionState() === 'connecting') return;

    // Clear any pending reconnect timer to prevent overlapping attempts.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    this.reconnectAttempts++;
    if (this.maxReconnectAttempts > 0 && this.reconnectAttempts > this.maxReconnectAttempts) {
      console.error(
        `[telegram] Max reconnection attempts (${this.maxReconnectAttempts}) reached. Giving up.`,
      );
      return;
    }

    const delay = Math.min(
      this.reconnectBaseDelay * Math.pow(2, this.reconnectAttempts - 1),
      this.reconnectMaxDelay,
    );

    console.log(`[telegram] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      void this.transport.connect({
        onMessage: (msg) => {
          void this.handleTransportMessage(msg);
        },
        onConnectionState: (state) => {
          this.handleConnectionState(state);
        },
        onError: (err) => {
          console.error('[telegram] Transport error:', err.message);
          this.handleReconnection();
        },
      });
    }, delay);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Build display name from transport message sender fields. */
function buildSenderName(msg: TelegramTransportMessage): string {
  if (msg.firstName && msg.lastName) {
    return `${msg.firstName} ${msg.lastName}`;
  }
  return msg.firstName || msg.username || String(msg.fromId);
}

/**
 * Parse a FlowHelm chat ID (tg:123) into a numeric Telegram chat ID.
 * Supports both positive (DM) and negative (group) chat IDs.
 */
export function parseTelegramChatId(userId: string): number {
  const match = userId.match(/^tg:(-?\d+)$/);
  if (!match) throw new Error(`Invalid Telegram chat ID: ${userId}`);
  return Number(match[1]);
}

/**
 * Escape text for Telegram MarkdownV2.
 * Escapes all special characters defined in the Telegram Bot API docs.
 */
export function escapeMarkdownV2(text: string): string {
  return text.replace(MARKDOWN_V2_SPECIAL, '\\$1');
}

/**
 * Strip markdown formatting to produce plain text.
 * Used as fallback when MarkdownV2 parsing fails.
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, '$1') // remove MD escapes
    .replace(/[*_~`]/g, ''); // remove formatting chars
}

/**
 * Split a message into Telegram-safe chunks (max 4096 chars).
 * Splits on newlines when possible, otherwise hard-splits.
 */
export function splitMessage(text: string, maxLen = 4096): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let splitIdx = remaining.lastIndexOf('\n', maxLen);
    if (splitIdx <= 0 || splitIdx < maxLen * 0.5) {
      splitIdx = remaining.lastIndexOf(' ', maxLen);
    }
    if (splitIdx <= 0 || splitIdx < maxLen * 0.5) {
      splitIdx = maxLen;
    }
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

/**
 * Create a TelegramAdapter from FlowHelm config, or return null if
 * Telegram is not configured. Uses GrammyTransport as the default transport.
 */
export function createTelegramAdapter(
  config: { botToken: string; allowedUsers: number[] } | undefined,
  downloadDir: string,
  transport?: TelegramTransport,
): TelegramAdapter | null {
  if (!config) return null;

  return new TelegramAdapter({
    transport: transport ?? new GrammyTransport({ botToken: config.botToken }),
    allowedUsers: config.allowedUsers,
    downloadDir,
  });
}
