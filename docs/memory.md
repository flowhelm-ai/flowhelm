# Memory Architecture

## Overview

FlowHelm uses a cognitive memory architecture stored in PostgreSQL + pgvector to give each agent a focused, relevant context window and persistent knowledge that improves over time. The architecture is modeled after human cognition: working memory for the current conversation, semantic memory for accumulated knowledge, and meta memory for distilled wisdom. An identity layer gives each agent a persistent sense of self and a growing understanding of its user.

Instead of dumping an ever-growing plaintext file into the system prompt, FlowHelm queries multiple specialized memory stores, scores results with a composite formula (similarity + recency + importance), and assembles a structured XML context block. Agents can also query the full memory database on demand during task execution via 25 MCP tools over a Unix domain socket.

**Why multiple tiers instead of one?** Different kinds of memory have different retrieval patterns. Recent messages should be returned chronologically (you want the conversation thread, not semantically similar old messages). Long-term facts should be returned by semantic similarity with recency decay (the most relevant preference, weighted toward recent access). Meta-level insights should be filtered by confidence. Separating these concerns lets each tier use the retrieval method that suits its data.

The context window is not a database. Dumping everything into it is brute force, not querying.

## Architecture

```
  TIER 1              TIER 2 (DAG d0→d1→d2+)          TIER 3 (DAG d0→d1→d2+)
+-----------+ consolidation+------------------------+  reflection  +-----------------+
| Working   | -----------> |   Semantic Memory      | -----------> |   Meta Memory   |
| Memory    |    extract   |                        |   synthesize |                 |
|           |              | facts, preferences,    |              | d0: monitoring  |
| Raw msgs  |   d0: session summaries, facts       |              | d1: evaluation  |
| (session) |   d1: condensed multi-session        |              | d2+: regulation |
|           |   d2+: archived long-range            |              |                 |
+-----------+              +------------------------+              +-----------------+
  ephemeral                  persistent (self-editing)               distilled (DAG)

  Full DAG traceability:
  T1 messages → T2 d0 → T2 d1 → T2 d2+ → T3 d0 → T3 d1 → T3 d2+
  (every level traversable via expand_memory / expand_meta / trace_to_source)

         +-----------------------------------+
         |       EXTERNAL MEMORY              |   (orthogonal, conditional)
         |   Documents + user-provided refs    |
         +-----------------------------------+

  AGENT IDENTITY        AGENT PERSONALITY       USER IDENTITY       USER PERSONALITY
  Who the agent is      How agent behaves       Who the user is     How user behaves
  (user-configured)     (user-configured)       (self-declared)     (agent-inferred)
```

### Summary Table

| Component | Cognitive Analog | Storage Table | Retrieval Method | Who Writes | Scoped By |
|-----------|-----------------|---------------|-----------------|------------|-----------|
| **Tier 1: Working Memory** | RAM / active context | `memory_working` | Chronological (last N) | User + agent, real time | `chat_id` |
| **Tier 2: Semantic Memory** | Long-term knowledge | `memory_semantic` | Composite scoring (similarity + recency + importance) | Orchestrator extraction + agent via MCP | `profile_id` |
| **Tier 3: Meta Memory** | Wisdom / distilled experience | `memory_meta` | Composite scoring (similarity + recency + confidence), depth hierarchy (d0 monitoring → d1 evaluation → d2+ regulation) | Agent via async reflection job (3-phase: d0 generation, d1 condensation, d2+ synthesis) | `profile_id` |
| **External Memory** | Reference library | `memory_external` | Pure cosine similarity (conditional injection) | User via upload/import | `profile_id` |
| **Agent Identity** | Who the agent is | `agent_identity` | Direct lookup (single row per profile) | User at setup time | `profile_id` |
| **Agent Personality** | Soul of the agent | `agent_personality` | Direct lookup (max 6 rows per profile) | User at setup, agent proposes updates | `profile_id` |
| **User Identity** | Who the user is | `user_identity` | Direct lookup (single row) | User, self-declared at onboarding | User-global |
| **User Personality** | Soul of the user | `user_personality` | Direct lookup (max 6 rows) | Agent inferred + user onboarding | User-global |

---

## Tier 1: Working Memory

**Cognitive analog**: Working memory. The active context the agent can reason over in a single inference call.

**Purpose**: Preserve the conversational thread within the current session. Required for the agent to correctly interpret follow-up messages like "also CC his manager" or "change that to Friday."

**What it stores**: Raw messages from the current session, in order.

**Storage**: `memory_working` table (composite PK: `id + chat_id`). Each message has a `session_id` FK linking it to the active session.

