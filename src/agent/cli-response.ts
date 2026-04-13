/**
 * CLI JSON response parser for `claude -p --output-format json`.
 *
 * Parses the structured JSON output from the Claude Code CLI,
 * extracting the agent's text response, token usage, session ID,
 * and error information.
 *
 * Also extracts the last assistant message UUID from session JSONL
 * files for precise resume point tracking (ADR-032).
 */

import type { CliJsonResponse, ParsedCliResponse } from './types.js';

// ─── CLI Response Parser ────────────────────────────────────────────────────

/**
 * Parse the JSON output from `claude -p --output-format json`.
 *
 * The CLI outputs a single JSON object on stdout. Stderr may contain
 * warnings or progress info. This function handles:
 * - Valid JSON response
 * - Empty/malformed output
 * - Partial output (agent killed mid-response)
 */
export function parseCliResponse(stdout: string, stderr: string): ParsedCliResponse {
  const trimmed = stdout.trim();

  if (!trimmed) {
    return {
      text: '',
      success: false,
      error: stderr.trim() || 'Empty response from agent',
      sessionId: '',
      numTurns: 0,
      cost: { inputTokens: 0, outputTokens: 0 },
    };
  }

  let json: CliJsonResponse;
  try {
    json = JSON.parse(trimmed) as CliJsonResponse;
  } catch {
    // Try to extract JSON from output that may have non-JSON prefix/suffix
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        json = JSON.parse(jsonMatch[0]) as CliJsonResponse;
      } catch {
        return {
          text: trimmed,
          success: false,
          error: 'Failed to parse agent response as JSON',
          sessionId: '',
          numTurns: 0,
          cost: { inputTokens: 0, outputTokens: 0 },
        };
      }
    } else {
      return {
        text: trimmed,
        success: false,
        error: 'Failed to parse agent response as JSON',
        sessionId: '',
        numTurns: 0,
        cost: { inputTokens: 0, outputTokens: 0 },
      };
    }
  }

  return {
    text: json.result ?? '',
    success: !json.is_error,
    error: json.is_error ? json.result || 'Agent returned an error' : undefined,
    sessionId: json.session_id ?? '',
    numTurns: json.num_turns ?? 0,
    cost: {
      inputTokens: json.total_input_tokens ?? 0,
      outputTokens: json.total_output_tokens ?? 0,
    },
  };
}

/**
 * Extract the last assistant message UUID from a Claude session JSONL file.
 *
 * The JSONL file contains one JSON object per line, each with a `type` field.
 * Assistant messages have `type: "assistant"` and a `uuid` field. We need
 * the UUID of the last assistant message for `--resume` precision.
 */
export function extractLastAssistantUuid(sessionJsonl: string): string | null {
  const lines = sessionJsonl.trim().split('\n');
  let lastUuid: string | null = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry.type === 'assistant' && typeof entry.uuid === 'string') {
        lastUuid = entry.uuid;
        break;
      }
    } catch {
      continue;
    }
  }

  return lastUuid;
}

/**
 * Extract the session ID from a `system/init` message in session JSONL.
 */
export function extractSessionIdFromJsonl(sessionJsonl: string): string | null {
  const lines = sessionJsonl.trim().split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as Record<string, unknown>;
      if (entry.type === 'system' && typeof entry.session_id === 'string') {
        return entry.session_id;
      }
    } catch {
      continue;
    }
  }

  return null;
}
