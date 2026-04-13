# Session Management

## Overview

FlowHelm agent containers stay alive between messages. Instead of creating and destroying a container for every incoming message, a warm container persists with `CMD sleep infinity` and each message is processed via `podman exec claude -p --resume SESSION_ID`. This eliminates the 3-5 second cold-start penalty on follow-up messages.

PostgreSQL serves as the crash safety net. After every message, the orchestrator asynchronously backs up session files (JSONL transcripts, subagent data, tool-result files) to the `agent_sessions` table. If a container dies — OOM, Podman issue, VM restart — the next message creates a fresh container and restores the session from PG. The user never notices.

There is no custom agent-runner, no IPC polling loop, no MessageStream abstraction. The entire warm container pattern is built on two primitives: `sleep infinity` (keep the container alive) and `podman exec` (inject work into it). Both the CLI runtime (`claude -p`) and the SDK runtime (`node /workspace/sdk-runner.js`) share the same warm container lifecycle via the `WarmContainerRuntime` abstract base class — identical idle timeout, PG backup, cold-start restore, and shutdown behavior. See ADR-008 and ADR-032 in [docs/decisions.md](decisions.md).

## Session Lifecycle

### State Machine

```
                   ┌──────────────────────────────────────────────────┐
                   │                                                  │
  Message arrives  │   No warm container?                            │
  ─────────────────┤                                                  │
                   │   YES ──► Cold Start                            │
                   │            ├─ Restore files from PG to host dir │
                   │            ├─ podman create (mount at .claude-host)│
                   │            ├─ podman start                      │
                   │            ├─ podman exec: cp .claude-host → .claude│
                   │            ├─ podman exec claude -p [--resume]  │
                   │            │   └─ "No conversation found" → retry│
                   │            │     without --resume               │
                   │            ├─ Async PG backup (read from container)│
                   │            └─ Start idle timer                  │
                   │                                                  │
                   │   NO ───► Warm Follow-up                        │
                   │            ├─ Verify container is alive         │
                   │            │   DEAD → treat as cold start       │
                   │            ├─ podman exec claude -p --resume    │
                   │            │   └─ "No conversation found" → retry│
                   │            │     without --resume               │
                   │            ├─ Async PG backup (read from container)│
                   │            └─ Reset idle timer                  │
                   │                                                  │
                   └──────────────────────────────────────────────────┘

  Idle timer fires (60 min default)
  ──────────────────────────────────
    ├─ Final PG backup
    ├─ podman stop (10s grace period)
    ├─ podman rm
    └─ Remove from warm container map

  Hard expiry (24h)
  ──────────────────
    ├─ Forced cleanup regardless of activity
    └─ Session row deleted from PG after consolidation
```

### Cold Start

When a message arrives for a chat with no warm container (first message, post-idle-timeout, or post-crash):

1. **Create host directories** for session files (`~/.flowhelm/data/sessions/{chatHash}/`), IPC sockets (`~/.flowhelm/data/ipc/`), and agent config (`~/.flowhelm/data/agent-config/{chatHash}/`).
2. **Restore session from PG** if an active session exists — `SessionManager.restoreToFilesystem()` writes every file from the `session_files` JSONB map to the host session directory. This includes `.claude.json` (stored as `__claude.json` key in JSONB), auto-memory `.md` files, subagent data, and tool results.
3. **Write MCP config** to the host config directory (bind-mounted read-only into the container).
4. **Create and start the container** with `CMD sleep infinity`, bind-mounting the session directory at `/home/flowhelm/.claude-host` (staging path), the IPC directory at `/workspace/ipc/`, and the config directory at `/workspace/config/`. Proxy env vars (`HTTPS_PROXY`, `HTTP_PROXY`) point to the user's credential proxy container.
5. **Copy staged files into the container** — `podman exec sh -c 'cp -a /home/flowhelm/.claude-host/. /home/flowhelm/.claude/'` copies restored session files from the staging mount to the container's own home directory. The staging path is necessary because Podman rootless UID namespace mapping makes host-written files appear root-owned inside the container, and container root cannot `chown` them in rootless mode. After copy, `.claude.json` is restored from the `__claude.json` backup key to its correct location at `/home/flowhelm/.claude.json`. Ownership is fixed with `chown -R flowhelm:flowhelm`. See ADR-038.
6. **Execute** `podman exec claude -p --resume SESSION_ID` (or fresh invocation if no session to restore). If `--resume` fails with "No conversation found" (stale session ID), the runtime automatically retries without `--resume` as a fresh invocation. See ADR-039.
7. **Async PG backup** — session files are read from INSIDE the running container via `podman exec find` + `podman exec cat`, not from the host filesystem. This avoids EACCES errors caused by Podman rootless subordinate UID mapping on the host side. See ADR-039.
8. **Start idle timer**.