**Scoping**: Working Memory is scoped by `chatId`, not by agent profile. It is raw message history tied to the chat/session. Profile scoping begins at Tier 2 (see [Profile-Scoped Memory](#profile-scoped-memory)).

**Retrieval method**: Chronological only. Fetch the last N messages (descending by timestamp), then re-sort ascending. No vector search. Content is irrelevant to retrieval — recency is everything.

**Default limit**: 20 messages (~3K tokens).

**Immutability**: Messages in `memory_working` are never modified or deleted. They are the immutable source of truth. The scheduled `MemoryConsolidationJob` summarizes ended sessions into Tier 2 — but the originals remain forever. This is the "lossless" property inspired by the LCM paper: nothing is ever lost, only progressively compressed.

```sql
SELECT * FROM (
  SELECT * FROM memory_working
  WHERE session_id = $1
  ORDER BY timestamp DESC
  LIMIT $2
) sub ORDER BY timestamp ASC
```

---

## Tier 2: Semantic Memory

**Cognitive analog**: Semantic memory. Structured, persistent knowledge the agent has accumulated about this specific user.

**Purpose**: Store everything the agent has learned about the user — facts they've stated, preferences observed, behavioral patterns, contact information, standing instructions, conversation summaries, and reusable procedures. This is the agent's curated user model. Entries are individually managed and refined over time.

**What it stores**: Extracted and classified memory entries, each with a 384-dimensional vector embedding.

**Storage**: `memory_semantic` table with HNSW vector index for sub-millisecond semantic search.

**Retrieval method**: Two-phase composite scoring. Phase 1: HNSW index retrieves top K*3 candidates by cosine similarity (sub-ms). Phase 2: Re-rank candidates in-memory using the composite formula:

```
score = alpha * similarity + beta * e^(-lambda * delta_t) + gamma * importance
```

Where:
- `similarity` = 1 - cosine_distance (0 to 1, from pgvector)
- `delta_t` = days since `last_accessed` (computed as `(Date.now() - lastAccessed) / 86_400_000`)
- `importance` = stored 0.0-1.0 value
- Default weights: alpha=0.5, beta=0.3, gamma=0.2, lambda=0.01

The recency decay term ensures a summary from last week ranks above a semantically identical summary from six months ago, even though the HNSW index doesn't know about time.

**Default limit**: 20 memories (~2K tokens).

### Memory Types

| Type | Description | Default Importance | Example |
|---|---|---|---|
| `preference` | User preferences and habits | 0.5 | "User prefers English for all communications" |
| `fact` | Facts the user has explicitly shared | 0.5 | "Company fiscal year starts in April" |
| `pattern` | Recurring behavioral patterns observed by the agent | 0.5 | "User usually reviews drafts at 9am" |
| `contact` | People and their details | 0.5 | "john.smith@company.com -- colleague, always notify" |
| `instruction` | Standing orders the agent must always follow | 1.0 | "Always draft emails first, ask confirmation before sending" |
| `summary` | Condensed summaries of past sessions (DAG hierarchy) | 0.7 | "2026-04-02: Discussed Q3 budget with John" |
| `procedure` | Reusable step-by-step workflows the agent has learned | 0.8 | "To schedule a meeting: (1) check calendar, (2) draft invite, (3) confirm" |

### Access Tracking

Every retrieval via `buildAgentContext()` updates `last_accessed = now()` and increments `access_count`. This feeds the recency decay term in the composite scoring formula and enables future LRU-like pruning of stale memories that are never accessed.

### Lifecycle

Entries persist indefinitely unless explicitly deleted or overwritten. The system should detect duplicate or contradicting entries and merge/update rather than append. This tier is **self-editing**, not append-only.

### Hierarchical Summarization (LCM-inspired DAG)

Summary entries in Semantic Memory form a **directed acyclic graph** (DAG) that provides lossless conversation history compression. This is inspired by the Lossless Context Management paper (Voltropy, 2026) but implemented independently using PostgreSQL + pgvector rather than SQLite + FTS5.

**How it works**: On a scheduled basis (default every 6 hours), the `MemoryConsolidationJob` compresses ended sessions' messages into summary entries with progressively increasing `depth`:

- **depth=0 (leaf)**: Direct summaries of raw message chunks. Each d0 node links to its source messages via the `summary_message_sources` join table.
- **depth=1 (condensed)**: Summaries of d0 summaries. Created when enough d0 nodes accumulate (configurable threshold, default 5). Each d1 node links to its source d0 nodes via the `summary_parent_sources` join table.
- **depth=2+ (archive)**: Progressively more abstract summaries for very long-running conversations.

**Nothing is lost**: Raw messages stay in `memory_working` forever. Summaries link back to their sources. The agent can drill into any summary via the `expand_memory` MCP tool to recover the original detail.

**Why not a separate table?** Summaries share the HNSW index with other semantic entries — one search mechanism, one scoring formula. They compete with facts for context slots on merit (composite score). A recent, relevant summary naturally ranks above an old, irrelevant fact.

#### Consolidation Process (MemoryConsolidationJob)

Consolidation is the full Tier 1 → Tier 2 pipeline: d0 summarization + fact extraction + d1+ condensation. It runs as a **scheduled batch job** (`MemoryConsolidationJob`), not at session end. This batches multiple ended sessions into one invocation, enables cross-session pattern detection, and avoids per-session overhead for trivial conversations.

**Scheduling**: Cron expression, default `0 */6 * * *` (every 6 hours). Configurable — users pick their off-peak hours.

**Minimum threshold**: Only runs if >= `minUnconsolidatedMessages` (default 20) unprocessed messages exist across all ended sessions. Below threshold, the job skips.

**Dispatch** (via `MemoryProvider`):
Orchestrator starts a fresh dedicated container (`flowhelm-memory-{username}`) and runs `claude -p --model <consolidationModel>`. Credential injection follows the same pattern as agent containers: MITM proxy with placeholder credentials when a CA cert is configured, or direct OAuth/API key forwarding otherwise. Quick shutdown (10s close delay). Never reuses the warm user container. Both consolidation and reflection share the same container name — since jobs run sequentially, they don't conflict.

**Parallel execution**: If the user is actively chatting when the job fires, consolidation runs in a **parallel container**. No conflict — PostgreSQL MVCC handles concurrent writes, and the consolidation job only processes ended sessions (`ended_at IS NOT NULL`).

**Crash safety**: The `state` table tracks `last_consolidation_at`. Missed runs just process more on the next run — Tier 1 messages are never lost.

**d0 generation** (messages -> leaf summary):
1. Query all ended sessions with unconsolidated messages
2. For each session: fetch messages not yet linked to any d0 summary
3. Chunk into groups of `chunkSize` (default 10 messages)
4. For each chunk: call the configured model to generate a ~300-token summary preserving decisions, facts, names, dates, and action items
5. Embed the summary, store as `memory_semantic` entry with `memory_type='summary'`, `depth=0`
6. Link to source messages via `summary_message_sources` join table
7. Extract structured facts from the same chunk and store as separate semantic entries

**d1+ condensation** (summary -> condensed summary):
1. When >= `consolidationThreshold` (default 5) depth=0 summaries exist for a chat, condense into depth=1
2. Condensation prompt focuses on final decisions, outcomes, and lasting facts (not deliberation process)
3. Target ~400 tokens per d1 summary
4. Link to source d0 entries via `summary_parent_sources` join table

**Depth-aware prompts**: d0 summaries preserve detail. d1 summaries preserve decisions and outcomes. d2+ summaries preserve only durable context (key decisions, accomplishments, hard constraints).

#### Token Costs

| Operation | Input tokens | Output tokens | Cost (Haiku) |
|---|---|---|---|
| d0 summary (per chunk) | ~600 | ~300 | ~$0.0003 |
| d1 condensation | ~1,500 | ~400 | ~$0.0009 |
| Batch of 5 sessions (~150 msgs) | ~9,000 | ~4,500 | ~$0.005 |
| 4 runs/day (every 6h) | ~36,000 | ~18,000 | ~$0.02/day |

#### DAG Traceability

Every link is traceable in the database:

```
memory_working (raw messages)
  |-- summary_message_sources --> memory_semantic depth=0 (leaf summaries)
                                    |-- summary_parent_sources --> memory_semantic depth=1+ (condensed)

memory_semantic (facts, preferences, etc.)
  |-- source_session FK --> sessions --> memory_working (which session produced this fact)

memory_meta depth=0 (direct observations)
  |-- memory_meta_sources --> memory_semantic (which T2 entries produced this observation)
  |-- meta_parent_sources --> memory_meta depth=1 (which d0s condensed into this pattern)
                                |-- meta_parent_sources --> memory_meta depth=2+ (strategic)
```

**Full traversal chain**: The agent can traverse backwards from a T3 d2 strategic self-assessment through T3 d1 evaluated patterns → T3 d0 direct observations → T2 facts/summaries → T2 d0 session summaries → T1 raw messages. Six levels of abstraction, all connected by join tables. The `trace_to_source` MCP tool traverses this entire chain in one call.

---

## Tier 3: Meta Memory

**Cognitive analog**: Meta-memory / reflective memory. The agent's own synthesized conclusions, derived from its experience — the closest analog to wisdom.

**Purpose**: Store distilled insights, behavioral heuristics, and self-assessments that the agent generated by reflecting across sessions and Tier 2 memories. No user stated these — the agent reasoned them into existence autonomously. This tier makes the agent **improve over time** rather than merely remember.

**What it stores**: Agent-generated reflections, linked to the source memories they were derived from.

**Storage**: `memory_meta` table with HNSW vector index.

**Retrieval method**: Same two-phase composite scoring as Tier 2, but replacing `importance` with `confidence`:

```
score = alpha * similarity + beta * e^(-lambda * delta_t) + gamma * confidence
```

**Default limit**: 5 entries (~500 tokens). High signal, low volume.

### Reflection Types

| Type | Description | Example |
|---|---|---|
| `insight` | Cross-session generalization about the user | "This user delays decisions involving budget. Surface cost implications early." |
| `heuristic` | Learned rule that improves task performance | "Email drafts are accepted without edits 80% of the time; scheduling tasks need one correction." |
| `self_assessment` | Agent's evaluation of its own performance patterns | "My calendar conflict detection misses recurring events. Double-check for those." |

### Confidence Model

New reflections start at the confidence provided by the generating LLM, clamped to 0.3-0.9. Each time a reflection is confirmed by subsequent behavior, confidence grows asymptotically:

```
new_confidence = min(0.95, old_confidence + (1 - old_confidence) * 0.1)
```

If a subsequent reflection contradicts an existing one, confidence decays faster:

```
new_confidence = max(0.1, old_confidence * 0.8)
```

Entries below 0.2 confidence are excluded from queries (soft-deleted). Entries above 0.4 are injected into the agent context.

### Recursive Metacognitive DAG (Hierarchical Tier 3)

Tier 3 uses the same DAG hierarchy pattern as Tier 2, with depth levels representing increasing levels of metacognitive abstraction. This makes FlowHelm the first AI memory system with hierarchical metacognition and full cross-tier DAG traceability.

**Depth levels** map to Nelson & Narens' (1990) metacognitive hierarchy:

| Depth | Metacognitive Level | Timescale | What It Captures |
|---|---|---|---|
| **d0** (Monitoring) | Direct reflection on T2 evidence | Daily | "User delays budget decisions" |
| **d1** (Evaluation) | Patterns across d0 observations | Weekly/monthly | "Decision speed inversely correlates with stakeholder count" |
| **d2+** (Regulation) | Strategic self-model, growth trajectory | Monthly/quarterly | "Over 3 months, I evolved from general assistant to email specialist" |

**Information flow** — strict waterfall within Tier 3, cross-tier link at the reflection boundary:

```
T2 ALL depths (d0 facts + d1 condensed + d2+ archived)
  ↓ reflection (cross-tier, qualitative change)
T3 d0: Monitoring — direct observations on T2 evidence
  ↓ synthesis (within T3, progressive abstraction)
T3 d1: Evaluation — patterns across d0 observations
  ↓ synthesis (within T3, progressive abstraction)
T3 d2+: Regulation — strategic self-knowledge
```

T3 d0 reads from ALL T2 depths because reflection benefits from both raw facts and condensed patterns. But T3 d1 reads ONLY from T3 d0 — if it accessed T2 directly, it would produce more d0-like observations instead of higher-order patterns.

**Full traceability chain** (6 levels, all traversable via MCP tools):

```
T3 d2 strategic insight
  └→ meta_parent_sources → T3 d1 evaluated patterns
      └→ meta_parent_sources → T3 d0 direct observations
          └→ memory_meta_sources → T2 facts/summaries (any depth)
              └→ summary_parent_sources → T2 d0 session summaries
                  └→ summary_message_sources → T1 raw messages
```

**Confidence propagation across depth**: Deeper entries inherit a floor confidence from their sources — a D1 insight synthesized from 5 high-confidence D0 observations starts higher than a fresh D0:

```
D1 floor = avg(source d0 confidences) + 0.05
D2 floor = avg(source d1 confidences) + 0.05
```

**Contradiction cascade**: When a D0 entry's confidence drops below 0.2 (soft-deleted), the system checks D1 entries that sourced from it. If >50% of a D1's source D0 entries are below 0.2, the D1 entry is decayed. Same logic cascades D1→D2.

### Traceability

Two join tables handle Tier 3 traceability:

| Join Table | Links | Purpose |
|---|---|---|
| `memory_meta_sources` | T3 entry → T2 source entries | Cross-tier: which T2 facts produced this T3 observation |
| `meta_parent_sources` | T3 parent → T3 child entries | Within-tier DAG: which d0 entries condensed into d1, etc. |

If a T2 source memory is deleted or corrected, derived T3 reflections can be found via `memory_meta_sources` and re-evaluated. If a T3 d0 entry is invalidated, derived T3 d1+ entries can be found via `meta_parent_sources` and cascade-decayed.

### Generation Method: Reflection Job (MemoryReflectionJob)

Meta memories are **never** written inline during a request. They are generated by a scheduled background job (`MemoryReflectionJob`) that runs during off-peak hours. The job runs three phases per cycle:

**Phase 1 — D0 generation** (monitoring):
- Input: Recent Tier 2 entries since last reflection (all depths)
- Processing: Three parallel LLM passes (insight, heuristic, self_assessment)
- Output: D0 meta entries linked to T2 via `memory_meta_sources`
- Duplicate detection: existing entries with >0.85 similarity are confirmed (confidence bumped), 0.7-0.85 similarity triggers contradiction decay

**Phase 2 — D1 condensation** (evaluation):
- Trigger: ≥ `metaCondensationThreshold` (default 5) uncondensed D0 entries per profile
- Input: Uncondensed D0 meta entries grouped by reflection_type
- Processing: LLM synthesizes higher-order patterns across D0 observations
- Output: D1 meta entries linked to source D0s via `meta_parent_sources`
- Confidence: Floor inherited from source D0 average + 0.05

**Phase 3 — D2+ condensation** (regulation):
- Trigger: ≥ `metaCondensationThreshold` uncondensed D1 entries per profile
- Input: Uncondensed D1 meta entries
- Processing: LLM synthesizes strategic self-knowledge from D1 patterns
- Output: D2 meta entries linked to source D1s via `meta_parent_sources`
- Recursion: Same function handles d1→d2, d2→d3, up to `maxMetaDepth` (default 3)

**Phase 4 — Contradiction cascade**:
- Check all D1+ entries whose source children have decayed below 0.2
- If >50% of sources invalidated, decay the parent entry
- Cascades upward through all depth levels

**Configuration**:
- **Enabled by default**: `reflection.enabled: true`. Users set `false` to opt out.
- **Schedule**: Cron expression, default `0 3 * * *` (daily at 3:00 AM).
- **Minimum data**: `minSemanticEntries` (default 10) new T2 entries since last run.
- **Model**: Haiku by default (~$0.002/run). Configurable — users may set Opus for higher quality.
- **Dispatch**: Same dual-runtime pattern as consolidation.

### Lifecycle

Entries persist until confidence drops below 0.2 (invalidated) or the user explicitly resets agent memory. Do not auto-expire by time — a valid insight remains valid regardless of age. Contradiction cascade may propagate invalidation from lower to higher depths.

---

## External Memory

**Cognitive analog**: External reference material. Not something the agent learned — something the user handed to the agent.

**Purpose**: Store document chunks and user-provided reference material that the agent can retrieve as context. Retention is source-managed: when a source document is removed, all its chunks are bulk-deleted together.

**What it stores**: Chunked content from external sources, each with a 384-dimensional vector embedding.

**Storage**: `memory_external` table with HNSW vector index.

**Retrieval method**: Pure cosine similarity. No importance scoring. No time decay. HNSW index order is final.

**Default limit**: 10 entries (~1K tokens).

**Conditional injection**: Unlike the other memory components, External Memory is **only injected into the agent context when relevant**. If no documents exceed the similarity threshold (default 0.5), the `<external_memory>` block is omitted entirely. This keeps token budget reserved for higher-signal memory types.

### Source Types

| Source | Description | Example |
|---|---|---|
| `document` | Chunks of user-provided documents | Paragraph from a PDF or report |
| `user_provided` | Manually added reference material | "Company vacation policy: 25 days/year" |

### Why Separate from Tier 2?

Different retention policies. External Memory entries are bulk-deleteable by `source_ref` — one call removes an entire document (`removeExternalBySource(sourceRef: string)`). Semantic Memory entries are individually curated and never bulk-deleted. External Memory is externally sourced and append-mostly; Semantic Memory is agent-learned and self-editing.

### Lifecycle

Append-mostly. Entries are added when users upload documents or provide reference material. Bulk-deleted when the source is removed. No merging or deduplication logic needed.

---

## Identity Layer

Above the three memory tiers, FlowHelm maintains an **identity layer** that gives the agent a persistent sense of who it is, how to behave, and who it's serving. The identity layer answers four questions:

1. **Agent Identity**: "Who am I?" (role, expertise, tone, instructions)
2. **Agent Personality**: "How should I behave?" (communication calibration, humor, boundaries)
3. **User Identity**: "Who am I talking to?" (name, role, organization, timezone)
4. **User Personality**: "How does this user behave?" (communication patterns, work habits, decision style)

### Agent Identity (User-Configured, Profile-Scoped)

Defines the agent's professional role and behavioral rules. Configured by the user during `flowhelm setup` and updateable via `flowhelm config identity` or via the agent's `propose_identity_update` MCP tool (requires user confirmation). **Profile-scoped**: each agent profile has its own identity row, allowing distinct personas (e.g., "Executive Assistant" vs. "Code Reviewer").

| Field | Type | Description | Example |
|---|---|---|---|
| `role` | `TEXT` | The agent's primary role | "Executive assistant" |
| `expertise` | `TEXT[]` | Areas of expertise | ["email management", "calendar optimization"] |
| `tone` | `TEXT` | Communication tone | "Professional but warm" |
| `instructions` | `TEXT` | Standing behavioral instructions | "Always draft emails first, ask confirmation before sending" |

Single row in `agent_identity` per profile. FK: `profile_id REFERENCES agent_profiles(id)`.

### Agent Personality (User-Configured, Agent-Refinable, Profile-Scoped)

Defines how the agent should relate to this specific user — communication calibration, humor preferences, boundaries. Configured by the user at setup time with confidence starting at 0.8. The agent can propose updates via the `observe_personality` MCP tool. **Profile-scoped**: each profile develops its own personality dimensions independently.

**Six fixed dimensions** (max 6 rows in `agent_personality`, UNIQUE constraint on dimension):

| Dimension | What it captures | Example |
|---|---|---|
| `communication_style` | How the agent should communicate | "Concise, bullet-point responses. Skip pleasantries." |
| `humor` | What humor style to use | "Dry humor OK. No puns." |
| `emotional_register` | How to adapt tone in different situations | "Monday mornings: keep it light. Under stress: just execute." |
| `values` | What the agent should prioritize | "Prioritize accuracy over speed. Always cite sources." |
| `rapport` | Current relationship trust level | "High trust. User delegates complex tasks without review." |
| `boundaries` | What the agent should never do | "Never contact spouse. Don't schedule meetings before 9am." |

**Confidence**: Starts at 0.8 (user explicitly configured). If the agent proposes an update and the user confirms, confidence stays high. If the user overrides a dimension, confidence resets to 0.8.

### User Identity (Self-Declared + Onboarding, User-Global)

Stores who the user is — factual, self-declared information collected during onboarding or updated via conversation. **User-global**: not scoped to any profile. The user is the same person regardless of which agent persona they interact with.

| Field | Type | Description | Example |
|---|---|---|---|
| `name` | `TEXT` | User's name | "Mark Johnson" |
| `role` | `TEXT` | Professional role | "CTO" |
| `organization` | `TEXT` | Company or team | "Acme Corp" |
| `timezone` | `TEXT` | IANA timezone | "Europe/Helsinki" |
| `language` | `TEXT` | Preferred communication language | "en" |
| `contact` | `JSONB` | Contact information | `{"email": "mark@acme.com"}` |
| `notes` | `TEXT` | Free-form context | "Manages 12 engineers. Fiscal year starts April." |

Single row in `user_identity`. Exactly one per user database. Updated by the agent via `update_user_identity` MCP tool when it discovers new information in conversation.

### User Personality (Agent-Inferred + Onboarding, User-Global)

Captures behavioral patterns the agent discovers through interaction — how the user communicates, works, makes decisions, and what their boundaries are. Unlike Agent Personality (which the user defines), User Personality is accumulated by the agent observing patterns across conversations. **User-global**: not scoped to any profile. Behavioral observations apply universally.

**Six fixed dimensions** (max 6 rows in `user_personality`, UNIQUE constraint on dimension):

| Dimension | What it captures | Example |
|---|---|---|
| `communication_style` | How the user communicates | "Short, direct messages. Uses abbreviations. Rarely writes paragraphs." |
| `work_patterns` | When and how the user works | "Active 9am-6pm Helsinki. Reviews email at 9am, 2pm, 5pm." |
| `decision_making` | How the user makes decisions | "Quick on technical choices. Delays budget decisions." |
| `priorities` | What the user values most | "Values punctuality. Privacy-conscious about personal data." |
| `preferences` | General preferences for agent behavior | "Prefers markdown tables. Likes concise summaries." |
| `boundaries` | What the agent should never do with/to the user | "Don't contact on weekends. Don't share personal info externally." |

**Confidence model**: Starts at 0.3 (agent tentatively inferring). Grows with confirming observations: `new = min(0.95, old + (1 - old) * 0.1)`. Dimensions below the confidence threshold (default 0.4) are excluded from context injection.

**Source tracking**: Each dimension records whether it came from `inferred` (agent-observed), `declared` (user explicitly stated), or `onboarding` (collected during setup).

---

## Managing Identity & Personality

Identity and personality are configured through three complementary mechanisms. Each writes to the same PostgreSQL tables — the difference is who initiates the update and how confidence is set.

### 1. CLI Commands (VM Terminal)

Users SSH into the VM under their Linux username and run `flowhelm identity` or `flowhelm personality` commands. Useful for initial setup and bulk configuration. See `docs/implementation-plan.md` Phase 10B for the complete command reference.

```bash
# Agent identity (profile-scoped)
flowhelm identity agent set --role "Executive assistant" --tone "Professional but warm"
flowhelm identity agent set --profile code-reviewer --role "Senior code reviewer"

# User identity (global)
flowhelm identity user set --name "Mark" --role "CTO" --timezone "Europe/Helsinki"

# Agent personality dimensions
flowhelm personality agent set --dimension communication_style --content "Concise, bullet points"
flowhelm personality agent set --dimension boundaries --content "Never contact spouse"

# User personality dimensions (declare instead of waiting for inference)
flowhelm personality user set --dimension work_patterns --content "Active 9am-6pm Helsinki"
```

### Onboarding Setup (Phase 10D)

For new users, `flowhelm setup identity` sets both agent and user identity in one command:

```bash
flowhelm setup identity \
  --agent-role "Personal assistant" \
  --agent-tone "Friendly, concise" \
  --agent-expertise "email,scheduling,research" \
  --user-name "Mark Johnson" \
  --user-role "CTO" \
  --user-timezone "Europe/Helsinki"
```

If the agent identity is not configured when the first channel message arrives, the agent's response includes a hint: "You can personalize me with `/identity set agent role=...`". This ensures users discover the identity system organically.

### 2. Channel Commands (Telegram, WhatsApp, etc.)

Users send `/`-prefixed commands from any connected channel. These are intercepted by the orchestrator before reaching the agent — zero API token cost. See `docs/implementation-plan.md` Phase 10C for the complete command reference.

```
/identity set agent role=Personal assistant
/identity set user name=Mark, timezone=Europe/Helsinki
/personality set agent humor=Dry humor OK. No puns.
/personality set user communication_style=Short and direct
/personality show
/identity show
```

### 3. Agent Inference (Automatic, MCP Tools)

The agent autonomously observes patterns during conversations and updates personality dimensions via MCP tools (`observe_personality`, `observe_user`). This is the only mechanism that operates automatically — the other two require explicit user action.

| Mechanism | Who Initiates | Confidence | Source | Token Cost |
|---|---|---|---|---|
| CLI commands | User (terminal) | 0.8 (declared) | `declared` | None |
| Channel commands | User (channel) | 0.8 (declared) | `declared` | None |
| Agent inference | Agent (automatic) | Starts 0.3, grows | `inferred` | Uses agent turns |
| Onboarding | System (setup) | 0.8 | `onboarding` | None |

All three mechanisms coexist. User-declared values (CLI or channel) take precedence over agent-inferred values because they start at higher confidence (0.8 vs 0.3). The agent's inference can still contribute additional detail — for example, a user might declare their timezone via CLI, and the agent might later infer their meeting scheduling preferences from conversation patterns.

---

## Profile-Scoped Memory

Agent profiles (see `docs/decisions.md` ADR-034) partition persistent memory so a single user can run multiple agent personas — each with its own accumulated knowledge, personality, and reflections. Every chat is assigned to exactly one profile via `ProfileManager.assignChat()`.

### What Is Profile-Scoped

| Component | Scoped By | Rationale |
|-----------|-----------|-----------|
| **Tier 2: Semantic Memory** | `profile_id` FK | Each profile accumulates its own facts, preferences, summaries, and procedures. An "Executive Assistant" profile should not see memories from a "Code Reviewer" profile. |
| **Tier 3: Meta Memory** | `profile_id` FK | Reflections and heuristics are derived from profile-specific Tier 2 entries. Mixing them would produce incoherent insights. |
| **External Memory** | `profile_id` FK | Reference documents are associated with the profile that uses them. |
| **Agent Identity** | `profile_id` FK | Each profile has its own role, expertise, tone, and instructions. |
| **Agent Personality** | `profile_id` FK | Each profile has its own communication calibration (6 dimensions). |

### What Is NOT Profile-Scoped

| Component | Scoped By | Rationale |
|-----------|-----------|-----------|
| **Tier 1: Working Memory** | `chat_id` | Raw message history belongs to the conversation, not the persona. If a chat is reassigned to a different profile, the messages stay. |
| **User Identity** | User-global (single row) | The user is the same person regardless of which agent profile they are talking to. |
| **User Personality** | User-global | Behavioral observations about the user apply universally. |

### How Scoping Works

When `buildAgentContext()` runs, it resolves the chat's profile via `ProfileManager.getChatProfile(chatId)` and passes the `profileId` to every downstream query. Tier 2, Tier 3, and External Memory queries all include `WHERE profile_id = $profileId`. Identity and personality lookups also filter by `profileId` (agent-side) or omit the filter (user-side, global).

The **consolidation job** (`MemoryConsolidationJob`) inherits `profileId` from each chat when creating Tier 2 summary entries. Since each chat maps to exactly one profile, the resulting d0 summaries and extracted facts automatically belong to the correct profile.

The **reflection job** (`MemoryReflectionJob`) now runs **per-profile**: it iterates all profiles for the user and generates Tier 3 meta entries scoped to each profile independently. A profile with insufficient Tier 2 data (below `minSemanticEntries`) is skipped.

---

## Context Assembly: buildAgentContext()

The `buildAgentContext()` method is the key function that assembles the agent's context from all memory stores. Called by the orchestrator before spawning an agent task.

### Injection Order

The order maximizes model attention where it matters most. Working Memory is placed **last** — closest to the task text — giving the model strongest recall of the current conversation.

```
1. Agent Identity + Personality     (~300 tokens, fixed)
2. User Identity + Personality      (~300 tokens, fixed)
3. Meta Memory                      (~500 tokens, Tier 3, high-confidence only)
4. Semantic Memory                  (~2K tokens, Tier 2, composite-scored)
5. External Memory                  (~1K tokens, CONDITIONAL — only if similarity > threshold)
6. Working Memory                   (~3K tokens, Tier 1, last N messages chronological)
```

**Total**: ~6.1K typical, ~7.1K with external documents, ~10K max (configurable via `contextTokenBudget`).

### Output Format

```xml
<context timezone="Europe/Helsinki" date="2026-04-06">
  <identity>
    <agent role="Executive assistant" tone="Professional but warm">
      <expertise>email management, calendar optimization</expertise>
      <instructions>Always draft emails before sending.</instructions>
    </agent>
    <agent_personality>
      <dim name="communication_style" confidence="0.85">Concise, uses bullet points.</dim>
      <dim name="boundaries" confidence="0.9">Never contact spouse.</dim>
    </agent_personality>
    <user name="Mark" role="CTO" org="Acme Corp" tz="Europe/Helsinki" lang="en" />
    <user_personality>
      <dim name="communication_style" confidence="0.7">Direct, prefers brevity.</dim>
      <dim name="work_patterns" confidence="0.6">Reviews email at 9am and 5pm.</dim>
    </user_personality>
  </identity>

  <!-- Hierarchical Cascade injection (ADR-052): strategic first, then evaluated, then observations -->
  <meta_memory>
    <!-- D2+: Strategic self-knowledge (weeks/months) — low similarity gate (0.3) -->
    <strategic type="insight" confidence="0.92" depth="2">
      Over 3 months, highest-value contributions shifted to email management.
    </strategic>
    <!-- D1: Evaluated patterns (daily/weekly) — moderate similarity gate (0.4) -->
    <evaluated type="heuristic" confidence="0.85">
      Email drafts accepted without edits 85% of time. Decision speed inversely
      correlates with stakeholder count.
    </evaluated>
    <!-- D0: Direct observations (per-session) — strict similarity gate (0.5) -->
    <observation type="insight" confidence="0.70">
      User delays budget decisions. Surface costs early.
    </observation>
  </meta_memory>

  <semantic_memory>
    <memory type="preference" importance="0.9" score="0.87">Prefers English for all comms.</memory>
    <memory type="instruction" importance="1.0" score="0.82">Always CC manager on budget.</memory>
    <memory type="summary" importance="0.7" score="0.75" depth="0">
      2026-04-05: Reviewed Q3 financials with CFO. Approved $50K increase.
    </memory>
    <memory type="procedure" importance="0.8" score="0.71">
      Budget flow: draft -> team review -> CFO sign-off
    </memory>
  </semantic_memory>

  <!-- Only present when external docs are relevant (similarity > 0.5) -->
  <external_memory>
    <entry source="document">Q3 Financial Summary: Revenue up 12% YoY...</entry>
  </external_memory>

  <working_memory>
    <message sender="Mark" time="2026-04-06 10:30">Reply to John about the budget</message>
    <message sender="assistant" time="2026-04-06 10:31">Done. He confirmed receipt.</message>
  </working_memory>
</context>
```

### Steps

1. **Resolve profile** — Look up the chat's assigned profile via `ProfileManager.getChatProfile(chatId)`. All subsequent queries use this `profileId`.
2. **Identity retrieval** — Query `agent_identity` and `agent_personality` (confidence >= threshold) filtered by `profileId`. Query `user_identity` and `user_personality` (confidence >= threshold) without profile filter (user-global).
3. **Meta retrieval** — Depends on `metaInjection.strategy` (default: `cascade`, see ADR-052):
   - **Cascade** (default): `queryMetaCascade()` — top-down hierarchical fetch. Fetches d2+ strategic entries first (low similarity gate), then d1 evaluated patterns (moderate gate), then d0 observations (strict gate). Each level has configurable slot count and minimum similarity. Results grouped in XML by depth level using `<strategic>`, `<evaluated>`, `<observation>` tags.
   - **Flat** (legacy): `queryMetaMemory()` — all depths compete in a single pool by composite score. Results use `<insight>`, `<heuristic>`, `<self_assessment>` tags.
4. **Semantic retrieval** — Embed task text, two-phase composite search over `memory_semantic` filtered by `profileId`
5. **External retrieval** — Embed task text, cosine search over `memory_external` filtered by `profileId`. If no results exceed `externalSimilarityThreshold` (default 0.5), skip the block entirely.
6. **Working memory** — Get last N messages from active session, chronological (scoped by `chatId`, not `profileId`)
7. **Update access counts** — Bump `last_accessed` and `access_count` for retrieved Tier 2/3 memories
8. **Format as XML** — Assemble structured XML block in injection order

---

## Composite Scoring Formula

### Parameters

| Symbol | Name | Default | Notes |
|--------|------|---------|-------|
| alpha | Similarity weight | 0.5 | Dominant factor — semantic relevance |
| beta | Recency weight | 0.3 | Time decay component |
| gamma | Importance/confidence weight | 0.2 | Static boost |
| lambda | Decay rate | 0.01 | Per day. e^(-0.01*7)=0.93 at 1 week, e^(-0.01*365)=0.03 at 1 year |

### Two-Phase Retrieval

**Phase 1 — HNSW candidate fetch** (sub-ms, index-accelerated):
```sql
SELECT *, 1 - (embedding <=> $1::vector) AS similarity
FROM memory_semantic
WHERE ($2::TEXT IS NULL OR memory_type = $2)
ORDER BY embedding <=> $1::vector
LIMIT $3  -- candidateMultiplier (3) * desired limit
```

**Phase 2 — Re-rank in TypeScript** (microseconds, in-memory):
```typescript
function compositeScore(
  similarity: number,
  lastAccessed: number,
  importance: number,
  w: { alpha: number; beta: number; gamma: number; lambda: number },
): number {
  const deltaDays = (Date.now() - lastAccessed) / 86_400_000;
  return (
    w.alpha * similarity +
    w.beta * Math.exp(-w.lambda * deltaDays) +
    w.gamma * importance
  );
}
```

Sort by compositeScore DESC, take top N.

### Tier-Specific Scoring

| Tier | Similarity | Recency | Third Factor | Formula |
|------|-----------|---------|-------------|---------|
| Tier 2 (Semantic) | Cosine (HNSW) | e^(-lambda*dt) on last_accessed | Importance (0-1) | alpha*sim + beta*recency + gamma*importance |
| Tier 3 (Meta) | Cosine (HNSW) | e^(-lambda*dt) on updated_at | Confidence (0-1) | alpha*sim + beta*recency + gamma*confidence |
| External | Cosine (HNSW) | None | None | Pure similarity, threshold-gated |
| Tier 1 (Working) | None | None | None | Chronological only |

---

## MCP Tools (On-Demand Memory Access)

The FlowHelm MCP server runs inside the orchestrator process and exposes memory, identity, profiles, skills, email, and admin tools to agent containers via 25 tools over a Unix domain socket. The UDS is bind-mounted into the agent container at `/workspace/ipc/memory.sock`.

The server resolves `profileId` at startup from the chat's assigned profile. All memory/identity tools use this `profileId` implicitly — queries are automatically scoped to the active profile without the agent needing to pass it. Profile management tools (13–15) let the agent inspect and switch profiles. Admin tools (16–22) provide self-service skill management, config updates, and system status. Meta DAG tools (23–25) provide deep memory introspection. This doc covers the 15 memory/identity/profile tools and the 3 meta DAG tools. See `docs/architecture.md` for the full 25-tool list including admin and email tools.

Pre-task context injection provides the agent with ~10K tokens of relevant context. On-demand MCP tools let the agent query the full database when it needs more. The agent decides when to query — the orchestrator doesn't guess.

### Tool Reference

| # | Tool | Parameters | Returns | Use Case |
|---|------|-----------|---------|----------|
| 1 | `search_semantic` | `query`, `type?`, `limit?` | Composite-scored Tier 2 entries | "What preferences does the user have about emails?" |
| 2 | `search_external` | `query`, `source?`, `limit?` | Similarity-ranked external entries | "What does the company vacation policy say?" |
| 3 | `recall_conversation` | `chat_id?`, `session_id?`, `limit?` | Chronological messages | "What did the user say earlier today?" |
| 4 | `store_semantic` | `content`, `type`, `importance?` | Stored entry ID | Agent captures a new fact mid-task |
| 5 | `get_memory_stats` | (none) | Counts by type across all tiers | Agent checks memory state |
| 6 | `expand_memory` | `memory_id` | Source messages or child summaries | Drill into a compressed T2 summary |
| 7 | `search_meta` | `query`, `type?`, `limit?`, `min_depth?`, `max_depth?` | Confidence-scored, depth-filtered Tier 3 entries | "What insights do I have about this user?" |
| 8 | `expand_meta` | `meta_id` | Source entries (T2 for d0, child metas for d1+) | Drill into a meta entry's DAG sources |
| 9 | `trace_to_source` | `meta_id` | Full T2 semantic evidence chain | Traverse full DAG from strategic insight to source facts |
| 10 | `get_identity` | (none) | Agent + user identity and personality | Full identity snapshot |
| 11 | `observe_personality` | `dimension`, `observation` | Updated entry | Agent calibrates agent personality |
| 12 | `observe_user` | `dimension`, `observation` | Updated entry | Agent records user behavioral pattern |
| 13 | `propose_identity_update` | `field`, `new_value`, `reason` | Proposal ID | Agent suggests identity change (needs confirmation) |
| 14 | `update_user_identity` | `field`, `value` | Updated entry | Agent updates user identity from conversation |
| 15 | `list_profiles` | (none) | All profiles for user | Agent discovers available profiles |
| 16 | `get_current_profile` | (none) | Active profile details | Agent checks which profile is active for this chat |
| 17 | `switch_chat_profile` | `profile_id` | Updated assignment | Agent reassigns chat to a different profile |

### Tool Details

**`search_semantic`** — Two-phase retrieval with composite scoring. Returns entries with similarity, recency, and compositeScore fields. The `type` parameter filters by `SemanticMemoryType` (preference, fact, pattern, contact, instruction, summary, procedure). Default limit 10, max 50.

**`search_external`** — Pure cosine similarity over `memory_external`. Only returns results above the similarity threshold. Default limit 5, max 50.

**`recall_conversation`** — Chronological retrieval from `memory_working` table. No embedding needed — direct query by chat_id or session_id, ordered by timestamp. Default limit 20, max 100.

**`store_semantic`** — Creates a new entry in `memory_semantic`. The orchestrator generates the embedding and stores it. The `source_session` is automatically set to the current session. Allows the agent to capture insights in real-time during task execution. Content validated (non-empty, max 2000 characters). Type must be a valid `SemanticMemoryType`.

**`expand_memory`** — The LCM-inspired drill-down tool. Given a semantic memory ID (specifically a `summary` type entry):
- For depth=0 summaries: returns the original source messages (via `summary_message_sources`)
- For depth=1+ summaries: returns the child summary entries (via `summary_parent_sources`)
This is how the agent recovers detail from compressed conversation history. Default max_tokens 2000, max 4000.

**`search_meta`** — Two-phase retrieval over Tier 3 with composite scoring (using confidence instead of importance). Filter by `MetaMemoryType` (insight, heuristic, self_assessment) and depth range (`min_depth`, `max_depth`). Default limit 5, max 20. Returns `depth` field on each result.

**`expand_meta`** — T3 DAG drill-down tool. Given a meta memory ID: for depth=0 entries, returns the source T2 semantic entries (via `memory_meta_sources`). For depth>0 entries, returns the child meta entries that were condensed into it (via `meta_parent_sources`).

**`trace_to_source`** — Recursive DAG traversal from any T3 meta entry all the way down to its source T2 semantic entries. Traverses through all intermediate depth levels, deduplicating shared sources. Provides full provenance for any strategic insight.

**`get_identity`** — Returns the full identity snapshot: agent identity (role, expertise, tone, instructions), agent personality (all dimensions above threshold), user identity (all fields), user personality (all dimensions above threshold). No parameters. ~16ms round-trip.

**`observe_personality`** — Agent records an observation about an agent personality dimension. Dimension must be one of the 6 fixed dimensions. The observation is stored as the new content, and confidence is updated using the asymptotic growth formula. If the dimension doesn't exist yet, it's created.

**`observe_user`** — Same as `observe_personality` but for user personality dimensions. Source is set to `inferred`.

**`propose_identity_update`** — Agent proposes a change to `agent_identity` (field must be role, expertise, tone, or instructions). The proposal is stored and surfaced to the user for confirmation via the channel adapter. The agent cannot unilaterally change its own identity.

**`update_user_identity`** — Agent updates `user_identity` fields discovered during conversation (e.g., user mentions they changed roles). Field must be one of: name, role, organization, timezone, language, notes.

**`list_profiles`** — Returns all agent profiles for the current user: id, name, description, and whether each is the default. No parameters.

**`get_current_profile`** — Returns the profile currently assigned to this chat, including its identity and personality snapshot.

**`switch_chat_profile`** — Reassigns the current chat to a different profile. The MCP server updates its internal `profileId` so subsequent tool calls (search, store, identity) automatically scope to the new profile. Existing Tier 1 messages remain in the chat (they are chat-scoped, not profile-scoped).

### Data Flow (On-Demand Query)

```
Agent (container)          Orchestrator
  |                        |
  | MCP call: search_semantic
  | { query: "..." } --UDS-> 1. Embed query (~15ms)
  |                        2. pgvector cosine search (<1ms)
  |                        3. Two-phase re-rank (~0.01ms)
  |                        4. Format results
  | <-----UDS-----
  | Results: [...]
```

Total round-trip: ~16ms per query.

### Security

- The MCP server queries only the current user's PostgreSQL database — cross-user access is impossible (separate PG containers per user)
- The UDS is scoped to the user's home directory, mounted into only that user's containers
- `store_semantic` writes include `source_session` for auditability
- Rate limiting prevents exhaustive database enumeration
- The agent cannot modify or delete existing semantic memories via MCP tools (only the orchestrator does that during consolidation)
- `propose_identity_update` requires user confirmation — the agent cannot change its own identity unilaterally

---

## Embedding Providers

### TransformersEmbeddingProvider (Default)

- **Model**: `Xenova/all-MiniLM-L6-v2`
- **Dimensions**: 384
- **Latency**: ~15ms per embedding on CPU
- **Size**: ~80 MB (downloaded once, cached locally)
- **Library**: `@huggingface/transformers` (ONNX runtime)
- **Cost**: Free, offline-capable
- **Lazy loading**: Model downloaded on first use, subsequent loads from cache

### OpenAIEmbeddingProvider (Optional)

- **Model**: `text-embedding-3-small` (configurable)
- **Dimensions**: Configurable (default 384 for compatibility)
- **Latency**: ~200ms (network)
- **Cost**: $0.02 per 1M tokens
- **Use case**: Higher quality embeddings when network latency is acceptable
- **Routing**: API calls go through the credential proxy for key injection

### Factory

```typescript
function createEmbeddingProvider(config: EmbeddingProviderConfig): EmbeddingProvider {
  switch (config.provider) {
    case 'transformers': return new TransformersEmbeddingProvider(config);
    case 'openai': return new OpenAIEmbeddingProvider(config);
  }
}
```

---

## MemoryProvider (Containerized LLM Interface)

The orchestrator needs LLM access for non-agentic operations (prompt → completion) used by `MemoryConsolidationJob` and `MemoryReflectionJob`:
- Session summarization (d0 generation)
- Summary condensation (d1+ generation)
- Fact extraction from session chunks
- Reflection generation (Tier 3)

```typescript
interface MemorySummarizationProvider {
  summarize(content: string, options: {
    model: string;
    maxTokens: number;
    systemPrompt: string;
  }): Promise<string>;
}
```

**Single implementation** — `MemoryProvider` — always containerized, regardless of the user's agent runtime mode:

| Implementation | How it works | Container? |
|---|---|---|
| `MemoryProvider` | Starts a fresh dedicated Podman container (`flowhelm-memory-{username}`), runs `claude -p --model <model> --output-format text`, captures stdout. Proxy handles credential injection (MITM with placeholders, or direct OAuth/API key forwarding). | Yes (quick, 10s close) |

**Credential injection** (ADR-053): `CliSummarizationProvider` supports both MITM proxy and direct token forwarding. When a CA cert path is configured, the summarization container gets the same MITM setup as user agent containers — placeholder credentials, CA cert mount, `NODE_EXTRA_CA_CERTS`. Without MITM, it falls back to forwarding `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` directly as environment variables. This ensures consolidation and reflection jobs work under both subscription OAuth and API key authentication.

**Key invariant**: The orchestrator never holds credentials. All LLM calls for memory jobs go through a dedicated container routed via the credential proxy.

**Container naming for housekeeping jobs**:

| Purpose | Container name | Lifecycle |
|---|---|---|
| User task | `flowhelm-agent-{username}-{taskid}` | Warm, 60min idle timeout |
| Memory jobs (consolidation + reflection) | `flowhelm-memory-{username}` | Quick, 10s close delay |

Default model: Haiku (cost-efficient for summarization tasks). Configurable independently for consolidation and reflection — users may set Opus for reflection while keeping Haiku for consolidation.

---

## Configuration

All memory configuration lives under the `memory` key in the FlowHelm config:

```yaml
memory:
  # Embedding provider
  embeddingProvider: transformers        # 'transformers' (free, local) or 'openai'
  embeddingModel: Xenova/all-MiniLM-L6-v2
  embeddingDimensions: 384

  # Context limits
  workingMemoryLimit: 20               # Max Tier 1 messages per context build
  semanticMemoryLimit: 20              # Max Tier 2 entries per context build
  metaMemoryLimit: 5                   # Max Tier 3 entries per context build
  externalMemoryLimit: 10              # Max External Memory entries per context build
  externalSimilarityThreshold: 0.5     # Min similarity for External Memory injection
  contextTokenBudget: 10000            # Total context token budget

  # Scheduled consolidation job (Tier 1 → Tier 2, LCM-inspired)
  consolidation:
    enabled: true
    schedule: '0 */6 * * *'           # Cron expression (default: every 6 hours)
    consolidationModel: claude-haiku-4-5-20251001  # Configurable model
    minUnconsolidatedMessages: 20      # Skip if below threshold
    chunkSize: 10                      # Messages per d0 summary chunk
    consolidationThreshold: 5          # d0 count before d1 condensation
    d0MaxTokens: 400
    d1MaxTokens: 500

  # Composite scoring weights
  scoring:
    alpha: 0.5                         # Similarity weight
    beta: 0.3                          # Recency weight
    gamma: 0.2                         # Importance/confidence weight
    lambda: 0.01                       # Decay rate (per day)
    candidateMultiplier: 3             # HNSW oversampling for re-ranking

  # Scheduled reflection job (Tier 2 → Tier 3, Recursive Metacognitive DAG)
  reflection:
    enabled: true                      # Enabled by default; set false to opt out
    schedule: '0 3 * * *'             # Cron expression (default: daily 3 AM)
    reflectionModel: claude-haiku-4-5-20251001  # Configurable (could be opus)
    maxInputTokens: 4000
    minSemanticEntries: 10             # Min new entries before triggering
    confidenceThreshold: 0.3           # Min confidence for context injection
    metaCondensationThreshold: 5       # Min uncondensed d0 metas before d1 condensation
    d1MetaMaxTokens: 400               # Max tokens for d1 meta synthesis
    d2MetaMaxTokens: 300               # Max tokens for d2+ meta synthesis
    maxMetaDepth: 3                    # Max depth level (0-indexed: 0/1/2/3)
    contradictionCascade: true         # Enable cascade re-evaluation on contradiction

  # Hierarchical Cascade context injection (ADR-052)
  metaInjection:
    strategy: cascade                  # 'cascade' (top-down hierarchical) or 'flat' (legacy single-pool)
    d2MinSimilarity: 0.3              # Low gate — strategic insights surface broadly
    d1MinSimilarity: 0.4              # Moderate gate — evaluated patterns need relevance
    d0MinSimilarity: 0.5              # Strict gate — observations compete on merit
    d2Slots: 2                         # Max d2+ entries in context
    d1Slots: 2                         # Max d1 entries in context
    d0Slots: 1                         # Max d0 entries in context

  # Identity layer
  identity:
    personalityConfidenceThreshold: 0.4
    userPersonalityConfidenceThreshold: 0.4
```

---

## Failure Modes

**Embedding provider failure**: If the model fails to load (missing file, corrupted download), `storeMemory()` and `queryMemory()` will throw. The orchestrator catches this and falls back to running the agent without memory context, then alerts the user.

**Summarization provider failure**: If the LLM call fails during consolidation (CLI container crash, API timeout, rate limit), the session's messages remain unconsolidated. The next scheduled consolidation run retries. Messages are never lost — they stay in `memory_working` regardless of consolidation status.

**HNSW index degradation**: At per-user scale (hundreds to tens of thousands of entries), HNSW maintains sub-millisecond performance. Index rebuild is automatic during PostgreSQL VACUUM.

**Session loss**: If the orchestrator crashes mid-session, the session remains in `sessions` with `ended_at IS NULL`. On restart, these are marked as ended. The next scheduled consolidation run processes them.

**Reflection job failure**: If the reflection job fails, it logs the error and retries at the next scheduled run. No meta memories are created for that run. The agent continues functioning with existing meta memories.

---

## Comparison with Alternative Approaches

### vs. FLOWHELM.md (brute-force plaintext)

| Metric | FLOWHELM.md | FlowHelm Memory |
|---|---|---|
| Tokens at 50 notes | ~1,500 | ~1,500 |
| Tokens at 500 notes | ~15,000 | ~5,000 |
| Tokens at 5,000 notes | ~150,000 | ~5,000 |
| Retrieval method | None (dump all) | Semantic similarity + recency decay |
| Agent drill-down | Read the file | 25 MCP tools |
| Cross-session context | None | Hierarchical DAG summaries |
| Fact extraction | None | Automatic (orchestrator pipeline) |
| Agent self-improvement | None | Meta memory reflection |

### vs. LCM (Lossless Context Management)

FlowHelm's memory is inspired by the LCM paper (Voltropy, 2026, MIT license) but diverges significantly:

| Aspect | LCM | FlowHelm |
|---|---|---|
| Storage | SQLite + FTS5 | PostgreSQL + pgvector |
| Search | Regex / full-text | HNSW vector similarity |
| Fact extraction | None — only compresses | Extracts structured facts into Semantic Memory |
| Meta-cognition | None | Tier 3 with recursive DAG (d0→d1→d2+) |
| Identity | None | 4-table identity system |
| Scoring | BM25-lite for eviction | Composite (similarity + recency + importance) |
| Separate digest layer | Yes (separate table) | No — summaries live in Tier 2 with depth field |
| Multi-tenant | No | Per-user PostgreSQL containers |
| Trigger | Context window fill | Scheduled batch jobs (cron) |

**What we adopted from LCM**: Hierarchical DAG summarization with full traceability, immutable message store, agent drill-down tools, depth-aware summarization prompts.

**What we do differently**: Vector search for retrieval, structured fact extraction, recursive metacognitive DAG (hierarchical Tier 3 with monitoring→evaluation→regulation depth levels), identity modeling, composite scoring, full cross-tier DAG traceability from T3 d2 to T1 messages, confidence propagation and contradiction cascade across depth levels, PostgreSQL + pgvector, scheduled batch consolidation (not session-end triggered), dual-runtime LLM dispatch.

### vs. All Known AI Memory Systems

No existing AI memory system implements hierarchical metacognition with full DAG traceability:

| System | Tiers | Internal DAG | Cross-Tier DAG | Meta-Cognition | Hierarchical Meta |
|---|---|---|---|---|---|
| Mem0 | 1 (flat KV) | No | N/A | No | No |
| Letta (MemGPT) | 2 (core + archival) | No | No | No | No |
| LCM (Voltropy) | 1 + digest | Yes (T2 only) | N/A | No | No |
| Zep | 1 + entities | No | No | No | No |
| **FlowHelm** | **3** | **Both T2 and T3** | **Full (T1→T2→T3)** | **Yes** | **Yes (d0→d1→d2+)** |

FlowHelm is the first system where a strategic self-assessment (T3 d2) is traceable through evaluated patterns (T3 d1) → direct observations (T3 d0) → semantic facts (T2) → session summaries (T2 d0) → raw messages (T1). Six levels of abstraction, all traversable.

---

## Files

| File | Contents |
|---|---|
| `src/orchestrator/memory.ts` | `MemoryManager` class: all tiers, composite scoring, hierarchical summarization, `buildAgentContext()`, session management, consolidation |
| `src/orchestrator/identity.ts` | `IdentityManager` class: CRUD for agent/user identity and personality, confidence model, `buildIdentityContext()` |
| `src/orchestrator/scoring.ts` | Composite scoring pure functions: `compositeScore()`, two-phase re-ranking |
| `src/orchestrator/memory-provider.ts` | `MemoryProvider`: containerized LLM dispatch for memory jobs (`flowhelm-memory-{username}`), credential injection via MITM proxy or direct token forwarding (ADR-031, ADR-053) |
| `src/orchestrator/consolidation.ts` | `MemoryConsolidationJob`: scheduled Tier 1 → Tier 2 (d0 summarization, fact extraction, d1+ condensation) |
| `src/orchestrator/reflection.ts` | `MemoryReflectionJob`: three-phase depth-aware pipeline (d0 generation, d1/d2+ condensation, contradiction cascade), scheduled Tier 2 → Tier 3 (ADR-051) |
| `src/orchestrator/embeddings.ts` | `TransformersEmbeddingProvider`, `OpenAIEmbeddingProvider`, `createEmbeddingProvider()` factory |
| `src/orchestrator/mcp-server.ts` | MCP server exposing 25 tools over UDS (15 memory/identity/profile + 7 admin/self-service + 3 meta DAG: expand_meta, trace_to_source, updated search_meta). See ADR-023, ADR-024, ADR-033, ADR-051 |
| `src/orchestrator/profile-manager.ts` | `ProfileManager`: agent profile CRUD, clone, chat assignment, default management (ADR-034) |
| `src/orchestrator/types.ts` | `SemanticMemoryEntry`, `MetaMemoryEntry`, `ExternalMemoryEntry`, `AgentIdentity`, `AgentPersonalityEntry`, `UserIdentity`, `UserPersonalityEntry`, `AgentProfile`, scoring types |
| `src/orchestrator/schema.sql` | PostgreSQL schema: `memory_working`, `memory_semantic`, `memory_meta` (with `depth`), `memory_external`, `summary_message_sources`, `summary_parent_sources`, `memory_meta_sources`, `meta_parent_sources` (T3 internal DAG), `agent_identity`, `agent_personality`, `user_identity`, `user_personality` |
| `src/config/schema.ts` | Zod schema for `memory` config section (consolidation, scoring, reflection, identity sub-schemas) |
