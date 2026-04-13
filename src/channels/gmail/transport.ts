/**
 * Abstract Gmail transport layer.
 *
 * Decouples the Gmail adapter from specific clients (GmailClient, PubSub, IMAP).
 * The transport handles notification listening, email fetching, parsing, and
 * sending. The adapter handles filtering, normalization, cross-channel routing,
 * and ChannelAdapter interface compliance.
 *
 * To swap implementations: implement GmailTransport with a different backend
 * (e.g., official Google SDK, Microsoft Graph for Outlook, etc.).
 */

import { GmailClient, parseGmailMessage } from './gmail-client.js';
import type { ParsedEmail } from './gmail-client.js';
import { PubSubPullDaemon } from './pubsub-pull.js';
import type { GmailNotification } from './pubsub-pull.js';
import { GmailWatchManager } from './watch.js';
import { ImapIdleClient } from './imap-client.js';

// ─── Abstract Transport Interface ───────────────────────────────────────────

/** Transport connection state. */
export type GmailConnectionState = 'disconnected' | 'connecting' | 'connected';

/** Event handlers the transport calls. */
export interface GmailTransportHandlers {
  /** Called when a new email passes the transport layer. */
  onEmail: (email: ParsedEmail) => void;
  /** Connection state changes. */
  onConnectionState: (state: GmailConnectionState) => void;
  /** Transport-level errors. */
  onError: (error: Error) => void;
}

/**
 * Abstract Gmail transport interface.
 *
 * Implement this to swap the underlying email provider or API client.
 * The current implementation uses Gmail REST API + Pub/Sub or IMAP IDLE.
 */
export interface GmailTransport {
  /** Connect and start listening for new emails. */
  connect(handlers: GmailTransportHandlers): Promise<void>;
  /** Disconnect and stop listening. */
  disconnect(): Promise<void>;
  /** Send a raw RFC 2822 email. Returns message ID and thread ID. */
  sendEmail(raw: string): Promise<{ id: string; threadId: string }>;
  /** Get a fresh OAuth access token (for IMAP XOAUTH2, etc.). */
  getAccessToken(): Promise<string>;
  /** Current connection state. */
  connectionState(): GmailConnectionState;
  /** Expose the underlying email client (for watch setup, send_email MCP tool, etc.). */
  emailClient(): GmailClient;
}

// ─── Gmail API Transport (Pub/Sub + IMAP) ────────────────────────────────────

export interface GmailApiTransportOptions {
  /** User's Gmail address. */
  emailAddress: string;
  /** Notification transport mode. */
  mode: 'pubsub' | 'imap';
  /** OAuth client ID. */
  oauthClientId: string;
  /** OAuth client secret. */
  oauthClientSecret: string;
  /** OAuth refresh token. */
  oauthRefreshToken: string;

  // ── Pub/Sub options ──
  /** GCP project ID (required for pubsub). */
  gcpProject?: string;
  /** Pub/Sub topic name. */
  pubsubTopic?: string;
  /** Pub/Sub subscription name. */
  pubsubSubscription?: string;
  /** Service account key path. */
  serviceAccountKeyPath?: string;
  /** Pull interval in ms. Default: 5000. */
  pullInterval?: number;

  // ── IMAP options ──
  /** IMAP host. Default: imap.gmail.com. */
  imapHost?: string;
  /** IMAP port. Default: 993. */
  imapPort?: number;

  /** Gmail Watch renewal interval in ms. */
  watchRenewalInterval?: number;

  /** Labels to monitor for new messages. */
  labels?: string[];

  /** Optional fetch override (for testing). */
  fetchFn?: typeof fetch;
}

/**
 * Gmail transport backed by Gmail REST API with Pub/Sub or IMAP notification.
 *
 * Can be replaced with another implementation by implementing GmailTransport.
 */
export class GmailApiTransport implements GmailTransport {
  private readonly client: GmailClient;
  private readonly emailAddress: string;
  private readonly mode: 'pubsub' | 'imap';
  private readonly labels: string[];
  private state: GmailConnectionState = 'disconnected';
  private handlers: GmailTransportHandlers | undefined;

  // Pub/Sub components
  private pubsubDaemon?: PubSubPullDaemon;
  private watchManager?: GmailWatchManager;

  // IMAP components
  private imapClient?: ImapIdleClient;
  private readonly imapHost: string;
  private readonly imapPort: number;

  // Dedup cache
  private processedIds = new Set<string>();
  private static readonly MAX_CACHE = 5000;

  // Options stored for deferred init
  private readonly options: GmailApiTransportOptions;

  constructor(options: GmailApiTransportOptions) {
    this.options = options;
    this.emailAddress = options.emailAddress;
    this.mode = options.mode;
    this.labels = options.labels ?? ['INBOX'];
    this.imapHost = options.imapHost ?? 'imap.gmail.com';
    this.imapPort = options.imapPort ?? 993;

    this.client = new GmailClient({
      emailAddress: options.emailAddress,
      clientId: options.oauthClientId,
      clientSecret: options.oauthClientSecret,
      refreshToken: options.oauthRefreshToken,
      fetchFn: options.fetchFn,
    });
  }

