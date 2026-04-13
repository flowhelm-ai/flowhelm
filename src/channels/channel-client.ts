/**
 * Channel container HTTP client.
 *
 * Used by the orchestrator to send outbound messages via the channel
 * container's HTTP API. Replaces direct adapter.send() calls —
 * the orchestrator no longer imports or holds channel adapters.
 *
 * Follows the ServiceClient pattern: simple fetch-based methods with
 * timeout and error handling.
 *
 * Google Workspace operations (email, contacts, calendar, etc.) go
 * through the generic gws() method → channel container's POST /gws
 * endpoint → gws CLI binary.
 */

import type {
  SendRequest,
  SendResponse,
  GwsRequest,
  GwsResponse,
  HealthResponse,
  StatusResponse,
  ErrorResponse,
} from './channel-types.js';
import type { ChannelType } from '../orchestrator/types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ChannelClientOptions {
  /** Base URL of the channel container (e.g., http://flowhelm-channel-stan:9000). */
  baseUrl: string;
  /** Request timeout in ms (default: 10000). */
  timeout?: number;
}

// ─── Client ─────────────────────────────────────────────────────────────────

export class ChannelClient {
  private readonly baseUrl: string;
  private readonly timeout: number;

  constructor(options: ChannelClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.timeout = options.timeout ?? 10_000;
  }

  /**
   * Send a message to a channel via the channel container.
   */
  async send(
    channel: ChannelType,
    userId: string,
    text: string,
    replyToMessageId?: string,
  ): Promise<void> {
    const body: SendRequest = { channel, userId, text, replyToMessageId };

    const response = await fetch(`${this.baseUrl}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!response.ok) {
      const error = (await response
        .json()
        .catch(() => ({ error: 'Unknown error' }))) as ErrorResponse;
      throw new Error(`Channel send failed (${String(response.status)}): ${error.error}`);
    }

    (await response.json()) as SendResponse;
  }

  /**
   * Execute a gws CLI command via the channel container.
   *
   * All Google Workspace operations (email, contacts, calendar, drive, etc.)
   * go through this single method. The channel container holds the gws binary
   * and OAuth credentials — it executes the command and returns the result.
   *
   * @param command - gws CLI arguments (e.g., "gmail +send --to bob@example.com --subject Hi --body Hello")
   * @param timeout - Optional timeout in ms (default: 30000, max: 60000)
   */
  async gws(command: string, timeout?: number): Promise<GwsResponse> {
    const body: GwsRequest = { command, timeout };

    const response = await fetch(`${this.baseUrl}/gws`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.min(timeout ?? 30_000, 60_000) + 5_000),
    });

    if (!response.ok) {
      const error = (await response
        .json()
        .catch(() => ({ error: 'Unknown error' }))) as ErrorResponse;
      throw new Error(`gws command failed (${String(response.status)}): ${error.error}`);
    }

    return (await response.json()) as GwsResponse;
  }

  /**
   * Check channel container health and per-channel connection status.
   */
  async health(): Promise<HealthResponse> {
    const response = await fetch(`${this.baseUrl}/healthz`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      throw new Error(`Channel health check failed: ${String(response.status)}`);
    }

    return (await response.json()) as HealthResponse;
  }

  /**
   * Get detailed per-channel status.
   */
  async status(): Promise<StatusResponse> {
    const response = await fetch(`${this.baseUrl}/status`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      throw new Error(`Channel status check failed: ${String(response.status)}`);
    }

    return (await response.json()) as StatusResponse;
  }

  /**
   * Check if the channel container is reachable.
   */
  async isReachable(): Promise<boolean> {
    try {
      await this.health();
      return true;
    } catch {
      return false;
    }
  }
}
