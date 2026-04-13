# Database Layer

## Overview

FlowHelm uses per-user PostgreSQL 18 + pgvector running in Alpine-based Podman containers. Each user's orchestrator connects to its own dedicated database container (`flowhelm-db-{username}`) on the user's isolated Podman network. There is no shared database, no cross-user access, and no external internet connectivity for the database container.

PostgreSQL was chosen over SQLite (used in the Phase 3 prototype) for three reasons: (1) pgvector provides HNSW-indexed vector similarity search for the cognitive memory system, (2) `LISTEN/NOTIFY` enables event-driven queue processing with zero polling latency, and (3) `FOR UPDATE SKIP LOCKED` provides true row-level locking for atomic dequeue. See ADR-018 in @docs/decisions.md for the full comparison.

The database client is `postgres.js` (the `postgres` npm package) -- a zero-dependency PostgreSQL client that uses tagged template literals for SQL injection prevention by construction. See ADR-022 in @docs/decisions.md.

## PostgreSQL Container

Each user's database runs in a dedicated Podman container built from `container-image/Containerfile.db`:

```
Image:     pgvector/pgvector:0.8.2-pg18 (Alpine-based, ~250-280 MB)
RAM:       ~100-130 MB idle (shared_buffers=64MB + process overhead)
Network:   flowhelm-network-{username} (isolated per user)
Volume:    ~/.flowhelm/data/pg/ → /var/lib/postgresql/data (persistent)
Security:  --read-only, --security-opt no-new-privileges
Name:      flowhelm-db-{username}
```

The container uses a custom `postgresql.conf` tuned for a single-user orchestrator workload:

| Setting | Value | Rationale |
|---|---|---|
| `max_connections` | 10 | One orchestrator with pool of 5 + headroom |
| `shared_buffers` | 64 MB | Per-user workload, not a shared database |
| `work_mem` | 4 MB | Sufficient for per-query sort/hash operations |
| `maintenance_work_mem` | 32 MB | Faster VACUUM and index builds |
| `effective_cache_size` | 128 MB | Informs query planner about available OS cache |
| `jit` | off | Saves ~30 MB RAM; JIT is not useful at per-user scale |
| `autovacuum_naptime` | 30s | Aggressive autovacuum for queue table churn |
| `autovacuum_vacuum_threshold` | 50 | Low threshold to keep dead tuples under control |

The pgvector extension is enabled at database creation via an init script (`init-extensions.sql`) placed in `/docker-entrypoint-initdb.d/`:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

The container lifecycle is managed by `PostgresContainerManager` (`src/container/postgres-manager.ts`), which handles create, start, stop, health checks (`pg_isready`), and connection string generation. The password is auto-generated using `crypto.randomBytes(24)` if not explicitly provided.

## Connection Setup

The connection factory (`src/orchestrator/connection.ts`) creates a postgres.js connection pool:

```typescript
import { createConnection } from './connection.js';

const sql = createConnection({
  connection: {
    host: 'flowhelm-db-mark',
    port: 5432,
    database: 'flowhelm',
    username: 'flowhelm',
    password: 'auto-generated-password',
  },
  maxConnections: 5,
  idleTimeout: 20,
  connectTimeout: 10,
});
```

| Option | Default | Description |
|---|---|---|
| `maxConnections` | 5 | Max connections in the pool |
| `idleTimeout` | 20 s | Close idle connections after this period |
| `connectTimeout` | 10 s | Fail fast if PG is unreachable |
| `ssl` | `false` | Disabled -- traffic stays on the isolated Podman network |

The hostname is the container name (`flowhelm-db-{username}`), resolved via Podman's internal DNS on the user's network. No ports are exposed to the host.

### Tagged Template Literals

All queries use postgres.js tagged templates. The `${}` interpolation is **always parameterized**, never string-concatenated. SQL injection is impossible by construction:

```typescript
// Safe — chatId is parameterized as $1
const rows = await sql`SELECT * FROM memory_working WHERE chat_id = ${chatId}`;

// This is NOT string interpolation. postgres.js transforms it into:
// PREPARE: SELECT * FROM memory_working WHERE chat_id = $1
// EXECUTE: ['tg:123']
```

For graceful shutdown, the caller invokes `sql.end()` to drain the connection pool and close all connections.

## Schema

The complete schema lives in `src/orchestrator/schema.sql` and is applied directly on startup via `sql.unsafe()`. All tables use `IF NOT EXISTS` for idempotence. Seed data (e.g., the default agent profile) uses `INSERT ... ON CONFLICT DO NOTHING`. No migration framework during active development — see ADR-035.

