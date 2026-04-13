# Agent Runtime

## Overview

FlowHelm supports two agent runtimes behind the same container interface. Both run inside Podman rootless containers. The orchestrator doesn't know which runtime is active — both implement the `AgentRuntime` interface.

## CLI Runtime (Default)

The CLI runtime invokes Anthropic's `claude` binary as a subprocess inside the Podman container. This is the default runtime.

### Invocation Pattern

```bash
claude -p "$TASK_PROMPT" \
  --system-prompt "$FLOWHELM_SYSTEM_PROMPT" \
  --append-system-prompt "$PRE_TASK_CONTEXT" \
  --output-format json \
  --dangerously-skip-permissions \
  --max-turns 25 \
  --strict-mcp-config \
  --mcp-config /workspace/mcp-config.json
```

Key flags:
- `-p "..."`: Non-interactive prompt mode. The entire task is a single prompt.
- `--system-prompt`: Replaces the CLI's default coding-focused system prompt with FlowHelm's minimal, task-focused prompt. This is the primary token optimization — see "CLI Token Optimization" below.
- `--append-system-prompt`: Appends `buildAgentContext()` output (identity, memory tiers) on top of the custom system prompt.
- `--output-format json`: Structured output for orchestrator parsing.
- `--dangerously-skip-permissions`: Required for headless operation (no human to approve tool calls).
- `--max-turns`: Prevent runaway tool-use loops. Default 25, configurable per user.
- `--strict-mcp-config`: Only load MCP servers specified in `--mcp-config`. Prevents the agent from discovering MCP servers from project or user config files.
- `--mcp-config`: Path to FlowHelm's MCP server configuration.

**NOT used by default (preserves skills):**
- `--disable-slash-commands`: Saves ~1-2K tokens but **disables all skills**. Since FlowHelm is an extensible platform where users install skills, this flag is off by default. Users who have no skills installed can opt in via `agent.cliDisableSlashCommands: true`. See ADR-026.

**Optional user-configurable flags:**
- `--tools "Bash,Read,Write,Edit"`: Restricts which built-in tools are available to the agent. Not set by default (all tools available), but users can configure this to further reduce token overhead if their use case requires fewer tools. See `agent.cliTools` in config.

### Credential Passing

Two auth paths for CLI runtime:

**API keys**: Passed via `--env ANTHROPIC_API_KEY` at container launch. V1 uses direct injection; V2 routes through the credential proxy.

**Subscription OAuth (Pro/Max)**: The `claude` binary inside the container authenticates via mounted OAuth tokens from the host. The token file is bind-mounted read-only from the user's home directory. No API key exists in this flow — the CLI handles token refresh internally. The token optimization flags (`--system-prompt`, `--disable-slash-commands`, `--strict-mcp-config`) all preserve OAuth compatibility — unlike `--bare` which requires API keys.

### Response Parsing

The orchestrator parses the JSON response:
- `result`: Text response to send back to the user via the channel
- `tool_calls`: Actions taken during task execution
- `cost`: Token usage for billing/monitoring
- `error`: Failure information

### CLI Token Optimization (ADR-026)

The CLI's default system prompt + tool definitions total ~27-31K tokens:
- Default coding-focused system prompt: ~2.5-4K tokens
- Built-in tool schemas (27 tools, 9 fully loaded + 18 deferred): ~14-17.6K tokens
- Skill/slash command definitions: ~1-2K tokens

This is designed for interactive coding assistance — irrelevant for FlowHelm's agents. FlowHelm reduces this overhead using two always-on flags plus optional user settings, all compatible with OAuth (unlike `--bare`):

**1. `--system-prompt` (replaces default prompt) — always on**

The default prompt contains detailed instructions for code editing, git workflows, PR creation, commit conventions, and IDE integration — none of which apply to FlowHelm agents. FlowHelm replaces it with a minimal, task-focused prompt (~500-800 tokens):

```
You are a personal AI assistant operating inside FlowHelm.
You have access to tools for file operations, shell commands, and web access.
Use the MCP tools (search_memory, search_knowledge, store_memory) to access
and update your memory about this user. Follow the instructions and context
provided below. Be concise and action-oriented.
```

**Savings: ~2-3K tokens.**

