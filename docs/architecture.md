# Architecture

## System Overview

FlowHelm is a multi-tenant AI agent orchestrator. Each user runs a fully independent agent stack under a dedicated Linux user: orchestrator process, PostgreSQL database container, credential proxy container, and warm agent containers — all in Podman rootless with separate UID namespaces. Agent containers stay alive between messages (default 60-minute idle timeout, configurable) and process each message via `podman exec`. Session state is backed up to PostgreSQL asynchronously for crash recovery and cold restarts.

```
┌──────────────────────────────────────────────────────────────────────┐
│  VM (Ubuntu 24.04)                                                    │
│                                                                       │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  flowhelm-admin (root, minimal surface)                         │  │
│  │  User lifecycle · Resource limits · Port registry                │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                       │
│  ┌───────────────────────────────────┐ ┌───────────────────────────┐ │
│  │ Linux user: flowhelm-mark         │ │ Linux user: flowhelm-evie │ │
│  │ UID range: 100000-165535          │ │ UID range: 165536-231071  │ │
│  │                                   │ │                           │ │
│  │ ┌───────────────────────────┐     │ │  (same architecture,      │ │
│  │ │ Orchestrator (Node.js)    │     │ │   fully independent)      │ │
│  │ │ Memory, identity, routing │     │ │                           │ │
│  │ │ Embedding model in-process│     │ │                           │ │
│  │ │ NO credentials here       │     │ │                           │ │
│  │ │ NO channel I/O here       │     │ │                           │ │
│  │ └──────────┬────────────────┘     │ │                           │ │
│  │            │                       │ │                           │ │
│  │   Podman network                   │ │                           │ │
│  │   (flowhelm-network-mark)          │ │                           │ │
│  │ ┌──────────▼─────────────────┐    │ │                           │ │
│  │ │ flowhelm-db-mark           │    │ │                           │ │
│  │ │ (always-on, ~100 MB)       │    │ │                           │ │
│  │ │ PG 18 + pgvector           │    │ │                           │ │
│  │ │ Cognitive memory (4 tiers)│    │ │                           │ │
│  │ │ Queue, identity, DAG      │    │ │                           │ │
│  │ │ LISTEN/NOTIFY → orchestrator│   │ │                           │ │
│  │ └──────────┬─────────────────┘    │ │                           │ │
│  │ ┌──────────▼─────────────────┐    │ │                           │ │
│  │ │ flowhelm-proxy-mark        │    │ │                           │ │
│  │ │ (always-on, ~20 MB)        │    │ │                           │ │
│  │ │ Holds REAL API credentials │    │ │                           │ │
│  │ │ Multi-key rotation, MITM   │    │ │                           │ │
│  │ │ Rate limits, cost log,     │    │ │                           │ │
│  │ │ /metrics, SIGHUP reload    │    │ │                           │ │
│  │ └──────────┬─────────────────┘    │ │                           │ │
│  │ ┌──────────▼─────────────────┐    │ │                           │ │
│  │ │ flowhelm-channel-mark      │    │ │                           │ │
│  │ │ (always-on, ~30 MB)        │    │ │                           │ │
│  │ │ Telegram, Gmail adapters   │    │ │                           │ │
│  │ │ Holds CHANNEL credentials  │    │ │                           │ │
│  │ │ Writes inbound to PG      │    │ │                           │ │
│  │ │ HTTP API :9000 for outbound│    │ │                           │ │
│  │ └──────────┬─────────────────┘    │ │                           │ │
│  │ ┌──────────▼─────────────────┐    │ │                           │ │
│  │ │ flowhelm-agent-mark-*      │    │ │                           │ │
│  │ │ (warm, 60 min idle)        │    │ │                           │ │
│  │ │ Session: container + PG bk │    │ │                           │ │
│  │ │ HTTPS_PROXY=proxy:10255    │    │ │                           │ │
│  │ └───────────────────────────┘     │ │                           │ │
│  └───────────────────────────────────┘ └───────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

### Admin Orchestrator (`src/admin/`)
Runs as root. Only purpose: user lifecycle and resource enforcement. Never touches user data, credentials, or agent logic. Implemented as four modular components (ADR-056): **PortRegistry** (JSON file-based port allocation, 10 sequential ports per user), **ServiceGenerator** (systemd user unit files for always-on operation), **ResourceLimits** (per-user cgroups v2 limits), **UserManager** (full lifecycle: Linux user, sub-UID, Podman, network, systemd, SSH). CLI dispatch: `flowhelm admin init/add-user/remove-user/status/set-limits`. Also provides identity onboarding (`flowhelm setup identity`) and welcome message hints for unconfigured agents.

### Per-User Orchestrator (`src/orchestrator/`)
Runs as Linux user `flowhelm-{username}`. Pure message broker + memory system: dequeues inbound messages from PostgreSQL (written by the channel container, notified instantly via `LISTEN/NOTIFY`), assembles cognitive memory context (identity, meta, semantic, external, working memory), spawns/reuses agent containers, routes responses back via `ChannelClient` (HTTP to channel container), and extracts memories from agent results. The orchestrator holds ZERO credentials — API keys live in the proxy container, channel credentials (Telegram bot token, Gmail OAuth) live in the channel container. No external network connections. Embeds text for memory storage/retrieval using an in-process `all-MiniLM-L6-v2` model (~80 MB, configurable).

### Database Container (`flowhelm-db-{username}`)
Per-user PostgreSQL 18 + pgvector running in an Alpine Podman container (~100-130 MB RAM). Each user's database is a separate container on their isolated Podman network — no external internet access. Stores all operational data (chats, sessions, queue, cursors, state, migrations), cognitive memory (working memory, semantic memory with DAG summarization, meta memory, external memory), and identity layer (agent identity + personality, user identity + personality). Connection credentials stored in the credential proxy. Data persisted to `~/.flowhelm/data/pg/`. See @docs/database.md and ADR-018.

### Cognitive Memory System (`src/orchestrator/memory.ts`)
Replaces FLOWHELM.md brute-force context dump. Four tiers queried per task: (1) **Working Memory** (Tier 1): last N messages from current session (~3K tokens, chronological, in `memory_working`). (2) **Semantic Memory** (Tier 2): vector-searchable facts, preferences, patterns, contacts, instructions, procedures, and hierarchical summaries via pgvector HNSW index (~2K tokens, composite-scored). Includes LCM-inspired DAG summarization — the `MemoryConsolidationJob` (scheduled every 6h by default) consolidates ended sessions' messages into depth-0 summaries, which condense into depth-1+ summaries, with full traceability via join tables. (3) **Meta Memory** (Tier 3): agent-synthesized insights, heuristics, and self-assessments distilled from Tier 2 via the `MemoryReflectionJob` (scheduled daily 3 AM by default, enabled by default — users opt out) (~500 tokens, high-confidence only). Tier 3 uses a recursive DAG hierarchy (d0 monitoring → d1 evaluation → d2+ regulation) with confidence propagation and contradiction cascade across depth levels (ADR-051). Context injection uses hierarchical cascade (ADR-052): strategic d2+ entries surface with a low similarity gate, evaluated d1 patterns need moderate relevance, and d0 observations compete strictly — each level has configurable slot counts and similarity thresholds. (4) **External Memory**: document chunks and user-provided references via RAG (~1K tokens, conditional — only injected when similarity exceeds threshold). The `buildAgentContext()` method assembles ~6-10K tokens of highly relevant context using composite scoring (`α·similarity + β·recency_decay + γ·importance`) vs. FLOWHELM.md's unbounded dump. Both jobs dispatch via `MemoryProvider` — a unified containerized provider that spawns `claude -p` in a dedicated `flowhelm-memory-{username}` container with MITM proxy credential injection or direct OAuth/API key forwarding (ADR-053). The orchestrator never holds real credentials. See @docs/memory.md, ADR-019, ADR-028, ADR-029, ADR-030, ADR-031, and ADR-051.

### Identity Layer (`src/orchestrator/identity.ts`)
Gives each user's agent a persistent, evolving identity — so every invocation feels like the same assistant, not a new one with access to previous notes. Four tables across two axes:

- **Agent Identity** (user-configured): professional role, expertise, tone, standing instructions. Single row in `agent_identity`. Defines *who* the agent is.
- **Agent Personality** (user-configured, agent-refinable): relational qualities — communication style, humor, emotional register, values, rapport, boundaries. Max 6 rows in `agent_personality` with confidence scoring (starts at 0.8). Defines *how* the agent behaves.
- **User Identity** (self-declared + onboarding): name, role, organization, timezone, language, contact info. Single row in `user_identity`. Defines *who* the user is.
- **User Personality** (agent-inferred + onboarding): behavioral patterns — communication style, work patterns, decision making, priorities, preferences, boundaries. Max 6 rows in `user_personality` with confidence scoring (starts at 0.3, grows with confirming observations). Defines *how* the user behaves.

The `buildIdentityContext()` method formats an `<identity>` XML block (~300-600 tokens, fixed) injected at the top of `buildAgentContext()` output, before the memory tiers. Agent identity and personality are profile-scoped (see ProfileManager below), while user identity and personality remain global — they describe the human, not the agent persona. See @docs/memory.md and ADR-024.

### ProfileManager (`src/orchestrator/profile-manager.ts`)
Provides CRUD operations for agent profiles, which scope agent identity, personality, and long-term memory (Tier 2, Tier 3, External). Each chat is assigned to exactly one profile. The default profile is created automatically during setup and used for all chats unless overridden. Profiles enable three key patterns: (a) **shared memory across channels** — the same agent profile assigned to Telegram and WhatsApp chats shares accumulated semantic and meta memory; (b) **distinct agents per channel** — different profiles give each channel its own identity, personality, and memory space; (c) **platform migration** — switching a chat's profile assignment carries all accumulated memory to the new context. Profile operations: create, read, update, delete, list, clone (deep-copies identity + personality rows), assign to chat, set default. Deletion is soft — the profile is marked inactive but its memories are preserved. See @docs/memory.md and ADR-034.

### Message Queue (`src/orchestrator/message-queue.ts`)
PostgreSQL-backed persistent queue with status lifecycle: `pending` → `processing` → `completed` | `failed` → `dead_letter`. Uses `FOR UPDATE SKIP LOCKED` for true atomic dequeue. Queue inserts fire `NOTIFY` — the orchestrator subscribes via `LISTEN` and reacts instantly (no 2-second polling). Crash-resilient: messages stuck in `processing` are recovered to `pending` on startup. Failed messages retry up to `max_attempts`, then move to dead-letter for admin inspection.

### Credential Proxy Container (`src/proxy/`)
One per user. Always running. Minimal Alpine + Node.js container (~20-30 MB) that holds decrypted credentials and acts as an HTTP forward proxy. Agent containers route outbound requests through the proxy via `HTTPS_PROXY=http://flowhelm-proxy-{username}:10255`. The proxy operates in two modes depending on the destination host:

