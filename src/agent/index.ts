/**
 * Agent runtime barrel exports and factory.
 *
 * Provides a single entry point for creating the appropriate
 * agent runtime based on config (CLI or SDK). Both use the same
 * warm container lifecycle via WarmContainerRuntime base class.
 */

import type { AgentRuntime, ContainerRuntime } from '../orchestrator/types.js';
import type { FlowHelmConfig } from '../config/schema.js';
import { CliRuntime } from './cli-runtime.js';
import { SdkRuntime } from './sdk-runtime.js';
import { SessionManager } from './session-manager.js';
import type { Sql } from '../orchestrator/connection.js';
import type { SkillStore } from '../skills/store.js';

// ─── Re-exports ─────────────────────────────────────────────────────────────

export { WarmContainerRuntime } from './warm-container-runtime.js';
export type { WarmContainerRuntimeOptions } from './warm-container-runtime.js';
export { CliRuntime } from './cli-runtime.js';
export type { CliRuntimeOptions } from './cli-runtime.js';
export { SdkRuntime } from './sdk-runtime.js';
export type { SdkRuntimeOptions, SdkRunnerOutput } from './sdk-runtime.js';
export { SessionManager } from './session-manager.js';
export type { SessionManagerOptions } from './session-manager.js';
export {
  parseCliResponse,
  extractLastAssistantUuid,
  extractSessionIdFromJsonl,
} from './cli-response.js';
export { buildSystemPrompt, estimatePromptTokens } from './system-prompt.js';
export {
  generateMcpConfig,
  writeMcpConfigFile,
  buildMcpCliFlags,
  getContainerMcpConfigPath,
} from './mcp-config.js';
export { hashChatId } from './warm-container-runtime.js';

export type {
  CliJsonResponse,
  ParsedCliResponse,
  AgentSession,
  AgentSessionRow,
  WarmContainer,
  WarmContainerOptions,
  ContainerExecOptions,
} from './types.js';

// ─── Runtime Factory ────────────────────────────────────────────────────────

export interface CreateAgentRuntimeOptions {
  config: FlowHelmConfig;
  containerRuntime: ContainerRuntime;
  sql: Sql;
  proxyUrl: string;
  /** Per-user skill store for container skill sync. */
  skillStore?: SkillStore;
  /** Path to built-in skills shipped with the container image. */
  builtinSkillsDir?: string;
  /** Path to the CA certificate for MITM TLS proxy. */
  caCertPath?: string;
}

/**
 * Create an agent runtime based on config.
 *
 * Both CLI and SDK runtimes use the same warm container lifecycle.
 * CLI: `podman exec claude -p` — supports OAuth and API keys.
 * SDK: `podman exec node /workspace/sdk-runner.js` — API keys only.
 */
export function createAgentRuntime(options: CreateAgentRuntimeOptions): {
  runtime: AgentRuntime;
  sessionManager: SessionManager;
} {
  const sessionManager = new SessionManager({
    sql: options.sql,
    idleTimeout: options.config.agent.idleTimeout,
    hardExpiry: options.config.agent.sessionHardExpiry,
    cleanupInterval: options.config.agent.sessionCleanupInterval,
  });

  const runtimeOptions = {
    config: options.config,
    containerRuntime: options.containerRuntime,
    sessionManager,
    proxyUrl: options.proxyUrl,
    skillStore: options.skillStore,
    builtinSkillsDir: options.builtinSkillsDir,
    caCertPath: options.caCertPath,
  };

  const runtime =
    options.config.agent.runtime === 'sdk'
      ? new SdkRuntime(runtimeOptions)
      : new CliRuntime(runtimeOptions);

  return { runtime, sessionManager };
}