**2. `--strict-mcp-config` (isolates MCP servers) — always on**

Only load FlowHelm's memory MCP server — ignore any MCP servers from project or user config files that might be in the container working directory.

**Savings: prevents unbounded MCP tool overhead.**

**3. `--disable-slash-commands` (optional, OFF by default)**

This flag removes skill and command definitions from context (~1-2K tokens). However, it **disables ALL skills** — including user-installed custom skills. Since FlowHelm is an extensible platform where users install agent skills, this flag is **off by default**. Users who have no skills installed can opt in via `agent.cliDisableSlashCommands: true` for the extra savings.

**Savings when enabled: ~1-2K tokens. Cost: no skills.**

**4. `--tools` (optional, user-configurable)**

Not set by default — all 27 built-in tools remain available. Users who want to further reduce overhead can restrict tools via `agent.cliTools` in their config. For example, an agent that only processes emails may only need `Bash`, `Read`, `Write`, `Edit` (4 tools instead of 27). This is a user choice, not a FlowHelm default.

**Estimated token budget:**

| Component | Default CLI | FlowHelm Default | + `--disable-slash-commands` | + `--tools` (4 tools) |
|---|---|---|---|---|
| System prompt | ~2.5-4K | ~0.5-0.8K | ~0.5-0.8K | ~0.5-0.8K |
| Tool schemas (27 tools) | ~14-17.6K | ~14-17.6K | ~14-17.6K | ~4-6K (est.) |
| Skills/slash commands | ~1-2K | ~1-2K | 0 | 0 |
| **CLI overhead subtotal** | **~27-31K** | **~16-20K** | **~15-18K** | **~5-7K** |
| FlowHelm memory context | ~10K | ~10K | ~10K | ~10K |
| **Total per invocation** | **~37-41K** | **~26-30K** | **~25-28K** | **~15-17K** |

The default optimization saves ~10-11K tokens per invocation (~30% reduction) while preserving skill extensibility. Users who also disable skills and restrict tools can achieve ~55-60% reduction. See ADR-026 in @docs/decisions.md.

**Why not `--bare`?** The `--bare` flag requires `ANTHROPIC_API_KEY` or `apiKeyHelper` — it bypasses subscription OAuth entirely. Since Personal and Team tiers primarily use subscription OAuth, `--bare` would defeat the purpose. The flags above achieve comparable or better token savings while preserving OAuth. See ADR-025 in @docs/decisions.md.

### Tool Access

Tools are controlled by two layers:

**Built-in Claude Code tools**: All 27 built-in tools available by default (Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch, Agent, etc.). Users can restrict this set via `agent.tools` in config.

**Container-installed binaries**: Claude Code discovers installed binaries and uses them via Bash tool calls:
- `gws` CLI (Gmail, Calendar, Drive operations)
- Standard Unix tools (bash, curl, git, etc.)
- `whisper-cli` (optional, for local transcription)
- Any tools installed by user-configured skills

### MCP Server (On-Demand Memory Access)

The CLI runtime connects to FlowHelm's MCP server via a Unix domain socket bind-mounted into the container. The orchestrator generates `/workspace/mcp-config.json` and passes it via `--strict-mcp-config --mcp-config`:

```json
{
  "mcpServers": {
    "flowhelm": {
      "command": "node",
      "args": ["/workspace/stdio-to-uds-bridge.js"]
    }
  }
}
```

The `stdio-to-uds-bridge.js` is a lightweight custom script (~50 lines of Node.js) that pipes stdin/stdout to/from the MCP server's Unix domain socket at `/workspace/ipc/memory.sock`. It is shipped in the agent container image.

This gives the agent five MCP tools: `search_memory` (semantic search over long-term memories), `search_knowledge` (RAG over knowledge base), `recall_conversation` (extended conversation history), `store_memory` (write new memories mid-task), and `get_memory_stats` (introspection). The agent calls these on demand during task execution, complementing the pre-selected ~5K token context injected at task start. See ADR-023 and @docs/memory.md for the full design.

## SDK Runtime (Team Optional, Enterprise Required)