Cold start adds ~3-5 seconds of container creation overhead. This happens only on the first message or after the container has been destroyed.

### Warm Follow-up

When a message arrives for a chat with an existing warm container:

1. **Health check** — verify the container is still running via `containerRuntime.isHealthy()`.
2. **Execute** `podman exec claude -p --resume SESSION_ID` with the existing session. `buildAgentContext()` output is re-injected via `--append-system-prompt` (memory may have changed between messages). If `--resume` fails with "No conversation found", the runtime retries without `--resume`.
3. **Async PG backup** — session files read from inside the container via `podman exec` (not from host filesystem). See "Backup and Restore Flow" below.
4. **Reset idle timer** to extend the container's lifetime.

Warm follow-up adds ~0.5 seconds of `podman exec` overhead. No container creation, no PG restore.

### Idle Timeout

When no messages arrive for the configured idle period (default 60 minutes):

1. **Final PG backup** — save the current session state.
2. **Stop container** — `podman stop` with a 10-second grace period for `sleep infinity` to exit.
3. **Remove container** — `podman rm` frees all container resources.
4. **Clean up** — remove from the warm container map and clear the idle timer.

The session data survives in PG. The next message triggers a cold start that restores the session.

### Hard Expiry

Sessions have a 24-hour hard expiry regardless of activity. After 24 hours, the `MemoryConsolidationJob` has had multiple opportunities to extract facts and summaries from the session's messages into Tier 2 semantic memory. The raw session data is no longer needed for long-term recall.

The periodic cleanup timer (every 5 minutes) sweeps `agent_sessions` for rows where `expires_at <= now()` and deletes them.

### Container Death

If a container dies unexpectedly (OOM kill, Podman crash, host restart):

1. The warm container map entry still exists but the container is gone.
2. On the next message, `containerRuntime.isHealthy()` returns `false`.
3. The stale entry is removed and a cold start begins.
4. PG has the last successfully backed-up session — restored into the new container.
5. The user experiences a ~3-5 second delay (cold start) but no data loss beyond the last unbacked-up message.

## PG Backup Schema

```sql
CREATE TABLE IF NOT EXISTS agent_sessions (
  chat_id              TEXT        PRIMARY KEY REFERENCES chats(id),
  session_id           TEXT        NOT NULL,
  session_files        JSONB       NOT NULL DEFAULT '{}',
  last_assistant_uuid  TEXT,
  message_count        INTEGER     NOT NULL DEFAULT 0,
  created_at           BIGINT      NOT NULL,
  updated_at           BIGINT      NOT NULL,
  expires_at           BIGINT      NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_expires ON agent_sessions(expires_at);
```

### Column Details

| Column | Type | Purpose |
|---|---|---|
| `chat_id` | `TEXT` (PK) | One active session per chat. Foreign key to `chats(id)`. Chat IDs follow the format `telegram:12345`, `whatsapp:5551234`, etc. |
| `session_id` | `TEXT` | Claude Code session UUID. Passed to `--resume` on follow-up messages. |
| `session_files` | `JSONB` | Complete session directory as a flat key-value map. Keys are relative paths, values are file contents. See "Session Files" below. |
| `last_assistant_uuid` | `TEXT` | UUID of the last assistant message in the session transcript. Used for precise resume-point tracking. |
| `message_count` | `INTEGER` | Number of messages processed in this session. Incremented on each backup. |
| `created_at` | `BIGINT` | Unix timestamp (ms) when the session was first created. |
| `updated_at` | `BIGINT` | Unix timestamp (ms) of the last PG backup. |
| `expires_at` | `BIGINT` | Unix timestamp (ms) when this session expires. Updated on each activity. |

