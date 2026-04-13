/**
 * MemoryConsolidationJob: scheduled batch job for Tier 1 → Tier 2.
 *
 * Processes ended sessions: generates d0 summaries, extracts structured facts,
 * and condenses d1+ summaries when enough d0 accumulate. Nothing is ever lost —
 * all summaries link back to source messages via DAG join tables.
 *
 * Dispatch via MemorySummarizationProvider (CLI or SDK runtime).
 * See ADR-028 and ADR-031.
 */

import type { Sql } from 'postgres';
import type {
  MemorySummarizationProvider,
  EmbeddingProvider,
  Startable,
  SemanticMemoryType,
} from './types.js';

// ─── Configuration ────────────────────────────────────────────────────────

export interface ConsolidationConfig {
  enabled: boolean;
  schedule: string;
  consolidationModel: string;
  minUnconsolidatedMessages: number;
  chunkSize: number;
  consolidationThreshold: number;
  d0MaxTokens: number;
  d1MaxTokens: number;
}

export interface ConsolidationJobOptions {
  sql: Sql;
  summarizationProvider: MemorySummarizationProvider;
  embeddingProvider: EmbeddingProvider;
  config: ConsolidationConfig;
}

// ─── Prompts ──────────────────────────────────────────────────────────────

const D0_SYSTEM_PROMPT = `You are a memory consolidation system. Summarize the following conversation messages into a concise summary.
Preserve: key decisions, action items, facts, names, dates, commitments.
Omit: greetings, filler, deliberation that led to a final decision (keep only the decision).
Output a single paragraph, max 300 tokens. Be factual and precise.`;

const D1_SYSTEM_PROMPT = `You are a memory condensation system. Condense the following session summaries into a higher-level overview.
Preserve: final decisions, outcomes, lasting facts, hard constraints.
Omit: intermediate reasoning, superseded plans, details already captured as individual facts.
Output a single paragraph, max 400 tokens. Focus on durable context.`;

const FACT_EXTRACTION_SYSTEM_PROMPT = `Extract structured facts from the following conversation summary.
Return a JSON array of objects, each with:
- "content": the fact as a concise sentence
- "type": one of "preference", "fact", "pattern", "contact", "instruction", "procedure"
- "importance": a number from 0.0 to 1.0

Only extract facts that are worth remembering long-term. Return [] if none.
Output ONLY valid JSON, no markdown fences.`;

// ─── Extracted Fact ───────────────────────────────────────────────────────

interface ExtractedFact {
  content: string;
  type: SemanticMemoryType;
  importance: number;
}

// ─── MemoryConsolidationJob ───────────────────────────────────────────────

export class MemoryConsolidationJob implements Startable {
  private readonly sql: Sql;
  private readonly provider: MemorySummarizationProvider;
  private readonly embedding: EmbeddingProvider;
  private readonly config: ConsolidationConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(options: ConsolidationJobOptions) {
    this.sql = options.sql;
    this.provider = options.summarizationProvider;
    this.embedding = options.embeddingProvider;
    this.config = options.config;
  }

  async start(): Promise<void> {
    if (!this.config.enabled) return;

    // Run once at startup if needed, then on schedule
    // For now, schedule is managed by the orchestrator via setInterval
    // (cron parsing deferred to orchestrator integration)
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Wait for any in-progress run to complete
    while (this.running) {
      await sleep(100);
    }
  }