The Agent SDK (`@anthropic-ai/claude-agent-sdk`) is a TypeScript library that provides programmatic control over Claude. It is a separate package from the CLI binary (`@anthropic-ai/claude-code`). FlowHelm uses the same warm container pattern for the SDK runtime as for the CLI runtime — containers stay alive with `CMD sleep infinity`, each message processed via `podman exec node /workspace/sdk-runner.js`. The `sdk-runner.js` script (shipped in the container image, ESM module) wraps the SDK's `query()` function into a JSON CLI interface. See ADR-049.

### What the SDK Enables Beyond CLI

**Custom system prompts**: Industry-specific agent behavior for legal, healthcare, finance. Enterprise compliance often mandates specific instructions that override the CLI's generic coding prompt.

**Subagents**: Parallel task processing — analyze email thread, check calendar, draft reply, and schedule follow-up simultaneously via `query()` with nested agent calls.

**Programmatic hooks**: Per-task permission callbacks for compliance audit trails. The orchestrator can intercept every tool call before execution.

**Tool Search**: Dynamic tool loading to save context window. Tools are registered programmatically and loaded on demand, not discovered from the filesystem.

### Auth Requirement

The Agent SDK explicitly requires API keys. Subscription OAuth is not supported — Anthropic prohibits it. This is the primary reason CLI is the default: requiring API keys at $3-15/day kills personal user adoption.

### Container Invocation Pattern

The SDK runtime uses the same warm container lifecycle as CLI. The orchestrator runs:

```bash
podman exec {container} node /workspace/sdk-runner.js \
  --message "$TASK_PROMPT" \
  --max-turns 25 \
  --mcp-config /workspace/config/mcp-config.json \
  --append-system-prompt "$PRE_TASK_CONTEXT" \
  --resume "$SESSION_ID"
```

Inside the container, `sdk-runner.js` (ESM module) calls the Agent SDK:

```javascript
import { query } from '@anthropic-ai/claude-agent-sdk';

for await (const message of query({
  prompt: args.message,
  maxTurns: args.maxTurns,
  allowDangerouslySkipPermissions: true,
  permissionMode: 'bypassPermissions',
  systemPrompt: args.systemPrompt,
  resume: true,
  sessionId: args.resume,
  mcpServers: { /* loaded from --mcp-config file */ },
})) {
  // Track session_id from init, count turns, capture result
}

// Output JSON to stdout: { result, is_error, session_id, num_turns, input_tokens, output_tokens }
```

**Package architecture in agent container** (ADR-049):
- `@anthropic-ai/claude-code` installed **globally** → provides the `claude` CLI binary for CLI runtime
- `@anthropic-ai/claude-agent-sdk` installed **locally** in `/workspace/node_modules/` → provides the `query()` API for SDK runtime
- Both packages are ESM-only; the local install ensures Node.js ESM resolution finds the SDK

The `SdkRunnerOutput` JSON format:

```typescript
interface SdkRunnerOutput {
  result: string;       // Agent's response text
  is_error: boolean;    // Whether the query failed
  session_id: string;   // Session UUID for --resume
  num_turns: number;    // Number of agent turns
  input_tokens: number; // Total input tokens consumed
  output_tokens: number; // Total output tokens consumed
}
```

### MCP Memory Access

The `--mcp-config` flag points to the same MCP config file used by the CLI runtime. The `sdk-runner.js` reads the config, constructs `mcpServers` options from it, and passes them to `query()`. This gives the SDK runtime the same on-demand memory access as the CLI runtime — all MCP tools available via UDS bind-mount. See ADR-023.

### Warm Container Lifecycle (Shared with CLI)

Both `CliRuntime` and `SdkRuntime` extend the `WarmContainerRuntime` abstract base class. All container lifecycle is shared:

- **Idle timeout**: Same configurable timeout (default 60 minutes). Container stopped + removed after inactivity.
- **Hard expiry**: Same 24-hour maximum session lifetime.
- **PG backup**: Same async backup after every message. Same JSONB UPSERT to `agent_sessions`.
- **Cold-start restore**: Same PG → filesystem restore on container creation.
- **Shutdown**: Same graceful shutdown (final backup → stop → remove).

The only differences between CLI and SDK are:
1. The `podman exec` command (`claude -p` vs `node /workspace/sdk-runner.js`)
2. The response parser (CLI JSON format vs SDK runner JSON format)
3. Auth mechanism (OAuth or API keys vs API keys only)

