/**
 * Agent runtime types for CLI and SDK execution modes.
 *
 * CLI response parsing, session metadata for PG backup/restore,
 * warm container tracking, and runtime configuration.
 */

// ─── CLI Response Types ────────────────────────────────────────────────────

/**
 * Parsed response from `claude -p --output-format json`.
 *
 * The CLI outputs a JSON object with the agent's final result,
 * tool calls made during execution, token usage, and session ID.
 */
export interface CliJsonResponse {
  /** Final text result from the agent. */
  result: string;
  /** Whether the agent completed normally (vs. hitting max turns or erroring). */
  is_error: boolean;
  /** Total input tokens consumed. */
  total_cost_usd?: number;
  /** Session ID for future `--resume`. */
  session_id: string;
  /** Number of turns the agent took. */
  num_turns: number;
  /** Total input tokens. */
  total_input_tokens?: number;
  /** Total output tokens. */
  total_output_tokens?: number;
}

/**
 * Parsed and normalized CLI response for internal use.
 */
export interface ParsedCliResponse {
  /** Agent's text response. */
  text: string;
  /** Whether the execution succeeded. */
  success: boolean;
  /** Error message if failed. */
  error?: string;
  /** Session ID for `--resume` on next invocation. */
  sessionId: string;
  /** Number of agent turns taken. */
  numTurns: number;
  /** Token usage for billing/tracking. */
  cost: {
    inputTokens: number;
    outputTokens: number;
  };
}

// ─── Session Types ─────────────────────────────────────────────────────────

/**
 * Agent session metadata stored in PostgreSQL.
 *
 * Session files (JSONL transcripts, subagent data, tool results)
 * live in the container filesystem during warm operation. PG backup
 * is the crash safety net — restored only on cold start.
 */
export interface AgentSession {
  /** Chat ID (primary key — one active session per chat). */
  chatId: string;
  /** Claude Code session ID for `--resume`. */
  sessionId: string;
  /** Flat JSONB map of session files: { "path/file.jsonl": "content", ... } */
  sessionFiles: Record<string, string>;
  /** Last assistant message UUID for precise resume point. */
  lastAssistantUuid: string | null;
  /** Number of messages processed in this session. */
  messageCount: number;
  /** When this session was created. */
  createdAt: number;
  /** Last time session was updated (PG backup timestamp). */
  updatedAt: number;
  /** When this session expires (idle timeout or hard expiry). */
  expiresAt: number;
}

/**
 * Row shape for the agent_sessions PostgreSQL table.
 */
export interface AgentSessionRow {
  chat_id: string;
  session_id: string;
  session_files: Record<string, string>;
  last_assistant_uuid: string | null;
  message_count: number;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

// ─── Warm Container Types ──────────────────────────────────────────────────

/**
 * Tracks the state of a warm agent container.
 *
 * Warm containers stay alive between messages (CMD sleep infinity).
 * Each message is processed via `podman exec claude -p --resume`.
 */
export interface WarmContainer {
  /** Podman container ID. */
  containerId: string;
  /** Container name (flowhelm-agent-{username}-{chatIdHash}). */
  containerName: string;
  /** Chat ID this container serves. */
  chatId: string;
  /** Current Claude Code session ID (null if fresh). */
  sessionId: string | null;
  /** When this container was created. */
  createdAt: number;
  /** When the last message was processed. */
  lastActivityAt: number;
  /** Number of messages processed in this container's lifetime. */
  messageCount: number;
  /** Host directory for session files (bind-mounted into container). */
  sessionDir: string;
  /** Host directory for IPC sockets (bind-mounted into container). */
  ipcDir: string;
}

/**
 * Options for creating a new warm agent container.
 */
export interface WarmContainerOptions {
  /** Chat ID this container will serve. */
  chatId: string;
  /** Username for container naming. */
  username: string;
  /** Container image. */
  image: string;
  /** Memory limit (e.g., "512m"). */
  memoryLimit: string;
  /** CPU limit (e.g., "1.0"). */
  cpuLimit: string;
  /** Max PIDs. */
  pidsLimit: number;
  /** Podman network name. */
  network: string;
  /** Proxy URL for credential injection. */
  proxyUrl: string;
  /** Host IPC directory for MCP socket. */
  ipcDir: string;
  /** Host session directory for session file persistence. */
  sessionDir: string;
  /** Additional environment variables. */
  env?: Record<string, string>;
}

/**
 * Options for executing a message in a warm container.
 */
export interface ContainerExecOptions {
  /** The user's message/prompt. */
  message: string;
  /** Pre-built context from buildAgentContext(). */
  systemPrompt: string;
  /** Path to MCP config file inside the container. */
  mcpConfigPath: string;
  /** Max agent turns. */
  maxTurns: number;
  /** Whether to resume an existing session. */
  resumeSessionId?: string;
  /** Use custom system prompt (ADR-026). */
  useCustomSystemPrompt: boolean;
  /** Disable slash commands (ADR-026). */
  disableSlashCommands: boolean;
  /** Restrict tools (ADR-026). */
  tools?: string;
}
