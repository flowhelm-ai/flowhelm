/**
 * CLI agent runtime — extends WarmContainerRuntime.
 *
 * Executes `podman exec claude -p --output-format json` inside warm containers.
 * Token optimization via custom system prompt (ADR-026).
 */

import type { AgentTask, AgentResult } from '../orchestrator/types.js';
import type { WarmContainer, ContainerExecOptions } from './types.js';
import { WarmContainerRuntime } from './warm-container-runtime.js';
import type { WarmContainerRuntimeOptions } from './warm-container-runtime.js';
import { parseCliResponse } from './cli-response.js';
import { buildSystemPrompt } from './system-prompt.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type CliRuntimeOptions = WarmContainerRuntimeOptions;

// ─── CLI Runtime ────────────────────────────────────────────────────────────

export class CliRuntime extends WarmContainerRuntime {
  protected get runtimeName(): string {
    return 'cli-runtime';
  }

  protected buildCommand(task: AgentTask, container: WarmContainer): string[] {
    const options: ContainerExecOptions = {
      message: task.message,
      systemPrompt: task.systemPrompt ?? '',
      mcpConfigPath: '/workspace/config/mcp-config.json',
      maxTurns: task.maxTurns,
      resumeSessionId: container.sessionId ?? undefined,
      useCustomSystemPrompt: this.config.agent.cliUseCustomSystemPrompt,
      disableSlashCommands: this.config.agent.cliDisableSlashCommands,
      tools: this.config.agent.cliTools,
    };
    return this.buildCliCommand(options);
  }

  protected parseExecResult(
    stdout: string,
    stderr: string,
  ): { result: AgentResult; sessionId: string } {
    const parsed = parseCliResponse(stdout, stderr);
    return {
      result: {
        text: parsed.text,
        toolCalls: [],
        cost: parsed.cost,
        success: parsed.success,
        error: parsed.error,
      },
      sessionId: parsed.sessionId,
    };
  }

  /**
   * Build the full `claude -p` command with all flags.
   * Public for testing.
   */
  buildCliCommand(options: ContainerExecOptions): string[] {
    const args: string[] = ['claude', '-p', '--output-format', 'json'];

    args.push('--dangerously-skip-permissions');
    args.push('--max-turns', String(options.maxTurns));

    if (options.useCustomSystemPrompt) {
      const prompt = buildSystemPrompt({ useCustom: true });
      if (prompt) {
        args.push('--system-prompt', prompt);
      }
    }

    if (options.systemPrompt) {
      args.push('--append-system-prompt', options.systemPrompt);
    }

    args.push('--mcp-config', options.mcpConfigPath);
    args.push('--strict-mcp-config');

    if (options.resumeSessionId) {
      args.push('--resume', options.resumeSessionId);
    }

    if (options.disableSlashCommands) {
      args.push('--disable-slash-commands');
    }

    if (options.tools) {
      args.push('--allowedTools', options.tools);
    }

    args.push(options.message);

    return args;
  }
}