The `PRIMARY KEY (chat_id)` — not a composite key on `(chat_id, session_id)` — enforces exactly one active session per chat. The `INSERT ... ON CONFLICT (chat_id) DO UPDATE` (UPSERT) pattern replaces the old session atomically when a new one starts.

## Session Files

Claude Code stores session data in a well-defined directory structure under `~/.claude/projects/<encoded-cwd>/`. In FlowHelm, the encoded CWD is always `-workspace` because every agent container uses `/workspace` as its working directory.

### What Is Stored

| File | Description |
|---|---|
| `<session-id>.jsonl` | Main conversation transcript. Append-only JSONL with every user and assistant message. This is the largest file. |
| `<session-id>/subagents/agent-<id>.jsonl` | Subagent conversation transcripts. Created when the agent uses the Agent tool for parallel subtasks. |
| `<session-id>/subagents/agent-<id>.meta.json` | Subagent metadata (type, description, status). |
| `<session-id>/tool-results/toolu_<id>.txt` | Externalized tool outputs. Created when tool results exceed the inline size threshold. |
| `sessions-index.json` | Session index listing all sessions in the project directory. Generated from session metadata. |
| `MEMORY.md` and other `.md` files | Claude Code auto-memory files. Created automatically by Claude Code when it detects patterns, preferences, and project knowledge worth persisting. These live under `projects/-workspace/` alongside session transcripts. |
| `__claude.json` (JSONB key only) | Claude Code global config (`~/.claude.json`). Stored as a special `__claude.json` key in the JSONB map because it lives outside the `~/.claude/` directory. On cold-start restore, it is written to `/home/flowhelm/.claude.json` (not inside `.claude/`). |

### JSONB Storage Format

Session files are stored as a flat JSONB map in the `session_files` column. Keys are relative paths (from `~/.claude/` as root), values are UTF-8 file contents. The entire `projects/` directory tree is captured — not just `.jsonl` and `.json` files — so that Claude Code auto-memory (`.md` files), subagent data, and tool results all survive cold starts. See ADR-041.

```json
{
  "projects/-workspace/abc123-def456.jsonl": "{\"role\":\"user\",\"content\":\"Check my calendar\"}\n{\"role\":\"assistant\",\"content\":\"You have 3 meetings today...\"}\n",
  "projects/-workspace/abc123-def456/subagents/agent-xyz.jsonl": "{\"role\":\"user\",\"content\":\"List calendar events\"}\n...",
  "projects/-workspace/abc123-def456/subagents/agent-xyz.meta.json": "{\"type\":\"agent\",\"description\":\"Calendar lookup\"}",
  "projects/-workspace/abc123-def456/tool-results/toolu_789.txt": "Event: Team standup at 9:00 AM\nEvent: 1:1 with Sarah at 2:00 PM\n...",
  "projects/-workspace/sessions-index.json": "[{\"id\":\"abc123-def456\",\"created\":1712500000000}]",
  "projects/-workspace/MEMORY.md": "- User prefers bullet-point summaries\n- Project uses TypeScript strict mode\n",
  "__claude.json": "{\"autoUpdaterStatus\":\"disabled\"}"
}
```

The JSONB value is written to PostgreSQL using the `sql.json()` helper from postgres.js, which ensures proper serialization. Without this helper, passing a JavaScript object directly results in double-serialization (the object is stringified twice, producing escaped JSON strings instead of a proper JSONB value).

