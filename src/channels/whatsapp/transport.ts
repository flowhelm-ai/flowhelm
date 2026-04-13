/**
 * Abstract WhatsApp transport layer.
 *
 * Decouples the WhatsApp adapter from any specific library (Baileys, etc.).
 * The transport handles the WebSocket connection, message sending/receiving,
 * and auth state management. The adapter handles message normalization,
 * file downloads, and ChannelAdapter interface compliance.
 *
 * To swap libraries: implement WhatsAppTransport with a different backend.
 */

import makeWASocket, {
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
  type WASocket,
  type WAMessage,
  type ConnectionState,
  type AuthenticationState,
} from '@whiskeysockets/baileys';

/** No-op logger that suppresses all Baileys internal logging. */
const noop = (): void => {};
const noopLogger = {
  level: 'silent',
  child: () => noopLogger,
  trace: noop,
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
} as const;

// ─── Abstract Transport Interface ───────────────────────────────────────────

/** Normalized inbound message from the transport layer. */
export interface TransportMessage {
  /** Platform message ID. */
  id: string;
  /** Sender JID (e.g., 14155551234@s.whatsapp.net). */
  senderJid: string;
  /** Chat JID (same as sender for DM, group JID for groups). */
  chatJid: string;
  /** Sender display name (push name). */
  senderName: string;
  /** Text content. */
  text?: string;
  /** Audio buffer (voice notes). */
  audioBuffer?: Buffer;
  /** Audio MIME type (e.g., audio/ogg; codecs=opus). */
  audioMimeType?: string;
  /** Image buffer. */
  imageBuffer?: Buffer;
  /** Image MIME type. */
  imageMimeType?: string;
  /** Caption for media messages. */
  caption?: string;
  /** Whether this message was sent by us. */
  isFromMe: boolean;
  /** Unix timestamp in seconds. */
  timestamp: number;
  /** Quoted message ID (if replying). */
  quotedMessageId?: string;
}

/** Content to send via the transport. */
export interface TransportSendContent {
  text?: string;
  // Future: image, audio, document, etc.
}

/** Transport connection state. */
export type TransportConnectionState = 'disconnected' | 'connecting' | 'connected';

/** Event handlers the transport calls. */
export interface TransportEventHandlers {
  onMessage: (msg: TransportMessage) => void;
  onQrCode: (qr: string) => void;
  onConnectionState: (state: TransportConnectionState) => void;
  onAuthStateUpdate: () => Promise<void>;
}

/**
 * Abstract WhatsApp transport interface.
 *
 * Implement this to swap the underlying WhatsApp library.
 * The current implementation uses @whiskeysockets/baileys.
 */
export interface WhatsAppTransport {
  /** Connect to WhatsApp. Auth state must be loaded before calling this. */
  connect(authState: AuthenticationState, handlers: TransportEventHandlers): Promise<void>;
  /** Disconnect from WhatsApp. */
  disconnect(): Promise<void>;
  /** Send a message to a JID. */
  sendMessage(jid: string, content: TransportSendContent): Promise<void>;
  /** Current connection state. */
  connectionState(): TransportConnectionState;
}

// ─── Baileys Implementation ─────────────────────────────────────────────────

export interface BaileysTransportOptions {
  /** Logger instance. Baileys is noisy — default suppresses most output. */
  logger?: { level: string };
  /** Print QR to terminal (for development). Default: false. */
  printQrInTerminal?: boolean;
}

/**
 * WhatsApp transport backed by @whiskeysockets/baileys.
 *
 * Can be replaced with another library by implementing WhatsAppTransport.
 */
export class BaileysTransport implements WhatsAppTransport {
  private socket: WASocket | undefined;
  private state: TransportConnectionState = 'disconnected';
  private handlers: TransportEventHandlers | undefined;
  private readonly printQrInTerminal: boolean;

  constructor(options?: BaileysTransportOptions) {
    this.printQrInTerminal = options?.printQrInTerminal ?? false;
  }