- **MITM mode** (credential-matched hosts): When the `CONNECT` target matches a credential rule (Zod-validated, stored AES-256-GCM encrypted at `~/.flowhelm/secrets/credentials.enc`), the proxy performs TLS interception. It terminates the agent's TLS connection using a dynamically generated per-domain certificate signed by a per-user CA, reads the plaintext HTTP request, injects the real credential (Authorization header, API key, etc.), then opens a new HTTPS connection to the actual destination. The full flow: **agent → CONNECT → proxy terminates TLS (per-domain cert) → credential injection → new HTTPS connection → destination**. Credentials never leave the proxy container — the agent only sees the MITM certificate, never the real secret. The per-user CA is auto-generated on first proxy startup (`src/proxy/ca-manager.ts`) and its root certificate is installed into the agent container's trust store at creation time. Per-domain certificates are cached in an in-memory LRU cache (`src/proxy/cert-cache.ts`) to avoid repeated signing on every request.
- **Passthrough mode** (all other hosts): For HTTPS destinations that do not match any credential rule, the proxy establishes a raw TCP tunnel via `CONNECT`. The TLS handshake is end-to-end between the agent and the destination — the proxy cannot read or modify encrypted traffic. The proxy still enforces rate limits and logs the connection (host, status, latency) for auditing.

**Subscription OAuth via MITM**: When using CLI runtime with subscription OAuth (`CLAUDE_CODE_OAUTH_TOKEN`), the token is stored as a credential rule and injected via MITM — the same as API keys. The `credentialMethod` config option (`oauth` or `api_key`) controls which placeholder the agent receives, ensuring the CLI sends the correct auth header type. Both OAuth and API key flows are fully proxied; no real credentials enter agent containers. See @docs/credential-proxy.md, ADR-012, and ADR-047.

**Unified encrypted vault** (ADR-055): `credentials.enc` is the single source of truth for all secrets. It stores HTTP proxy injection rules (`credentials[]`), cert pinning bypass lists, and general-purpose secrets (`secrets{}`) including the PostgreSQL password. The orchestrator decrypts once at boot and distributes secrets to containers via env vars and file mounts. `credentials.key` (chmod 400) is the single master key. See `docs/credential-proxy.md` for the full schema.

**Source files**: `src/proxy/proxy-manager.ts` (container lifecycle + SIGHUP reload), `src/proxy/proxy-server.ts` (HTTP CONNECT handling, MITM vs passthrough routing, request-level rules enforcement, `/metrics` endpoint), `src/proxy/ca-manager.ts` (per-user CA generation + per-domain certificate signing via node-forge), `src/proxy/cert-cache.ts` (in-memory LRU certificate cache), `src/proxy/mitm-handler.ts` (core MITM TLS interception — virtual HTTP server on decrypted TLS socket, header-aware credential selection for multi-credential hosts, request-level rules enforcement, key rotation, cost parsing; see ADR-047), `src/proxy/credential-store.ts` (AES-256-GCM encrypted storage + general-purpose secrets vault), `src/proxy/credential-schema.ts` (Zod rules for host patterns, headers, rate limits, request rules, pinning bypass, expiration, multi-credential host selection, secrets), `src/proxy/rate-limiter.ts` (per-host sliding window), `src/proxy/audit-log.ts` (append-only request logging), `src/proxy/key-rotator.ts` (multi-key round-robin distribution), `src/proxy/metrics.ts` (per-credential metrics with latency percentiles), `src/proxy/cost-log.ts` (append-only JSONL cost/usage log), `src/proxy/placeholders.ts` (format-valid placeholder tokens for agent containers, `credentialMethod`-aware), `src/proxy/main.ts` (proxy entrypoint with SIGHUP handler and expiration checks).

**Placeholder credentials** (Phase 9): When MITM TLS is active, agent containers no longer receive real API keys or OAuth tokens. Instead, `getPlaceholderEnv()` (`src/proxy/placeholders.ts`) provides format-valid but meaningless tokens (e.g., `sk-ant-flowhelm-proxy-placeholder-...` for API keys). These pass CLI startup validation but carry no real access — the MITM proxy replaces them with real credentials before requests reach upstream APIs. This eliminates the last scenario where a compromised agent container could exfiltrate a real credential.

**Multi-key round-robin** (Phase 9): `KeyRotator` (`src/proxy/key-rotator.ts`) distributes requests across multiple API keys when a credential rule has a `values` array. Each credential name gets an independent counter that cycles through available keys via modulo. This enables load spreading across rate-limited API keys and graceful key rotation without downtime.

