/**
 * Channel container HTTP API types.
 *
 * Shared between the channel container (server) and the orchestrator (client).
 * The channel container exposes an HTTP API on port 9000 (configurable) for
 * outbound message delivery, health checks, and status queries.
 */

import type { ChannelType } from '../orchestrator/types.js';

// ─── Send API ─────────────────────────────────────────────────────────────

/** POST /send — send a message to any channel. */
export interface SendRequest {
  channel: ChannelType;
  userId: string;
  text: string;
  replyToMessageId?: string;
}

export interface SendResponse {
  success: boolean;
}

// ─── Google Workspace CLI API ─────────────────────────────────────────────

/**
 * POST /gws — execute a gws CLI command via the channel container.
 *
 * The channel container has the gws binary installed and holds OAuth
 * credentials. The orchestrator sends gws command strings, and the
 * channel container executes them with GOOGLE_WORKSPACE_CLI_TOKEN set
 * to a fresh OAuth access token.
 *
 * This single endpoint replaces the previous /email/send, /gmail/search,
 * /gmail/read, /contacts/* endpoints — all Google Workspace operations
 * now go through the gws CLI.
 */
export interface GwsRequest {
  /** gws CLI command arguments (e.g., "gmail +send --to bob@example.com --subject Hello --body Hi"). */
  command: string;
  /** Optional timeout in ms (default: 30000). */
  timeout?: number;
}

export interface GwsResponse {
  /** Whether the command executed successfully (exit code 0). */
  success: boolean;
  /** Stdout from gws CLI (usually JSON). */
  output: string;
  /** Stderr from gws CLI (error messages). */
  stderr?: string;
  /** Process exit code. */
  exitCode: number;
}

// ─── Health API ───────────────────────────────────────────────────────────

export type ChannelStatus = 'connected' | 'disconnected' | 'not_configured';

/** GET /healthz — health check with per-channel status. */
export interface HealthResponse {
  status: 'ok' | 'degraded';
  channels: Record<string, ChannelStatus>;
  uptimeMs: number;
}

// ─── Status API ───────────────────────────────────────────────────────────

export interface ChannelStatusDetail {
  status: ChannelStatus;
  lastMessageAt?: number;
  errorCount: number;
  lastError?: string;
}

/** GET /status — detailed per-channel status. */
export interface StatusResponse {
  channels: Record<string, ChannelStatusDetail>;
  uptimeMs: number;
}

// ─── Error ────────────────────────────────────────────────────────────────

export interface ErrorResponse {
  error: string;
  code: string;
}

// ─── Channel Container Config ─────────────────────────────────────────────

export interface ChannelContainerConfig {
  /** Channel container image. */
  image: string;
  /** Memory limit for the channel container. */
  memoryLimit: string;
  /** CPU limit for the channel container. */
  cpuLimit: string;
  /** HTTP API port inside the container. */
  port: number;
}
