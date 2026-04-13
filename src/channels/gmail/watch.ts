/**
 * Gmail Watch lifecycle manager.
 *
 * Creates and renews Gmail Watches that push notifications to a
 * Pub/Sub topic. Watches expire every 7 days; we renew every 6.
 * Tracks the last processed historyId to avoid re-processing.
 */

import type { GmailClient, GmailWatchResponse } from './gmail-client.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface GmailWatchManagerOptions {
  /** Gmail API client. */
  client: GmailClient;
  /** Full Pub/Sub topic path: projects/{project}/topics/{topic}. */
  topicName: string;
  /** Gmail label IDs to watch. Default: ['INBOX']. */
  labelIds?: string[];
  /** Renewal interval in ms. Default: 6 days. */
  renewalInterval?: number;
  /** Callback when historyId changes (for persistence). */
  onHistoryIdUpdate?: (historyId: string) => void;
}

export interface WatchState {
  /** Current watch historyId (latest synced). */
  historyId: string;
  /** Watch expiration timestamp (epoch ms). */
  expiration: number;
  /** Whether the watch is active. */
  active: boolean;
}

const SIX_DAYS_MS = 6 * 24 * 60 * 60 * 1000;

// ─── Watch Manager ─────────────────────────────────────────────────────────

export class GmailWatchManager {
  private readonly client: GmailClient;
  private readonly topicName: string;
  private readonly labelIds: string[];
  private readonly renewalInterval: number;
  private readonly onHistoryIdUpdate?: (historyId: string) => void;

  private renewalTimer: ReturnType<typeof setTimeout> | null = null;
  private state: WatchState = { historyId: '', expiration: 0, active: false };

  constructor(options: GmailWatchManagerOptions) {
    this.client = options.client;
    this.topicName = options.topicName;
    this.labelIds = options.labelIds ?? ['INBOX'];
    this.renewalInterval = options.renewalInterval ?? SIX_DAYS_MS;
    this.onHistoryIdUpdate = options.onHistoryIdUpdate;
  }

  /** Get the current watch state. */
  getState(): WatchState {
    return { ...this.state };
  }

  /** Get the last processed historyId. */
  getHistoryId(): string {
    return this.state.historyId;
  }

  /**
   * Update the historyId after processing a notification.
   * Only updates if the new historyId is greater than the current one.
   */
  updateHistoryId(historyId: string): void {
    // historyIds are numeric strings — compare numerically
    if (!this.state.historyId || BigInt(historyId) > BigInt(this.state.historyId)) {
      this.state.historyId = historyId;
      this.onHistoryIdUpdate?.(historyId);
    }
  }

  /**
   * Create or renew the Gmail Watch.
   * Sets up a renewal timer for automatic re-creation before expiry.
   */
  async createWatch(initialHistoryId?: string): Promise<GmailWatchResponse> {
    const response = await this.client.createWatch(this.topicName, this.labelIds);

    this.state = {
      historyId: initialHistoryId ?? response.historyId,
      expiration: Number(response.expiration),
      active: true,
    };

    // Schedule renewal
    this.scheduleRenewal();

    console.log(
      `[gmail-watch] Watch created, historyId=${response.historyId}, expires=${new Date(Number(response.expiration)).toISOString()}`,
    );

    return response;
  }

  /** Stop the watch and cancel renewal timer. */
  async stopWatch(): Promise<void> {
    this.cancelRenewal();

    if (this.state.active) {
      try {
        await this.client.stopWatch();
        console.log('[gmail-watch] Watch stopped');
      } catch (err) {
        // Stop can fail if the watch already expired — that's fine
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('[gmail-watch] Stop failed (may already be expired):', msg);
      }
    }

    this.state.active = false;
  }

  /** Renew the watch (creates a new one — Gmail API idempotently replaces). */
  async renewWatch(): Promise<GmailWatchResponse> {
    const currentHistoryId = this.state.historyId;
    const response = await this.client.createWatch(this.topicName, this.labelIds);

    this.state = {
      historyId: currentHistoryId || response.historyId,
      expiration: Number(response.expiration),
      active: true,
    };

    this.scheduleRenewal();

    console.log(
      `[gmail-watch] Watch renewed, expires=${new Date(Number(response.expiration)).toISOString()}`,
    );

    return response;
  }

  /**
   * Initialize with an existing historyId (e.g., loaded from PG).
   * Skips creating a new watch — assumes one is already active or will be created separately.
   */
  restoreHistoryId(historyId: string): void {
    this.state.historyId = historyId;
  }

  // ── Internal ─────────────────────────────────────────────────────────

  private scheduleRenewal(): void {
    this.cancelRenewal();

    this.renewalTimer = setTimeout(() => {
      void this.renewWatch().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[gmail-watch] Renewal failed:', msg);
        // Retry in 1 hour
        this.renewalTimer = setTimeout(
          () => {
            void this.renewWatch().catch(() => {});
          },
          60 * 60 * 1000,
        );
      });
    }, this.renewalInterval);
  }

  private cancelRenewal(): void {
    if (this.renewalTimer) {
      clearTimeout(this.renewalTimer);
      this.renewalTimer = null;
    }
  }
}
