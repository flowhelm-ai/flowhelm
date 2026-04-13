/**
 * Cognitive memory manager — four-tier architecture.
 *
 * Tier 1 Working Memory: raw messages (chronological, immutable).
 * Tier 2 Semantic Memory: facts, preferences, summaries (composite-scored).
 * Tier 3 Meta Memory: agent-synthesized reflections (composite-scored).
 * External Memory: documents and user-provided references (cosine-gated).
 *
 * `buildAgentContext()` assembles ~6-10K tokens of context per task
 * in injection order: Identity → Meta → Semantic → External → Working.
 *
 * See ADR-019, ADR-028, ADR-029, docs/memory.md.
 */

import type { Sql } from './connection.js';
import type {
  EmbeddingProvider,
  SemanticMemoryType,
  SemanticMemoryEntry,
  MetaMemoryType,
  MetaMemoryEntry,
  ExternalMemorySource,
  ExternalMemoryEntry,
  Session,
  SemanticQueryResult,
  MetaQueryResult,
  ExternalQueryResult,
  ScoringWeights,
  Startable,
} from './types.js';
import type { MessageRow } from './database.js';
import type { IdentityManager, IdentityThresholds } from './identity.js';
import type { ProfileManager } from './profile-manager.js';
import { rankByCompositeScore, DEFAULT_SCORING_WEIGHTS } from './scoring.js';

// ─── Options ──────────────────────────────────────────────────────────────

export interface MetaInjectionConfig {
  strategy: 'cascade' | 'flat';
  d2MinSimilarity: number;
  d1MinSimilarity: number;
  d0MinSimilarity: number;
  d2Slots: number;
  d1Slots: number;
  d0Slots: number;
}

const DEFAULT_META_INJECTION: MetaInjectionConfig = {
  strategy: 'cascade',
  d2MinSimilarity: 0.3,
  d1MinSimilarity: 0.4,
  d0MinSimilarity: 0.5,
  d2Slots: 2,
  d1Slots: 2,
  d0Slots: 1,
};

export interface MemoryManagerOptions {
  sql: Sql;
  embeddingProvider: EmbeddingProvider;
  identityManager: IdentityManager;
  profileManager: ProfileManager;
  workingMemoryLimit?: number;
  semanticMemoryLimit?: number;
  metaMemoryLimit?: number;
  externalMemoryLimit?: number;
  externalSimilarityThreshold?: number;
  scoringWeights?: Partial<ScoringWeights>;
  candidateMultiplier?: number;
  identityThresholds?: Partial<IdentityThresholds>;
  metaInjection?: Partial<MetaInjectionConfig>;
}

export interface StoreSemanticOptions {
  content: string;
  memoryType: SemanticMemoryType;
  importance?: number;
  sourceSession?: string;
  depth?: number;
  profileId: string;
}

export interface QuerySemanticOptions {
  memoryType?: SemanticMemoryType;
  limit?: number;
}

export interface StoreExternalOptions {
  content: string;
  sourceType: ExternalMemorySource;
  sourceRef: string;
  profileId: string;
}

// ─── Memory Manager ───────────────────────────────────────────────────────

export class MemoryManager implements Startable {
  private readonly sql: Sql;
  private readonly embedding: EmbeddingProvider;
  private readonly identity: IdentityManager;
  private readonly profiles: ProfileManager;
  private readonly workingMemoryLimit: number;
  private readonly semanticMemoryLimit: number;
  private readonly metaMemoryLimit: number;
  private readonly externalMemoryLimit: number;
  private readonly externalSimilarityThreshold: number;
  private readonly scoringWeights: ScoringWeights;
  private readonly candidateMultiplier: number;
  private readonly identityThresholds: IdentityThresholds;
  private readonly metaInjection: MetaInjectionConfig;
  private started = false;

