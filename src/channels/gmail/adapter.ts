/**
 * Gmail channel adapter.
 *
 * Implements the ChannelAdapter interface for Gmail email notifications.
 * Uses the abstract GmailTransport layer for notification listening,
 * email fetching, and sending. The adapter handles filtering,
 * normalization, cross-channel routing, and ChannelAdapter compliance.
 *
 * To swap the underlying provider: provide a different GmailTransport
 * implementation. The current default is GmailApiTransport.
 */

import type { ChannelAdapter, InboundMessage, OutboundMessage } from '../../orchestrator/types.js';
import { buildRawEmail } from './gmail-client.js';
import type { ParsedEmail } from './gmail-client.js';
import type { GmailClient } from './gmail-client.js';
import { evaluateFilter, buildFilterRules } from './filter.js';
import type { EmailFilterRules } from './filter.js';
import {
  GmailApiTransport,
  type GmailTransport,
  type GmailTransportHandlers,
} from './transport.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface GmailAdapterOptions {
  /** Transport implementation (GmailApiTransport or any GmailTransport). */
  transport: GmailTransport;
  /** User's Gmail address (for outbound email From header). */
  emailAddress: string;
  /** Filter rules for deciding which emails to process. */
  filterRules?: Partial<EmailFilterRules>;
  /** Optional adapter to delegate outbound messages to (cross-channel notification). */
  notificationAdapter?: ChannelAdapter;
  /** User ID on the notification channel (e.g., Telegram chat ID). Required when notificationAdapter is set. */
  notificationUserId?: string;
}

type MessageHandler = (msg: InboundMessage) => void;

// ─── Adapter ───────────────────────────────────────────────────────────────

export class GmailAdapter implements ChannelAdapter {
  readonly name = 'Gmail';
  readonly type = 'gmail' as const;

  private readonly transport: GmailTransport;
  private readonly emailAddress: string;
  private readonly filterRules: EmailFilterRules;
  private readonly notificationAdapter?: ChannelAdapter;
  private readonly notificationUserId?: string;

  private handlers: MessageHandler[] = [];
  private connected = false;

  constructor(options: GmailAdapterOptions) {
    this.transport = options.transport;
    this.emailAddress = options.emailAddress;
    this.filterRules = buildFilterRules(options.filterRules ?? {});
    this.notificationAdapter = options.notificationAdapter;
    this.notificationUserId = options.notificationUserId;
  }

  // ── ChannelAdapter interface ─────────────────────────────────────────

  async connect(): Promise<void> {
    const transportHandlers: GmailTransportHandlers = {
      onEmail: (email) => {
        void this.processEmail(email);
      },
      onConnectionState: (state) => {
        if (state === 'connected') {
          this.connected = true;
          console.log('[gmail] Connected');
        } else if (state === 'disconnected') {
          this.connected = false;
          console.log('[gmail] Disconnected');
        }
      },
      onError: (err) => {
        console.error('[gmail] Transport error:', err.message);
      },
    };

    await this.transport.connect(transportHandlers);
  }

  async disconnect(): Promise<void> {
    await this.transport.disconnect();
    this.connected = false;
    console.log('[gmail] Disconnected');
  }