**Request-level rules enforcement** (Phase 9): Each credential rule can declare fine-grained request constraints in its `rules` block: `methods` (allowed HTTP methods), `pathPrefixes` (allowed URL path prefixes), and `maxBodySize` (maximum request body in bytes). Both passthrough and MITM code paths enforce these rules — non-conforming requests are rejected with descriptive errors before reaching the upstream API.

**Certificate pinning bypass** (Phase 9): The `pinningBypass` array in the credential store lists hostnames that should skip MITM interception even when a credential rule matches. This handles services with certificate pinning or mutual TLS that cannot tolerate proxy-signed certificates — the proxy falls through to raw TCP tunnel mode for these hosts.

**SIGHUP warm-restart** (Phase 9): Sending `SIGHUP` to the proxy process (or `podman exec kill -HUP 1` from the host) triggers a live credential reload. The `main.ts` handler re-reads `credentials.enc`, decrypts, validates with Zod, and calls `server.reloadCredentials()` to swap rules, rate limiter state, and pinning bypass set — all without restarting the container or dropping active connections. `ProxyManager.reloadCredentials()` wraps this for orchestrator use.

**Credential expiration detection** (Phase 9): Credentials can declare an `expiresAt` Unix timestamp. On startup and every 5 minutes, the proxy checks all credentials against the current time and logs warnings for those expiring within 1 hour or already expired. This provides early warning before API calls start failing with 401s. Additionally, 401 responses from upstream APIs trigger a per-credential warning suggesting possible expiration.

**Observability** (Phase 9): `ProxyMetrics` (`src/proxy/metrics.ts`) tracks per-credential request counts, status code distribution, rate limit hits, and latency percentiles (p50/p95/p99) using a circular buffer of the last 1000 measurements. The proxy exposes a `GET /metrics` JSON endpoint for health monitoring and dashboards. `CostLog` (`src/proxy/cost-log.ts`) writes an append-only JSONL file with per-request cost data (credential name, model, input/output tokens) that the orchestrator can ingest into PostgreSQL for billing and usage analytics.

Per-host sliding window rate limits prevent runaway agents from burning API credits. An append-only audit log records every proxied request (method, host, status, latency, credential name — never bodies). The proxy starts before agent containers and health-checks every 30s with auto-restart on failure.

### Channel Container (`flowhelm-channel-{username}`)
A unified, always-on container that hosts all channel adapters (Telegram, Gmail, future WhatsApp/Slack) for a single user. Moves all channel I/O and channel credentials out of the orchestrator, making the orchestrator a pure message broker + memory system with zero external network connections and zero channel credentials.

**Inbound (channel → orchestrator)**: The channel container connects directly to `flowhelm-db-{user}:5432` on the same Podman network and writes inbound messages to PostgreSQL: `upsertChat()` → `INSERT INTO memory_working` (with `session_id = NULL`) → `INSERT INTO queue` (triggers `NOTIFY new_message`). The orchestrator's existing `queue.subscribe()` picks up the message with zero changes to dequeue logic. Messages are crash-safe — if the orchestrator is down, they're queued in PG. The orchestrator backfills `session_id` with a single UPDATE immediately after dequeue.

**Outbound (orchestrator → channel)**: The orchestrator calls `ChannelClient.send()` → `POST http://flowhelm-channel-{user}:9000/send`. Low latency (~1ms container-to-container on Podman network). Matches the proven ServiceClient pattern.

**HTTP API**: `POST /send` (send to any channel), `POST /email/send` (structured email via Gmail), `GET /healthz` (health check with per-channel status), `GET /status` (detailed channel status).

**Credentials**: The channel container is trusted infrastructure (our code, not arbitrary agent code). It mounts `credentials.enc` read-only and decrypts in-memory at startup (same pattern as the proxy container). Channel credentials (Telegram bot token, Gmail OAuth tokens, etc.) never enter the orchestrator or agent containers. Note: IMAP XOAUTH2 needs raw access tokens over a TLS socket (not HTTP), so the channel container decrypts credentials directly rather than routing through the MITM proxy.

**Database access**: A thin `ChannelDbWriter` (~80 LOC) with only 4 operations — `resolveDefaultProfileId()`, `upsertChat()`, `storeMessage()`, `enqueueMessage()`. Minimal coupling by design; these tables (`chats`, `memory_working`, `queue`) are core and stable.

**Container spec**: Alpine + Node.js (~30 MB), 256 MB memory limit, 0.5 CPU, PIDs limit 128, read-only filesystem with `/tmp` tmpfs. Port 9000 (configurable). Auto-restarted by `ChannelManager` on health check failure (30s interval).

**Cross-channel routing**: Gmail → Telegram notifications are simpler in the channel container — both adapters are in the same process, so `GmailAdapter.notificationAdapter` references the local `TelegramAdapter` instance. Zero network hop.

**Source files**: `src/channels/channel-types.ts` (HTTP API types), `src/channels/channel-db.ts` (thin PG adapter), `src/channels/channel-server.ts` (HTTP server), `src/channels/channel-client.ts` (HTTP client for orchestrator), `src/channels/channel-manager.ts` (container lifecycle), `src/channels/credential-reader.ts` (decrypt credentials.enc), `src/channels/main.ts` (container entrypoint), `container-image/Containerfile.channel` (container image). See @docs/channel-container.md and ADR-054.

### Agent Containers (`src/container/`)
Podman rootless containers running Claude Code. **Warm: containers stay alive between messages with a configurable idle timeout (default 60 minutes).** Started with `CMD sleep infinity`, each message processed via `podman exec claude -p --resume`. No custom agent-runner, no IPC polling — simple and reliable. Session files live in the container filesystem during conversations. PostgreSQL backs up session state asynchronously after each message for crash recovery and cold restarts. Run in the user's UID namespace. Connect to proxy via per-user Podman network. Hold no real credentials — when MITM is active, agent containers receive placeholder tokens (`src/proxy/placeholders.ts`) that are format-valid but carry no access. The MITM proxy replaces them with real credentials at the network level. The per-user CA root certificate is installed into the agent container's trust store at creation time so MITM connections are trusted.

**Rootless mount staging pattern**: Podman rootless UID mapping causes host files to appear root-owned inside the container (the host user's UID maps to UID 0 in the container's user namespace). The `flowhelm` user inside the container cannot write to these bind-mounted files. FlowHelm solves this with a two-phase staging pattern:

1. **Pre-start**: Session files (restored from PG or provisioned credentials) are written to a host directory (`sessionDir`), which is bind-mounted into the container at `/home/flowhelm/.claude-host`.
2. **Post-start**: Immediately after `podman run`, a `podman exec` copies files from `.claude-host` (root-owned, read-only to container user) into `/home/flowhelm/.claude` (container-owned, writable), then `chown`s them to the `flowhelm` user. This ensures Claude Code can read and write its own session state.

**macOS MCP transport**: On macOS, the IPC bind mount (`/workspace/ipc/`) is skipped entirely because Apple's virtiofs does not support Unix domain sockets through bind mounts. Instead, the MCP server listens on TCP (OS-assigned port) and agent containers connect via `host.containers.internal:<port>`. The `stdio-to-uds-bridge.cjs` script inside the container detects `FLOWHELM_MCP_HOST`/`FLOWHELM_MCP_PORT` env vars and uses TCP instead of UDS. See the MCP Memory Server section above for details.

**Session backup reads from the container**: Because host-side session files are root-owned (UID mapping), `asyncBackupSession()` reads session files via `podman exec` from inside the running container rather than from the host filesystem. The container-side files at `/home/flowhelm/.claude/projects/` are owned by the container's `flowhelm` user and are always readable. This avoids permission errors that would occur reading from the host bind mount.