JSONB was chosen over BYTEA or tar archives because:
- Inspectable without extraction (`SELECT session_files->'main.jsonl' FROM agent_sessions`)
- Individual files can be updated without rewriting the entire blob
- PostgreSQL handles large JSONB efficiently (TOAST compression)
- No binary format versioning concerns

### Container Filesystem Layout

The host session directory is bind-mounted at a **staging path** (`/home/flowhelm/.claude-host`), not directly at `~/.claude`. After container start, session files are copied from the staging path to the container's own `/home/flowhelm/.claude/`. This two-step approach is required because of Podman rootless UID namespace mapping — see ADR-038 for the full rationale.

```
Host (restored from PG before container creation):
  ~/.flowhelm/data/sessions/{chatHash}/
    projects/
      -workspace/
        <session-id>.jsonl
        <session-id>/
          subagents/
            agent-<id>.jsonl
            agent-<id>.meta.json
          tool-results/
            toolu_<id>.txt
        sessions-index.json
        MEMORY.md              ← Claude Code auto-memory
    __claude.json              ← Claude Code global config (special key)

Container (staging mount at /home/flowhelm/.claude-host, read-only after copy):
  /home/flowhelm/.claude-host/  ← bind mount from host (staging)
    projects/...                ← same structure as host

Container (working copy, owned by flowhelm user):
  /home/flowhelm/.claude/       ← copied from .claude-host after start
    projects/
      -workspace/
        <session-id>.jsonl
        <session-id>/
          subagents/...
          tool-results/...
        sessions-index.json
        MEMORY.md
  /home/flowhelm/.claude.json   ← restored from __claude.json key
```

While the container is warm, session files live in the container's own filesystem at `/home/flowhelm/.claude/`. The orchestrator reads session files from **inside** the container (via `podman exec find` + `podman exec cat`) for PG backups — not from the host-side staging mount. Host-side reads are unreliable because Podman rootless subordinate UID mapping causes EACCES errors. See ADR-039. On cold start, files are restored from PG to the host directory, then copied into the container after start.

### Typical Session Sizes

| Component | Interactive CLI (reference) | FlowHelm Agent (expected) |
|---|---|---|
| Main JSONL | 200 KB - 10 MB | 20 KB - 500 KB |
| Subagent directory | 88 KB - 7 MB | 0 - 200 KB |
| Tool-results directory | 0 - 1 MB | 0 - 100 KB |
| **Total per session** | 300 KB - 18 MB | 50 KB - 500 KB |

FlowHelm agent sessions are much smaller than interactive CLI coding sessions because agent tasks are shorter (1-5 minutes vs. 30 min - 8 hours) and involve fewer subagent invocations.

## Three Memory Layers

Every message benefits from three complementary memory sources. They are not alternatives — they work together to give the agent both perfect short-term recall and rich long-term context.

### Layer 1: Session Resume (`--resume`)

**What it provides**: Perfect short-term recall. The exact conversation transcript, including every tool call and result, subagent interactions, and file edits.

**Mechanism**: The `--resume SESSION_ID` flag tells Claude Code to load the session's JSONL transcript and continue from where it left off. The agent sees the full conversation history without any summarization loss.

**Where it lives**: Container filesystem (warm path) or PG backup (cold start restore).

**Scope**: Current session only. Lost when the session expires or is deleted.

### Layer 2: `buildAgentContext()` (`--append-system-prompt`)

**What it provides**: Fresh long-term context, re-assembled every message. Identity (who the agent is, who the user is), semantic memories (facts, preferences, contacts, patterns), meta memories (high-confidence insights), and external memories (relevant documents).

**Mechanism**: The orchestrator calls `buildAgentContext()` before every agent invocation. The output (~6-10K tokens) is injected via `--append-system-prompt`, appended after the system prompt. This context is always fresh — if the consolidation job extracted new facts or the user updated their identity between messages, the next invocation reflects that.

**Where it lives**: PostgreSQL cognitive memory tables (queried in real-time by the orchestrator).

**Scope**: Profile-scoped (Tier 2, Tier 3, External) and global (User Identity/Personality). Persists across all sessions.