  async send(message: OutboundMessage): Promise<void> {
    if (!this.connected) throw new Error('Gmail adapter not connected');

    // Cross-channel notification: delegate to notification adapter.
    // Strip replyToMessageId — Gmail message IDs are not valid on the notification channel.
    if (this.notificationAdapter?.isConnected() && this.notificationUserId) {
      await this.notificationAdapter.send({
        ...message,
        channel: this.notificationAdapter.type,
        userId: this.notificationUserId,
        replyToMessageId: undefined,
      });
      return;
    }

    // Default: send as email reply via Gmail API
    const raw = buildRawEmail({
      from: this.emailAddress,
      to: message.userId.replace(/^gmail:/, ''),
      subject: 'Re: FlowHelm notification',
      body: message.text,
    });
    await this.transport.sendEmail(raw);
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Expose the Gmail client for external use (e.g., watch setup CLI, email sending). */
  get client(): GmailClient {
    return this.transport.emailClient();
  }

  // ── Processing Pipeline ──────────────────────────────────────────────

  /**
   * Process a single email through the filter and notification pipeline.
   * Called by the transport when a new email arrives.
   */
  private async processEmail(email: ParsedEmail): Promise<void> {
    // Apply filter rules
    const filterResult = evaluateFilter(email, this.filterRules);
    if (!filterResult.passed) {
      console.log(`[gmail] Filtered out: ${email.subject} — ${filterResult.reason}`);
      return;
    }

    // Normalize to InboundMessage
    const inbound = this.normalizeEmail(email, filterResult.importance);

    // Emit to registered handlers
    this.emit(inbound);
  }

  /**
   * Normalize a ParsedEmail into a FlowHelm InboundMessage.
   */
  private normalizeEmail(email: ParsedEmail, importance: number): InboundMessage {
    const text = formatEmailForAgent(email);

    return {
      id: email.id,
      channel: 'gmail',
      userId: `gmail:${this.emailAddress}`,
      senderName: extractSenderName(email.from),
      text,
      timestamp: email.date,
      isFromMe: false,
      metadata: {
        threadId: email.threadId,
        subject: email.subject,
        from: email.from,
        to: email.to,
        labels: email.labelIds,
        isStarred: email.isStarred,
        isImportant: email.isImportant,
        importance,
        snippet: email.snippet,
        attachments: email.attachments,
      },
    };
  }

  private emit(msg: InboundMessage): void {
    for (const handler of this.handlers) {
      handler(msg);
    }
  }
}

// ─── Formatting Helpers ──────────────────────────────────────────────────────

/**
 * Format a parsed email as text for the agent context.
 * Includes subject, sender, snippet, and body excerpt.
 */
export function formatEmailForAgent(email: ParsedEmail): string {
  const lines: string[] = [];
  lines.push(`[Email] From: ${email.from}`);
  lines.push(`Subject: ${email.subject}`);
  if (email.snippet) {
    lines.push(`Preview: ${email.snippet}`);
  }
  if (email.attachments.length > 0) {
    lines.push(
      `Attachments: ${email.attachments.map((a) => `${a.filename} (${a.mimeType}, ${formatBytes(a.size)})`).join(', ')}`,
    );
  }
  if (email.bodyText) {
    // Truncate body to ~2000 chars to stay within token budgets
    const body =
      email.bodyText.length > 2000 ? email.bodyText.slice(0, 2000) + '...' : email.bodyText;
    lines.push('');
    lines.push(body);
  }
  return lines.join('\n');
}

/**
 * Extract a human-readable sender name from a From header.
 * "John Doe <john@example.com>" -> "John Doe"
 * "<john@example.com>" -> "john@example.com"
 * "john@example.com" -> "john@example.com"
 */
export function extractSenderName(from: string): string {
  // "Display Name <email>" format
  const match = from.match(/^"?([^"<]+)"?\s*<[^>]+>/);
  if (match?.[1]) return match[1].trim();

  // "<email>" format
  const angleMatch = from.match(/^<([^>]+)>/);
  if (angleMatch?.[1]) return angleMatch[1];

  return from;
}

/** Format byte count as human-readable string. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Create a GmailAdapter from FlowHelm config, or return null if
 * Gmail is not configured. Uses GmailApiTransport as the default transport.
 */
export function createGmailAdapter(
  config:
    | {
        enabled: boolean;
        emailAddress?: string;
        transport: 'pubsub' | 'imap';
        gcpProject?: string;
        pubsubTopic?: string;
        pubsubSubscription?: string;
        serviceAccountKeyPath?: string;
        pullInterval?: number;
        imapHost?: string;
        imapPort?: number;
        oauthClientId?: string;
        oauthClientSecret?: string;
        watchRenewalInterval?: number;
        notificationChannel?: 'telegram' | 'whatsapp';
        filter?: Partial<EmailFilterRules>;
      }
    | undefined,
  secrets: { oauthRefreshToken?: string },
  notificationAdapter?: ChannelAdapter,
  notificationUserId?: string,
  transport?: GmailTransport,
): GmailAdapter | null {
  if (!config?.enabled) return null;
  if (!config.emailAddress) {
    console.warn('[gmail] Gmail enabled but emailAddress not set — skipping');
    return null;
  }
  if (!config.oauthClientId || !config.oauthClientSecret || !secrets.oauthRefreshToken) {
    console.warn('[gmail] Gmail enabled but OAuth credentials not set — skipping');
    return null;
  }

  const gmailTransport =
    transport ??
    new GmailApiTransport({
      emailAddress: config.emailAddress,
      mode: config.transport,
      oauthClientId: config.oauthClientId,
      oauthClientSecret: config.oauthClientSecret,
      oauthRefreshToken: secrets.oauthRefreshToken,
      gcpProject: config.gcpProject,
      pubsubTopic: config.pubsubTopic,
      pubsubSubscription: config.pubsubSubscription,
      serviceAccountKeyPath: config.serviceAccountKeyPath,
      pullInterval: config.pullInterval,
      imapHost: config.imapHost,
      imapPort: config.imapPort,
      watchRenewalInterval: config.watchRenewalInterval,
      labels: config.filter?.labels,
    });

  return new GmailAdapter({
    transport: gmailTransport,
    emailAddress: config.emailAddress,
    filterRules: config.filter,
    notificationAdapter,
    notificationUserId,
  });
}
