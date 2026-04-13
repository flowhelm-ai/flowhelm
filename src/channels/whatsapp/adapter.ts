/**
 * WhatsApp channel adapter.
 *
 * Implements ChannelAdapter using the abstract WhatsApp transport layer.
 * Handles message normalization (text, voice notes, images), access control,
 * vault-backed session persistence, and reconnection with exponential backoff.
 *
 * Voice notes are saved as OGG files to the downloads directory for STT
 * processing by the service container.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ChannelAdapter, InboundMessage, OutboundMessage } from '../../orchestrator/types.js';
import type { WhatsAppTransport, TransportMessage, TransportConnectionState } from './transport.js';
import type { VaultAuthState } from './auth-state.js';
import { useVaultAuthState } from './auth-state.js';
import type { CredentialStore } from '../../proxy/credential-store.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WhatsAppAdapterOptions {
  /** Transport implementation (BaileysTransport or any WhatsAppTransport). */
  transport: WhatsAppTransport;
  /** Credential store for vault-backed auth state. */
  credentialStore: CredentialStore;
  /** Directory for downloaded media files (voice notes, images). */
  downloadDir: string;
  /**
   * Allowed WhatsApp JIDs. Empty array = allow all.
   * Use the number portion (e.g., "14155551234") — matched against sender JID.
   */
  allowedNumbers: string[];
  /** Max reconnection attempts before giving up. 0 = unlimited. Default: 0. */
  maxReconnectAttempts?: number;
  /** Base delay for exponential backoff (ms). Default: 1000. */
  reconnectBaseDelay?: number;
  /** Max backoff delay (ms). Default: 60000. */
  reconnectMaxDelay?: number;
  /** Callback for QR codes (e.g., display in terminal). */
  onQrCode?: (qr: string) => void;
}

type MessageHandler = (msg: InboundMessage) => void;

// ─── Adapter ────────────────────────────────────────────────────────────────

export class WhatsAppAdapter implements ChannelAdapter {
  readonly name = 'WhatsApp';
  readonly type = 'whatsapp' as const;