  /** Run a single consolidation pass. Returns number of sessions processed. */
  async run(): Promise<number> {
    if (this.running) return 0;
    this.running = true;

    try {
      // Check if enough unconsolidated messages exist
      const countResult = await this.sql`
        SELECT COUNT(*) AS cnt FROM memory_working mw
        JOIN sessions s ON mw.session_id = s.id
        WHERE s.ended_at IS NOT NULL
          AND mw.session_id NOT IN (
            SELECT DISTINCT s2.id FROM sessions s2
            JOIN memory_working mw2 ON mw2.session_id = s2.id
            JOIN summary_message_sources sms ON sms.message_id = mw2.id AND sms.chat_id = mw2.chat_id
          )
      `;
      const unconsolidatedCount = Number(countResult[0]?.cnt ?? 0);
      if (unconsolidatedCount < this.config.minUnconsolidatedMessages) {
        return 0;
      }

      // Find ended sessions with unconsolidated messages
      const sessions = await this.sql`
        SELECT DISTINCT s.id AS session_id, s.chat_id
        FROM sessions s
        JOIN memory_working mw ON mw.session_id = s.id
        WHERE s.ended_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM summary_message_sources sms
            WHERE sms.message_id = mw.id AND sms.chat_id = mw.chat_id
          )
        ORDER BY s.id
      `;

      let processed = 0;
      for (const session of sessions) {
        await this.consolidateSession(session.session_id as string, session.chat_id as string);
        processed++;
      }

      // Update last consolidation timestamp
      await this.sql`
        INSERT INTO state (key, value) VALUES ('last_consolidation_at', ${String(Date.now())})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
      `;

      // Check for d1 condensation opportunities
      await this.condenseIfReady();

      return processed;
    } finally {
      this.running = false;
    }
  }

  /** Resolve the profile for a chat. */
  private async getProfileIdForChat(chatId: string): Promise<string> {
    const rows = await this.sql`
      SELECT profile_id FROM chats WHERE id = ${chatId}
    `;
    const row = rows[0];
    if (!row) throw new Error(`Chat not found: ${chatId}`);
    return row.profile_id as string;
  }

  /** Generate d0 summaries for a single session. */
  private async consolidateSession(sessionId: string, chatId: string): Promise<void> {
    // Fetch unconsolidated messages for this session
    const messages = await this.sql`
      SELECT mw.id, mw.chat_id, mw.sender_name, mw.content, mw.timestamp, mw.is_bot_message
      FROM memory_working mw
      WHERE mw.session_id = ${sessionId}
        AND NOT EXISTS (
          SELECT 1 FROM summary_message_sources sms
          WHERE sms.message_id = mw.id AND sms.chat_id = mw.chat_id
        )
      ORDER BY mw.timestamp ASC
    `;

    if (messages.length === 0) return;

    // Resolve profile from chat
    const profileId = await this.getProfileIdForChat(chatId);

    // Chunk messages
    const chunks = chunkArray(messages, this.config.chunkSize);

    for (const chunk of chunks) {
      // Format messages for summarization
      const formatted = chunk
        .map((m) => {
          const sender = m.is_bot_message ? 'assistant' : (m.sender_name as string);
          return `[${sender}]: ${(m.content as string) ?? '(no text)'}`;
        })
        .join('\n');

      // Generate d0 summary
      const summary = await this.provider.summarize(formatted, {
        model: this.config.consolidationModel,
        maxTokens: this.config.d0MaxTokens,
        systemPrompt: D0_SYSTEM_PROMPT,
      });

      // Embed and store the summary
      const embedding = await this.embedding.embed(summary);
      const now = Date.now();
      const earliestAt = Number(chunk[0]?.timestamp);
      const latestAt = Number(chunk[chunk.length - 1]?.timestamp);
      const tokenCount = estimateTokens(summary);

      const summaryRows = await this.sql`
        INSERT INTO memory_semantic
          (content, embedding, memory_type, importance, depth, token_count,
           source_session, profile_id, earliest_at, latest_at, created_at, updated_at, last_accessed, access_count)
        VALUES (${summary}, ${toVectorLiteral(embedding)}::vector, 'summary', ${0.7}, ${0},
                ${tokenCount}, ${sessionId}, ${profileId}, ${earliestAt}, ${latestAt},
                ${now}, ${now}, ${now}, ${0})
        RETURNING id
      `;

      const summaryId = summaryRows[0]?.id as string;

      // Link to source messages via DAG join table
      for (const msg of chunk) {
        await this.sql`
          INSERT INTO summary_message_sources (summary_id, message_id, chat_id)
          VALUES (${summaryId}, ${msg.id as string}, ${msg.chat_id as string})
        `;
      }

      // Extract structured facts
      await this.extractFacts(formatted, sessionId, profileId);
    }
  }