### Layer 3: MCP Tools (On-Demand)

**What it provides**: Deep recall during task execution. The agent can search the full memory database, retrieve extended conversation history, store new memories, and introspect on memory state — all mid-task.

**Mechanism**: The MCP memory server runs in the orchestrator process and exposes 12 tools over a Unix domain socket bind-mounted into the container at `/workspace/ipc/memory.sock`. The agent discovers these tools via the MCP config passed to `--mcp-config`.

**Where it lives**: Same PostgreSQL tables as Layer 2, but accessed on-demand by the agent (not pre-selected by the orchestrator).

**Scope**: Full memory database. No token budget — the agent decides what to query.

### How They Complement Each Other

```
Layer 1 (session resume):
  "User said 'Check my calendar' 3 messages ago"
  → Perfect recall within the current conversation session

Layer 2 (buildAgentContext):
  "User prefers bullet-point summaries. John Smith is a key contact."
  → Long-term facts and preferences, refreshed every message

Layer 3 (MCP tools):
  Agent: search_semantic("vendor John recommended last month")
  → Deep recall beyond what the orchestrator pre-selected
```

If session resume fails (corrupt JSONL, version mismatch), Layers 2 and 3 still provide rich context. The agent loses the exact transcript but retains all long-term knowledge. See ADR-008 and ADR-032.

## Configuration

Session behavior is configured under the `agent` section of the FlowHelm config (`~/.flowhelm/config.yaml`):

```yaml
agent:
  # Warm container idle timeout in milliseconds.
  # Container is stopped and removed after this period of inactivity.
  # Default: 3600000 (60 minutes)
  idleTimeout: 3600000

  # Hard session expiry in milliseconds.
  # Sessions are deleted after this time regardless of activity.
  # Default: 86400000 (24 hours)
  sessionHardExpiry: 86400000

  # Cleanup interval in milliseconds.
  # How often the periodic sweep checks for expired sessions.
  # Default: 300000 (5 minutes)
  sessionCleanupInterval: 300000
```

### Configuration Constraints

| Setting | Type | Min | Default | Notes |
|---|---|---|---|---|
| `agent.idleTimeout` | `integer` (ms) | 0 | 3,600,000 (60 min) | Set to 0 to disable idle timeout (not recommended — containers accumulate). |
| `agent.sessionHardExpiry` | `integer` (ms) | 60,000 | 86,400,000 (24h) | Must be >= 1 minute. Lower values risk deleting sessions before consolidation runs. |
| `agent.sessionCleanupInterval` | `integer` (ms) | 10,000 | 300,000 (5 min) | How often expired sessions are swept. Lower = faster cleanup, slightly more PG queries. |

These are validated at startup by the Zod config schema (`src/config/schema.ts`).

### Tuning Guidance

**Low-traffic personal use** (1-3 active chats): Default settings work well. 60-minute idle timeout keeps containers warm for typical back-and-forth conversations. 24-hour hard expiry matches the consolidation job's default 6-hour cycle.

**High-traffic multi-user** (10+ active chats per user): Consider reducing `idleTimeout` to 15-30 minutes to free container resources sooner. Each warm container uses ~50-100 MB RAM.

**Resource-constrained VPS** (1-2 GB RAM): Reduce `idleTimeout` to 5-10 minutes. Pair with `agent.maxConcurrentContainers` to cap total container count. Accept the 3-5 second cold-start trade-off for lower memory usage.

## Retention Policy

### One Active Session Per Chat

The `PRIMARY KEY (chat_id)` constraint guarantees exactly one active session per chat. When a new session starts for a chat that already has a session, the UPSERT replaces the old one atomically. There is no session forking — each chat (Telegram conversation, WhatsApp thread, etc.) maps to one linear conversation.

### Cleanup Lifecycle