  constructor(options: MemoryManagerOptions) {
    this.sql = options.sql;
    this.embedding = options.embeddingProvider;
    this.identity = options.identityManager;
    this.profiles = options.profileManager;
    this.workingMemoryLimit = options.workingMemoryLimit ?? 20;
    this.semanticMemoryLimit = options.semanticMemoryLimit ?? 20;
    this.metaMemoryLimit = options.metaMemoryLimit ?? 5;
    this.externalMemoryLimit = options.externalMemoryLimit ?? 10;
    this.externalSimilarityThreshold = options.externalSimilarityThreshold ?? 0.5;
    this.scoringWeights = { ...DEFAULT_SCORING_WEIGHTS, ...options.scoringWeights };
    this.candidateMultiplier = options.candidateMultiplier ?? 3;
    this.identityThresholds = {
      personalityConfidenceThreshold: 0.4,
      userPersonalityConfidenceThreshold: 0.4,
      ...options.identityThresholds,
    };
    this.metaInjection = { ...DEFAULT_META_INJECTION, ...options.metaInjection };
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  private ensureStarted(): void {
    if (!this.started) throw new Error('MemoryManager not started');
  }

  // ── Tier 2: Semantic Memory ─────────────────────────────────────────────

  async storeSemanticMemory(options: StoreSemanticOptions): Promise<string> {
    this.ensureStarted();
    const vector = await this.embedding.embed(options.content);
    const now = Date.now();
    const tokenCount = estimateTokens(options.content);
    const vectorStr = `[${vector.join(',')}]`;

    const rows = await this.sql<[{ id: string }]>`
      INSERT INTO memory_semantic
        (content, embedding, memory_type, importance, depth, token_count,
         source_session, profile_id, created_at, updated_at, last_accessed, access_count)
      VALUES (
        ${options.content}, ${vectorStr}::vector, ${options.memoryType},
        ${options.importance ?? defaultImportance(options.memoryType)},
        ${options.depth ?? 0}, ${tokenCount},
        ${options.sourceSession ?? null}, ${options.profileId},
        ${now}, ${now}, ${now}, ${0}
      )
      RETURNING id
    `;
    return rows[0].id;
  }

  async querySemanticMemory(
    text: string,
    profileId: string,
    options?: QuerySemanticOptions,
  ): Promise<SemanticQueryResult[]> {
    this.ensureStarted();
    const vector = await this.embedding.embed(text);
    const limit = options?.limit ?? this.semanticMemoryLimit;
    const fetchLimit = limit * this.candidateMultiplier;
    const vectorStr = `[${vector.join(',')}]`;

    // Phase 1: HNSW candidate fetch (profile-scoped)
    let rows;
    if (options?.memoryType) {
      rows = await this.sql<Array<SemanticRow & { similarity: number }>>`
        SELECT *, 1 - (embedding <=> ${vectorStr}::vector) AS similarity
        FROM memory_semantic
        WHERE profile_id = ${profileId} AND memory_type = ${options.memoryType}
        ORDER BY embedding <=> ${vectorStr}::vector
        LIMIT ${fetchLimit}
      `;
    } else {
      rows = await this.sql<Array<SemanticRow & { similarity: number }>>`
        SELECT *, 1 - (embedding <=> ${vectorStr}::vector) AS similarity
        FROM memory_semantic
        WHERE profile_id = ${profileId}
        ORDER BY embedding <=> ${vectorStr}::vector
        LIMIT ${fetchLimit}
      `;
    }

    // Phase 2: composite re-ranking
    const candidates = rows.map((r) => ({
      ...semanticRowToEntry(r),
      similarity: Number(r.similarity),
      lastAccessed: Number(r.last_accessed),
      importance: Number(r.importance),
    }));

    const ranked = rankByCompositeScore(candidates, this.scoringWeights, limit);

    return ranked.map((r) => ({
      entry: r as unknown as SemanticMemoryEntry,
      similarity: r.similarity,
      compositeScore: r.compositeScore,
    }));
  }

  async deleteSemanticMemory(memoryId: string): Promise<boolean> {
    this.ensureStarted();
    const result = await this.sql`DELETE FROM memory_semantic WHERE id = ${memoryId}`;
    return result.count > 0;
  }

  // ── Tier 3: Meta Memory ─────────────────────────────────────────────────

  async queryMetaMemory(
    text: string,
    profileId: string,
    options?: { type?: MetaMemoryType; limit?: number; minDepth?: number; maxDepth?: number },
  ): Promise<MetaQueryResult[]> {
    this.ensureStarted();
    const vector = await this.embedding.embed(text);
    const limit = options?.limit ?? this.metaMemoryLimit;
    const fetchLimit = limit * this.candidateMultiplier;
    const vectorStr = `[${vector.join(',')}]`;

    const minDepth = options?.minDepth ?? 0;
    const maxDepth = options?.maxDepth ?? 999;

    let rows;
    if (options?.type) {
      rows = await this.sql<Array<MetaRow & { similarity: number }>>`
        SELECT *, 1 - (embedding <=> ${vectorStr}::vector) AS similarity
        FROM memory_meta
        WHERE profile_id = ${profileId}
          AND reflection_type = ${options.type}
          AND confidence >= 0.2
          AND depth >= ${minDepth} AND depth <= ${maxDepth}
        ORDER BY embedding <=> ${vectorStr}::vector
        LIMIT ${fetchLimit}
      `;
    } else {
      rows = await this.sql<Array<MetaRow & { similarity: number }>>`
        SELECT *, 1 - (embedding <=> ${vectorStr}::vector) AS similarity
        FROM memory_meta
        WHERE profile_id = ${profileId}
          AND confidence >= 0.2
          AND depth >= ${minDepth} AND depth <= ${maxDepth}
        ORDER BY embedding <=> ${vectorStr}::vector
        LIMIT ${fetchLimit}
      `;
    }

    // Phase 2: composite re-ranking (using confidence as importance)
    const candidates = rows.map((r) => ({
      ...metaRowToEntry(r),
      similarity: Number(r.similarity),
      lastAccessed: Number(r.last_accessed),
      importance: Number(r.confidence),
    }));

    const ranked = rankByCompositeScore(candidates, this.scoringWeights, limit);

    return ranked.map((r) => ({
      entry: r as unknown as MetaMemoryEntry,
      similarity: r.similarity,
      compositeScore: r.compositeScore,
    }));
  }

  /**
   * Hierarchical cascade retrieval for T3 meta memory.
   *
   * Top-down: starts from the highest available depth, fills remaining budget
   * with progressively lower depths. Each depth level has its own similarity
   * gate — strategic insights are permissive (low threshold), raw observations
   * require direct relevance (high threshold).
   *
   * Returns entries grouped by depth level in descending order.
   */
  async queryMetaCascade(
    text: string,
    profileId: string,
    config?: MetaInjectionConfig,
  ): Promise<MetaQueryResult[]> {
    this.ensureStarted();
    const cfg = config ?? this.metaInjection;
    const vector = await this.embedding.embed(text);
    const vectorStr = `[${vector.join(',')}]`;

    // Determine the max depth present in the database
    const maxDepthRow = await this.sql<[{ max_depth: number }]>`
      SELECT COALESCE(MAX(depth), 0)::integer AS max_depth
      FROM memory_meta
      WHERE profile_id = ${profileId} AND confidence >= 0.2
    `;
    const maxDepth = maxDepthRow[0].max_depth;

    const results: MetaQueryResult[] = [];

    // Step 1: d2+ strategic entries (highest depth first)
    if (maxDepth >= 2 && cfg.d2Slots > 0) {
      const d2Results = await this.fetchMetaAtDepthRange(
        vectorStr,
        profileId,
        2,
        maxDepth,
        cfg.d2Slots,
        cfg.d2MinSimilarity,
      );
      results.push(...d2Results);
    }

    // Step 2: d1 evaluated patterns
    if (cfg.d1Slots > 0) {
      const d1Results = await this.fetchMetaAtDepthRange(
        vectorStr,
        profileId,
        1,
        1,
        cfg.d1Slots,
        cfg.d1MinSimilarity,
      );
      results.push(...d1Results);
    }

    // Step 3: d0 direct observations (fill remaining)
    if (cfg.d0Slots > 0) {
      const d0Results = await this.fetchMetaAtDepthRange(
        vectorStr,
        profileId,
        0,
        0,
        cfg.d0Slots,
        cfg.d0MinSimilarity,
      );
      results.push(...d0Results);
    }

    // Update access counts
    const accessUpdates = results.map((r) => this.updateMetaAccess(r.entry.id));
    await Promise.all(accessUpdates);

    return results;
  }

  /**
   * Fetch meta entries within a depth range, filtered by similarity gate.
   */
  private async fetchMetaAtDepthRange(
    vectorStr: string,
    profileId: string,
    minDepth: number,
    maxDepth: number,
    limit: number,
    minSimilarity: number,
  ): Promise<MetaQueryResult[]> {
    const fetchLimit = limit * this.candidateMultiplier;

    const rows = await this.sql<Array<MetaRow & { similarity: number }>>`
      SELECT *, 1 - (embedding <=> ${vectorStr}::vector) AS similarity
      FROM memory_meta
      WHERE profile_id = ${profileId}
        AND confidence >= 0.2
        AND depth >= ${minDepth} AND depth <= ${maxDepth}
      ORDER BY embedding <=> ${vectorStr}::vector
      LIMIT ${fetchLimit}
    `;

    // Apply similarity gate + composite re-rank
    const candidates = rows
      .filter((r) => Number(r.similarity) >= minSimilarity)
      .map((r) => ({
        ...metaRowToEntry(r),
        similarity: Number(r.similarity),
        lastAccessed: Number(r.last_accessed),
        importance: Number(r.confidence),
      }));

    const ranked = rankByCompositeScore(candidates, this.scoringWeights, limit);

    return ranked.map((r) => ({
      entry: r as unknown as MetaMemoryEntry,
      similarity: r.similarity,
      compositeScore: r.compositeScore,
    }));
  }

  // ── External Memory ─────────────────────────────────────────────────────

  async storeExternalMemory(options: StoreExternalOptions): Promise<string> {
    this.ensureStarted();
    const vector = await this.embedding.embed(options.content);
    const now = Date.now();
    const vectorStr = `[${vector.join(',')}]`;

    const rows = await this.sql<[{ id: string }]>`
      INSERT INTO memory_external
        (content, embedding, source_type, source_ref, profile_id, created_at)
      VALUES (
        ${options.content}, ${vectorStr}::vector,
        ${options.sourceType}, ${options.sourceRef}, ${options.profileId}, ${now}
      )
      RETURNING id
    `;
    return rows[0].id;
  }

  async queryExternalMemory(
    text: string,
    profileId: string,
    options?: { source?: ExternalMemorySource; limit?: number },
  ): Promise<ExternalQueryResult[]> {
    this.ensureStarted();
    const vector = await this.embedding.embed(text);
    const limit = options?.limit ?? this.externalMemoryLimit;
    const vectorStr = `[${vector.join(',')}]`;

    let rows;
    if (options?.source) {
      rows = await this.sql<Array<ExternalRow & { similarity: number }>>`
        SELECT *, 1 - (embedding <=> ${vectorStr}::vector) AS similarity
        FROM memory_external
        WHERE profile_id = ${profileId} AND source_type = ${options.source}
        ORDER BY embedding <=> ${vectorStr}::vector
        LIMIT ${limit}
      `;
    } else {
      rows = await this.sql<Array<ExternalRow & { similarity: number }>>`
        SELECT *, 1 - (embedding <=> ${vectorStr}::vector) AS similarity
        FROM memory_external
        WHERE profile_id = ${profileId}
        ORDER BY embedding <=> ${vectorStr}::vector
        LIMIT ${limit}
      `;
    }

    return rows
      .filter((r) => Number(r.similarity) >= this.externalSimilarityThreshold)
      .map((r) => ({
        entry: externalRowToEntry(r),
        similarity: Number(r.similarity),
      }));
  }

  async removeExternalBySource(sourceRef: string, profileId: string): Promise<number> {
    this.ensureStarted();
    const result = await this.sql`
      DELETE FROM memory_external WHERE source_ref = ${sourceRef} AND profile_id = ${profileId}
    `;
    return result.count;
  }

  // ── DAG Traversal ───────────────────────────────────────────────────────

  async expandMemory(
    summaryId: string,
  ): Promise<{ messages?: MessageRow[]; childSummaries?: SemanticMemoryEntry[] }> {
    this.ensureStarted();

    // Check the depth of this summary
    const summaryRows = await this.sql`
      SELECT depth FROM memory_semantic WHERE id = ${summaryId} AND memory_type = 'summary'
    `;
    const summaryRow = summaryRows[0];
    if (summaryRows.length === 0 || !summaryRow) return {};

    const depth = Number(summaryRow.depth);

    if (depth === 0) {
      // Return source messages
      const messages = await this.sql<MessageRow[]>`
        SELECT mw.* FROM memory_working mw
        JOIN summary_message_sources sms ON sms.message_id = mw.id AND sms.chat_id = mw.chat_id
        WHERE sms.summary_id = ${summaryId}
        ORDER BY mw.timestamp ASC
      `;
      return { messages };
    }

    // Return child summaries (depth-1 or lower)
    const children = await this.sql<SemanticRow[]>`
      SELECT ms.* FROM memory_semantic ms
      JOIN summary_parent_sources sps ON sps.child_id = ms.id
      WHERE sps.parent_id = ${summaryId}
      ORDER BY ms.earliest_at ASC
    `;
    return { childSummaries: children.map(semanticRowToEntry) };
  }

  /**
   * Expand a T3 meta memory entry by traversing the meta_parent_sources DAG.
   *
   * For depth > 0: returns the child meta entries that were condensed into this parent.
   * For depth 0: returns the source T2 semantic entries via memory_meta_sources.
   */
  async expandMetaMemory(
    metaId: string,
  ): Promise<{ sourceSemantics?: SemanticMemoryEntry[]; childMetas?: MetaMemoryEntry[] }> {
    this.ensureStarted();

    // Get the depth of this meta entry
    const metaRows = await this.sql<Array<{ depth: number }>>`
      SELECT depth FROM memory_meta WHERE id = ${metaId}
    `;
    const metaRow = metaRows[0];
    if (!metaRow) return {};

    const depth = Number(metaRow.depth);

    if (depth === 0) {
      // Return source T2 semantic entries (via memory_meta_sources)
      const sourceRows = await this.sql<SemanticRow[]>`
        SELECT ms.* FROM memory_semantic ms
        JOIN memory_meta_sources mms ON mms.semantic_id = ms.id
        WHERE mms.meta_id = ${metaId}
        ORDER BY ms.created_at ASC
      `;
      return { sourceSemantics: sourceRows.map(semanticRowToEntry) };
    }

    // depth > 0: return child meta entries (via meta_parent_sources)
    const childRows = await this.sql<MetaRow[]>`
      SELECT mm.* FROM memory_meta mm
      JOIN meta_parent_sources mps ON mps.child_id = mm.id
      WHERE mps.parent_id = ${metaId}
      ORDER BY mm.depth ASC, mm.created_at ASC
    `;
    return { childMetas: childRows.map(metaRowToEntry) };
  }

  /**
   * Trace a T3 meta entry to its ultimate T2 sources, recursively
   * traversing the DAG down to depth 0 and then to T2 semantic entries.
   */
  async traceMetaToSources(metaId: string): Promise<SemanticMemoryEntry[]> {
    this.ensureStarted();

    const result = await this.expandMetaMemory(metaId);

    if (result.sourceSemantics) {
      // Already at depth 0 — return T2 sources directly
      return result.sourceSemantics;
    }

    if (result.childMetas) {
      // Recurse through children and collect all T2 sources
      const allSources: SemanticMemoryEntry[] = [];
      for (const child of result.childMetas) {
        const childSources = await this.traceMetaToSources(child.id);
        allSources.push(...childSources);
      }
      // Deduplicate by ID
      const seen = new Set<string>();
      return allSources.filter((s) => {
        if (seen.has(s.id)) return false;
        seen.add(s.id);
        return true;
      });
    }

    return [];
  }

  // ── Session Management ──────────────────────────────────────────────────

  async startSession(chatId: string): Promise<string> {
    this.ensureStarted();
    const now = Date.now();
    const rows = await this.sql<[{ id: string }]>`
      INSERT INTO sessions (chat_id, started_at)
      VALUES (${chatId}, ${now})
      RETURNING id
    `;
    return rows[0].id;
  }

  async endSession(sessionId: string): Promise<void> {
    this.ensureStarted();
    await this.sql`
      UPDATE sessions SET ended_at = ${Date.now()}
      WHERE id = ${sessionId}
    `;
  }

  async getActiveSession(chatId: string): Promise<Session | null> {
    this.ensureStarted();
    const rows = await this.sql<SessionRow[]>`
      SELECT * FROM sessions
      WHERE chat_id = ${chatId} AND ended_at IS NULL
      ORDER BY started_at DESC
      LIMIT 1
    `;
    const row = rows[0];
    return row ? sessionRowToSession(row) : null;
  }

  async getSessionMessages(sessionId: string, limit?: number): Promise<MessageRow[]> {
    this.ensureStarted();
    const lim = limit ?? this.workingMemoryLimit;
    return this.sql<MessageRow[]>`
      SELECT * FROM (
        SELECT * FROM memory_working
        WHERE session_id = ${sessionId}
        ORDER BY timestamp DESC
        LIMIT ${lim}
      ) sub ORDER BY timestamp ASC
    `;
  }

  // ── Memory Stats ────────────────────────────────────────────────────────

  async getMemoryStats(profileId: string): Promise<Record<string, number>> {
    this.ensureStarted();

    const [semanticStats, metaStats, externalStats, workingCount] = await Promise.all([
      this.sql<Array<{ memory_type: string; count: number }>>`
        SELECT memory_type, COUNT(*)::integer AS count
        FROM memory_semantic WHERE profile_id = ${profileId} GROUP BY memory_type
      `,
      this.sql<Array<{ reflection_type: string; count: number }>>`
        SELECT reflection_type, COUNT(*)::integer AS count
        FROM memory_meta WHERE profile_id = ${profileId} AND confidence >= 0.2 GROUP BY reflection_type
      `,
      this.sql<Array<{ source_type: string; count: number }>>`
        SELECT source_type, COUNT(*)::integer AS count
        FROM memory_external WHERE profile_id = ${profileId} GROUP BY source_type
      `,
      this.sql<[{ count: number }]>`
        SELECT COUNT(*)::integer AS count FROM memory_working
      `,
    ]);

    const stats: Record<string, number> = {};
    for (const row of semanticStats) stats[`semantic_${row.memory_type}`] = row.count;
    for (const row of metaStats) stats[`meta_${row.reflection_type}`] = row.count;
    for (const row of externalStats) stats[`external_${row.source_type}`] = row.count;
    stats.working_messages = workingCount[0].count;
    return stats;
  }

  // ── Context Assembly ────────────────────────────────────────────────────

  /**
   * Build the agent context from all memory tiers + identity.
   *
   * Injection order (maximizes model attention where it matters):
   * 1. Identity (agent + user identity and personality)
   * 2. Meta Memory (Tier 3, high-confidence only)
   * 3. Semantic Memory (Tier 2, composite-scored)
   * 4. External Memory (conditional — only if similarity > threshold)
   * 5. Working Memory (Tier 1, last N messages chronological)
   */
  async buildAgentContext(
    chatId: string,
    taskText: string,
    options?: { timezone?: string },
  ): Promise<string> {
    this.ensureStarted();

    const now = Date.now();
    const dateStr = new Date(now).toISOString().slice(0, 10);

    // Resolve profile from chat
    const chatProfile = await this.profiles.getChatProfile(chatId);
    if (!chatProfile) {
      throw new Error(`No profile found for chat ${chatId}`);
    }
    const profileId = chatProfile.id;

    // Parallel retrieval (all profile-scoped)
    // Meta uses cascade or flat strategy depending on config
    const metaPromise =
      this.metaInjection.strategy === 'cascade'
        ? this.queryMetaCascade(taskText, profileId)
        : this.queryMetaMemory(taskText, profileId);

    const [identityContext, metaResults, semanticResults, externalResults, activeSession] =
      await Promise.all([
        this.identity.buildIdentityContext(this.identityThresholds, profileId),
        metaPromise,
        this.querySemanticMemory(taskText, profileId),
        this.queryExternalMemory(taskText, profileId),
        this.getActiveSession(chatId),
      ]);

    let sessionMessages: MessageRow[] = [];
    if (activeSession) {
      sessionMessages = await this.getSessionMessages(activeSession.id, this.workingMemoryLimit);
    }

    // Update access counts for retrieved Tier 2 entries
    // (cascade strategy updates meta access internally; flat still needs it)
    const accessUpdates: Promise<void>[] = [];
    for (const r of semanticResults) {
      accessUpdates.push(this.updateSemanticAccess(r.entry.id));
    }
    if (this.metaInjection.strategy === 'flat') {
      for (const r of metaResults) {
        accessUpdates.push(this.updateMetaAccess(r.entry.id));
      }
    }
    await Promise.all(accessUpdates);

    // Assemble XML
    const parts: string[] = [];
    const tzAttr = options?.timezone ? ` timezone="${escapeXml(options.timezone)}"` : '';
    parts.push(`<context${tzAttr} date="${dateStr}">`);

    // 1. Identity
    parts.push(`  ${identityContext.split('\n').join('\n  ')}`);

    // 2. Meta Memory — grouped by depth level for cascade, flat for legacy
    if (metaResults.length > 0) {
      parts.push('  <meta_memory>');
      if (this.metaInjection.strategy === 'cascade') {
        // Group by depth level: strategic (d2+) → evaluated (d1) → observation (d0)
        const strategic = metaResults.filter((r) => r.entry.depth >= 2);
        const evaluated = metaResults.filter((r) => r.entry.depth === 1);
        const observations = metaResults.filter((r) => r.entry.depth === 0);

        for (const r of strategic) {
          parts.push(
            `    <strategic type="${r.entry.reflectionType}" confidence="${r.entry.confidence.toFixed(2)}" depth="${r.entry.depth}">${escapeXml(r.entry.content)}</strategic>`,
          );
        }
        for (const r of evaluated) {
          parts.push(
            `    <evaluated type="${r.entry.reflectionType}" confidence="${r.entry.confidence.toFixed(2)}">${escapeXml(r.entry.content)}</evaluated>`,
          );
        }
        for (const r of observations) {
          parts.push(
            `    <observation type="${r.entry.reflectionType}" confidence="${r.entry.confidence.toFixed(2)}">${escapeXml(r.entry.content)}</observation>`,
          );
        }
      } else {
        // Flat: original format
        for (const r of metaResults) {
          const tag =
            r.entry.reflectionType === 'self_assessment'
              ? 'self_assessment'
              : r.entry.reflectionType;
          const depthAttr = r.entry.depth > 0 ? ` depth="${r.entry.depth}"` : '';
          parts.push(
            `    <${tag} confidence="${r.entry.confidence.toFixed(2)}"${depthAttr}>${escapeXml(r.entry.content)}</${tag}>`,
          );
        }
      }
      parts.push('  </meta_memory>');
    }

    // 3. Semantic Memory
    if (semanticResults.length > 0) {
      parts.push('  <semantic_memory>');
      for (const r of semanticResults) {
        const depthAttr = r.entry.depth > 0 ? ` depth="${r.entry.depth}"` : '';
        parts.push(
          `    <memory type="${r.entry.memoryType}" importance="${r.entry.importance.toFixed(1)}" score="${r.compositeScore.toFixed(2)}"${depthAttr}>${escapeXml(r.entry.content)}</memory>`,
        );
      }
      parts.push('  </semantic_memory>');
    }

    // 4. External Memory (conditional)
    if (externalResults.length > 0) {
      parts.push('  <external_memory>');
      for (const r of externalResults) {
        parts.push(
          `    <entry source="${r.entry.sourceType}">${escapeXml(r.entry.content)}</entry>`,
        );
      }
      parts.push('  </external_memory>');
    }

    // 5. Working Memory
    if (sessionMessages.length > 0) {
      parts.push('  <working_memory>');
      for (const msg of sessionMessages) {
        const time = new Date(Number(msg.timestamp)).toISOString().replace('T', ' ').slice(0, 16);
        const sender = msg.is_bot_message ? 'assistant' : escapeXml(msg.sender_name);
        const content = escapeXml(msg.content ?? '[no content]');
        parts.push(`    <message sender="${sender}" time="${time}">${content}</message>`);
      }
      parts.push('  </working_memory>');
    }

    parts.push('</context>');
    return parts.join('\n');
  }

  // ── Access Tracking ─────────────────────────────────────────────────────

  private async updateSemanticAccess(memoryId: string): Promise<void> {
    await this.sql`
      UPDATE memory_semantic
      SET last_accessed = ${Date.now()}, access_count = access_count + 1
      WHERE id = ${memoryId}
    `;
  }

  private async updateMetaAccess(memoryId: string): Promise<void> {
    await this.sql`
      UPDATE memory_meta
      SET last_accessed = ${Date.now()}
      WHERE id = ${memoryId}
    `;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function defaultImportance(type: SemanticMemoryType): number {
  switch (type) {
    case 'instruction':
      return 1.0;
    case 'procedure':
      return 0.8;
    case 'summary':
      return 0.7;
    default:
      return 0.5;
  }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Row Types & Converters ───────────────────────────────────────────────

interface SemanticRow {
  id: string;
  content: string;
  memory_type: string;
  importance: number;
  depth: number;
  token_count: number;
  source_session: string | null;
  earliest_at: number | null;
  latest_at: number | null;
  created_at: number;
  updated_at: number;
  last_accessed: number;
  access_count: number;
}

interface MetaRow {
  id: string;
  content: string;
  reflection_type: string;
  confidence: number;
  depth: number;
  created_at: number;
  updated_at: number;
  last_accessed: number;
}

interface ExternalRow {
  id: string;
  content: string;
  source_type: string;
  source_ref: string;
  created_at: number;
}

interface SessionRow {
  id: string;
  chat_id: string;
  started_at: number;
  ended_at: number | null;
  summary: string | null;
  metadata: Record<string, unknown>;
}

function semanticRowToEntry(row: SemanticRow): SemanticMemoryEntry {
  return {
    id: row.id,
    content: row.content,
    memoryType: row.memory_type as SemanticMemoryType,
    importance: Number(row.importance),
    depth: Number(row.depth),
    tokenCount: Number(row.token_count),
    sourceSession: row.source_session ?? undefined,
    earliestAt: row.earliest_at ? Number(row.earliest_at) : undefined,
    latestAt: row.latest_at ? Number(row.latest_at) : undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastAccessed: Number(row.last_accessed),
    accessCount: Number(row.access_count),
  };
}

function metaRowToEntry(row: MetaRow): MetaMemoryEntry {
  return {
    id: row.id,
    content: row.content,
    reflectionType: row.reflection_type as MetaMemoryType,
    confidence: Number(row.confidence),
    depth: Number(row.depth ?? 0),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastAccessed: Number(row.last_accessed),
  };
}

function externalRowToEntry(row: ExternalRow): ExternalMemoryEntry {
  return {
    id: row.id,
    content: row.content,
    sourceType: row.source_type as ExternalMemorySource,
    sourceRef: row.source_ref,
    createdAt: Number(row.created_at),
  };
}

function sessionRowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    chatId: row.chat_id,
    startedAt: Number(row.started_at),
    endedAt: row.ended_at ? Number(row.ended_at) : undefined,
    summary: row.summary ?? undefined,
    metadata: row.metadata ?? {},
  };
}