  /** Extract structured facts from a message chunk and store them. */
  private async extractFacts(
    formattedMessages: string,
    sessionId: string,
    profileId: string,
  ): Promise<void> {
    try {
      const result = await this.provider.summarize(formattedMessages, {
        model: this.config.consolidationModel,
        maxTokens: 500,
        systemPrompt: FACT_EXTRACTION_SYSTEM_PROMPT,
      });

      const facts = JSON.parse(result) as ExtractedFact[];
      if (!Array.isArray(facts)) return;

      const now = Date.now();
      for (const fact of facts) {
        if (!fact.content || !fact.type) continue;
        const importance = Math.max(0, Math.min(1, fact.importance ?? 0.5));
        const embedding = await this.embedding.embed(fact.content);
        const tokenCount = estimateTokens(fact.content);

        await this.sql`
          INSERT INTO memory_semantic
            (content, embedding, memory_type, importance, depth, token_count,
             source_session, profile_id, created_at, updated_at, last_accessed, access_count)
          VALUES (${fact.content}, ${toVectorLiteral(embedding)}::vector, ${fact.type},
                  ${importance}, ${0}, ${tokenCount}, ${sessionId}, ${profileId},
                  ${now}, ${now}, ${now}, ${0})
        `;
      }
    } catch {
      // Fact extraction is best-effort; continue on parse errors
    }
  }

  /** Condense d0 summaries into d1+ when enough accumulate per chat. */
  private async condenseIfReady(): Promise<void> {
    // Find chats with enough d0 summaries that aren't yet condensed
    const candidates = await this.sql`
      SELECT ms.source_session, s.chat_id, COUNT(*) AS d0_count
      FROM memory_semantic ms
      JOIN sessions s ON ms.source_session = s.id
      WHERE ms.memory_type = 'summary' AND ms.depth = 0
        AND ms.id NOT IN (SELECT child_id FROM summary_parent_sources)
      GROUP BY ms.source_session, s.chat_id
      HAVING COUNT(*) >= ${this.config.consolidationThreshold}
    `;

    for (const candidate of candidates) {
      await this.condenseSummaries(candidate.chat_id as string);
    }
  }

  /** Condense depth-0 summaries for a chat into a depth-1 summary. */
  private async condenseSummaries(chatId: string): Promise<void> {
    const profileId = await this.getProfileIdForChat(chatId);

    // Get uncondensed d0 summaries for this chat
    const d0Summaries = await this.sql`
      SELECT ms.id, ms.content, ms.earliest_at, ms.latest_at
      FROM memory_semantic ms
      JOIN sessions s ON ms.source_session = s.id
      WHERE s.chat_id = ${chatId}
        AND ms.memory_type = 'summary'
        AND ms.depth = 0
        AND ms.id NOT IN (SELECT child_id FROM summary_parent_sources)
      ORDER BY ms.earliest_at ASC
    `;

    if (d0Summaries.length < this.config.consolidationThreshold) return;

    const formatted = d0Summaries
      .map((s, i) => `[Summary ${i + 1}]: ${s.content as string}`)
      .join('\n\n');

    const condensed = await this.provider.summarize(formatted, {
      model: this.config.consolidationModel,
      maxTokens: this.config.d1MaxTokens,
      systemPrompt: D1_SYSTEM_PROMPT,
    });

    const embedding = await this.embedding.embed(condensed);
    const now = Date.now();
    const earliestAt = Number(d0Summaries[0]?.earliest_at);
    const latestAt = Number(d0Summaries[d0Summaries.length - 1]?.latest_at);
    const tokenCount = estimateTokens(condensed);

    const parentRows = await this.sql`
      INSERT INTO memory_semantic
        (content, embedding, memory_type, importance, depth, token_count,
         profile_id, earliest_at, latest_at, created_at, updated_at, last_accessed, access_count)
      VALUES (${condensed}, ${toVectorLiteral(embedding)}::vector, 'summary', ${0.7}, ${1},
              ${tokenCount}, ${profileId}, ${earliestAt}, ${latestAt},
              ${now}, ${now}, ${now}, ${0})
      RETURNING id
    `;

    const parentId = parentRows[0]?.id as string;

    // Link to child d0 summaries via DAG join table
    for (const child of d0Summaries) {
      await this.sql`
        INSERT INTO summary_parent_sources (parent_id, child_id)
        VALUES (${parentId}, ${child.id as string})
      `;
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/** Format a number[] embedding for pgvector insertion. */
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

function estimateTokens(text: string): number {
  // Rough estimate: ~4 characters per token
  return Math.ceil(text.length / 4);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
