/**
 * Google Cloud Pub/Sub REST-based synchronous pull.
 *
 * No gRPC dependency — uses the Pub/Sub REST API with periodic fetch.
 * Authenticates via service account JWT → access token exchange.
 * Designed for low-volume email notifications (~50/day).
 */

import { createSign, createPrivateKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface PubSubPullOptions {
  /** GCP project ID. */
  projectId: string;
  /** Pub/Sub subscription name (short name). */
  subscriptionName: string;
  /** Path to service account key JSON file. */
  serviceAccountKeyPath: string;
  /** Pull interval in ms. Default: 5000. */
  pullInterval?: number;
  /** Max messages per pull request. Default: 10. */
  maxMessages?: number;
  /** Optional fetch override (for testing). */
  fetchFn?: typeof fetch;
  /** Optional service account key override (for testing, avoids file read). */
  serviceAccountKey?: ServiceAccountKey;
}

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  project_id: string;
}

export interface PubSubReceivedMessage {
  ackId: string;
  message: {
    data: string; // base64-encoded
    messageId: string;
    publishTime: string;
    attributes?: Record<string, string>;
  };
}

/** Decoded Gmail notification from Pub/Sub. */
export interface GmailNotification {
  emailAddress: string;
  historyId: string;
}

type NotificationHandler = (notification: GmailNotification) => void;

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

const PUBSUB_API_BASE = 'https://pubsub.googleapis.com/v1';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const PUBSUB_SCOPE = 'https://www.googleapis.com/auth/pubsub';
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

// ─── Pub/Sub Pull Daemon ───────────────────────────────────────────────────

export class PubSubPullDaemon {
  private readonly projectId: string;
  private readonly subscriptionName: string;
  private readonly serviceAccountKeyPath: string;
  private readonly pullInterval: number;
  private readonly maxMessages: number;
  private readonly fetchFn: typeof fetch;
  private serviceAccountKeyOverride?: ServiceAccountKey;

  private handlers: NotificationHandler[] = [];
  private pullTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private cachedKey: ServiceAccountKey | null = null;
  private cachedToken: CachedToken | null = null;
  private pulling = false; // Guard against overlapping pulls

  constructor(options: PubSubPullOptions) {
    this.projectId = options.projectId;
    this.subscriptionName = options.subscriptionName;
    this.serviceAccountKeyPath = options.serviceAccountKeyPath;
    this.pullInterval = options.pullInterval ?? 5000;
    this.maxMessages = options.maxMessages ?? 10;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.serviceAccountKeyOverride = options.serviceAccountKey;
  }

  /** Register a handler for Gmail notifications. */
  onNotification(handler: NotificationHandler): void {
    this.handlers.push(handler);
  }

  /** Start periodic pull. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Validate auth on startup (fail fast)
    await this.getAccessToken();

    // Do an immediate pull, then start the timer
    await this.doPull();
    this.pullTimer = setInterval(() => {
      void this.doPull();
    }, this.pullInterval);

    console.log(
      `[pubsub] Started pulling ${this.subscriptionPath()} every ${String(this.pullInterval)}ms`,
    );
  }

  /** Stop pulling. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.pullTimer) {
      clearInterval(this.pullTimer);
      this.pullTimer = null;
    }
    console.log('[pubsub] Stopped');
  }

  /** Whether the daemon is running. */
  isRunning(): boolean {
    return this.running;
  }

  // ── Pull Mechanics ──────────────────────────────────────────────────

  /** Perform a single synchronous pull and process messages. */
  private async doPull(): Promise<void> {
    if (!this.running || this.pulling) return;
    this.pulling = true;

    try {
      const messages = await this.pull();
      if (messages.length === 0) return;

      const ackIds: string[] = [];

      for (const received of messages) {
        try {
          const data = Buffer.from(received.message.data, 'base64').toString('utf-8');
          const notification = JSON.parse(data) as GmailNotification;

          if (notification.emailAddress && notification.historyId) {
            this.emit(notification);
          } else {
            console.warn('[pubsub] Malformed notification:', data);
          }

          ackIds.push(received.ackId);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error('[pubsub] Error processing message:', msg);
          ackIds.push(received.ackId); // Ack even on parse error to avoid redelivery
        }
      }

      if (ackIds.length > 0) {
        await this.acknowledge(ackIds);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[pubsub] Pull error:', msg);
    } finally {
      this.pulling = false;
    }
  }

  /** Pull messages from the subscription. */
  private async pull(): Promise<PubSubReceivedMessage[]> {
    const token = await this.getAccessToken();
    const response = await this.fetchFn(`${PUBSUB_API_BASE}/${this.subscriptionPath()}:pull`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ maxMessages: this.maxMessages }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Pub/Sub pull failed (${String(response.status)}): ${text}`);
    }

    const data = (await response.json()) as { receivedMessages?: PubSubReceivedMessage[] };
    return data.receivedMessages ?? [];
  }

  /** Acknowledge successfully processed messages. */
  private async acknowledge(ackIds: string[]): Promise<void> {
    const token = await this.getAccessToken();
    const response = await this.fetchFn(
      `${PUBSUB_API_BASE}/${this.subscriptionPath()}:acknowledge`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ackIds }),
      },
    );

    if (!response.ok) {
      const text = await response.text();
      console.error(`[pubsub] Acknowledge failed (${String(response.status)}): ${text}`);
    }
  }

  private subscriptionPath(): string {
    return `projects/${this.projectId}/subscriptions/${this.subscriptionName}`;
  }

  private emit(notification: GmailNotification): void {
    for (const handler of this.handlers) {
      handler(notification);
    }
  }

  // ── Service Account JWT Auth ───────────────────────────────────────

  /** Get a valid access token, refreshing via JWT if needed. */
  private async getAccessToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAt - TOKEN_REFRESH_BUFFER_MS) {
      return this.cachedToken.accessToken;
    }

    const key = await this.loadServiceAccountKey();
    const jwt = createServiceAccountJwt(key.client_email, key.private_key, PUBSUB_SCOPE);

    const response = await this.fetchFn(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Service account token exchange failed (${String(response.status)}): ${text}`,
      );
    }

    const data = (await response.json()) as { access_token: string; expires_in: number };
    this.cachedToken = {
      accessToken: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    return data.access_token;
  }

  /** Load and cache the service account key file. */
  private async loadServiceAccountKey(): Promise<ServiceAccountKey> {
    if (this.serviceAccountKeyOverride) return this.serviceAccountKeyOverride;
    if (this.cachedKey) return this.cachedKey;
    const raw = await readFile(this.serviceAccountKeyPath, 'utf-8');
    this.cachedKey = JSON.parse(raw) as ServiceAccountKey;
    return this.cachedKey;
  }
}

// ─── JWT Utilities ──────────────────────────────────────────────────────────

/**
 * Create a signed JWT for Google service account authentication.
 * Uses RS256 (RSA + SHA-256) as required by Google's OAuth2 spec.
 */
export function createServiceAccountJwt(
  clientEmail: string,
  privateKeyPem: string,
  scope: string,
  lifetimeSeconds = 3600,
): string {
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: clientEmail,
    scope,
    aud: TOKEN_ENDPOINT,
    iat: now,
    exp: now + lifetimeSeconds,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const key = createPrivateKey(privateKeyPem);
  const sign = createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature = sign.sign(key);
  const encodedSignature = signature
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  return `${signingInput}.${encodedSignature}`;
}

function base64UrlEncode(data: string): string {
  return Buffer.from(data, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
