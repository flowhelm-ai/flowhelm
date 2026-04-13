/**
 * SDK agent runtime — extends WarmContainerRuntime.
 *
 * Same warm container lifecycle as CLI runtime but executes
 * `podman exec node /workspace/sdk-runner.js` which calls the
 * Claude Agent SDK's query() function.
 *
 * Requires API keys (OAuth not supported for SDK).
 * Used for Team (optional) and Enterprise (required) tiers.
 */

import type { AgentTask, AgentResult } from '../orchestrator/types.js';
import type { WarmContainer } from './types.js';
import { WarmContainerRuntime } from './warm-container-runtime.js';
import type { WarmContainerRuntimeOptions } from './warm-container-runtime.js';
import { buildSystemPrompt } from './system-prompt.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type SdkRuntimeOptions = WarmContainerRuntimeOptions;

/** JSON output from sdk-runner.js. */
export interface SdkRunnerOutput {
  result: string;
  is_error: boolean;
  session_id: string;
  num_turns: number;
  input_tokens: number;
  output_tokens: number;
}

// ─── SDK Runtime ────────────────────────────────────────────────────────────

export class SdkRuntime extends WarmContainerRuntime {
  protected get runtimeName(): string {
    return 'sdk-runtime';
  }

  protected buildCommand(task: AgentTask, container: WarmContainer): string[] {
    const args: string[] = [
      'node',
      '/workspace/sdk-runner.js',
      '--message',
      task.message,
      '--max-turns',
      String(task.maxTurns),
      '--mcp-config',
      '/workspace/config/mcp-config.json',
    ];

    // Append memory context
    if (task.systemPrompt) {
      args.push('--append-system-prompt', task.systemPrompt);
    }

    // Custom system prompt
    if (this.config.agent.cliUseCustomSystemPrompt) {
      const prompt = buildSystemPrompt({ useCustom: true });
      if (prompt) {
        args.push('--system-prompt', prompt);
      }
    }

    // Session resume
    if (container.sessionId) {
      args.push('--resume', container.sessionId);
    }

    // Allowed tools
    if (this.config.agent.cliTools) {
      args.push('--allowed-tools', this.config.agent.cliTools);
    }

    return args;
  }

  protected parseExecResult(
    stdout: string,
    stderr: string,
  ): { result: AgentResult; sessionId: string } {
    const trimmed = stdout.trim();

    if (!trimmed) {
      return {
        result: {
          text: '',
          toolCalls: [],
          cost: { inputTokens: 0, outputTokens: 0 },
          success: false,
          error: stderr.trim() || 'Empty response from SDK runner',
        },
        sessionId: '',
      };
    }

    let json: SdkRunnerOutput;
    try {
      json = JSON.parse(trimmed) as SdkRunnerOutput;
    } catch {
      return {
        result: {
          text: trimmed,
          toolCalls: [],
          cost: { inputTokens: 0, outputTokens: 0 },
          success: false,
          error: 'Failed to parse SDK runner response as JSON',
        },
        sessionId: '',
      };
    }

    return {
      result: {
        text: json.result ?? '',
        toolCalls: [],
        cost: {
          inputTokens: json.input_tokens ?? 0,
          outputTokens: json.output_tokens ?? 0,
        },
        success: !json.is_error,
        error: json.is_error ? json.result || 'Agent returned an error' : undefined,
      },
      sessionId: json.session_id ?? '',
    };
  }
}
