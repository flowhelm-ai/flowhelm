-- FlowHelm PostgreSQL schema.
--
-- Complete schema for per-user PostgreSQL 18 + pgvector.
-- Applied directly on startup via sql.unsafe(). Idempotent
-- (all CREATE use IF NOT EXISTS).
--
-- Tiers: Working Memory (Tier 1), Semantic Memory (Tier 2),
-- Meta Memory (Tier 3), External Memory, Identity Layer.
-- See docs/memory.md and docs/database.md.

-- ─── Extensions ───────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS vector;

-- ─── Agent Profiles ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_profiles (
  id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT    NOT NULL UNIQUE,
  description TEXT,
  is_default  BOOLEAN NOT NULL DEFAULT false,
  created_at  BIGINT  NOT NULL,
  updated_at  BIGINT  NOT NULL
);

-- Ensure at most one default profile (partial unique index)
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_default_profile
  ON agent_profiles(is_default) WHERE is_default = true;

-- ─── Chats ────────────────────────────────────────────────────────────────

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
CREATE INDEX IF NOT EXISTS idx_chats_channel ON chats(channel);
CREATE INDEX IF NOT EXISTS idx_chats_profile ON chats(profile_id);

-- ─── Sessions ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sessions (
  id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id     TEXT    NOT NULL REFERENCES chats(id),
  started_at  BIGINT  NOT NULL,
  ended_at    BIGINT,
  summary     TEXT,
  metadata    JSONB   DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_sessions_chat ON sessions(chat_id, started_at DESC);

-- ─── Tier 1: Working Memory (raw messages) ───────────────────────────────

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
CREATE INDEX IF NOT EXISTS idx_working_timestamp ON memory_working(timestamp);
CREATE INDEX IF NOT EXISTS idx_working_chat_timestamp ON memory_working(chat_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_working_session ON memory_working(session_id, timestamp);

-- ─── Message Queue ────────────────────────────────────────────────────────

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
CREATE INDEX IF NOT EXISTS idx_queue_status ON queue(status, created_at);
CREATE INDEX IF NOT EXISTS idx_queue_chat ON queue(chat_id);

-- Queue insert notification trigger
CREATE OR REPLACE FUNCTION notify_new_message() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('new_message', NEW.chat_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_queue_notify ON queue;
CREATE TRIGGER trg_queue_notify
  AFTER INSERT ON queue
  FOR EACH ROW
  EXECUTE FUNCTION notify_new_message();

-- ─── Cursors ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cursors (
  chat_id     TEXT    PRIMARY KEY,
  timestamp   BIGINT  NOT NULL,
  updated_at  BIGINT  NOT NULL,
  CONSTRAINT cursors_chat_fk FOREIGN KEY (chat_id) REFERENCES chats(id)
);

-- ─── State (key-value) ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ─── Tier 2: Semantic Memory ─────────────────────────────────────────────

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
CREATE INDEX IF NOT EXISTS idx_semantic_embedding ON memory_semantic
  USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_semantic_type ON memory_semantic(memory_type);
CREATE INDEX IF NOT EXISTS idx_semantic_importance ON memory_semantic(importance DESC);
CREATE INDEX IF NOT EXISTS idx_semantic_depth ON memory_semantic(memory_type, depth)
  WHERE memory_type = 'summary';
CREATE INDEX IF NOT EXISTS idx_semantic_profile ON memory_semantic(profile_id);

-- ─── Tier 3: Meta Memory ─────────────────────────────────────────────────

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
CREATE INDEX IF NOT EXISTS idx_meta_embedding ON memory_meta
  USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_meta_type ON memory_meta(reflection_type);
CREATE INDEX IF NOT EXISTS idx_meta_profile ON memory_meta(profile_id);
CREATE INDEX IF NOT EXISTS idx_meta_depth ON memory_meta(reflection_type, depth);

-- ─── External Memory ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS memory_external (
  id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  content     TEXT    NOT NULL,
  embedding   vector(384) NOT NULL,
  source_type TEXT    NOT NULL CHECK (source_type IN ('document', 'user_provided')),
  source_ref  TEXT    NOT NULL,
  profile_id  UUID    NOT NULL REFERENCES agent_profiles(id),
  created_at  BIGINT  NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_external_embedding ON memory_external
  USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_external_source ON memory_external(source_type);
CREATE INDEX IF NOT EXISTS idx_external_ref ON memory_external(source_ref);
CREATE INDEX IF NOT EXISTS idx_external_profile ON memory_external(profile_id);

-- ─── DAG Join Tables (LCM-Inspired Traceability) ────────────────────────

-- Links depth-0 summaries to source working memory messages
CREATE TABLE IF NOT EXISTS summary_message_sources (
  summary_id  UUID NOT NULL REFERENCES memory_semantic(id) ON DELETE CASCADE,
  message_id  TEXT NOT NULL,
  chat_id     TEXT NOT NULL,
  PRIMARY KEY (summary_id, message_id, chat_id),
  CONSTRAINT sms_message_fk FOREIGN KEY (message_id, chat_id)
    REFERENCES memory_working(id, chat_id) ON DELETE CASCADE
);

-- Links depth-1+ summaries to their child summaries
CREATE TABLE IF NOT EXISTS summary_parent_sources (
  parent_id  UUID NOT NULL REFERENCES memory_semantic(id) ON DELETE CASCADE,
  child_id   UUID NOT NULL REFERENCES memory_semantic(id) ON DELETE CASCADE,
  PRIMARY KEY (parent_id, child_id)
);

-- Links meta memory entries to their source semantic entries (T2→T3 d0)
CREATE TABLE IF NOT EXISTS memory_meta_sources (
  meta_id     UUID NOT NULL REFERENCES memory_meta(id) ON DELETE CASCADE,
  semantic_id UUID NOT NULL REFERENCES memory_semantic(id) ON DELETE CASCADE,
  PRIMARY KEY (meta_id, semantic_id)
);

-- Links depth-1+ meta entries to their child meta entries (T3 internal DAG)
CREATE TABLE IF NOT EXISTS meta_parent_sources (
  parent_id  UUID NOT NULL REFERENCES memory_meta(id) ON DELETE CASCADE,
  child_id   UUID NOT NULL REFERENCES memory_meta(id) ON DELETE CASCADE,
  PRIMARY KEY (parent_id, child_id)
);
CREATE INDEX IF NOT EXISTS idx_meta_parent_child ON meta_parent_sources(child_id);

-- ─── Agent Sessions (Warm Container PG Backup) ─────────────────────────

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

-- ─── Identity Layer ──────────────────────────────────────────────────────

-- Agent Identity: user-configured professional profile (one per profile)
CREATE TABLE IF NOT EXISTS agent_identity (
  id           UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id   UUID    NOT NULL REFERENCES agent_profiles(id),
  role         TEXT    NOT NULL,
  expertise    TEXT[]  NOT NULL DEFAULT '{}',
  tone         TEXT    NOT NULL DEFAULT 'professional but warm',
  instructions TEXT,
  created_at   BIGINT  NOT NULL,
  updated_at   BIGINT  NOT NULL,
  UNIQUE(profile_id)
);

-- Agent Personality: 6 relational dimensions per profile (user-configured, agent-refinable)
CREATE TABLE IF NOT EXISTS agent_personality (
  id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id      UUID    NOT NULL REFERENCES agent_profiles(id),
  dimension       TEXT    NOT NULL CHECK (dimension IN (
                    'communication_style', 'humor', 'emotional_register',
                    'values', 'rapport', 'boundaries')),
  content         TEXT    NOT NULL,
  confidence      REAL    NOT NULL DEFAULT 0.8,
  evidence_count  INTEGER NOT NULL DEFAULT 1,
  created_at      BIGINT  NOT NULL,
  updated_at      BIGINT  NOT NULL,
  UNIQUE(profile_id, dimension)
);

-- User Identity: self-declared + agent-discovered (single row per user DB)
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

-- User Personality: 6 behavioral dimensions (agent-inferred + onboarding)
CREATE TABLE IF NOT EXISTS user_personality (
  id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  dimension       TEXT    NOT NULL UNIQUE CHECK (dimension IN (
                    'communication_style', 'work_patterns', 'decision_making',
                    'priorities', 'preferences', 'boundaries')),
  content         TEXT    NOT NULL,
  confidence      REAL    NOT NULL DEFAULT 0.3,
  evidence_count  INTEGER NOT NULL DEFAULT 1,
  source          TEXT    NOT NULL DEFAULT 'inferred'
                  CHECK (source IN ('inferred', 'declared', 'onboarding')),
  created_at      BIGINT  NOT NULL,
  updated_at      BIGINT  NOT NULL
);

-- ─── Cost Tracking (forward-looking, populated by orchestrator ingestion) ──

CREATE TABLE IF NOT EXISTS cost_tracking (
  id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_name TEXT    NOT NULL,
  model           TEXT    NOT NULL,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  recorded_at     BIGINT  NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cost_tracking_credential
  ON cost_tracking (credential_name, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_cost_tracking_recorded
  ON cost_tracking (recorded_at DESC);

-- ─── Seed: Default Profile ──────────────────────────────────────────────
-- Ensures a default profile always exists. INSERT ... ON CONFLICT is
-- idempotent — safe to run on every startup.

INSERT INTO agent_profiles (name, description, is_default, created_at, updated_at)
VALUES ('default', 'Default agent profile', true, extract(epoch from now())::bigint * 1000, extract(epoch from now())::bigint * 1000)
ON CONFLICT (name) DO NOTHING;