  async connect(handlers: GmailTransportHandlers): Promise<void> {
    this.handlers = handlers;
    this.state = 'connecting';

    try {
      if (this.mode === 'pubsub') {
        await this.connectPubSub();
      } else {
        await this.connectImap();
      }
      this.state = 'connected';
      handlers.onConnectionState('connected');
    } catch (err) {
      this.state = 'disconnected';
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.mode === 'pubsub') {
      if (this.pubsubDaemon) await this.pubsubDaemon.stop();
      if (this.watchManager) await this.watchManager.stopWatch();
    } else {
      if (this.imapClient) await this.imapClient.disconnect();
    }
    this.state = 'disconnected';
    this.handlers?.onConnectionState('disconnected');
  }

  async sendEmail(raw: string): Promise<{ id: string; threadId: string }> {
    return this.client.sendMessage(raw);
  }

  async getAccessToken(): Promise<string> {
    return this.client.getAccessToken();
  }

  connectionState(): GmailConnectionState {
    return this.state;
  }

  emailClient(): GmailClient {
    return this.client;
  }

  // ── Pub/Sub Transport ──────────────────────────────────────────────

  private async connectPubSub(): Promise<void> {
    const opts = this.options;
    if (!opts.gcpProject || !opts.serviceAccountKeyPath) {
      throw new Error('Pub/Sub transport requires gcpProject and serviceAccountKeyPath');
    }

    const topicName = `projects/${opts.gcpProject}/topics/${opts.pubsubTopic ?? 'flowhelm-gmail'}`;

    this.pubsubDaemon = new PubSubPullDaemon({
      projectId: opts.gcpProject,
      subscriptionName: opts.pubsubSubscription ?? 'flowhelm-gmail-sub',
      serviceAccountKeyPath: opts.serviceAccountKeyPath,
      pullInterval: opts.pullInterval ?? 5000,
      fetchFn: opts.fetchFn,
    });

    this.watchManager = new GmailWatchManager({
      client: this.client,
      topicName,
      renewalInterval: opts.watchRenewalInterval,
    });

    this.pubsubDaemon.onNotification((notification) => {
      void this.handlePubSubNotification(notification);
    });

    const profile = await this.client.getProfile();
    this.watchManager.restoreHistoryId(profile.historyId);
    await this.watchManager.createWatch(profile.historyId);
    await this.pubsubDaemon.start();
  }

  private async handlePubSubNotification(notification: GmailNotification): Promise<void> {
    if (notification.emailAddress !== this.emailAddress) return;

    const lastHistoryId = this.watchManager?.getHistoryId();
    if (!lastHistoryId) return;

    try {
      await this.fetchAndDeliverNewEmails(lastHistoryId);
      this.watchManager?.updateHistoryId(notification.historyId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[gmail-transport] Pub/Sub processing error:', msg);
      this.handlers?.onError(err instanceof Error ? err : new Error(msg));
    }
  }

  // ── IMAP Transport ─────────────────────────────────────────────────

  private async connectImap(): Promise<void> {
    const accessToken = await this.client.getAccessToken();

    this.imapClient = new ImapIdleClient({
      host: this.imapHost,
      port: this.imapPort,
      emailAddress: this.emailAddress,
      accessToken,
    });

    this.imapClient.on('newMail', () => {
      void this.handleImapNewMail();
    });

    await this.imapClient.connect();
  }

  private async handleImapNewMail(): Promise<void> {
    try {
      const list = await this.client.listMessages('is:unread', 10);
      if (!list.messages) return;

      for (const ref of list.messages) {
        if (this.processedIds.has(ref.id)) continue;

        const msg = await this.client.getMessage(ref.id, 'full');
        const parsed = parseGmailMessage(msg);
        this.deliverEmail(parsed);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[gmail-transport] IMAP processing error:', msg);
      this.handlers?.onError(err instanceof Error ? err : new Error(msg));
    }
  }

  // ── Shared ─────────────────────────────────────────────────────────

  private async fetchAndDeliverNewEmails(sinceHistoryId: string): Promise<void> {
    const history = await this.client.listHistory(sinceHistoryId, this.labels);
    if (!history.history) return;

    for (const record of history.history) {
      if (!record.messagesAdded) continue;

      for (const added of record.messagesAdded) {
        if (this.processedIds.has(added.message.id)) continue;

        try {
          const msg = await this.client.getMessage(added.message.id, 'full');
          const parsed = parseGmailMessage(msg);
          this.deliverEmail(parsed);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[gmail-transport] Error fetching ${added.message.id}:`, msg);
        }
      }
    }
  }

  private deliverEmail(email: ParsedEmail): void {
    if (this.processedIds.has(email.id)) return;
    this.trackId(email.id);
    this.handlers?.onEmail(email);
  }

  private trackId(id: string): void {
    this.processedIds.add(id);
    if (this.processedIds.size > GmailApiTransport.MAX_CACHE) {
      const first = this.processedIds.values().next();
      if (!first.done) this.processedIds.delete(first.value);
    }
  }
}

// Re-export ParsedEmail for transport consumers
export type { ParsedEmail } from './gmail-client.js';
