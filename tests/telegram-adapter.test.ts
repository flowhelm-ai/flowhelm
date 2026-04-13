/**
 * Tests for the Telegram channel adapter.
 *
 * Tests cover: transport abstraction, text/voice/image normalization,
 * access control, outbound formatting, message splitting, JID parsing,
 * reconnection.
 *
 * Uses a MockTelegramTransport — no real grammY or Telegram API calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TelegramAdapter,
  parseTelegramChatId,
  escapeMarkdownV2,
  stripMarkdown,
  splitMessage,
  createTelegramAdapter,
} from '../src/channels/telegram/adapter.js';
import type {
  TelegramTransport,
  TelegramTransportMessage,
  TelegramSendOptions,
  TelegramConnectionState,
  TelegramTransportHandlers,
} from '../src/channels/telegram/transport.js';
import type { InboundMessage, OutboundMessage } from '../src/orchestrator/types.js';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── Mock Transport ──────────────────────────────────────────────────────────

class MockTelegramTransport implements TelegramTransport {
  private state: TelegramConnectionState = 'disconnected';
  private handlers: TelegramTransportHandlers | undefined;
  readonly sentMessages: TelegramSendOptions[] = [];
  readonly fileDownloads: string[] = [];
  connectCalls = 0;
  disconnectCalls = 0;

  /** File content returned by downloadFile. Override per test. */
  fileContent = Buffer.from('fake-file-content');

  async connect(handlers: TelegramTransportHandlers): Promise<void> {
    this.connectCalls++;
    this.handlers = handlers;
    this.state = 'connected';
    handlers.onConnectionState('connected');
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls++;
    this.state = 'disconnected';
    this.handlers?.onConnectionState('disconnected');
  }

  async sendMessage(options: TelegramSendOptions): Promise<void> {
    if (this.state !== 'connected') throw new Error('Not connected');
    this.sentMessages.push(options);
  }

  async downloadFile(filePath: string): Promise<Buffer> {
    this.fileDownloads.push(filePath);
    return this.fileContent;
  }

  connectionState(): TelegramConnectionState {
    return this.state;
  }

  // Test helpers
  simulateMessage(msg: TelegramTransportMessage): void {
    this.handlers?.onMessage(msg);
  }

  simulateError(err: Error): void {
    this.handlers?.onError(err);
  }
}

// ─── Test Fixtures ────────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'flowhelm-tg-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function createTransport(): MockTelegramTransport {
  return new MockTelegramTransport();
}

function createAdapter(
  transport: MockTelegramTransport,
  options?: Partial<ConstructorParameters<typeof TelegramAdapter>[0]>,
): TelegramAdapter {
  return new TelegramAdapter({
    transport,
    allowedUsers: [],
    downloadDir: tempDir,
    ...options,
  });
}

function makeTextMessage(
  overrides: Partial<TelegramTransportMessage> = {},
): TelegramTransportMessage {
  return {
    messageId: 42,
    chatId: 123456,
    chatType: 'private',
    fromId: 789,
    firstName: 'Stan',
    lastName: 'Tyan',
    username: 'stantyan',
    text: 'Hello world',
    timestamp: 1712500000,
    ...overrides,
  };
}

function makeVoiceMessage(
  overrides: Partial<TelegramTransportMessage> = {},
): TelegramTransportMessage {
  return {
    messageId: 43,
    chatId: 123456,
    chatType: 'private',
    fromId: 789,
    firstName: 'Stan',
    lastName: 'Tyan',
    username: 'stantyan',
    voice: { duration: 5, mimeType: 'audio/ogg' },
    filePath: 'voice/file_42.ogg',
    timestamp: 1712500000,
    ...overrides,
  };
}

function makePhotoMessage(
  overrides: Partial<TelegramTransportMessage> = {},
): TelegramTransportMessage {
  return {
    messageId: 44,
    chatId: 123456,
    chatType: 'private',
    fromId: 789,
    firstName: 'Stan',
    lastName: 'Tyan',
    username: 'stantyan',
    photo: { width: 800, height: 800, fileSize: 20000 },
    filePath: 'photos/file_42.jpg',
    caption: 'A photo',
    timestamp: 1712500000,
    ...overrides,
  };
}