## Runtime Abstraction

Both runtimes extend `WarmContainerRuntime` which implements the `AgentRuntime` interface. The orchestrator is runtime-agnostic.

```typescript
interface AgentRuntime {
  execute(task: AgentTask): Promise<AgentResult>;
  isHealthy(): Promise<boolean>;
}

abstract class WarmContainerRuntime implements AgentRuntime {
  // Shared: container lifecycle, PG backup, idle timer, shutdown
  protected abstract buildCommand(task, container): string[];
  protected abstract parseExecResult(stdout, stderr): { result; sessionId };
  protected abstract get runtimeName(): string;
}
```

`CliRuntime` builds `claude -p` commands, parses CLI JSON output.

`SdkRuntime` builds `node /workspace/sdk-runner.js` commands, parses SDK runner JSON output.

The orchestrator selects the runtime based on user config:

```typescript
const runtime = options.config.agent.runtime === 'sdk'
  ? new SdkRuntime(runtimeOptions)
  : new CliRuntime(runtimeOptions);
```

This makes the switch per-user, not per-deployment. Teammates on a Team plan can use different runtimes.

## Migration Path

Switching from CLI to SDK runtime is a per-user config change:

1. User obtains an Anthropic API key
2. User adds API key via `flowhelm credentials add anthropic`
3. User sets `agentRuntime: "sdk"` in their config
4. Orchestrator picks up the change on next task — no restart needed

Team users can switch anytime. Enterprise deployments start on SDK from day one.

There is no migration from SDK to CLI for Enterprise — the SDK is required for compliance reasons (custom system prompts, programmatic hooks, deterministic audit trails).

## Memory Access Model

Both runtimes receive memory through two complementary layers:

### Layer 1: Pre-Task Injection (Passive)

Before the agent starts, the orchestrator calls `buildAgentContext()` to assemble ~5K tokens of relevant context from the three-tier memory system (short-term session messages, long-term semantic memories, knowledge base RAG). This is injected via:

- **CLI runtime**: `--append-system-prompt` flag
- **SDK runtime**: `systemPrompt` option

The agent sees this context immediately — no tool calls needed. See @docs/memory.md and ADR-019.

### Layer 2: On-Demand Retrieval (Active)

During task execution, the agent can query the full memory database via MCP tools exposed by the orchestrator's MCP server over a Unix domain socket:

- `search_memory` — semantic search over long-term memories (preferences, facts, contacts, patterns)
- `search_knowledge` — RAG over knowledge base (conversation summaries, documents)
- `recall_conversation` — extended conversation history beyond the pre-selected window
- `store_memory` — write new memories in real-time during task execution
- `get_memory_stats` — introspection on memory state

This is the equivalent of Claude Code's ability to read `.claude/` memory files on demand, but with semantic search instead of file reads. The agent decides when it needs more context — the orchestrator doesn't have to guess everything in advance. See @docs/memory.md and ADR-023.

### Example: Two-Layer Access in Action

```
Pre-task injection (~5K tokens):
  - Recent messages: "Reply to John about the budget"
  - Preference: "Always draft first, ask before sending"
  - Contact: "john.smith@company.com"

User follows up: "Also mention that vendor he recommended"

Agent calls: search_knowledge("vendor John recommended")
  → Returns: "2026-03-15: John proposed Acme Corp for Q3 supplies"

Agent calls: search_memory("Acme Corp", type="contact")
  → Returns: "Acme Corp rep: Sarah Chen, vendor@acme.com"

Agent now has full context to draft the email.
```

## Session Strategy: Warm Containers with Resume

Both runtimes use warm containers that stay alive between messages (default 60-min idle timeout). Each message is processed via `podman exec claude -p --resume SESSION_ID`. Session files live in the container filesystem; PostgreSQL backs them up asynchronously for crash recovery and cold restarts. Rationale documented in @docs/decisions.md ADR-008 and ADR-032.

The three-tier memory system in PostgreSQL + pgvector provides persistent long-term recall that survives across all sessions — crash-safe, transactional, and semantically searchable. `buildAgentContext()` is re-injected every message via `--append-system-prompt`, complementing the session transcript. See @docs/memory.md and @docs/sessions.md.