  async connect(authState: AuthenticationState, handlers: TransportEventHandlers): Promise<void> {
    this.handlers = handlers;
    this.state = 'connecting';
    handlers.onConnectionState('connecting');

    const socket = makeWASocket({
      auth: {
        creds: authState.creds,
        keys: makeCacheableSignalKeyStore(authState.keys),
      },
      printQRInTerminal: this.printQrInTerminal,
      // Suppress Baileys internal logging — noop logger satisfying ILogger interface
      logger: noopLogger,
    });

    this.socket = socket;

    // Connection updates (QR code, open, close)
    socket.ev.on('connection.update', (update: Partial<ConnectionState>) => {
      this.handleConnectionUpdate(update);
    });

    // Credential updates (save back to vault)
    socket.ev.on('creds.update', () => {
      void handlers.onAuthStateUpdate();
    });

    // Incoming messages
    socket.ev.on('messages.upsert', (upsert) => {
      if (upsert.type !== 'notify') return;
      for (const msg of upsert.messages) {
        void this.handleMessage(msg);
      }
    });
  }

  async disconnect(): Promise<void> {
    this.state = 'disconnected';
    if (this.socket) {
      this.socket.end(undefined);
      this.socket = undefined;
    }
  }

  async sendMessage(jid: string, content: TransportSendContent): Promise<void> {
    if (!this.socket || this.state !== 'connected') {
      throw new Error('WhatsApp transport not connected');
    }
    if (content.text) {
      await this.socket.sendMessage(jid, { text: content.text });
    }
  }

  connectionState(): TransportConnectionState {
    return this.state;
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private handleConnectionUpdate(update: Partial<ConnectionState>): void {
    if (!this.handlers) return;

    if (update.qr) {
      this.handlers.onQrCode(update.qr);
    }

    if (update.connection === 'open') {
      this.state = 'connected';
      this.handlers.onConnectionState('connected');
    }

    if (update.connection === 'close') {
      this.state = 'disconnected';
      this.handlers.onConnectionState('disconnected');
    }
  }

  private async handleMessage(raw: WAMessage): Promise<void> {
    if (!this.handlers || !raw.message) return;

    const chatJid = raw.key.remoteJid ?? '';
    const senderJid = raw.key.participant ?? chatJid;
    const isFromMe = raw.key.fromMe ?? false;
    const timestamp =
      typeof raw.messageTimestamp === 'number'
        ? raw.messageTimestamp
        : Number(raw.messageTimestamp ?? 0);

    // Extract push name
    const senderName = raw.pushName ?? senderJid.split('@')[0] ?? 'Unknown';

    // Determine message type and extract content
    const msg: TransportMessage = {
      id: raw.key.id ?? '',
      senderJid,
      chatJid,
      senderName,
      isFromMe,
      timestamp,
      quotedMessageId: raw.message.extendedTextMessage?.contextInfo?.stanzaId ?? undefined,
    };

    const m = raw.message;

    // Text message
    if (m.conversation) {
      msg.text = m.conversation;
    } else if (m.extendedTextMessage?.text) {
      msg.text = m.extendedTextMessage.text;
    }

    // Voice note / audio
    if (m.audioMessage) {
      try {
        const buffer = (await downloadMediaMessage(raw, 'buffer', {})) as Buffer;
        msg.audioBuffer = buffer;
        msg.audioMimeType = m.audioMessage.mimetype ?? 'audio/ogg; codecs=opus';
        msg.caption = undefined; // Audio messages don't have captions
      } catch (err) {
        console.error('[whatsapp-transport] Failed to download audio:', err);
      }
    }

    // Image
    if (m.imageMessage) {
      try {
        const buffer = (await downloadMediaMessage(raw, 'buffer', {})) as Buffer;
        msg.imageBuffer = buffer;
        msg.imageMimeType = m.imageMessage.mimetype ?? 'image/jpeg';
        msg.caption = m.imageMessage.caption ?? undefined;
      } catch (err) {
        console.error('[whatsapp-transport] Failed to download image:', err);
      }
    }

    this.handlers.onMessage(msg);
  }
}

// ─── Re-exports for auth state ──────────────────────────────────────────────

export {
  initAuthCreds,
  type AuthenticationState,
  type AuthenticationCreds,
  type SignalKeyStore,
} from '@whiskeysockets/baileys';

export { downloadMediaMessage };