// ─── parseTelegramChatId ───────────────────────────────────────────────────

describe('parseTelegramChatId', () => {
  it('parses positive (DM) chat ID', () => {
    expect(parseTelegramChatId('tg:123456')).toBe(123456);
  });

  it('parses negative (group) chat ID', () => {
    expect(parseTelegramChatId('tg:-1001234567890')).toBe(-1001234567890);
  });

  it('throws on invalid format', () => {
    expect(() => parseTelegramChatId('123456')).toThrow('Invalid Telegram chat ID');
    expect(() => parseTelegramChatId('wa:123')).toThrow('Invalid Telegram chat ID');
    expect(() => parseTelegramChatId('tg:abc')).toThrow('Invalid Telegram chat ID');
    expect(() => parseTelegramChatId('')).toThrow('Invalid Telegram chat ID');
  });
});

// ─── escapeMarkdownV2 ──────────────────────────────────────────────────────

describe('escapeMarkdownV2', () => {
  it('escapes special characters', () => {
    expect(escapeMarkdownV2('Hello_world')).toBe('Hello\\_world');
    expect(escapeMarkdownV2('Price: $10.00')).toBe('Price: $10\\.00');
    expect(escapeMarkdownV2('A *bold* move')).toBe('A \\*bold\\* move');
  });

  it('escapes all MarkdownV2 special chars', () => {
    const specials = '_*[]()~`>#+-.=|{}!\\';
    const escaped = escapeMarkdownV2(specials);
    expect(escaped).toBe('\\_\\*\\[\\]\\(\\)\\~\\`\\>\\#\\+\\-\\.\\=\\|\\{\\}\\!\\\\');
  });

  it('leaves plain text unchanged', () => {
    expect(escapeMarkdownV2('Hello world')).toBe('Hello world');
  });
});

// ─── stripMarkdown ─────────────────────────────────────────────────────────

describe('stripMarkdown', () => {
  it('removes formatting characters', () => {
    expect(stripMarkdown('**bold** and _italic_')).toBe('bold and italic');
  });

  it('removes escaped characters', () => {
    expect(stripMarkdown('Hello\\_world')).toBe('Helloworld');
  });

  it('leaves plain text unchanged', () => {
    expect(stripMarkdown('Hello world')).toBe('Hello world');
  });
});

// ─── splitMessage ──────────────────────────────────────────────────────────

describe('splitMessage', () => {
  it('returns single chunk for short messages', () => {
    expect(splitMessage('Hello', 4096)).toEqual(['Hello']);
  });

  it('splits on newlines near the limit', () => {
    const line = 'a'.repeat(40);
    const text = Array(6).fill(line).join('\n');
    const result = splitMessage(text, 100);
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(100);
    }
  });

  it('hard splits when no suitable break point', () => {
    const text = 'a'.repeat(200);
    const result = splitMessage(text, 100);
    expect(result).toHaveLength(2);
    expect(result[0]).toHaveLength(100);
    expect(result[1]).toHaveLength(100);
  });

  it('handles default max length (4096)', () => {
    const short = 'Hello world';
    expect(splitMessage(short)).toEqual([short]);
  });

  it('splits on space when no newline available', () => {
    const words = Array(25).fill('word').join(' ');
    const result = splitMessage(words, 50);
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(50);
    }
  });
});

// ─── TelegramAdapter ──────────────────────────────────────────────────────