```
  Session active (container warm)
    │
    ├─ Idle timeout fires (60 min)
    │   ├─ Final PG backup
    │   ├─ Container stopped + removed
    │   └─ Session row persists in PG (for cold-start restore)
    │
    ├─ Hard expiry (24h)
    │   └─ Session eligible for cleanup
    │
    └─ Periodic cleanup sweep (every 5 min)
        ├─ DELETE FROM agent_sessions WHERE expires_at <= now()
        └─ Returns count of deleted sessions (logged)
```

### Consolidation Before Deletion

In production, the `MemoryConsolidationJob` (scheduled every 6 hours by default) processes ended sessions' working memory (Tier 1) messages into Tier 2 semantic memory:

1. **d0 summaries**: Groups of messages condensed into summary entries.
2. **Fact extraction**: Individual facts, preferences, contacts, and patterns extracted as standalone semantic memory entries.
3. **d1+ condensation**: Older d0 summaries further condensed into higher-depth summaries.

The 24-hour hard expiry gives the consolidation job at least 4 opportunities to process a session's messages before the raw session data is discarded. The long-term memories extracted into Tier 2 and Tier 3 persist indefinitely in PostgreSQL.

If the consolidation job has not yet run for a session's messages (e.g., the orchestrator was down), the cleanup timer will still delete the session row at hard expiry. The working memory messages in `memory_working` are retained independently and will be consolidated on the next job run.

## Failure Modes

### Container Crash

**Symptom**: `containerRuntime.isHealthy()` returns `false` on the next message.

**Recovery**:
1. Stale warm container entry removed from the in-memory map.
2. Cold start triggered — new container created.
3. Session restored from PG (last successful async backup).
4. `podman exec claude -p --resume SESSION_ID` continues the conversation.

**Data loss**: At most one unbacked-up message (the one being processed when the crash occurred). The message queue retries the failed message.

### PG Backup Failure

**Symptom**: `asyncBackupSession()` throws an error (PG connection issue, disk full, etc.).

**Recovery**:
1. Error logged to stderr: `[cli-runtime] Session backup failed for {chatId}: ...`
2. The container and session files are unaffected — they persist on the host bind-mount.
3. On the next message, the backup is retried (every message triggers a full backup, not an incremental one).
4. If the backup keeps failing, the session data is safe in the container as long as the container is warm. Risk increases after idle timeout removes the container.

**Mitigation**: Monitor backup failure logs. Investigate PG health if failures are persistent.

### Session Resume Failure

**Symptom**: `claude -p --resume SESSION_ID` fails (corrupt JSONL, Claude Code version mismatch, missing session files, stale session ID).

**Recovery**:

Two recovery paths exist depending on the failure mode:

**Path A — Automatic retry (stale session)**: If `--resume` produces no stdout and stderr contains "No conversation found", the runtime automatically retries the same message without `--resume`. The container's `sessionId` is set to `null` so `buildCommand()` omits the `--resume` flag. A new session is started transparently. This handles the most common failure mode: session IDs that become stale after Claude Code updates or container image rebuilds.

**Path B — Parse error (corrupt data)**: If the CLI returns an unparseable response:
1. Parse error detected in CLI response.
2. Delete the corrupt session from PG: `SessionManager.deleteSession(chatId)`.
3. Retry the message as a fresh session (no `--resume`).
4. The three-tier memory system (Layer 2: `buildAgentContext()`, Layer 3: MCP tools) provides context even without the session transcript. The user loses the exact conversation history but retains all extracted long-term knowledge.

### Orchestrator Crash

**Symptom**: The orchestrator process dies (OOM, unhandled exception, signal).

**Recovery**:
1. Host temp directories persist on disk (they are not cleaned up by process exit).
2. Warm containers continue running (`sleep infinity` is independent of the orchestrator).
3. On orchestrator restart, the cleanup routine:
   - Lists running `flowhelm-agent-*` containers.
   - Rebuilds the warm container map from running containers.
   - Orphaned containers (no matching chat) are stopped and removed.
4. The message queue recovers messages stuck in `processing` state back to `pending`.

### PG Session Data Too Large

**Symptom**: Session files grow beyond typical size (>10 MB for an agent session).

