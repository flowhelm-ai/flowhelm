/**
 * System prompt builder for agent containers.
 *
 * Generates a minimal, task-focused system prompt (~500-800 tokens)
 * that replaces Claude Code's default coding-focused prompt (ADR-026).
 *
 * The prompt is injected via `--system-prompt` (CLI) or `systemPrompt`
 * option (SDK). Memory context is appended via `--append-system-prompt`.
 *
 * Design: The prompt tells the agent what it is, how to use MCP tools,
 * and basic behavioral guidelines. It does NOT include memory context
 * (that's appended separately by buildAgentContext()).
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SystemPromptOptions {
  /** Whether to use the custom FlowHelm system prompt (ADR-026). Default: true. */
  useCustom: boolean;
  /** Agent display name (from identity, if available). */
  agentName?: string;
  /** Username of the person this agent serves. */
  username?: string;
}

// ─── System Prompt Builder ──────────────────────────────────────────────────

/**
 * Build the system prompt for an agent container.
 *
 * When useCustom is true, returns a minimal task-focused prompt
 * (~500-800 tokens) that saves ~2-3K tokens vs CLI's default.
 * When false, returns undefined (CLI uses its default prompt).
 */
export function buildSystemPrompt(options: SystemPromptOptions): string | undefined {
  if (!options.useCustom) return undefined;

  const name = options.agentName ?? 'FlowHelm Agent';
  const user = options.username ? ` for ${options.username}` : '';

  return `You are ${name}, a personal AI assistant${user}. You help with tasks, answer questions, and manage information through conversation.

## Core Behavior

- Respond directly and concisely to the user's message.
- Use the tools available to you when needed. Prefer action over explanation.
- When you learn something about the user (preferences, facts, contacts), store it using memory tools so you can recall it later.
- When you need context about the user or past conversations, search memory first.
- Never fabricate information. If you don't know something and can't find it in memory, say so.
- Respect the user's communication style. Match their formality level.

## Memory Tools

You have access to memory tools via MCP. Use them proactively:

- **search_semantic**: Find stored facts, preferences, and patterns about the user.
- **store_semantic**: Save new facts, preferences, or patterns you learn.
- **recall_conversation**: Review recent conversation history.
- **search_external**: Search uploaded documents and knowledge base.
- **get_identity**: Get your configured identity and the user's profile.
- **observe_personality**: Record observations about the user's communication style.

Your appended context (below) contains pre-fetched memory relevant to this message. MCP tools let you search for additional context during your response.

## Guidelines

- Be helpful, accurate, and respectful.
- Keep responses focused on what the user asked.
- If a task requires multiple steps, break it down and execute each step.
- For ambiguous requests, make reasonable assumptions and note them.
- Prioritize the user's stated preferences (from memory) in your responses.`;
}

/**
 * Estimate the token count of the system prompt.
 * Uses a rough 4 chars per token heuristic.
 */
export function estimatePromptTokens(prompt: string): number {
  return Math.ceil(prompt.length / 4);
}