describe('TelegramAdapter', () => {
  describe('construction', () => {
    it('has correct name and type', () => {
      const transport = createTransport();
      const adapter = createAdapter(transport);
      expect(adapter.name).toBe('Telegram');
      expect(adapter.type).toBe('telegram');
    });

    it('starts disconnected', () => {
      const transport = createTransport();
      const adapter = createAdapter(transport);
      expect(adapter.isConnected()).toBe(false);
    });
  });

  describe('connect / disconnect', () => {
    it('connects via transport', async () => {
      const transport = createTransport();
      const adapter = createAdapter(transport);
      await adapter.connect();
      expect(adapter.isConnected()).toBe(true);
      expect(transport.connectCalls).toBe(1);
    });

    it('disconnects via transport', async () => {
      const transport = createTransport();
      const adapter = createAdapter(transport);
      await adapter.connect();
      await adapter.disconnect();
      expect(transport.disconnectCalls).toBe(1);
    });
  });

  describe('text messages', () => {
    it('normalizes text message to InboundMessage', async () => {
      const transport = createTransport();
      const adapter = createAdapter(transport);
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));

      await adapter.connect();
      transport.simulateMessage(makeTextMessage());

      await vi.waitFor(() => expect(received).toHaveLength(1));
      const msg = received[0]!;
      expect(msg.id).toBe('42');
      expect(msg.channel).toBe('telegram');
      expect(msg.userId).toBe('tg:123456');
      expect(msg.senderName).toBe('Stan Tyan');
      expect(msg.text).toBe('Hello world');
      expect(msg.timestamp).toBe(1712500000000);
      expect(msg.isFromMe).toBe(false);
      expect(msg.metadata['telegramUserId']).toBe(789);
      expect(msg.metadata['chatType']).toBe('private');
    });

    it('handles reply_to_message', async () => {
      const transport = createTransport();
      const adapter = createAdapter(transport);
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));

      await adapter.connect();
      transport.simulateMessage(makeTextMessage({ replyToMessageId: 10 }));

      await vi.waitFor(() => expect(received).toHaveLength(1));
      expect(received[0]!.replyToMessageId).toBe('10');
    });

    it('uses first_name only when last_name missing', async () => {
      const transport = createTransport();
      const adapter = createAdapter(transport);
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));

      await adapter.connect();
      transport.simulateMessage(makeTextMessage({ lastName: undefined }));

      await vi.waitFor(() => expect(received).toHaveLength(1));
      expect(received[0]!.senderName).toBe('Stan');
    });

    it('falls back to username when no names', async () => {
      const transport = createTransport();
      const adapter = createAdapter(transport);
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));

      await adapter.connect();
      transport.simulateMessage(makeTextMessage({ firstName: '', username: 'stantyan' }));

      await vi.waitFor(() => expect(received).toHaveLength(1));
      expect(received[0]!.senderName).toBe('stantyan');
    });

    it('handles group chats with negative chat ID', async () => {
      const transport = createTransport();
      const adapter = createAdapter(transport);
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));

      await adapter.connect();
      transport.simulateMessage(
        makeTextMessage({ chatId: -1001234567890, chatType: 'supergroup' }),
      );

      await vi.waitFor(() => expect(received).toHaveLength(1));
      expect(received[0]!.userId).toBe('tg:-1001234567890');
      expect(received[0]!.metadata['chatType']).toBe('supergroup');
    });

    it('includes entities in metadata', async () => {
      const transport = createTransport();
      const adapter = createAdapter(transport);
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));

      await adapter.connect();
      transport.simulateMessage(
        makeTextMessage({
          entities: [{ type: 'bold', offset: 0, length: 5 }],
        }),
      );

      await vi.waitFor(() => expect(received).toHaveLength(1));
      expect(received[0]!.metadata['entities']).toBeDefined();
    });
  });

  describe('voice messages', () => {
    it('normalizes voice message with downloaded audio', async () => {
      const transport = createTransport();
      transport.fileContent = Buffer.from('ogg-audio-data');
      const adapter = createAdapter(transport);
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));

      await adapter.connect();
      transport.simulateMessage(makeVoiceMessage());

      await vi.waitFor(() => expect(received).toHaveLength(1));
      const msg = received[0]!;
      expect(msg.audioPath).toBeDefined();
      expect(msg.audioPath!.endsWith('.ogg')).toBe(true);
      expect(msg.metadata['duration']).toBe(5);
      expect(msg.metadata['mimeType']).toBe('audio/ogg');

      // Verify file was written
      const content = await readFile(msg.audioPath!);
      expect(content.toString()).toBe('ogg-audio-data');
    });

    it('downloads file via transport', async () => {
      const transport = createTransport();
      const adapter = createAdapter(transport);
      adapter.onMessage(() => {});

      await adapter.connect();
      transport.simulateMessage(makeVoiceMessage());

      await vi.waitFor(() => expect(transport.fileDownloads).toHaveLength(1));
      expect(transport.fileDownloads[0]).toBe('voice/file_42.ogg');
    });
  });

  describe('photo messages', () => {
    it('normalizes photo with caption and metadata', async () => {
      const transport = createTransport();
      transport.fileContent = Buffer.from('jpeg-image-data');
      const adapter = createAdapter(transport);
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));

      await adapter.connect();
      transport.simulateMessage(makePhotoMessage());

      await vi.waitFor(() => expect(received).toHaveLength(1));
      const msg = received[0]!;
      expect(msg.imagePath).toBeDefined();
      expect(msg.imagePath!.endsWith('.jpg')).toBe(true);
      expect(msg.text).toBe('A photo');
      expect(msg.metadata['width']).toBe(800);
      expect(msg.metadata['height']).toBe(800);
      expect(msg.metadata['fileSize']).toBe(20000);
    });
  });

  describe('access control', () => {
    it('allows all users when allowedUsers is empty', async () => {
      const transport = createTransport();
      const adapter = createAdapter(transport, { allowedUsers: [] });
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));

      await adapter.connect();
      transport.simulateMessage(makeTextMessage());

      await vi.waitFor(() => expect(received).toHaveLength(1));
    });

    it('allows whitelisted users', async () => {
      const transport = createTransport();
      const adapter = createAdapter(transport, { allowedUsers: [789] });
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));

      await adapter.connect();
      transport.simulateMessage(makeTextMessage());

      await vi.waitFor(() => expect(received).toHaveLength(1));
    });

    it('denies non-whitelisted users', async () => {
      const transport = createTransport();
      const adapter = createAdapter(transport, { allowedUsers: [111, 222] });
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));

      await adapter.connect();
      transport.simulateMessage(makeTextMessage());

      await new Promise((r) => setTimeout(r, 50));
      expect(received).toHaveLength(0);
      // Adapter sends access denied via transport
      expect(
        transport.sentMessages.some(
          (m) => m.text === 'Access denied. Contact the administrator to get access.',
        ),
      ).toBe(true);
    });

    it('denies non-whitelisted users for voice messages', async () => {
      const transport = createTransport();
      const adapter = createAdapter(transport, { allowedUsers: [111] });
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));

      await adapter.connect();
      transport.simulateMessage(makeVoiceMessage());

      await new Promise((r) => setTimeout(r, 50));
      expect(received).toHaveLength(0);
    });

    it('denies non-whitelisted users for photo messages', async () => {
      const transport = createTransport();
      const adapter = createAdapter(transport, { allowedUsers: [111] });
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));

      await adapter.connect();
      transport.simulateMessage(makePhotoMessage());

      await new Promise((r) => setTimeout(r, 50));
      expect(received).toHaveLength(0);
    });
  });

  describe('/start command', () => {
    it('replies with welcome and does not forward to handler', async () => {
      const transport = createTransport();
      const adapter = createAdapter(transport);
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));

      await adapter.connect();
      transport.simulateMessage(makeTextMessage({ text: '/start' }));

      await new Promise((r) => setTimeout(r, 50));
      expect(received).toHaveLength(0);
      expect(transport.sentMessages).toHaveLength(1);
      expect(transport.sentMessages[0]!.text).toContain('Hi Stan');
      expect(transport.sentMessages[0]!.text).toContain('FlowHelm');
    });

    it('uses username when firstName is empty', async () => {
      const transport = createTransport();
      const adapter = createAdapter(transport);
      adapter.onMessage(() => {});

      await adapter.connect();
      transport.simulateMessage(
        makeTextMessage({ text: '/start', firstName: '', username: 'joe' }),
      );

      await new Promise((r) => setTimeout(r, 50));
      expect(transport.sentMessages[0]!.text).toContain('Hi joe');
    });

    it('falls back to "there" when no name available', async () => {
      const transport = createTransport();
      const adapter = createAdapter(transport);
      adapter.onMessage(() => {});

      await adapter.connect();
      transport.simulateMessage(
        makeTextMessage({ text: '/start', firstName: '', username: undefined }),
      );

      await new Promise((r) => setTimeout(r, 50));
      expect(transport.sentMessages[0]!.text).toContain('Hi there');
    });
  });

  describe('outbound delivery', () => {
    it('sends text via transport with MarkdownV2', async () => {
      const transport = createTransport();
      const adapter = createAdapter(transport);

      await adapter.connect();
      await adapter.send({ channel: 'telegram', userId: 'tg:123', text: 'Hello' });

      expect(transport.sentMessages).toHaveLength(1);
      expect(transport.sentMessages[0]!.chatId).toBe(123);
      expect(transport.sentMessages[0]!.text).toBe('Hello');
      expect(transport.sentMessages[0]!.parseMode).toBe('MarkdownV2');
    });

    it('falls back to plain text on MarkdownV2 failure', async () => {
      const transport = createTransport();
      let callCount = 0;
      const originalSend = transport.sendMessage.bind(transport);
      transport.sendMessage = async (options: TelegramSendOptions) => {
        callCount++;
        if (callCount === 1 && options.parseMode === 'MarkdownV2') {
          throw new Error('MarkdownV2 parse error');
        }
        return originalSend(options);
      };

      const adapter = createAdapter(transport);
      await adapter.connect();
      await adapter.send({ channel: 'telegram', userId: 'tg:123', text: 'Hello' });

      expect(callCount).toBe(2); // First try + fallback
    });

    it('throws when not connected', async () => {
      const transport = createTransport();
      const adapter = createAdapter(transport);

      await expect(
        adapter.send({
          channel: 'telegram',
          userId: 'tg:123',
          text: 'Hello',
        }),
      ).rejects.toThrow('not connected');
    });

    it('splits long messages', async () => {
      const transport = createTransport();
      const adapter = createAdapter(transport);

      await adapter.connect();
      const longText = 'A'.repeat(5000);
      await adapter.send({ channel: 'telegram', userId: 'tg:123', text: longText });

      expect(transport.sentMessages.length).toBeGreaterThan(1);
    });

    it('includes reply_to_message_id', async () => {
      const transport = createTransport();
      const adapter = createAdapter(transport);

      await adapter.connect();
      await adapter.send({
        channel: 'telegram',
        userId: 'tg:123',
        text: 'Reply',
        replyToMessageId: '42',
      });

      expect(transport.sentMessages[0]!.replyToMessageId).toBe(42);
    });
  });

  describe('multiple handlers', () => {
    it('emits to all registered handlers', async () => {
      const transport = createTransport();
      const adapter = createAdapter(transport);
      const received1: InboundMessage[] = [];
      const received2: InboundMessage[] = [];
      adapter.onMessage((msg) => received1.push(msg));
      adapter.onMessage((msg) => received2.push(msg));

      await adapter.connect();
      transport.simulateMessage(makeTextMessage());

      await vi.waitFor(() => expect(received1).toHaveLength(1));
      expect(received2).toHaveLength(1);
    });
  });
});

// ─── createTelegramAdapter Factory ──────────────────────────────────────────

describe('createTelegramAdapter', () => {
  it('returns null when config is undefined', () => {
    const result = createTelegramAdapter(undefined, tempDir);
    expect(result).toBeNull();
  });

  it('returns adapter when config is provided', () => {
    const result = createTelegramAdapter({ botToken: 'test:token', allowedUsers: [123] }, tempDir);
    expect(result).toBeInstanceOf(TelegramAdapter);
    expect(result!.type).toBe('telegram');
  });
});
