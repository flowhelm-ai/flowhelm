/**
 * Tests for the Gmail channel adapter.
 *
 * Uses MockGmailTransport to test adapter logic in isolation from
 * the actual Gmail API, Pub/Sub, and IMAP transport implementations.
 *
 * Covers: adapter lifecycle, email normalization, filter integration,
 * cross-channel notification, outbound email sending, factory function,
 * formatting helpers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  GmailAdapter,
  createGmailAdapter,
  formatEmailForAgent,
  extractSenderName,
} from '../src/channels/gmail/adapter.js';
import type { GmailAdapterOptions } from '../src/channels/gmail/adapter.js';
import type { OutboundMessage, ChannelAdapter } from '../src/orchestrator/types.js';
import type { ParsedEmail } from '../src/channels/gmail/gmail-client.js';
import type { GmailClient } from '../src/channels/gmail/gmail-client.js';
import type {
  GmailTransport,
  GmailConnectionState,
  GmailTransportHandlers,
} from '../src/channels/gmail/transport.js';

// ─── Mock Transport ──────────────────────────────────────────────────────

class MockGmailTransport implements GmailTransport {
  private state: GmailConnectionState = 'disconnected';
  private handlers: GmailTransportHandlers | undefined;

  // Tracking
  connectCalls = 0;
  disconnectCalls = 0;
  sentEmails: string[] = [];
  accessTokenCalls = 0;

  async connect(handlers: GmailTransportHandlers): Promise<void> {
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

  async sendEmail(raw: string): Promise<{ id: string; threadId: string }> {
    this.sentEmails.push(raw);
    return {
      id: `sent-${String(this.sentEmails.length)}`,
      threadId: `thread-${String(this.sentEmails.length)}`,
    };
  }

  async getAccessToken(): Promise<string> {
    this.accessTokenCalls++;
    return 'mock-access-token';
  }

  connectionState(): GmailConnectionState {
    return this.state;
  }

  emailClient(): GmailClient {
    return {
      emailAddress: 'test@gmail.com',
      sendMessage: vi.fn(async () => ({ id: 'sent-1', threadId: 'thread-1' })),
      getAccessToken: vi.fn(async () => 'mock-token'),
      getProfile: vi.fn(async () => ({
        emailAddress: 'test@gmail.com',
        messagesTotal: 10,
        historyId: '100',
      })),
    } as unknown as GmailClient;
  }

  // ── Test helpers ────────────────────────────────────────────────────────

  /** Simulate an inbound email delivered by the transport. */
  simulateEmail(email: ParsedEmail): void {
    this.handlers?.onEmail(email);
  }

  /** Simulate a transport error. */
  simulateError(error: Error): void {
    this.handlers?.onError(error);
  }

  /** Simulate a connection state change. */
  simulateConnectionState(state: GmailConnectionState): void {
    this.state =
      state === 'connected' ? 'connected' : state === 'connecting' ? 'connecting' : 'disconnected';
    this.handlers?.onConnectionState(state);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function createMockTransport(): MockGmailTransport {
  return new MockGmailTransport();
}

function createTestAdapter(
  transport?: MockGmailTransport,
  overrides?: Partial<GmailAdapterOptions>,
): { adapter: GmailAdapter; transport: MockGmailTransport } {
  const t = transport ?? createMockTransport();
  const adapter = new GmailAdapter({
    transport: t,
    emailAddress: 'test@gmail.com',
    ...overrides,
  });
  return { adapter, transport: t };
}

function buildParsedEmail(overrides: Partial<ParsedEmail> = {}): ParsedEmail {
  return {
    id: 'msg-1',
    threadId: 'thread-1',
    from: 'Alice <alice@example.com>',
    to: 'test@gmail.com',
    subject: 'Test Email',
    snippet: 'This is a test email',
    date: 1700000000000,
    labelIds: ['INBOX'],
    isStarred: false,
    isImportant: false,
    headers: {},
    attachments: [],
    ...overrides,
  };
}

// ─── Formatting Helpers ──────────────────────────────────────────────────

describe('formatEmailForAgent', () => {
  it('formats email with subject and snippet', () => {
    const email = buildParsedEmail();
    const text = formatEmailForAgent(email);
    expect(text).toContain('[Email] From: Alice <alice@example.com>');
    expect(text).toContain('Subject: Test Email');
    expect(text).toContain('Preview: This is a test email');
  });

  it('includes body text when available', () => {
    const email = buildParsedEmail({ bodyText: 'Full email body content here.' });
    const text = formatEmailForAgent(email);
    expect(text).toContain('Full email body content here.');
  });

  it('includes attachment metadata in formatted output', () => {
    const email = buildParsedEmail({
      attachments: [
        {
          filename: 'report.pdf',
          mimeType: 'application/pdf',
          size: 102400,
          attachmentId: 'att-1',
        },
        { filename: 'photo.jpg', mimeType: 'image/jpeg', size: 2097152, attachmentId: 'att-2' },
      ],
    });
    const text = formatEmailForAgent(email);
    expect(text).toContain('Attachments:');
    expect(text).toContain('report.pdf (application/pdf, 100.0 KB)');
    expect(text).toContain('photo.jpg (image/jpeg, 2.0 MB)');
  });

  it('omits attachment line when no attachments', () => {
    const email = buildParsedEmail();
    const text = formatEmailForAgent(email);
    expect(text).not.toContain('Attachments:');
  });

  it('formats small file sizes in bytes', () => {
    const email = buildParsedEmail({
      attachments: [{ filename: 'tiny.txt', mimeType: 'text/plain', size: 512 }],
    });
    const text = formatEmailForAgent(email);
    expect(text).toContain('tiny.txt (text/plain, 512 B)');
  });

  it('truncates body text over 2000 chars', () => {
    const email = buildParsedEmail({ bodyText: 'x'.repeat(3000) });
    const text = formatEmailForAgent(email);
    expect(text).toContain('...');
    expect(text.length).toBeLessThan(3100);
  });
});

describe('extractSenderName', () => {
  it('extracts name from "Name <email>" format', () => {
    expect(extractSenderName('Alice Smith <alice@example.com>')).toBe('Alice Smith');
  });

  it('extracts name with quotes', () => {
    expect(extractSenderName('"Alice Smith" <alice@example.com>')).toBe('Alice Smith');
  });

  it('extracts email from "<email>" format', () => {
    expect(extractSenderName('<alice@example.com>')).toBe('alice@example.com');
  });

  it('returns raw string for plain email', () => {
    expect(extractSenderName('alice@example.com')).toBe('alice@example.com');
  });
});

// ─── Factory ──────────────────────────────────────────────────────────────

describe('createGmailAdapter', () => {
  it('returns null when config is undefined', () => {
    expect(createGmailAdapter(undefined, {})).toBeNull();
  });

  it('returns null when not enabled', () => {
    expect(createGmailAdapter({ enabled: false, transport: 'pubsub' }, {})).toBeNull();
  });

  it('returns null when emailAddress is missing', () => {
    expect(
      createGmailAdapter({ enabled: true, transport: 'pubsub' }, { oauthRefreshToken: 'token' }),
    ).toBeNull();
  });

  it('returns null when OAuth credentials are missing', () => {
    expect(
      createGmailAdapter({ enabled: true, transport: 'pubsub', emailAddress: 'a@b.com' }, {}),
    ).toBeNull();
  });

  it('returns adapter when fully configured with custom transport', () => {
    const transport = createMockTransport();
    const adapter = createGmailAdapter(
      {
        enabled: true,
        transport: 'imap',
        emailAddress: 'user@gmail.com',
        oauthClientId: 'id',
        oauthClientSecret: 'secret',
      },
      { oauthRefreshToken: 'refresh' },
      undefined,
      undefined,
      transport,
    );
    expect(adapter).toBeInstanceOf(GmailAdapter);
    expect(adapter!.type).toBe('gmail');
    expect(adapter!.name).toBe('Gmail');
  });

  it('passes notification adapter through', () => {
    const mockNotification: ChannelAdapter = {
      name: 'Telegram',
      type: 'telegram',
      connect: vi.fn(),
      disconnect: vi.fn(),
      send: vi.fn(),
      onMessage: vi.fn(),
      isConnected: () => true,
    };
    const transport = createMockTransport();

    const adapter = createGmailAdapter(
      {
        enabled: true,
        transport: 'imap',
        emailAddress: 'user@gmail.com',
        oauthClientId: 'id',
        oauthClientSecret: 'secret',
        notificationChannel: 'telegram',
      },
      { oauthRefreshToken: 'refresh' },
      mockNotification,
      undefined,
      transport,
    );

    expect(adapter).not.toBeNull();
  });
});

// ─── MockGmailTransport ──────────────────────────────────────────────────

describe('MockGmailTransport', () => {
  it('starts disconnected', () => {
    const transport = createMockTransport();
    expect(transport.connectionState()).toBe('disconnected');
  });

  it('transitions to connected on connect()', async () => {
    const transport = createMockTransport();
    await transport.connect({
      onEmail: () => {},
      onConnectionState: () => {},
      onError: () => {},
    });
    expect(transport.connectionState()).toBe('connected');
    expect(transport.connectCalls).toBe(1);
  });

  it('transitions to disconnected on disconnect()', async () => {
    const transport = createMockTransport();
    await transport.connect({
      onEmail: () => {},
      onConnectionState: () => {},
      onError: () => {},
    });
    await transport.disconnect();
    expect(transport.connectionState()).toBe('disconnected');
    expect(transport.disconnectCalls).toBe(1);
  });

  it('tracks sent emails', async () => {
    const transport = createMockTransport();
    const result = await transport.sendEmail('raw-email-content');
    expect(result.id).toBe('sent-1');
    expect(transport.sentEmails).toEqual(['raw-email-content']);
  });

  it('returns mock access token', async () => {
    const transport = createMockTransport();
    const token = await transport.getAccessToken();
    expect(token).toBe('mock-access-token');
    expect(transport.accessTokenCalls).toBe(1);
  });

  it('exposes mock email client', () => {
    const transport = createMockTransport();
    const client = transport.emailClient();
    expect(client.emailAddress).toBe('test@gmail.com');
  });
});

// ─── Adapter Interface ───────────────────────────────────────────────────

describe('GmailAdapter', () => {
  it('has correct name and type', () => {
    const { adapter } = createTestAdapter();
    expect(adapter.name).toBe('Gmail');
    expect(adapter.type).toBe('gmail');
  });

  it('is not connected before connect()', () => {
    const { adapter } = createTestAdapter();
    expect(adapter.isConnected()).toBe(false);
  });

  it('becomes connected after connect()', async () => {
    const { adapter, transport } = createTestAdapter();
    await adapter.connect();
    expect(adapter.isConnected()).toBe(true);
    expect(transport.connectCalls).toBe(1);
  });

  it('becomes disconnected after disconnect()', async () => {
    const { adapter, transport } = createTestAdapter();
    await adapter.connect();
    await adapter.disconnect();
    expect(adapter.isConnected()).toBe(false);
    expect(transport.disconnectCalls).toBe(1);
  });

  it('registers message handlers', () => {
    const { adapter } = createTestAdapter();
    const handler = vi.fn();
    adapter.onMessage(handler);
    // Handler registered — will be called when emails arrive
    expect(handler).not.toHaveBeenCalled();
  });

  it('exposes email client from transport', () => {
    const { adapter } = createTestAdapter();
    const client = adapter.client;
    expect(client.emailAddress).toBe('test@gmail.com');
  });
});

// ─── Inbound Email Processing ────────────────────────────────────────────

describe('GmailAdapter inbound', () => {
  let adapter: GmailAdapter;
  let transport: MockGmailTransport;
  let handler: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const result = createTestAdapter();
    adapter = result.adapter;
    transport = result.transport;
    handler = vi.fn();
    adapter.onMessage(handler);
    await adapter.connect();
  });

  it('normalizes email to InboundMessage', () => {
    transport.simulateEmail(buildParsedEmail());
    expect(handler).toHaveBeenCalledTimes(1);

    const msg = handler.mock.calls[0][0];
    expect(msg.id).toBe('msg-1');
    expect(msg.channel).toBe('gmail');
    expect(msg.userId).toBe('gmail:test@gmail.com');
    expect(msg.senderName).toBe('Alice');
    expect(msg.isFromMe).toBe(false);
    expect(msg.text).toContain('[Email] From:');
    expect(msg.text).toContain('Subject: Test Email');
  });

  it('sets metadata correctly', () => {
    transport.simulateEmail(
      buildParsedEmail({
        isStarred: true,
        isImportant: true,
        labelIds: ['INBOX', 'STARRED'],
      }),
    );

    const msg = handler.mock.calls[0][0];
    expect(msg.metadata.threadId).toBe('thread-1');
    expect(msg.metadata.subject).toBe('Test Email');
    expect(msg.metadata.isStarred).toBe(true);
    expect(msg.metadata.isImportant).toBe(true);
    expect(msg.metadata.labels).toEqual(['INBOX', 'STARRED']);
  });

  it('passes emails through filter rules', () => {
    // Default filter rules allow most emails
    transport.simulateEmail(
      buildParsedEmail({
        from: 'alice@example.com',
        subject: 'Important Update',
      }),
    );
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('filters out automated emails when filter configured', async () => {
    // Create adapter with strict filter
    const t = createMockTransport();
    const filteredAdapter = new GmailAdapter({
      transport: t,
      emailAddress: 'test@gmail.com',
      filterRules: {
        blockedSenders: ['*@noreply.github.com'],
      },
    });
    const filteredHandler = vi.fn();
    filteredAdapter.onMessage(filteredHandler);
    await filteredAdapter.connect();

    t.simulateEmail(
      buildParsedEmail({
        from: 'notifications@noreply.github.com',
        subject: 'PR merged',
        headers: { 'x-github-event': 'pull_request' },
      }),
    );

    expect(filteredHandler).not.toHaveBeenCalled();
  });

  it('delivers multiple emails sequentially', () => {
    transport.simulateEmail(buildParsedEmail({ id: 'msg-1' }));
    transport.simulateEmail(buildParsedEmail({ id: 'msg-2', subject: 'Second Email' }));
    transport.simulateEmail(buildParsedEmail({ id: 'msg-3', subject: 'Third Email' }));

    expect(handler).toHaveBeenCalledTimes(3);
    expect(handler.mock.calls[0][0].id).toBe('msg-1');
    expect(handler.mock.calls[1][0].id).toBe('msg-2');
    expect(handler.mock.calls[2][0].id).toBe('msg-3');
  });

  it('extracts sender name from From header', () => {
    transport.simulateEmail(buildParsedEmail({ from: 'Bob Jones <bob@work.com>' }));
    expect(handler.mock.calls[0][0].senderName).toBe('Bob Jones');
  });

  it('includes importance in metadata', () => {
    transport.simulateEmail(buildParsedEmail({ isImportant: true }));
    const msg = handler.mock.calls[0][0];
    expect(msg.metadata.importance).toBeDefined();
    expect(typeof msg.metadata.importance).toBe('number');
  });
});

// ─── Outbound ────────────────────────────────────────────────────────────

describe('GmailAdapter outbound', () => {
  it('sends email via transport when no notification adapter', async () => {
    const { adapter, transport } = createTestAdapter();
    await adapter.connect();

    await adapter.send({
      channel: 'gmail',
      userId: 'gmail:recipient@example.com',
      text: 'Hello from FlowHelm',
    });

    expect(transport.sentEmails.length).toBe(1);
    // buildRawEmail returns base64url-encoded RFC 2822 — decode to verify content
    const decoded = Buffer.from(transport.sentEmails[0], 'base64url').toString();
    expect(decoded).toContain('recipient@example.com');
    expect(decoded).toContain('Hello from FlowHelm');
  });

  it('delegates outbound to notification adapter when configured', async () => {
    const mockSend = vi.fn();
    const mockNotification: ChannelAdapter = {
      name: 'Telegram',
      type: 'telegram',
      connect: vi.fn(),
      disconnect: vi.fn(),
      send: mockSend,
      onMessage: vi.fn(),
      isConnected: () => true,
    };

    const { adapter, transport } = createTestAdapter(undefined, {
      notificationAdapter: mockNotification,
      notificationUserId: 'tg:12345',
    });
    await adapter.connect();

    await adapter.send({
      channel: 'gmail',
      userId: 'gmail:test@gmail.com',
      text: 'Email notification',
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
    const sentMsg = mockSend.mock.calls[0][0] as OutboundMessage;
    expect(sentMsg.channel).toBe('telegram');
    expect(sentMsg.userId).toBe('tg:12345');
    expect(sentMsg.text).toBe('Email notification');
    expect(sentMsg.replyToMessageId).toBeUndefined();
    // Should not have sent via transport
    expect(transport.sentEmails.length).toBe(0);
  });

  it('falls back to email when notification adapter is disconnected', async () => {
    const mockNotification: ChannelAdapter = {
      name: 'Telegram',
      type: 'telegram',
      connect: vi.fn(),
      disconnect: vi.fn(),
      send: vi.fn(),
      onMessage: vi.fn(),
      isConnected: () => false,
    };

    const { adapter, transport } = createTestAdapter(undefined, {
      notificationAdapter: mockNotification,
      notificationUserId: 'tg:12345',
    });
    await adapter.connect();

    await adapter.send({
      channel: 'gmail',
      userId: 'gmail:bob@example.com',
      text: 'Fallback email',
    });

    // Should send via transport (email), not notification adapter
    expect(transport.sentEmails.length).toBe(1);
    expect(mockNotification.send).not.toHaveBeenCalled();
  });

  it('throws on send when not connected', async () => {
    const { adapter } = createTestAdapter();
    await expect(adapter.send({ channel: 'gmail', userId: 'x', text: 'test' })).rejects.toThrow(
      'not connected',
    );
  });
});

// ─── Transport Error Handling ────────────────────────────────────────────

describe('GmailAdapter error handling', () => {
  it('logs transport errors without crashing', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { adapter, transport } = createTestAdapter();
    await adapter.connect();

    transport.simulateError(new Error('Connection lost'));

    expect(consoleSpy).toHaveBeenCalledWith('[gmail] Transport error:', 'Connection lost');
    consoleSpy.mockRestore();
  });

  it('handles connection state changes from transport', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { adapter, transport } = createTestAdapter();
    await adapter.connect();

    transport.simulateConnectionState('disconnected');
    expect(adapter.isConnected()).toBe(false);

    consoleSpy.mockRestore();
  });
});