### `chats` -- Channel-Agnostic Chat Metadata

```sql
CREATE TABLE IF NOT EXISTS chats (
  id           TEXT    PRIMARY KEY,
  channel      TEXT    NOT NULL,
  external_id  TEXT    NOT NULL,
  name         TEXT,
  is_group     BOOLEAN NOT NULL DEFAULT false,
  profile_id   UUID    NOT NULL REFERENCES agent_profiles(id),
  created_at   BIGINT  NOT NULL,
  updated_at   BIGINT  NOT NULL,
  UNIQUE(channel, external_id)
);
```

The `id` is a channel-prefixed identifier (e.g., `tg:123`, `wa:+1234`) that uniquely identifies a conversation across all channels. The `UNIQUE(channel, external_id)` constraint prevents duplicate registrations while allowing the same external ID across different channels.

`is_group` uses PostgreSQL's native `BOOLEAN` type (replacing SQLite's `INTEGER 0/1`). All timestamps are `BIGINT` Unix milliseconds -- compact, fast to compare, and trivial for arithmetic.

### `sessions` -- Conversation Sessions

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id     TEXT    NOT NULL REFERENCES chats(id),
  started_at  BIGINT  NOT NULL,
  ended_at    BIGINT,
  summary     TEXT,
  metadata    JSONB   DEFAULT '{}'
);
```

Tracks conversation sessions for the cognitive memory system. When the orchestrator starts a new task, it creates or continues a session. Old sessions are summarized into `memory_semantic` entries with `memory_type='summary'` (LCM-inspired hierarchical summarization, see ADR-028). Key facts and preferences are extracted as separate semantic entries. The `metadata` column uses PostgreSQL's native `JSONB` type for structured data without schema changes.

Primary keys use `gen_random_uuid()` (PostgreSQL 18 built-in) for globally unique, time-sortable identifiers.

### `memory_working` -- Tier 1 Working Memory (Message History)

```sql
CREATE TABLE IF NOT EXISTS memory_working (
  id              TEXT    NOT NULL,
  chat_id         TEXT    NOT NULL,
  sender_id       TEXT    NOT NULL,
  sender_name     TEXT    NOT NULL,
  content         TEXT,
  audio_path      TEXT,
  image_path      TEXT,
  reply_to_id     TEXT,
  timestamp       BIGINT  NOT NULL,
  is_from_me      BOOLEAN NOT NULL DEFAULT false,
  is_bot_message  BOOLEAN NOT NULL DEFAULT false,
  session_id      UUID    REFERENCES sessions(id),
  PRIMARY KEY (id, chat_id),
  CONSTRAINT memory_working_chat_fk FOREIGN KEY (chat_id) REFERENCES chats(id)
);
```

**Composite primary key** `(id, chat_id)` prevents collisions when different channels reuse message IDs. A message ID is only unique within its chat.

**`session_id`** links each message to a conversation session for Working Memory retrieval. The orchestrator queries the last N messages by session when assembling context for agent tasks.

**`ON CONFLICT (id, chat_id) DO NOTHING`** on insert prevents duplicate messages from causing errors. If the same `(id, chat_id)` is stored twice, the second write is silently ignored.

### `queue` -- Status-Based Message Queue

```sql
CREATE TABLE IF NOT EXISTS queue (
  id           BIGINT  PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  message_id   TEXT    NOT NULL,
  chat_id      TEXT    NOT NULL,
  channel      TEXT    NOT NULL,
  payload      JSONB   NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'dead_letter')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  created_at   BIGINT  NOT NULL,
  updated_at   BIGINT  NOT NULL,
  error        TEXT,
  CONSTRAINT queue_chat_fk FOREIGN KEY (chat_id) REFERENCES chats(id)
);
```

The queue is a separate table with explicit status tracking and a `CHECK` constraint enforcing valid states. The `payload` column uses `JSONB` (not `TEXT`) -- postgres.js auto-serializes on insert and auto-parses on select, so the application works with native JavaScript objects.

`GENERATED ALWAYS AS IDENTITY` replaces SQLite's `AUTOINCREMENT` for monotonically increasing IDs.

**LISTEN/NOTIFY trigger**: A trigger fires `pg_notify('new_message', chat_id)` on every queue INSERT:

```sql
CREATE OR REPLACE FUNCTION notify_new_message() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('new_message', NEW.chat_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_queue_notify
  AFTER INSERT ON queue
  FOR EACH ROW
  EXECUTE FUNCTION notify_new_message();
```

The orchestrator subscribes via `LISTEN new_message` at startup and reacts instantly when a message is enqueued. This eliminates the 2-second polling latency from the earlier SQLite implementation.

### `cursors` -- Per-Chat Processing Position

```sql
CREATE TABLE IF NOT EXISTS cursors (
  chat_id     TEXT    PRIMARY KEY,
  timestamp   BIGINT  NOT NULL,
  updated_at  BIGINT  NOT NULL,
  CONSTRAINT cursors_chat_fk FOREIGN KEY (chat_id) REFERENCES chats(id)
);
```

Each chat has an independent cursor tracking the timestamp of the last message dispatched to an agent. One row per chat provides O(1) reads and updates.

### `state` -- Global Key-Value Store

```sql
CREATE TABLE IF NOT EXISTS state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

Minimal key-value store for global orchestrator state (e.g., last global poll timestamp). Uses `INSERT ... ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value` for atomic upserts.

### `memory_semantic` -- Tier 2 Semantic Memory

```sql
CREATE TABLE IF NOT EXISTS memory_semantic (
  id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  content         TEXT    NOT NULL,
  embedding       vector(384) NOT NULL,
  memory_type     TEXT    NOT NULL CHECK (memory_type IN (
                    'preference', 'fact', 'pattern', 'contact',
                    'instruction', 'summary', 'procedure')),
  importance      REAL    NOT NULL DEFAULT 0.5
                  CHECK (importance >= 0 AND importance <= 1),
  depth           INTEGER NOT NULL DEFAULT 0,
  token_count     INTEGER NOT NULL DEFAULT 0,
  source_session  UUID    REFERENCES sessions(id),
  profile_id      UUID    NOT NULL REFERENCES agent_profiles(id),
  earliest_at     BIGINT,
  latest_at       BIGINT,
  created_at      BIGINT  NOT NULL,
  updated_at      BIGINT  NOT NULL,
  last_accessed   BIGINT  NOT NULL,
  access_count    INTEGER NOT NULL DEFAULT 0
);
```

Stores extracted facts, preferences, patterns, procedures, instructions, and hierarchical summaries with 384-dimensional vector embeddings (generated by `all-MiniLM-L6-v2`). The `embedding` column uses pgvector's `vector(384)` type with an HNSW index for sub-millisecond cosine similarity search.

- `memory_type`: Categorizes the memory for filtered retrieval. The `summary` type uses the `depth` column for hierarchical summarization (0=leaf from working memory, 1+=condensed from lower-depth summaries). The `procedure` type stores multi-step workflows.
- `importance`: A score from 0.0 to 1.0 used in composite scoring: `score = α·similarity + β·e^(−λ·Δt) + γ·importance` (see ADR-029).
- `profile_id`: FK to `agent_profiles`. Each profile accumulates its own semantic memories — an "Executive Assistant" profile does not see memories from a "Code Reviewer" profile.
- `access_count` + `last_accessed`: Updated on every retrieval, implementing a "use it or lose it" recency pattern via exponential time decay.
- `depth`, `token_count`, `earliest_at`, `latest_at`: Summary-specific columns for the LCM-inspired DAG structure (see ADR-028). Default 0 for non-summary entries.

See @docs/memory.md for the full cognitive memory system design.

### `summary_message_sources` -- DAG: Summary → Source Messages

```sql
CREATE TABLE IF NOT EXISTS summary_message_sources (
  summary_id  UUID NOT NULL REFERENCES memory_semantic(id) ON DELETE CASCADE,
  message_id  TEXT NOT NULL,
  chat_id     TEXT NOT NULL,
  PRIMARY KEY (summary_id, message_id, chat_id),
  CONSTRAINT sms_message_fk FOREIGN KEY (message_id, chat_id)
    REFERENCES memory_working(id, chat_id) ON DELETE CASCADE
);
```

Links depth-0 summary entries to their source working memory messages. Enables the `expand_memory` MCP tool to recover original messages from a leaf summary.

### `summary_parent_sources` -- DAG: Condensed Summary → Parent Summaries

```sql
CREATE TABLE IF NOT EXISTS summary_parent_sources (
  parent_id  UUID NOT NULL REFERENCES memory_semantic(id) ON DELETE CASCADE,
  child_id   UUID NOT NULL REFERENCES memory_semantic(id) ON DELETE CASCADE,
  PRIMARY KEY (parent_id, child_id)
);
```

Links depth-1+ condensed summaries to their child (source) summaries. The `parent_id` is the higher-depth condensed summary; `child_id` is the lower-depth summary it was condensed from. Enables the `expand_memory` MCP tool to traverse the DAG from high-level summaries down to leaf summaries.

Together, `summary_message_sources` and `summary_parent_sources` implement the LCM-inspired traceability DAG: nothing is ever lost. The agent can drill from any condensed summary back to the original messages.

### `memory_meta` -- Tier 3 Meta Memory

```sql
CREATE TABLE IF NOT EXISTS memory_meta (
  id               UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  content          TEXT    NOT NULL,
  embedding        vector(384) NOT NULL,
  reflection_type  TEXT    NOT NULL CHECK (reflection_type IN (
                     'insight', 'heuristic', 'self_assessment')),
  confidence       REAL    NOT NULL DEFAULT 0.5
                   CHECK (confidence >= 0 AND confidence <= 1),
  depth            INTEGER NOT NULL DEFAULT 0,
  profile_id       UUID    NOT NULL REFERENCES agent_profiles(id),
  created_at       BIGINT  NOT NULL,
  updated_at       BIGINT  NOT NULL,
  last_accessed    BIGINT  NOT NULL
);
```

Stores agent-synthesized reflections generated by an opt-in async reflection job (see ADR-030). Three types:

- `insight`: Cross-cutting patterns across facts/preferences (e.g., "User delays budget decisions").
- `heuristic`: Rules of thumb for better task performance (e.g., "Bullet format drafts are accepted 80% of the time").
- `self_assessment`: Performance evaluation and improvement areas.

`confidence` starts at 0.3 and grows asymptotically with confirming observations. Entries below 0.2 are excluded from queries. Uses composite scoring with `confidence` replacing `importance`.

### `memory_meta_sources` -- Traceability: Meta → Semantic

```sql
CREATE TABLE IF NOT EXISTS memory_meta_sources (
  meta_id     UUID NOT NULL REFERENCES memory_meta(id) ON DELETE CASCADE,
  semantic_id UUID NOT NULL REFERENCES memory_semantic(id) ON DELETE CASCADE,
  PRIMARY KEY (meta_id, semantic_id)
);
```

Links each Tier 3 meta entry to the Tier 2 semantic entries that produced it. Combined with Tier 2's DAG traceability, enables full provenance: meta insight → source semantic entries → source summaries → original messages.

### `memory_external` -- External Memory

```sql
CREATE TABLE IF NOT EXISTS memory_external (
  id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  content     TEXT    NOT NULL,
  embedding   vector(384) NOT NULL,
  source_type TEXT    NOT NULL CHECK (source_type IN ('document', 'user_provided')),
  source_ref  TEXT    NOT NULL,
  profile_id  UUID    NOT NULL REFERENCES agent_profiles(id),
  created_at  BIGINT  NOT NULL
);
```

Stores document chunks and user-provided references with vector embeddings. External Memory is conditional — only injected into agent context when cosine similarity exceeds a configurable threshold (default 0.5). Profile-scoped like semantic and meta memory.

- `source_type`: Either `document` (uploaded/imported files) or `user_provided` (manually added references).
- `source_ref`: Identifies the source document for bulk deletion when a document is removed.
- `chunk_index`: Tracks position within a source document for ordering when multiple chunks match.

### Identity Tables

Four tables implement the identity layer (see ADR-024):

```sql
-- Agent Identity: user-configured professional profile
CREATE TABLE IF NOT EXISTS agent_identity (
  id           UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  role         TEXT    NOT NULL,
  expertise    TEXT[]  NOT NULL DEFAULT '{}',
  tone         TEXT    NOT NULL DEFAULT 'professional but warm',
  instructions TEXT,
  created_at   BIGINT  NOT NULL,
  updated_at   BIGINT  NOT NULL
);

-- Agent Personality: 6 relational dimensions (user-configured, starts 0.8 confidence)
CREATE TABLE IF NOT EXISTS agent_personality (
  id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  dimension       TEXT    NOT NULL UNIQUE CHECK (dimension IN (
                    'communication_style', 'humor', 'emotional_register',
                    'values', 'rapport', 'boundaries')),
  content         TEXT    NOT NULL,
  confidence      REAL    NOT NULL DEFAULT 0.8
                  CHECK (confidence >= 0 AND confidence <= 1),
  evidence_count  INTEGER NOT NULL DEFAULT 1,
  created_at      BIGINT  NOT NULL,
  updated_at      BIGINT  NOT NULL
);

-- User Identity: self-declared + agent-discovered
CREATE TABLE IF NOT EXISTS user_identity (
  id           UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT,
  role         TEXT,
  organization TEXT,
  timezone     TEXT,
  language     TEXT    DEFAULT 'en',
  contact      JSONB   DEFAULT '{}',
  notes        TEXT,
  created_at   BIGINT  NOT NULL,
  updated_at   BIGINT  NOT NULL
);

-- User Personality: 6 behavioral dimensions (agent-inferred, starts 0.3 confidence)
CREATE TABLE IF NOT EXISTS user_personality (
  id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  dimension       TEXT    NOT NULL UNIQUE CHECK (dimension IN (
                    'communication_style', 'work_patterns', 'decision_making',
                    'priorities', 'preferences', 'boundaries')),
  content         TEXT    NOT NULL,
  confidence      REAL    NOT NULL DEFAULT 0.3
                  CHECK (confidence >= 0 AND confidence <= 1),
  evidence_count  INTEGER NOT NULL DEFAULT 1,
  source          TEXT    NOT NULL DEFAULT 'inferred'
                  CHECK (source IN ('inferred', 'declared', 'onboarding')),
  created_at      BIGINT  NOT NULL,
  updated_at      BIGINT  NOT NULL
);
```

The identity layer gives the agent persistent personhood. `agent_identity` + `agent_personality` define who the agent is and how it relates to the user (max 7 rows). `user_identity` + `user_personality` track who the user is and how they behave (max 7 rows). All are injected at the top of the agent context XML. No vector embeddings — identity is always injected in full.

## Indexes

### Standard Indexes

| Index | Table | Columns | Purpose |
|---|---|---|---|
| `idx_chats_channel` | chats | `channel` | Filter chats by channel type |
| `idx_sessions_chat` | sessions | `chat_id, started_at DESC` | Find active/recent sessions for a chat |
| `idx_working_timestamp` | memory_working | `timestamp` | Global message ordering |
| `idx_working_chat_timestamp` | memory_working | `chat_id, timestamp` | Per-chat message retrieval (compound index for the subquery pattern) |
| `idx_working_session` | memory_working | `session_id, timestamp` | Working Memory: messages in a session |
| `idx_queue_status` | queue | `status, created_at` | Dequeue: find oldest pending |
| `idx_queue_chat` | queue | `chat_id` | Per-chat queue operations |
| `idx_semantic_type` | memory_semantic | `memory_type` | Filter by memory category |
| `idx_semantic_importance` | memory_semantic | `importance DESC` | Retrieve most important memories first |
| `idx_semantic_last_accessed` | memory_semantic | `last_accessed DESC` | Recency-based retrieval for composite scoring |
| `idx_semantic_depth` | memory_semantic | `(memory_type, depth)` WHERE `memory_type = 'summary'` | Filter summaries by depth for condensation |
| `idx_meta_type` | memory_meta | `meta_type` | Filter by meta memory category |
| `idx_meta_confidence` | memory_meta | `confidence DESC` | Retrieve highest-confidence reflections |
| `idx_external_source` | memory_external | `source` | Filter by external source type |
| `idx_external_ref` | memory_external | `source_ref` | Bulk operations on source documents |
| `idx_sms_message` | summary_message_sources | `message_id, chat_id` | DAG: find summaries for a message |
| `idx_sps_parent` | summary_parent_sources | `parent_id` | DAG: find condensed summaries for a parent |

### HNSW Vector Indexes

| Index | Table | Column | Operator Class | Purpose |
|---|---|---|---|---|
| `idx_semantic_embedding` | memory_semantic | `embedding` | `vector_cosine_ops` | Sub-ms cosine similarity for Tier 2 retrieval (two-phase: HNSW fetch + composite re-rank) |
| `idx_meta_embedding` | memory_meta | `embedding` | `vector_cosine_ops` | Sub-ms cosine similarity for Tier 3 retrieval |
| `idx_external_embedding` | memory_external | `embedding` | `vector_cosine_ops` | Sub-ms cosine similarity for External Memory retrieval |

HNSW (Hierarchical Navigable Small World) indexes provide approximate nearest-neighbor search with tunable recall. At per-user scale (thousands to tens of thousands of entries), HNSW delivers sub-millisecond query times with near-perfect recall. The `vector_cosine_ops` operator class uses cosine distance, which is the standard similarity metric for sentence embeddings.

Example two-phase retrieval query (Phase 1 — HNSW candidate fetch):

```sql
SELECT id, content, memory_type, importance, last_accessed,
       1 - (embedding <=> $1::vector) AS similarity
FROM memory_semantic
WHERE ($2::TEXT IS NULL OR memory_type = $2)
ORDER BY embedding <=> $1::vector
LIMIT $3  -- candidateMultiplier (3x) * desired limit
```

Phase 2 re-ranks the candidates in TypeScript using composite scoring:
```
score = α · similarity + β · e^(−λ · Δt) + γ · importance
```

The `<=>` operator computes cosine distance. `1 - distance` gives cosine similarity (0.0 to 1.0). See ADR-029 for the full composite scoring design.

## Message Query Patterns

### Get Messages Since Cursor

```sql
SELECT * FROM (
  SELECT * FROM memory_working
  WHERE chat_id = $1 AND timestamp > $2 AND is_bot_message = false
  ORDER BY timestamp DESC
  LIMIT $3
) sub ORDER BY timestamp ASC
```

The efficient subquery pattern: the inner query grabs the N most recent qualifying rows (descending), and the outer query re-sorts them chronologically (ascending). The `idx_working_chat_timestamp` compound index makes the inner query efficient -- PostgreSQL scans the index backward, reads at most N rows, and stops.

### Get Recent Messages (All Types)

```sql
SELECT * FROM (
  SELECT * FROM memory_working
  WHERE chat_id = $1
  ORDER BY timestamp DESC
  LIMIT $2
) sub ORDER BY timestamp ASC
```

Same pattern but includes bot messages. Used for conversation history display and Working Memory context assembly.

### Upsert Chat

```sql
INSERT INTO chats (id, channel, external_id, name, is_group, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT(id) DO UPDATE SET
  name = COALESCE(EXCLUDED.name, chats.name),
  updated_at = EXCLUDED.updated_at
```

`COALESCE(EXCLUDED.name, chats.name)` preserves the existing name if the new value is null. This prevents channels from accidentally clearing display names on re-registration.

### Upsert Cursor

```sql
INSERT INTO cursors (chat_id, timestamp, updated_at)
VALUES ($1, $2, $3)
ON CONFLICT(chat_id) DO UPDATE SET
  timestamp = EXCLUDED.timestamp,
  updated_at = EXCLUDED.updated_at
```

### Upsert State

```sql
INSERT INTO state (key, value) VALUES ($1, $2)
ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value
```

## Queue: Status Lifecycle

The message queue uses explicit status tracking with the following lifecycle:

```
pending  -->  processing  -->  completed
                           |
                           -->  failed  -->  pending  (retry, attempts < max_attempts)
                                        |
                                        -->  dead_letter  (attempts >= max_attempts)
```

### Enqueue

`enqueue()` inserts a row with `status = 'pending'`. The `trg_queue_notify` trigger fires `NOTIFY new_message, '{chat_id}'` automatically. The full `InboundMessage` is stored as `JSONB` in the `payload` column.

```typescript
const queueId = await queue.enqueue(message);
// INSERT fires NOTIFY → orchestrator reacts instantly
```

### Dequeue (FOR UPDATE SKIP LOCKED)

`dequeue()` atomically selects the oldest pending item and marks it as `processing` using `FOR UPDATE SKIP LOCKED`:

```sql
UPDATE queue SET
  status = 'processing',
  attempts = attempts + 1,
  updated_at = $1
WHERE id = (
  SELECT id FROM queue
  WHERE status = 'pending'
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
RETURNING *
```

`FOR UPDATE SKIP LOCKED` is PostgreSQL's native row-level locking for concurrent queue consumers. If another transaction has already locked the row, it is skipped rather than blocking -- the query moves to the next pending row. This provides true atomic dequeue without the transaction-based workaround required in SQLite.

A chat-specific variant, `dequeueForChat(chatId)`, adds a `chat_id` filter to the inner SELECT for targeted dequeue.

### Acknowledge

`acknowledge(queueId)` sets `status = 'completed'` after successful processing.

### Fail

`fail(queueId, error)` checks the attempt count:
- If `attempts < max_attempts`: returns to `pending` for retry.
- If `attempts >= max_attempts`: moves to `dead_letter` for admin inspection.

The error message is stored in the `error` column for debugging.

### Subscribe (LISTEN/NOTIFY)

The orchestrator subscribes to queue events at startup:

```typescript
await queue.subscribe((chatId) => {
  // New message enqueued for this chat — dequeue and process immediately
});
```

Under the hood, this calls `sql.listen('new_message', handler)`. When the trigger fires `NOTIFY`, the handler is invoked with the `chat_id` as the payload. The orchestrator can then call `dequeueForChat(chatId)` for targeted processing.

This replaces the 2-second `setTimeout` polling loop from the SQLite implementation with instant, event-driven notification.

## Schema Application

During active development, FlowHelm applies the schema directly on startup — no migration framework. The `Database.start()` method reads `schema.sql` and executes it via `sql.unsafe()`:

```typescript
const schemaSql = await readFile(schemaPath, 'utf-8');
await this.sql.unsafe(schemaSql);
```

All statements use `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`, making this idempotent. Seed data (e.g., the default agent profile) uses `INSERT ... ON CONFLICT DO NOTHING`. This is safe to run on every startup — existing data is never modified.

A migration framework will be introduced before the first production release, when real user data must survive schema changes. See ADR-035 in [docs/decisions.md](decisions.md).

## Crash Recovery

### Queue Recovery

On startup, `MessageQueue.start()` resets any messages stuck in `processing` back to `pending`:

```sql
UPDATE queue SET status = 'pending', updated_at = $1
WHERE status = 'processing'
```

Messages in `processing` when the orchestrator crashed were being handled but never acknowledged. Resetting them provides at-least-once delivery semantics -- they will be re-dispatched on the next dequeue cycle.

### Cursor Recovery

Cursors are stored in the `cursors` table and survive crashes. If a cursor is missing (first run for a new chat), `getCursor()` returns `0`, which means "process all messages from the beginning."

### WAL Durability

PostgreSQL's WAL (Write-Ahead Log) provides crash-safe writes. If the orchestrator or the database container crashes mid-transaction, the WAL contains enough information to either complete or roll back the transaction on restart. The custom `postgresql.conf` sets `max_wal_size = 256MB` and `min_wal_size = 32MB`, balanced for a per-user workload.

The `PostgresContainerManager` uses a 30-second stop timeout (`--stop-timeout 30`) to give PostgreSQL time to flush WAL and checkpoint before the container exits.

### Container Restart

The PostgreSQL container is an always-on component (like the credential proxy). If it crashes, the orchestrator detects the failure via health checks (`pg_isready`) and restarts the container. The `postgres.js` connection pool handles transient connection failures with automatic retry.

## Maintenance

### Purge Completed Messages

```typescript
const deleted = await queue.purgeCompleted(olderThanMs);
// Example: purge completed entries older than 24 hours
const deleted = await queue.purgeCompleted(24 * 60 * 60 * 1000);
```

Removes completed queue entries older than the specified age. Should be called periodically (e.g., daily) to prevent unbounded growth. Only `completed` entries are purged -- `pending`, `processing`, and `dead_letter` entries are preserved.

### Dead-Letter Inspection

```typescript
const deadLetters = await queue.getDeadLetters();
// Returns all dead-lettered items, ordered by creation time

const retried = await queue.retryDeadLetter(queueId);
// Resets attempts to 0, clears error, returns to 'pending'
```

Dead-lettered messages have exhausted their retry attempts. They remain in the queue for admin inspection via `getDeadLetters()`. To retry, call `retryDeadLetter(queueId)` which resets the attempt counter and moves the item back to `pending`.

### Queue Counts

```typescript
const counts = await queue.counts();
// { pending: 3, processing: 1, completed: 42, failed: 0, dead_letter: 1 }
```

Returns per-status counts for monitoring and health checks. Also available: `pendingCount()` for a lightweight check.

### Database Backup

Per-user database backup uses `pg_dump`:

```bash
# As the user (or via admin script):
podman exec flowhelm-db-mark pg_dump -U flowhelm -d flowhelm > /backup/flowhelm-mark-$(date +%Y%m%d).sql

# Compressed:
podman exec flowhelm-db-mark pg_dump -U flowhelm -d flowhelm -Fc > /backup/flowhelm-mark-$(date +%Y%m%d).dump

# Restore:
podman exec -i flowhelm-db-mark psql -U flowhelm -d flowhelm < /backup/flowhelm-mark-20260405.sql
```

For automated backups, the admin CLI will provide `flowhelm admin backup {username}`.

### Autovacuum

The custom `postgresql.conf` configures aggressive autovacuum settings for the queue table's high churn pattern:

- `autovacuum_naptime = 30s` -- check for dead tuples every 30 seconds
- `autovacuum_vacuum_threshold = 50` -- vacuum after 50 dead tuples
- `autovacuum_vacuum_scale_factor = 0.1` -- plus 10% of table size

This prevents bloat from the queue's insert-update-delete cycle. No manual `VACUUM` is needed under normal operation.

## Comparison with Phase 3 SQLite Approach

Phase 3 shipped with SQLite (`better-sqlite3`) as a rapid prototype that validated schema design, queue lifecycle, and crash recovery patterns. Phase 3A replaced it with PostgreSQL while preserving the proven patterns.

| Aspect | Phase 3 (SQLite) | Phase 3A (PostgreSQL + pgvector) |
|---|---|---|
| Connection model | Synchronous (blocks event loop) | Async (non-blocking, native `await`) |
| SQL injection prevention | Parameterized queries (manual `?` binding) | Tagged template literals (parameterized by construction) |
| Vector search | Not supported | pgvector HNSW indexes, sub-ms cosine similarity |
| Queue dequeue | Transaction trick (SELECT + UPDATE in tx) | `FOR UPDATE SKIP LOCKED` (true row-level locking) |
| Queue notification | 2-second `setTimeout` polling loop | `LISTEN/NOTIFY` (instant, event-driven) |
| Concurrency | Single-writer with WAL | Full MVCC (multiple concurrent readers and writers) |
| JSON support | `TEXT` column storing serialized JSON | Native `JSONB` with GIN indexing capability |
| Boolean type | `INTEGER` (0/1 convention) | Native `BOOLEAN` |
| Primary keys | `INTEGER AUTOINCREMENT` / `TEXT` | `BIGINT GENERATED ALWAYS AS IDENTITY` / `UUID gen_random_uuid()` |
| Status validation | Convention only | `CHECK` constraint on `status` column |
| Migration locking | N/A (single process, no contention) | `pg_advisory_lock` (prevents concurrent runs) |
| Session tracking | Not supported | `sessions` table with UUID primary keys |
| Memory tables | Not supported | `memory_semantic` + `memory_meta` + `memory_external` with vector columns, DAG join tables, 4 identity tables |
| Dependency | Native C++ addon (build tools required) | Zero-dep client (`postgres.js`, pure JavaScript) |
| Backup | `cp messages.db messages.db-wal messages.db-shm` | `pg_dump` (well-understood, scriptable) |
| Resource cost per user | 0 MB (embedded) | ~100-130 MB (Alpine container) |

**What was preserved from Phase 3**: Schema design (chats, memory_working, queue, cursors, state tables), queue status lifecycle (pending -> processing -> completed/failed/dead_letter), crash recovery pattern (reset stuck `processing` -> `pending` on startup), composite primary keys, integer (BIGINT) timestamps, the efficient subquery pattern for message retrieval.

**What was gained**: Vector similarity search for the cognitive memory system (4 memory tables with 3 HNSW indexes), composite scoring with recency decay, LCM-inspired hierarchical summarization with DAG traceability, event-driven queue (zero latency vs 2-second floor), JSONB for structured metadata, full MVCC concurrency, session tracking, identity layer (4 tables), native boolean and UUID types, and CHECK constraints for data integrity.

## Files

| File | Responsibility |
|---|---|
| `src/orchestrator/schema.sql` | Complete PostgreSQL schema: all tables, indexes, triggers, pgvector extension |
| `src/orchestrator/database.ts` | `FlowHelmDatabase` class: lifecycle, chat/message/cursor/state CRUD operations |
| `src/orchestrator/connection.ts` | Connection factory: URL construction, pool configuration, `createConnection()` |
| ~~`src/orchestrator/migrator.ts`~~ | Removed (ADR-035). Schema applied directly on startup via `sql.unsafe(schema.sql)`. |
| `src/orchestrator/message-queue.ts` | `MessageQueue` class: enqueue, dequeue (FOR UPDATE SKIP LOCKED), acknowledge, fail, dead-letter, LISTEN/NOTIFY subscription, crash recovery |
| `src/orchestrator/types.ts` | Core types: `InboundMessage`, `SemanticMemoryEntry`, `MetaMemoryEntry`, `ExternalMemoryEntry`, `AgentIdentity`, `AgentPersonalityEntry`, `UserIdentity`, `UserPersonalityEntry`, `Session`, `EmbeddingProvider`, `Startable` |
| `src/orchestrator/index.ts` | Barrel exports |
| `src/container/postgres-manager.ts` | `PostgresContainerManager`: container lifecycle, health checks, connection info |
| `container-image/Containerfile.db` | PostgreSQL 18 + pgvector container image definition |
| `container-image/postgresql.conf` | Per-user PostgreSQL tuning configuration |
| `container-image/init-extensions.sql` | Enables pgvector on database creation |
| `tests/database.test.ts` | 34 tests: schema, CRUD, FK enforcement, session_id behavior, JSONB operations |
| `tests/message-queue.test.ts` | 29 tests: queue lifecycle, FOR UPDATE SKIP LOCKED, LISTEN/NOTIFY, crash recovery, dead-letter |
| `tests/connection.test.ts` | 7 tests: URL construction, pool config, error handling |
| ~~`tests/migrator.test.ts`~~ | Removed (migrator deleted). |
| `tests/postgres-manager.test.ts` | 30 tests: container config generation, health checks, connection string building |