**Impact**: PG handles large JSONB via TOAST compression transparently. No schema changes needed.

**Monitoring**: Query session sizes with:

```sql
SELECT chat_id,
       session_id,
       pg_column_size(session_files) AS size_bytes,
       message_count,
       updated_at
FROM agent_sessions
ORDER BY pg_column_size(session_files) DESC;
```

**Future**: If sessions routinely exceed 10 MB, consider enabling explicit compression (`pg_lz`) or storing session files as compressed BYTEA.

## Backup and Restore Flow

### Async Backup (After Every Message)

```
podman exec claude -p --resume $SID "Cancel my 3pm meeting"
  │
  ├─ CLI writes updated session files to container filesystem
  │   (/home/flowhelm/.claude/ — the container's own copy, not the staging mount)
  │
  ├─ Orchestrator parses CLI JSON response (result, session_id, cost)
  │
  ├─ Orchestrator sends response back to user via channel adapter
  │
  └─ Async (non-blocking):
      readSessionFilesFromContainer(containerId)
        ├─ podman exec find /home/flowhelm/.claude/projects -type f
        │   → list all session files (transcripts, auto-memory, subagents, tool results)
        ├─ podman exec cat <path>  (for each file found)
        │   → read file contents from inside the container
        ├─ podman exec cat /home/flowhelm/.claude.json
        │   → capture Claude Code global config as __claude.json key
        ├─ Build flat JSONB map { "relative/path": "content", ... }
        └─ SessionManager.saveSession(chatId, sessionId, sessionFiles)
            └─ INSERT ... ON CONFLICT (chat_id) DO UPDATE
               SET session_files = sql.json($map), updated_at = now(),
                   expires_at = now() + 24h
```

Session files are read from **inside the container** via `podman exec`, not from the host filesystem. This is because Podman rootless subordinate UID mapping makes host-side file reads return EACCES — the mapped UIDs are not accessible to the orchestrator process. See ADR-039.

The `sql.json()` helper from postgres.js ensures the session files map is properly serialized as a JSONB value (not double-stringified).

The backup is non-blocking — the user receives the agent's response immediately. PG backup runs in the background with ~100-500ms I/O overhead.

### Cold-Start Restore

```
Message arrives for chat with no warm container
  │
  ├─ SessionManager.restoreToFilesystem(chatId, targetDir)
  │   ├─ SELECT session_files FROM agent_sessions WHERE chat_id = $id AND expires_at > now()
  │   ├─ For each entry in JSONB map:
  │   │   ├─ mkdir -p dirname(targetDir/path)
  │   │   └─ writeFile(targetDir/path, content)
  │   │   (includes projects/ tree, auto-memory .md files, __claude.json)
  │   └─ Return AgentSession (or null if no active session)
  │
  ├─ Create container with targetDir bind-mounted at /home/flowhelm/.claude-host (staging)
  │
  ├─ podman start $CONTAINER
  │
  ├─ podman exec sh -c:
  │   ├─ cp -a /home/flowhelm/.claude-host/. /home/flowhelm/.claude/
  │   ├─ if __claude.json exists → cp to /home/flowhelm/.claude.json
  │   └─ chown -R flowhelm:flowhelm /home/flowhelm/.claude
  │
  └─ podman exec claude -p --resume $SESSION_ID ...
      ├─ Claude Code finds restored session files and continues
      └─ If "No conversation found" → retry without --resume (fresh session)
```

## Design Alternatives Considered