  private readonly transport: WhatsAppTransport;
  private readonly credentialStore: CredentialStore;
  private readonly downloadDir: string;
  private readonly allowedNumbers: Set<string>;
  private readonly maxReconnectAttempts: number;
  private readonly reconnectBaseDelay: number;
  private readonly reconnectMaxDelay: number;
  private readonly onQrCode: ((qr: string) => void) | undefined;
  private handlers: MessageHandler[] = [];
  private reconnectAttempts = 0;
  private authState: VaultAuthState | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: WhatsAppAdapterOptions) {
    this.transport = options.transport;
    this.credentialStore = options.credentialStore;
    this.downloadDir = options.downloadDir;
    this.allowedNumbers = new Set(options.allowedNumbers);
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 0;
    this.reconnectBaseDelay = options.reconnectBaseDelay ?? 1000;
    this.reconnectMaxDelay = options.reconnectMaxDelay ?? 60_000;
    this.onQrCode = options.onQrCode;
  }

  // ── ChannelAdapter interface ─────────────────────────────────────────────

  async connect(): Promise<void> {
    await mkdir(this.downloadDir, { recursive: true });

    // Initialize vault-backed auth state
    this.authState = await useVaultAuthState({
      store: this.credentialStore,
    });

    await this.transport.connect(this.authState.state, {
      onMessage: (msg) => {
        void this.handleTransportMessage(msg);
      },
      onQrCode: (qr) => {
        console.log('[whatsapp] QR code received — scan with your phone');
        this.onQrCode?.(qr);
      },
      onConnectionState: (state) => {
        this.handleConnectionState(state);
      },
      onAuthStateUpdate: async () => {
        // Baileys fires creds.update — persist to vault
        await this.authState?.saveCreds();
      },
    });
  }

  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    await this.transport.disconnect();
    console.log('[whatsapp] Disconnected');
  }

  async send(message: OutboundMessage): Promise<void> {
    if (!this.isConnected()) {
      throw new Error('WhatsApp adapter not connected');
    }

    const jid = parseWhatsAppJid(message.userId);

    // WhatsApp has a generous 65536 char limit — split at 4096 for readability
    const chunks = splitMessage(message.text);
    for (const chunk of chunks) {
      await this.transport.sendMessage(jid, { text: chunk });
    }
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  isConnected(): boolean {
    return this.transport.connectionState() === 'connected';
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private handleConnectionState(state: TransportConnectionState): void {
    if (state === 'connected') {
      this.reconnectAttempts = 0;
      console.log('[whatsapp] Connected');
    } else if (state === 'disconnected') {
      console.log('[whatsapp] Connection closed');
      this.handleReconnection();
    }
  }

  private async handleTransportMessage(msg: TransportMessage): Promise<void> {
    // Skip messages from self
    if (msg.isFromMe) return;

    // Access control
    const number = msg.senderJid.split('@')[0] ?? '';
    if (!this.isNumberAllowed(number)) {
      console.log(`[whatsapp] Number ${number} not allowed, ignoring`);
      return;
    }

    // Normalize to InboundMessage
    const inbound: InboundMessage = {
      id: msg.id,
      channel: 'whatsapp',
      userId: `wa:${msg.chatJid}`,
      senderName: msg.senderName,
      text: msg.text ?? msg.caption,
      replyToMessageId: msg.quotedMessageId,
      timestamp: msg.timestamp * 1000, // Baileys uses seconds, FlowHelm uses ms
      isFromMe: false,
      metadata: {
        senderJid: msg.senderJid,
        chatJid: msg.chatJid,
      },
    };

    // Voice note — save to downloads dir for service STT
    if (msg.audioBuffer) {
      const ext = mimeToExtension(msg.audioMimeType ?? 'audio/ogg');
      const audioPath = join(this.downloadDir, `${randomUUID()}.${ext}`);
      await writeFile(audioPath, msg.audioBuffer);
      inbound.audioPath = audioPath;
      inbound.metadata.mimeType = msg.audioMimeType;
    }

    // Image — save to downloads dir
    if (msg.imageBuffer) {
      const ext = mimeToExtension(msg.imageMimeType ?? 'image/jpeg');
      const imagePath = join(this.downloadDir, `${randomUUID()}.${ext}`);
      await writeFile(imagePath, msg.imageBuffer);
      inbound.imagePath = imagePath;
      inbound.metadata.mimeType = msg.imageMimeType;
    }

    this.emit(inbound);
  }

  private isNumberAllowed(number: string): boolean {
    if (this.allowedNumbers.size === 0) return true;
    return this.allowedNumbers.has(number);
  }

  private emit(msg: InboundMessage): void {
    for (const handler of this.handlers) {
      handler(msg);
    }
  }

  // ── Reconnection ──────────────────────────────────────────────────────

  private handleReconnection(): void {
    if (!this.authState) return; // Never connected

    this.reconnectAttempts++;
    if (this.maxReconnectAttempts > 0 && this.reconnectAttempts > this.maxReconnectAttempts) {
      console.error(
        `[whatsapp] Max reconnection attempts (${this.maxReconnectAttempts}) reached. Giving up.`,
      );
      return;
    }

    const delay = Math.min(
      this.reconnectBaseDelay * Math.pow(2, this.reconnectAttempts - 1),
      this.reconnectMaxDelay,
    );

    console.log(`[whatsapp] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      void this.reconnect();
    }, delay);
  }

  private async reconnect(): Promise<void> {
    if (!this.authState) return;
    try {
      await this.transport.connect(this.authState.state, {
        onMessage: (msg) => {
          void this.handleTransportMessage(msg);
        },
        onQrCode: (qr) => {
          this.onQrCode?.(qr);
        },
        onConnectionState: (state) => {
          this.handleConnectionState(state);
        },
        onAuthStateUpdate: async () => {
          await this.authState?.saveCreds();
        },
      });
    } catch (err) {
      console.error('[whatsapp] Reconnection failed:', err);
      this.handleReconnection();
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Parse a FlowHelm chat ID (wa:...) into a WhatsApp JID.
 * Examples: "wa:14155551234@s.whatsapp.net" → "14155551234@s.whatsapp.net"
 */
export function parseWhatsAppJid(userId: string): string {
  if (!userId.startsWith('wa:')) {
    throw new Error(`Invalid WhatsApp chat ID: ${userId}`);
  }
  return userId.slice(3);
}

/**
 * Split a message into WhatsApp-safe chunks.
 * WhatsApp technically supports ~65536 chars but we split at 4096 for readability.
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
 * Map MIME type to file extension for media downloads.
 */
function mimeToExtension(mime: string): string {
  // Normalize: "audio/ogg; codecs=opus" → "audio/ogg"
  const base = (mime.split(';')[0] ?? mime).trim().toLowerCase();
  const map: Record<string, string> = {
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/wav': 'wav',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
  };
  return map[base] ?? 'bin';
}