**Container image** (`container-image/Containerfile.agent`): Debian slim image with Node.js 22, Claude Code CLI, Claude Agent SDK (both installed globally), the stdio-to-UDS bridge (`container-image/stdio-to-uds-bridge.cjs`), and the SDK runner (`container-image/sdk-runner.js`). Built-in skills ship at `container-image/skills/` (capabilities, status). User-installed skills synced to `/workspace/.claude/skills/` on container creation.

### Agent Runtime (`src/agent/`)
The runtime layer that bridges the orchestrator to Claude Code inside containers. The orchestrator is runtime-agnostic — it calls `runtime.execute(task, context)` and gets back a structured response. All container lifecycle, prompt assembly, CLI invocation, response parsing, and session management live here.

**Source files**: `src/agent/warm-container-runtime.ts`, `src/agent/cli-runtime.ts`, `src/agent/sdk-runtime.ts`, `src/agent/session-manager.ts`, `src/agent/system-prompt.ts`, `src/agent/mcp-config.ts`, `src/agent/cli-response.ts`, `src/agent/types.ts`, `src/agent/index.ts`.

#### CliRuntime (`src/agent/cli-runtime.ts`)
Default runtime for Personal and Team tiers. Manages the full lifecycle of a warm container invocation:

1. **Get or create warm container** — checks `SessionManager` for an existing warm container for this chat. If none exists (or the previous one was reaped), creates a new one via `podman run -d --name flowhelm-agent-{username}-{taskid} ... sleep infinity`. Container creation includes: proxy env vars (`HTTPS_PROXY`), MCP memory server UDS bind-mount (`/workspace/ipc/memory.sock`), skill directory mounts, resource limits, and the MCP config file generated by `McpConfigGenerator`.
2. **Restore session on cold start** — if the chat has a previous session in PG (from a reaped container or crash), `SessionManager` restores session files into the new container before the first `exec`.
3. **Execute** — runs `podman exec {container} claude -p --resume {sessionId} --output-format json --append-system-prompt {systemPrompt}` with the task text piped to stdin. The system prompt is assembled by `SystemPromptBuilder` and the `--resume` flag is omitted for brand-new sessions.
4. **Parse response** — `CliResponseParser` extracts the result text, cost metadata (input/output tokens, USD), session ID, and error information from Claude Code's JSON output.
5. **Async PG backup** — fires a non-blocking `SessionManager.backup()` that copies session files from the container filesystem to PostgreSQL. This is the crash safety net — if the container is reaped or the host crashes, the session can be restored from PG.

**Per-message flow (warm container exists)**: `podman exec claude -p --resume $SID` → parse response → async PG backup. ~0.5s exec overhead. **Cold start (first message or after idle timeout)**: create container → restore session from PG (if resuming) → `podman exec claude -p` → async PG backup. ~3-5s container creation.

#### WarmContainerRuntime (`src/agent/warm-container-runtime.ts`)
Abstract base class shared by both `CliRuntime` and `SdkRuntime`. Contains **all** warm container lifecycle logic: `getOrCreateContainer()`, `createWarmContainer()`, `asyncBackupSession()`, `resetIdleTimer()`, `handleIdleTimeout()`, `shutdown()`. Subclasses implement only three methods: `buildCommand(task, container)` (the `podman exec` command), `parseExecResult(stdout, stderr)` (normalized `AgentResult`), and `runtimeName` (log prefix). This ensures both runtimes have identical container behavior — same idle timeout, same PG backup, same cold-start restore.

#### SdkRuntime (`src/agent/sdk-runtime.ts`)
Optional runtime for Team tier, required for Enterprise. API keys only (no subscription OAuth). Uses the same warm container lifecycle as `CliRuntime` — containers stay alive with `CMD sleep infinity`, messages processed via `podman exec node /workspace/sdk-runner.js`. The `sdk-runner.js` script (shipped in the container image at `/workspace/sdk-runner.js`) wraps the Claude Agent SDK's `query()` function into a JSON-in/JSON-out CLI interface. It accepts `--message`, `--max-turns`, `--system-prompt`, `--append-system-prompt`, `--mcp-config`, `--resume`, and `--allowed-tools` flags. Session resume, MCP memory access, idle timeout, and PG backup work identically to the CLI runtime.

#### SessionManager (`src/agent/session-manager.ts`)
PostgreSQL-backed session state manager. Tracks which containers are warm, maps chat IDs to container names and session IDs, and handles the full session lifecycle:

- **Warm container tracking**: maintains an in-memory map of active containers with last-activity timestamps. On each message, updates the timestamp to reset the idle timer.
- **Idle timeout**: a periodic sweep (every 60s) identifies containers that have been idle longer than the configured timeout (default 60 minutes, configurable via `agent.containerIdleTimeout`). Idle containers get a final PG backup, then `podman stop` + `podman rm`.
- **Hard expiry**: sessions older than 24 hours are forcibly ended regardless of activity. This prevents unbounded session growth and ensures fresh context periodically.
- **PG backup/restore**: session files (conversation history, subagent state, tool results) are serialized to JSONL and stored in the `agent_sessions` table. On cold start, if a previous session exists for the chat, it is restored into the new container before the first `exec`.
- **Retention**: one active session per chat. When a new session starts (hard expiry, explicit reset, or profile change), the old session's PG backup is retained for the configured retention period (default 7 days) before cleanup.

See ADR-008 (rewritten) and ADR-032.

#### SystemPromptBuilder (`src/agent/system-prompt.ts`)
Assembles a minimal, task-focused system prompt (~500-800 tokens) injected via `--append-system-prompt`. The prompt is deliberately small — the pre-assembled `buildAgentContext()` output provides the bulk of context (~6-10K tokens). The system prompt contains:

- **Task framing**: what the agent should do with this specific message (channel context, reply expectations).
- **Identity summary**: a compressed reference to the identity block already in context (not a duplication — just a "you are {name}, {role}" anchor).
- **Tool guidance**: which MCP tools are available and when to use them (e.g., "use `search_semantic` for facts you don't have in context, `store_semantic` to save discoveries").
- **Response format**: output expectations (plain text for chat, structured for automation).
- **Constraints**: token budget, no hallucination policy, credential handling rules.

The builder is deterministic — same inputs produce same prompt. No LLM calls in prompt construction. See ADR-026.

#### McpConfigGenerator (`src/agent/mcp-config.ts`)
Generates the MCP configuration file that tells Claude Code how to reach the memory server. The memory server runs in the orchestrator process and the MCP config bridges stdio (what Claude Code expects) to the transport layer using `container-image/stdio-to-uds-bridge.cjs` — a lightweight Node.js script that relays stdin/stdout. The generated config is written to `/workspace/.claude/mcp.json` in the container.

On Linux, the bridge connects to a Unix domain socket bind-mounted at `/workspace/ipc/memory.sock`. On macOS, the bridge connects via TCP to `host.containers.internal:<port>` using `FLOWHELM_MCP_HOST` and `FLOWHELM_MCP_PORT` environment variables injected into the MCP config. The `McpConfigOptions` type accepts optional `tcpHost` and `tcpPort` fields; when both are set, the generator emits a TCP-mode config with those env vars instead of a UDS socket path. `WarmContainerRuntime.createWarmContainer()` detects `process.platform === 'darwin'` and generates the appropriate config variant.

#### CliResponseParser (`src/agent/cli-response.ts`)
Parses Claude Code's `--output-format json` output. Extracts:

- **Result text**: the agent's response content (may be multi-part for tool-use conversations).
- **Cost metadata**: input tokens, output tokens, total USD cost — logged per-message for usage tracking and billing.
- **Session ID**: the Claude Code session identifier used for `--resume` on subsequent messages.
- **Error detection**: identifies API errors, rate limits, context overflow, and tool failures from the JSON output. Maps these to typed error codes for the orchestrator to handle (retry, notify user, escalate).

**Two runtimes**: `CliRuntime` (default: spawns `claude -p` subprocess) and `SdkRuntime` (Team optional, Enterprise required: runs `node /workspace/sdk-runner.js` which calls the Agent SDK's `query()` function). Both extend `WarmContainerRuntime` — sharing identical warm container lifecycle, idle timeout, PG backup, and cold-start restore. The orchestrator is runtime-agnostic. See @docs/claude-integration.md and ADR-015.

### MCP Memory Server (`src/orchestrator/mcp-server.ts`)
Runs inside the orchestrator process. Exposes the full cognitive memory database, identity layer, profile management, meta DAG introspection, and self-service administration to agent containers via 25 MCP tools over a Unix domain socket. Memory tools (7): `search_semantic` (composite-scored search over Tier 2 via pgvector), `search_external` (RAG over external documents), `recall_conversation` (chronological message history from Tier 1), `store_semantic` (agent writes a new semantic memory mid-task), `get_memory_stats` (aggregate stats across all tiers), `expand_memory` (LCM-inspired drill-down: summary → source messages or child summaries), `search_meta` (search Tier 3 insights and heuristics, with optional `min_depth`/`max_depth` filtering). Meta DAG tools (2, Phase 9B): `expand_meta` (T3 DAG drill-down: d0 → T2 sources, d1+ → child meta entries via `meta_parent_sources`), `trace_to_source` (recursive full-DAG traversal from any T3 entry to its T2 semantic evidence chain). Identity tools (5): `get_identity` (agent + user identity and personality), `observe_personality` (record agent personality observation), `observe_user` (record user personality observation), `propose_identity_update` (suggest agent identity change, user confirms), `update_user_identity` (update user identity fields discovered in conversation). Profile tools (3): `list_profiles`, `get_current_profile`, `switch_chat_profile`. Admin / self-service tools (7, ADR-033): `install_skill` (install from registry), `uninstall_skill` (remove with dependency check), `list_skills` (installed + built-in + available), `search_skills` (keyword search on registry), `update_config` (allowlisted fields only — security-sensitive fields blocked), `get_auth_url` (OAuth URL generation for services), `get_system_status` (memory stats, profiles, skills, MCP health). Google Workspace tool (1, ADR-059): `google_workspace` (execute any gws CLI command — email send/search/read, contacts CRUD, calendar, drive, etc. via the channel container's gws binary with auto-refreshed OAuth token).

**Dual transport (UDS on Linux, TCP on macOS)**: On Linux, the MCP server listens on a Unix domain socket. Each chat gets its own socket file at `${sanitizedChatId}-memory.sock` in a shared IPC directory (`~/.flowhelm/ipc/`). The shared IPC directory is bind-mounted into the container at `/workspace/ipc/`, and the MCP config references the per-chat socket path.

On macOS (`process.platform === 'darwin'`), Apple's virtiofs implementation does not support Unix domain sockets through bind mounts. The MCP server instead listens on TCP `0.0.0.0:<OS-assigned port>` (port 0 requests an ephemeral port from the OS). The orchestrator reads the assigned port via `mcpServer.assignedPort` and passes it to the `AgentTask` as `mcpPort`. Agent containers connect via `host.containers.internal:<port>` -- the standard hostname that both Podman machine and Apple Container VMs resolve to the host. The `stdio-to-uds-bridge.cjs` script checks `FLOWHELM_MCP_HOST` and `FLOWHELM_MCP_PORT` environment variables: if set, it connects via TCP; otherwise it connects via UDS at the default socket path. The IPC bind mount is skipped entirely on macOS since the socket is not used.

This enables on-demand memory, identity, and administrative access during task execution -- complementing the pre-task `buildAgentContext()` injection. Users can administer FlowHelm entirely via chat (no SSH needed). ~16ms per memory query (embedding + HNSW search); identity and admin queries are direct reads (<1ms). See @docs/memory.md, @docs/skills.md, ADR-023, ADR-024, ADR-033, and ADR-051.

### Channel Adapters (`src/channels/`)
Extensible channel system using the **Transport Abstraction Pattern** (Ports & Adapters / Hexagonal Architecture, ADR-058). Every channel has two layers: an **adapter** (business logic: filtering, normalization, access control, reconnection) and a **transport** (protocol I/O: library calls, connection management, message sending/receiving). The transport implements an abstract interface; concrete implementations are swappable without touching the adapter. All adapters run inside the unified `flowhelm-channel-{username}` container (Phase 11, ADR-054), not in the orchestrator process. Built-in adapters: Telegram (grammY), WhatsApp (Baileys), Gmail (dual transport: Pub/Sub REST pull or IMAP IDLE, zero npm deps). All channels normalize to `InboundMessage` and implement the `ChannelAdapter` interface. Unconfigured channels don't start via the factory-with-null pattern (zero resource cost). New channel adapters must follow the transport abstraction pattern — implement both `{Channel}Transport` interface and `{Channel}Adapter`. See ADR-011, ADR-058, and @docs/channel-container.md.

**Telegram** (`src/channels/telegram/`, ADR-037): `TelegramTransport` interface with `GrammyTransport` implementation (long-polling). JID format: `tg:{chatId}` (positive for DMs, negative for groups). Handles text messages, voice notes (downloaded as OGG, set as `audioPath` for voice pipeline), and photos (highest resolution selected, downloaded as JPG). Access control via `allowedUsers` whitelist (empty = allow all). Outbound messages use MarkdownV2 with plain text fallback. Long messages auto-split at 4096 chars (Telegram limit), preferring newline/space break points. Reconnection with exponential backoff (configurable base delay, max delay, and max attempts).

**WhatsApp** (`src/channels/whatsapp/`, ADR-057): `WhatsAppTransport` interface with `BaileysTransport` implementation. JID format: `wa:{number}@s.whatsapp.net` (DMs) or `wa:{id}@g.us` (groups). All auth state (noise keys, signal identity, pre-keys, session tokens) stored in the encrypted credential vault (`credentials.enc`) via `useVaultAuthState()` — replaces Baileys' default filesystem storage. Handles text, voice notes (OGG saved to downloads dir for service STT), and images (JPEG/PNG). Access control via `allowedNumbers` whitelist. QR code pairing on first connect. Reconnection with exponential backoff. See @docs/channels.md for full WhatsApp documentation.

**Gmail** (`src/channels/gmail/`, ADR-045): `GmailTransport` interface with `GmailApiTransport` implementation supporting dual notification modes (Pub/Sub pull and IMAP IDLE). The transport handles the full notification-to-delivery pipeline: notification listening, email fetching via Gmail REST API, parsing, deduplication, and delivery of `ParsedEmail` objects. The adapter handles filtering (importance scoring, sender/domain blocking, automated email detection), normalization to `InboundMessage`, and cross-channel routing (Gmail notifications forwarded to Telegram/WhatsApp). See @docs/channels.md for setup and configuration.

### Skills & Extensibility (`src/skills/`, `flowhelm-ai/flowhelm-skills`)
FlowHelm is an extensible agent platform, not a fixed-function assistant. Users install skills via `flowhelm install <name>` to extend what their agent can do. There are no skill type categories — a skill is a directory with a SKILL.md file and optional supporting files. The SKILL.md frontmatter declares requirements (channels, binaries, env vars, other skills, OS) and the body contains agent instructions loaded into Claude Code's context on invocation.

**Two-layer model for service integrations** (ADR-027): Each channel (Telegram, Gmail, WhatsApp, etc.) has a channel adapter (transport, always present in `src/channels/`, runs in the `flowhelm-channel-{user}` container) and an optional companion skill (capability, in `flowhelm-ai/flowhelm-skills`, runs in agent container). The adapter delivers messages. The skill teaches the agent platform-specific operations. Users install skills explicitly — `flowhelm setup gmail` recommends `flowhelm install google-email` but doesn't force it.

**Google Workspace skills** (ADR-059): Google Workspace services have a channel adapter (inbound pipeline: Pub/Sub, IMAP IDLE, email filtering) and companion skills. The `google-email` skill combines behavioral guidance (email formatting, etiquette) with full API command syntax for the `google_workspace` MCP tool. The remaining Google Workspace skills (`google-calendar`, `google-contacts`, `google-drive`, `google-tasks`) teach the agent the exact gws CLI command syntax, eliminating trial-and-error turns (1 turn with skill vs 4-6 without). These skills require `tools: [google_workspace]` in frontmatter.

**Skill lifecycle**: `flowhelm install <name>` → fetches from `flowhelm-ai/flowhelm-skills` registry (or local path / Git URL) → validates SKILL.md → checks `requires` dependencies (tools, channels, skills) → copies to `~/.flowhelm/skills/` → synced into agent container at `/workspace/.claude/skills/` on next launch → Claude Code auto-discovers.

**Built-in skills** (`container-image/skills/`): Two skills ship with the container image — `capabilities` (agent self-description) and `status` (health report). Always available. Everything else comes from the registry via `flowhelm install`.

**Registry**: `flowhelm-ai/flowhelm-skills` GitHub repo with `registry.json` index. 7 skills: 2 behavioral (`telegram`, `voice`) + 5 Google Workspace (`google-email`, `google-calendar`, `google-contacts`, `google-drive`, `google-tasks`). Community contributions via PRs. See @docs/skills.md, ADR-027, ADR-059.

### Auth Bridge Service (`services/auth-bridge/`)
Self-hostable relay service (default: `flowhelm.to`) that enables Tailscale-like authentication for headless VMs. Users scan a QR code or open a short link on their phone/laptop, authenticate there, and the FlowHelm VM receives credentials via end-to-end encryption (X25519 ECDH + AES-256-GCM). The bridge stores only ciphertext — it never sees plaintext tokens. Sessions are ephemeral (10-minute TTL, in-memory Map, no database). Includes a from-scratch QR code generator for terminal display. See @docs/auth-bridge.md and ADR-025.

### CLI Auth Integration (`src/auth/`)
Three authentication methods for `flowhelm setup`: (1) API key — validated and stored in `~/.flowhelm/secrets/`, used by SdkRuntime. (2) Token Bridge — generates X25519 keypair, creates session on bridge, displays QR code, polls for encrypted credentials, decrypts and stores in `~/.claude/.credentials.json`. (3) SSH Tunnel — manual port forwarding for `claude login`. The credential store writes files in the format the `claude` binary expects (mode 0600).

### Auth Health Monitor (`src/auth/auth-monitor.ts`)

Monitors the health of configured authentication methods. Checks both OAuth tokens and API keys independently — a user may have both configured.

**OAuth check**: Reads `~/.claude/.credentials.json`, parses `expiresAt` (ISO 8601), computes days remaining. Status levels: `ok` (>30 days), `expiring` (≤30 days, configurable threshold), `expired` (<0 days). Claude OAuth tokens are opaque (`sk-ant-oat01-*`), not JWTs — expiry is recorded at setup time (1 year from `flowhelm setup`).

**API key check**: Reads `~/.flowhelm/secrets/api-key`, validates `sk-ant-*` format. No expiry — API keys are valid until revoked.

**Integration**: `flowhelm doctor` includes auth checks in its diagnostic output. `flowhelm status` shows an auth section. `flowhelm auth status` provides detailed auth health. `flowhelm auth switch <oauth|api_key>` changes the active credential method in config.yaml without re-running setup.

See ADR-062.

### Auth Token Persistence (`src/index.ts`)
Auth tokens survive process restarts via a bidirectional persistence flow. On startup, `loadPersistedAuthTokens()` checks `~/.flowhelm/secrets/` for two files:

- `oauth-token` — persisted `CLAUDE_CODE_OAUTH_TOKEN` (subscription auth)
- `api-key` — persisted `ANTHROPIC_API_KEY` (API key auth)

If the environment variable is already set (e.g., first run after `flowhelm setup`), the value is saved to the corresponding file (mode 0600). If the environment variable is absent, the value is loaded from the persisted file back into `process.env`. This means tokens survive `systemctl restart` without requiring re-authentication. The persisted token is forwarded to agent containers as an environment variable — `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` — by the `WarmContainerRuntime` during container creation.

### Voice Transcription (`src/voice/`)
Converts audio attachments (OGG voice notes from Telegram, M4A from WhatsApp, etc.) into text before the message enters the orchestrator's main processing pipeline. Transcription runs in `processQueueItem()` immediately after dequeue — the resulting text replaces or supplements `message.text` before `buildAgentContext()` is called and before the agent container is invoked.

**Architecture**: Provider abstraction (`TranscriptionProvider` interface) with a `Transcriber` fallback chain. The `createTranscriber()` factory reads config (`voice.providers`) and returns a `Transcriber` instance configured with the requested provider order. On each transcription request, providers are tried in sequence — if a provider fails (network error, quota exceeded, binary not found), the chain falls through to the next. This makes the system resilient to transient cloud failures and allows gradual migration between providers.

**Providers**:

- **WhisperApiProvider** (`src/voice/whisper-api.ts`): Calls the OpenAI Whisper API (`/v1/audio/transcriptions`). Fast (~1-3s for 30s clip), high accuracy (5-8% WER), $0.006/min. Credentials are never in the orchestrator — the API key is injected by the credential proxy via MITM TLS interception (the request routes through `HTTPS_PROXY`, matching the `api.openai.com` credential rule). This means voice transcription benefits from the same credential isolation guarantee as all other external API calls.

- **WhisperCppProvider** (`src/voice/whisper-cpp.ts`): Shells out to the `whisper.cpp` binary installed in the agent container or on the host. CPU-bound (~5-15s for 30s clip depending on model size), fully offline, free. Falls back to this automatically if the Whisper API call fails or if configured as the sole provider. Requires the `whisper.cpp` binary and a model file path in config.

**Config-driven selection**: The `voice.providers` config array controls provider order and fallback behavior. Example:

```jsonc
{
  "voice": {
    "providers": ["whisper-api", "whisper-cpp"],  // try in order
    "whispercpp": { "binary": "/usr/local/bin/whisper", "model": "/models/ggml-base.en.bin" }
  }
}
```

Setting `providers: ["whisper-cpp"]` routes all transcription locally — no cloud calls, no cost, suitable for privacy-sensitive deployments.

**Integration point**: Channel adapters that receive audio (Telegram voice notes, WhatsApp audio messages) set `message.audioPath` to a temporary file path. `processQueueItem()` checks for `audioPath`, calls `transcriber.transcribe(audioPath)`, writes the result into `message.text`, and proceeds with the standard pipeline (`buildAgentContext()` → agent execution → response routing). If transcription fails entirely (all providers exhausted), the message is surfaced as an error to the user rather than silently dropped.

**Source files**: `src/voice/transcriber.ts` (provider abstraction, fallback chain, `createTranscriber()` factory), `src/voice/whisper-api.ts` (OpenAI Whisper API provider), `src/voice/whisper-cpp.ts` (local binary provider). See @docs/voice-pipeline.md.

### Gmail Pipeline (`src/channels/gmail/`)
Push-based email ingestion with dual transport support and zero new npm dependencies. The default path uses Gmail Watch API → GCP Pub/Sub → REST synchronous pull (periodic `fetch` to `:pull` endpoint) → filter → orchestrator. An alternative IMAP IDLE transport is available for restricted Workspace accounts that lack GCP access.

**Dual transport**:

- **Pub/Sub REST Pull** (default, `transport: 'pubsub'`): `PubSubPullDaemon` authenticates via service account JWT (RS256 signed with `node:crypto`, exchanged for access token at `oauth2.googleapis.com/token`). Polls the subscription every 5s (configurable). Incoming notifications contain `{ emailAddress, historyId }` — the daemon calls `GmailClient.listHistory()` via OAuth to fetch actual emails. Cost: $0/month for typical usage (well within Pub/Sub free tier).
- **IMAP IDLE** (alternative, `transport: 'imap'`): `ImapIdleClient` connects to `imap.gmail.com:993` via `node:tls`, authenticates with XOAUTH2 SASL, and enters IDLE mode. Server pushes `* N EXISTS` on new mail (1-5s latency). IDLE refreshed every 29 minutes per RFC 2177. For sending, `SmtpClient` connects to `smtp.gmail.com:465` with XOAUTH2. No GCP project required.

**Email filter engine** (`src/channels/gmail/filter.ts`): All incoming emails pass through `evaluateFilter()` before reaching the orchestrator. Rules evaluated in order — first rejection wins: exclude senders (regex deny list) → required labels → starred-only gate → important contacts (glob patterns like `*@company.com`) → minimum importance score (0.0–1.0, computed from Gmail labels: STARRED +0.3, IMPORTANT +0.2, CATEGORY_PERSONAL +0.15, etc.).

**Gmail Watch lifecycle** (`src/channels/gmail/watch.ts`): `GmailWatchManager` creates Gmail API watches (expires every 7 days), auto-renews every 6 days via `setTimeout`, retries on failure in 1 hour. History ID tracked with BigInt comparison (only advances forward).

**Cross-channel notification**: When `gmail.notificationChannel` is set to `'telegram'` or `'whatsapp'`, the `GmailAdapter` delegates outbound `send()` to the specified channel's adapter. Email arrives → agent processes → response sent to Telegram (not back as email). The agent can still send email replies via the gws CLI.

**gws CLI wrapper** (`src/channels/gmail/gws.ts`): Typed async wrappers around the `gws` binary for agent-container operations — Gmail (list, get, send, search, labels, history) and Calendar (list, create, delete).

**Source files**: `src/channels/gmail/gmail-client.ts` (OAuth token auto-refresh, fetch-based Gmail REST API), `src/channels/gmail/pubsub-pull.ts` (Pub/Sub REST pull daemon, SA JWT creation), `src/channels/gmail/filter.ts` (filter engine, importance scoring), `src/channels/gmail/watch.ts` (Gmail Watch lifecycle), `src/channels/gmail/imap-client.ts` (IMAP IDLE + SMTP via `node:tls`), `src/channels/gmail/gws.ts` (gws CLI wrapper), `src/channels/gmail/adapter.ts` (GmailAdapter + factory), `src/channels/gmail/index.ts` (barrel exports). See @docs/gmail-pipeline.md and ADR-045.

## Data Flow: Message Processing Pipeline

The core pipeline for every inbound message, regardless of channel:

```
1.  Message arrives on channel (Telegram, WhatsApp, Gmail, etc.)
2.  Channel adapter normalizes → InboundMessage → enqueue into PostgreSQL
3.  NOTIFY fires → orchestrator dequeues atomically (FOR UPDATE SKIP LOCKED)
3a. If message.audioPath is set (voice note): Transcriber.transcribe(audioPath)
    → WhisperApiProvider (OpenAI, via MITM proxy) or WhisperCppProvider (local)
    → result written into message.text; pipeline continues with text message
4.  Orchestrator calls buildAgentContext(chatId):
    resolves profileId → identity → meta memory → semantic memory →
    external memory (conditional) → working memory → ~6-10K tokens assembled
5.  Orchestrator starts MCP memory server on UDS (if not already running)
    → /workspace/ipc/memory.sock ready for bind-mount
6.  SessionManager checks for warm container for this chat:
    If warm → reuse existing container (skip to step 8)
    If cold → create container:
      podman run -d --name flowhelm-agent-{user}-{task} sleep infinity
      + HTTPS_PROXY env, placeholder credentials (no real keys), UDS bind-mount,
        skill mounts, resource limits, per-user CA cert in trust store
      + McpConfigGenerator writes /workspace/.claude/mcp.json
      + restore session from PG if resuming (SessionManager.restore())
7.  SystemPromptBuilder assembles task-focused prompt (~500-800 tokens)
    → task framing, identity anchor, tool guidance, response format, constraints
8.  Execute: podman exec {container} claude -p [--resume $SID]
      --output-format json --append-system-prompt {systemPrompt}
      with buildAgentContext() output + user message piped to stdin
9.  Agent runs inside container. May call MCP tools on demand:
    search_semantic, search_external, store_semantic, observe_personality, etc.
10. Agent completes → CliResponseParser extracts:
    result text, cost (tokens + USD), session ID, errors
11. SessionManager.backup() fires async → session files → PG (crash safety net)
    Container stays warm, idle timer resets
12. Orchestrator routes response back to originating channel
13. Orchestrator extracts memories from agent result → memory_semantic
14. Message acknowledged (status → completed)
    On failure: retry up to max_attempts → dead_letter
```

### Data Flow: Email → Voice → Action (End-to-End Example)

```
1.  Email arrives → Gmail Watch → GCP Pub/Sub → REST pull (5-10s)
    (or IMAP IDLE → `* N EXISTS` push → Gmail REST API fetch, 1-5s)
2.  Filter: starred/important? → if yes, inject into PostgreSQL queue
3.  NOTIFY fires → orchestrator dequeues instantly (no polling delay)
4.  Orchestrator → Telegram: "📧 From: John — 'Budget Review'"
5.  User sends 30s voice reply
6.  Telegram adapter → Whisper API → "Reply saying I'll review by Friday"
7.  Orchestrator calls buildAgentContext():
    resolves profileId from the chat's profile assignment (or falls back to default),
    identity (agent identity + personality scoped to profile, user identity + personality global),
    meta memory (high-confidence insights, profile-scoped), semantic memory (composite-scored, profile-scoped),
    external memory (conditional, profile-scoped, if relevant docs exist),
    working memory (last N session messages)
8.  SystemPromptBuilder assembles prompt (~500-800 tokens):
    task framing (Gmail reply context), identity anchor, MCP tool guidance
9.  SessionManager checks for warm container for this chat:
    If warm: podman exec claude -p --resume $SID (zero container overhead)
    If cold: create container (CMD sleep infinity, proxy env, IPC mount, skills)
      → McpConfigGenerator writes mcp.json (stdio-to-UDS bridge config)
      → restore session from PG if resuming (only on cold start)
      → podman exec claude -p --resume $SID (or fresh invocation)
    Pre-selected context injected via --append-system-prompt (~6-10K tokens)
    MCP memory server UDS bind-mounted at /workspace/ipc/memory.sock
10. Agent may call MCP tools on demand during execution:
    search_semantic("budget review John") → composite-scored semantic memories
    search_external("Q3 budget history") → RAG over external documents
    observe_personality("communication_style", "Concise, uses bullet points")
    observe_user("preferences", "User prefers bullet-point replies")
11. Agent executes: gws gmail messages send --reply ...
12. Request hits proxy → CONNECT googleapis.com → MITM TLS intercept (per-domain cert)
    → proxy replaces placeholder token with real OAuth credential (KeyRotator selects key)
    → request-level rules enforced (methods, path prefixes, body size)
    → HTTPS to googleapis.com → CostLog records usage
13. Agent stores insight via MCP: store_semantic("Replied to John re budget, he
    wants review by Friday", type="fact") — written in real-time, not post-task
14. CliResponseParser extracts result text, cost, session ID from JSON output
15. Confirmation → Telegram: "✅ Reply sent to John"
16. Orchestrator extracts additional memories from agent result
    → stored in memory_semantic with embedding for future retrieval
17. SessionManager async-backs up session files to PG (crash safety net)
    Container stays warm — next message uses podman exec --resume (no cold-start)
    After 60 min idle → final PG save → podman stop + rm
```

## Technology Stack

| Component | Technology | Rationale |
|---|---|---|
| Language | TypeScript (strict) | Type safety, ecosystem |
| Runtime | Node.js 22+ | Claude Agent SDK requirement |
| Container (Linux) | Podman rootless | Daemonless, rootless, UID namespaces |
| Container (macOS) | Apple Container (macOS Tahoe 26+, Apple Silicon) | VM-based isolation via Virtualization.framework. vmnet networking (192.168.64.0/24). `container` CLI wrapping. Podman fallback on older macOS/Intel. See `docs/apple-container.md`, ADR-068 |
| Credential proxy | HTTP forward proxy in per-user Alpine container (~171 MB with Node.js base, MITM TLS interception for credential-matched hosts, passthrough for all others, AES-256-GCM, sliding window rate limiter, append-only audit log). Per-container `proxy-package.json` — only `zod` + `node-forge` (ADR-067) | Credentials never in orchestrator or agent — injected via MITM, not env vars. See ADR-012 |
| X.509 certificate generation | node-forge | Per-user CA generation + per-domain certificate signing for MITM TLS interception. Pure JS, no OpenSSL binary dependency |
| Proxy metrics | ProxyMetrics (`src/proxy/metrics.ts`) — circular buffer, latency percentiles, `/metrics` JSON endpoint | Per-credential request counts, status codes, rate limit hits, p50/p95/p99 latency |
| Key rotation | KeyRotator (`src/proxy/key-rotator.ts`) — round-robin distribution | Multi-key load spreading, zero-downtime key rotation |
| Cost tracking | CostLog (`src/proxy/cost-log.ts`) — append-only JSONL | Per-request cost data (credential, model, tokens) for billing and usage analytics |
| Placeholder credentials | `src/proxy/placeholders.ts` — format-valid dummy tokens | Agent containers hold no real secrets when MITM is active |
| Database | PostgreSQL 18 per user (Alpine Podman container) | Vector search (pgvector), LISTEN/NOTIFY event queue, MVCC, JSONB. See ADR-018 |
| Vector search | pgvector 0.8+ (HNSW index) | Semantic memory retrieval, sub-ms cosine similarity at per-user scale |
| DB client | postgres.js (zero-dep, tagged templates) | SQL injection prevention by construction. See ADR-022 |
| Memory system | Cognitive: Working Memory, Semantic Memory (pgvector + DAG summarization), Meta Memory (async reflection), External Memory (pgvector RAG, conditional) | Replaces FLOWHELM.md brute-force. Composite scoring (`α·similarity + β·recency + γ·importance`). ~6-10K tokens relevant context. See ADR-019, ADR-028, ADR-029, ADR-030 |
| Agent identity | Agent Identity + Personality (user-configured, 6 dimensions) + User Identity + Personality (agent-inferred, 6 dimensions) | Persistent agent identity across invocations. Dual confidence models. ~300-600 tokens fixed overhead. See ADR-024 |
| Agent profiles | ProfileManager (`src/orchestrator/profile-manager.ts`) | Profile-scoped identity, personality, and long-term memory (Tier 2/3/External). Per-chat assignment, clone, default management. See ADR-034 |
| Embeddings (default) | all-MiniLM-L6-v2 via @huggingface/transformers (in-process) | Free, offline, 384-dim, ~15ms/embedding on CPU. See ADR-021 |
| Message queue | PostgreSQL-backed status queue with LISTEN/NOTIFY | Event-driven (no polling), FOR UPDATE SKIP LOCKED, dead-letter, crash recovery |
| Agent IPC | MCP server: UDS on Linux (bind-mounted into container), TCP on macOS (virtiofs UDS limitation — `host.containers.internal:<port>`) | On-demand memory + identity access during task execution. See ADR-023 |
| Session resume | Warm containers (session in filesystem) + PostgreSQL backup (JSONL + subagents + tool-results) | Warm containers with `podman exec`; PG backup for crash recovery / cold restart. See ADR-008, ADR-032 |
| System prompt | SystemPromptBuilder (`src/agent/system-prompt.ts`), ~500-800 tokens | Minimal task-focused prompt. No LLM calls in construction. See ADR-026 |
| MCP config bridge | stdio-to-UDS/TCP bridge (`container-image/stdio-to-uds-bridge.cjs`) + McpConfigGenerator (`src/agent/mcp-config.ts`) | Bridges Claude Code's stdio MCP transport to UDS (Linux) or TCP (macOS) where memory server listens |
| CLI response parsing | CliResponseParser (`src/agent/cli-response.ts`) | Extracts result text, cost (tokens + USD), session ID, errors from `--output-format json` |
| Agent memory access | MCP server over UDS (on-demand) | Agent queries full memory database mid-task via semantic search. See ADR-023 |
| Skills system | Per-user store (`~/.flowhelm/skills/`) + container sync + Claude Code native discovery | Reversible install/uninstall, multi-tenant isolated, lazy-loaded. See ADR-027 |
| Skills registry | `flowhelm-ai/flowhelm-skills` (GitHub repo with `registry.json`) | Separate repo from core — independent release cadence, low contributor friction |
| Config validation | Zod | Runtime type checking |
| Google Workspace | gws CLI (googleworkspace/cli) | Official tooling, dynamic API discovery |
| Gmail push (default) | GCP Pub/Sub REST synchronous pull (`fetch` + SA JWT via `node:crypto`) | No exposed ports, 5-10s latency, free tier, zero npm deps. See ADR-045 |
| Gmail push (alt) | IMAP IDLE via `node:tls` + XOAUTH2 SASL | No GCP required, 1-5s latency, zero npm deps |
| Gmail sending | Gmail REST API (OAuth) or SMTP via `node:tls` (XOAUTH2) | Both transports use built-in Node.js modules |
| Voice (primary) | OpenAI Whisper API | $0.006/min, 5-8% WER |
| Voice (fallback) | whisper.cpp | Free, offline capable |
| Agent runtime (default) | Claude Code CLI (`claude -p`) | Supports subscription OAuth + API keys, used by Personal and Team tiers |
| Agent runtime (advanced) | Claude Agent SDK (TypeScript) | API keys only, optional for Team, required for Enterprise |
| Auth (subscription) | OAuth (Pro/Max) | Flat rate, CLI runtime only, recommended for personal users |
| Auth (API keys) | Anthropic API keys | Pay-per-token, works with both runtimes, required for SDK |
| Auth bridge | Self-hostable relay (flowhelm.to), X25519 + AES-256-GCM E2E encryption | QR-code auth for headless VMs, no plaintext on server. See ADR-025 |
| Auth credential transfer | WebCrypto API (Node.js 22+ and browsers) | Standard X25519 ECDH, zero external crypto dependencies |
| Process manager (Linux) | systemd | Native Linux, cgroups v2 |
| Process manager (macOS) | launchd | Native macOS, `~/Library/LaunchAgents/ai.flowhelm.plist`, KeepAlive + RunAtLoad. See ADR-068 |
| Testing | Vitest + @electric-sql/pglite | Fast, TypeScript-native; pglite for in-process PG tests |