| Aspect | Persistent Container Approach | FlowHelm (Warm Container) |
|---|---|---|
| **Container lifecycle** | Persistent containers with custom agent-runner (IPC polling, message streams) | Warm containers with `sleep infinity` + `podman exec` (no custom agent-runner) |
| **Session storage** | Filesystem only (mounted directory on host) | Container filesystem (warm) + PG backup (crash recovery) |
| **Resume mechanism** | Agent SDK `resume` (in-memory) | CLI `--resume SESSION_ID` (filesystem-based, or PG restore on cold start) |
| **Crash recovery** | Host filesystem — if corrupted or lost, session is gone | PG backup survives container death, host dir loss, and VM migration |
| **Cross-host migration** | Not possible — session tied to host filesystem | PG backup can be restored on any host with access to the database |
| **Retention** | Indefinite (session files accumulate on disk) | 60-min idle timeout, 24-hour hard expiry, 1 active session per chat |
| **Resource cost (idle)** | ~50-100 MB RAM per chat (persistent container) | ~50-100 MB (warm container) or 0 (after idle timeout, PG row only) |
| **Implementation complexity** | High (custom agent-runner, IPC directory polling) | Low (`sleep infinity`, `podman exec`, JSONB UPSERT) |

FlowHelm's key design choices:
- **PG backup as crash safety net**: Filesystem-only session storage is only as durable as the host. FlowHelm adds transactional PG backup that survives container death, host directory corruption, and enables cross-host migration.
- **Bounded retention**: Rather than accumulating session files indefinitely, FlowHelm enforces idle timeout and hard expiry, freeing resources after inactivity while the consolidation job captures long-term knowledge in semantic memory.
- **Simpler implementation**: No custom agent-runner. The warm container pattern uses standard Podman primitives (`sleep infinity`, `podman exec`) and standard CLI flags (`--resume`).

## Source Files

| File | Purpose |
|---|---|
| `src/agent/warm-container-runtime.ts` | `WarmContainerRuntime` abstract base class: shared warm container lifecycle, `getOrCreateContainer()`, `asyncBackupSession()`, idle timer, `shutdown()` |
| `src/agent/cli-runtime.ts` | `CliRuntime` class: extends `WarmContainerRuntime`, builds `claude -p` command, parses CLI JSON response |
| `src/agent/sdk-runtime.ts` | `SdkRuntime` class: extends `WarmContainerRuntime`, builds `node /workspace/sdk-runner.js` command, parses SDK runner JSON |
| `src/agent/session-manager.ts` | `SessionManager` class: PG backup/restore, cleanup timer, UPSERT, filesystem read/write |
| `src/agent/types.ts` | `AgentSession`, `AgentSessionRow`, `WarmContainer`, `WarmContainerOptions`, `ContainerExecOptions` type definitions |
| `src/orchestrator/schema.sql` | `agent_sessions` table DDL and `idx_agent_sessions_expires` index |
| `src/config/schema.ts` | Zod schema for `agent.idleTimeout`, `agent.sessionHardExpiry`, `agent.sessionCleanupInterval` |
| `src/config/defaults.ts` | Default values for session configuration |
| `container-image/sdk-runner.js` | SDK runner script: wraps Claude Agent SDK `query()` into JSON CLI interface inside containers |
| `tests/session-manager.test.ts` | Unit tests for `SessionManager` (save, restore, cleanup, expiry, filesystem round-trip) |
| `tests/agent-runtime.test.ts` | Unit tests for both runtimes (warm container lifecycle, CLI flags, SDK runner, session resume, error handling) |

## Related Documentation

- [docs/decisions.md](decisions.md) — ADR-008 (Warm Containers with `podman exec` and PostgreSQL Session Backup), ADR-032 (PostgreSQL Session Backup for Warm Containers), ADR-038 (Podman Rootless Mount Staging Pattern), ADR-039 (Session Backup via Container Exec), ADR-040 (Auth Token Persistence), ADR-041 (Full `projects/` Directory Backup), ADR-042 (Proxy Container Entrypoint)
- [docs/architecture.md](architecture.md) — Agent Containers section, Data Flow diagram
- [docs/claude-integration.md](claude-integration.md) — Session Strategy section, CLI and SDK invocation patterns
- [docs/memory.md](memory.md) — `buildAgentContext()`, consolidation job, three-tier memory system
- [docs/database.md](database.md) — PostgreSQL schema overview, LISTEN/NOTIFY queue
- [docs/podman-isolation.md](podman-isolation.md) — Container isolation model, UID namespaces
