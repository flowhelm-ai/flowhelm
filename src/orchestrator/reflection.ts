/**
 * MemoryReflectionJob: scheduled background job for Tier 2 → Tier 3 Meta Memory.
 *
 * Three-phase depth-aware pipeline (Recursive Metacognitive DAG):
 *   Phase 1 — D0 generation: T2 entries → T3 d0 (monitoring/direct observations)
 *   Phase 2 — D1 condensation: T3 d0 → T3 d1 (evaluation/pattern recognition)
 *   Phase 3 — D2+ condensation: T3 d(N-1) → T3 dN (regulation/strategic synthesis)
 *
 * Confidence model: new reflections start at provider-specified confidence,
 * existing entries are confirmed (asymptotic growth) or contradicted (faster decay).
 * Entries below 0.2 are excluded from queries.
 *
 * Contradiction cascade: when a child entry is contradicted below 0.2, parent
 * entries sourced from it are re-evaluated and decayed if >50% of their sources
 * are below threshold.
 *
 * See ADR-030, ADR-031, ADR-050.
 */

import type { Sql } from 'postgres';
import type {
  MemorySummarizationProvider,
  EmbeddingProvider,
  MetaMemoryType,
  Startable,
} from './types.js';
import { confirmConfidence, contradictConfidence } from './identity.js';

// ─── Configuration ────────────────────────────────────────────────────────

export interface ReflectionConfig {
  enabled: boolean;
  schedule: string;
  reflectionModel: string;
  maxInputTokens: number;
  minSemanticEntries: number;
  confidenceThreshold: number;
  metaCondensationThreshold: number;
  d1MetaMaxTokens: number;
  d2MetaMaxTokens: number;
  maxMetaDepth: number;
  contradictionCascade: boolean;
}

export interface ReflectionJobOptions {
  sql: Sql;
  summarizationProvider: MemorySummarizationProvider;
  embeddingProvider: EmbeddingProvider;
  config: ReflectionConfig;
}

// ─── D0 Prompts (T2 → T3 direct observations) ───────────────────────────

const INSIGHT_SYSTEM_PROMPT = `You are a reflective memory system. Analyze the following semantic memory entries and identify cross-cutting insights about the user.
An insight is a generalization that spans multiple facts or patterns.
Return a JSON array of objects: [{"content": "...", "confidence": 0.3-0.9}]
Only include genuine insights, not restatements of individual facts. Return [] if none.
Output ONLY valid JSON, no markdown fences.`;

const HEURISTIC_SYSTEM_PROMPT = `You are a reflective memory system. Analyze the following semantic memory entries and generate heuristics (rules of thumb) that improve task performance.
A heuristic is a learned rule based on patterns of success or failure.
Return a JSON array of objects: [{"content": "...", "confidence": 0.3-0.9}]
Only include actionable heuristics based on evidence. Return [] if none.
Output ONLY valid JSON, no markdown fences.`;

const SELF_ASSESSMENT_SYSTEM_PROMPT = `You are a reflective memory system. Analyze the following semantic memory entries and generate self-assessments about the agent's performance.
A self-assessment evaluates areas of strength and improvement.
Return a JSON array of objects: [{"content": "...", "confidence": 0.3-0.9}]
Be specific and evidence-based. Return [] if none.
Output ONLY valid JSON, no markdown fences.`;

// ─── D1 Prompts (d0 observations → evaluated patterns) ──────────────────

const D1_INSIGHT_PROMPT = `You are a reflective memory system performing meta-analysis. The following are direct observations (depth-0) accumulated over multiple reflection cycles. Identify higher-order patterns that span these observations.
Return a JSON array of objects: [{"content": "...", "confidence": 0.5-0.95}]
Synthesize cross-cutting evaluations — not restatements. Return [] if none.
Output ONLY valid JSON, no markdown fences.`;

const D1_HEURISTIC_PROMPT = `You are a reflective memory system performing meta-analysis. The following are heuristic observations (depth-0) accumulated over multiple reflection cycles. Evaluate which heuristics have been consistently validated and synthesize refined, higher-confidence rules.
Return a JSON array of objects: [{"content": "...", "confidence": 0.5-0.95}]
Only include patterns confirmed across multiple observations. Return [] if none.
Output ONLY valid JSON, no markdown fences.`;

const D1_SELF_ASSESSMENT_PROMPT = `You are a reflective memory system performing meta-analysis. The following are self-assessment observations (depth-0) accumulated over multiple reflection cycles. Identify consistent trends in performance strengths and growth areas.
Return a JSON array of objects: [{"content": "...", "confidence": 0.5-0.95}]
Synthesize evaluated performance patterns, not individual observations. Return [] if none.
Output ONLY valid JSON, no markdown fences.`;

// ─── D2+ Prompts (strategic synthesis) ───────────────────────────────────

const D2_INSIGHT_PROMPT = `You are a reflective memory system performing strategic synthesis. The following are evaluated patterns (depth-1+) spanning weeks or months. Synthesize strategic self-knowledge: how has the user's relationship with the agent evolved, what are the dominant themes, and what long-term trajectory is emerging?
Return a JSON array of objects: [{"content": "...", "confidence": 0.6-0.95}]
Focus on strategic-level understanding, not operational detail. Return [] if none.
Output ONLY valid JSON, no markdown fences.`;

const D2_HEURISTIC_PROMPT = `You are a reflective memory system performing strategic synthesis. The following are refined heuristics (depth-1+) spanning weeks or months. Synthesize meta-heuristics: which rules have become foundational, which should be retired, and what strategic principles emerge?
Return a JSON array of objects: [{"content": "...", "confidence": 0.6-0.95}]
Focus on enduring strategic principles. Return [] if none.
Output ONLY valid JSON, no markdown fences.`;

const D2_SELF_ASSESSMENT_PROMPT = `You are a reflective memory system performing strategic synthesis. The following are performance evaluations (depth-1+) spanning weeks or months. Synthesize a strategic growth trajectory: how has effectiveness evolved, where to focus next, what to change at a fundamental level?
Return a JSON array of objects: [{"content": "...", "confidence": 0.6-0.95}]
Focus on long-term growth trajectory, not individual metrics. Return [] if none.
Output ONLY valid JSON, no markdown fences.`;

// ─── Prompt Lookup ───────────────────────────────────────────────────────

const D0_PROMPTS: Record<MetaMemoryType, string> = {
  insight: INSIGHT_SYSTEM_PROMPT,
  heuristic: HEURISTIC_SYSTEM_PROMPT,
  self_assessment: SELF_ASSESSMENT_SYSTEM_PROMPT,
};

const D1_PROMPTS: Record<MetaMemoryType, string> = {
  insight: D1_INSIGHT_PROMPT,
  heuristic: D1_HEURISTIC_PROMPT,
  self_assessment: D1_SELF_ASSESSMENT_PROMPT,
};

const D2_PROMPTS: Record<MetaMemoryType, string> = {
  insight: D2_INSIGHT_PROMPT,
  heuristic: D2_HEURISTIC_PROMPT,
  self_assessment: D2_SELF_ASSESSMENT_PROMPT,
};

function getPromptForDepth(depth: number, type: MetaMemoryType): string {
  if (depth === 0) return D0_PROMPTS[type];
  if (depth === 1) return D1_PROMPTS[type];
  return D2_PROMPTS[type];
}

// ─── Parsed Reflection ────────────────────────────────────────────────────

interface ParsedReflection {
  content: string;
  confidence: number;
}

// ─── MemoryReflectionJob ──────────────────────────────────────────────────

export class MemoryReflectionJob implements Startable {
  private readonly sql: Sql;
  private readonly provider: MemorySummarizationProvider;
  private readonly embedding: EmbeddingProvider;
  private readonly config: ReflectionConfig;
  private running = false;

  constructor(options: ReflectionJobOptions) {
    this.sql = options.sql;
    this.provider = options.summarizationProvider;
    this.embedding = options.embeddingProvider;
    this.config = options.config;
  }

  async start(): Promise<void> {
    // Schedule management deferred to orchestrator
  }

  async stop(): Promise<void> {
    while (this.running) {
      await sleep(100);
    }
  }

  /** Run a single reflection pass (iterates all profiles). Returns number of meta entries created. */
  async run(): Promise<number> {
    if (this.running || !this.config.enabled) return 0;
    this.running = true;

    try {
      const profiles = await this.sql`SELECT id FROM agent_profiles ORDER BY id`;

      let totalCreated = 0;
      for (const profile of profiles) {
        totalCreated += await this.runForProfile(profile.id as string);
      }

      // Update last reflection timestamp
      await this.sql`
        INSERT INTO state (key, value) VALUES ('last_reflection_at', ${String(Date.now())})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
      `;

      return totalCreated;
    } finally {
      this.running = false;
    }
  }

  /**
   * Run the full three-phase pipeline for a single profile:
   *   Phase 1: D0 generation (T2 → T3 d0)
   *   Phase 2: D1 condensation (d0 → d1)
   *   Phase 3: D2+ condensation (dN → dN+1, recursive up to maxMetaDepth)
   *   Phase 4: Contradiction cascade (optional)
   */
  private async runForProfile(profileId: string): Promise<number> {
    let totalCreated = 0;

    // Phase 1: D0 generation from T2 entries
    totalCreated += await this.generateD0(profileId);

    // Phase 2-3: Recursive condensation (d0→d1, d1→d2, ...)
    for (let depth = 1; depth <= this.config.maxMetaDepth; depth++) {
      const created = await this.condenseMeta(depth - 1, depth, profileId);
      totalCreated += created;
      if (created === 0) break; // No data at this depth, stop recursion
    }

    // Phase 4: Contradiction cascade
    if (this.config.contradictionCascade) {
      await this.runContradictionCascade(profileId);
    }

    return totalCreated;
  }

  // ── Phase 1: D0 Generation (T2 → T3 d0) ───────────────────────────────

  /**
   * Generate depth-0 meta entries from recent T2 semantic memory.
   * This is the cross-tier boundary: T2 (facts/summaries) → T3 (observations).
   */
  private async generateD0(profileId: string): Promise<number> {
    const stateRows = await this.sql`
      SELECT value FROM state WHERE key = 'last_reflection_at'
    `;
    const lastReflectionAt = stateRows.length > 0 ? Number(stateRows[0]?.value) : 0;

    // Get recent T2 entries (all depths — d0 facts AND d1+ condensed summaries)
    const recentEntries = await this.sql`
      SELECT id, content, memory_type, importance
      FROM memory_semantic
      WHERE profile_id = ${profileId} AND created_at > ${lastReflectionAt}
      ORDER BY created_at DESC
    `;

    if (recentEntries.length < this.config.minSemanticEntries) {
      return 0;
    }

    const entriesText = recentEntries
      .map((e) => `[${e.memory_type}] (importance: ${e.importance}): ${e.content}`)
      .join('\n');
    const truncated = truncateToTokens(entriesText, this.config.maxInputTokens);
    const sourceIds = recentEntries.map((e) => e.id as string);

    const types: MetaMemoryType[] = ['insight', 'heuristic', 'self_assessment'];
    let totalCreated = 0;

    for (const type of types) {
      totalCreated += await this.runReflection(
        type,
        D0_PROMPTS[type],
        truncated,
        sourceIds,
        profileId,
        0, // depth = 0
      );
    }

    return totalCreated;
  }

  // ── Phase 2-3: Meta Condensation (dN → dN+1) ──────────────────────────

  /**
   * Condense uncondensed meta entries at sourceDepth into entries at targetDepth.
   * Generic — works for d0→d1, d1→d2, d2→d3, etc.
   */
  private async condenseMeta(
    sourceDepth: number,
    targetDepth: number,
    profileId: string,
  ): Promise<number> {
    const types: MetaMemoryType[] = ['insight', 'heuristic', 'self_assessment'];
    let totalCreated = 0;

    for (const type of types) {
      totalCreated += await this.condenseMetaType(type, sourceDepth, targetDepth, profileId);
    }

    return totalCreated;
  }

  /**
   * Condense uncondensed entries of a specific type at sourceDepth.
   * "Uncondensed" = not yet a child in meta_parent_sources.
   */
  private async condenseMetaType(
    type: MetaMemoryType,
    sourceDepth: number,
    targetDepth: number,
    profileId: string,
  ): Promise<number> {
    // Find uncondensed entries at sourceDepth for this type/profile
    const uncondensed = await this.sql`
      SELECT id, content, confidence
      FROM memory_meta
      WHERE profile_id = ${profileId}
        AND reflection_type = ${type}
        AND depth = ${sourceDepth}
        AND confidence >= 0.2
        AND id NOT IN (SELECT child_id FROM meta_parent_sources)
      ORDER BY created_at ASC
    `;

    if (uncondensed.length < this.config.metaCondensationThreshold) {
      return 0;
    }

    // Build input text from uncondensed entries
    const entriesText = uncondensed
      .map((e) => `(confidence: ${Number(e.confidence).toFixed(2)}): ${e.content}`)
      .join('\n');
    const maxTokens = targetDepth === 1 ? this.config.d1MetaMaxTokens : this.config.d2MetaMaxTokens;
    const truncated = truncateToTokens(entriesText, maxTokens * 4); // Input budget = 4x output
    const prompt = getPromptForDepth(targetDepth, type);

    // Confidence floor: avg(source confidences) + 0.05, capped at 0.95
    const avgConfidence =
      uncondensed.reduce((sum, e) => sum + Number(e.confidence), 0) / uncondensed.length;
    const confidenceFloor = Math.min(0.95, avgConfidence + 0.05);

    const childIds = uncondensed.map((e) => e.id as string);

    return await this.runCondensation(
      type,
      prompt,
      truncated,
      childIds,
      profileId,
      targetDepth,
      confidenceFloor,
      maxTokens,
    );
  }

  /**
   * Run a condensation prompt and store results as higher-depth meta entries.
   * Links new entries to their source children via meta_parent_sources.
   */
  private async runCondensation(
    type: MetaMemoryType,
    systemPrompt: string,
    content: string,
    childIds: string[],
    profileId: string,
    depth: number,
    confidenceFloor: number,
    maxTokens: number,
  ): Promise<number> {
    try {
      const result = await this.provider.summarize(content, {
        model: this.config.reflectionModel,
        maxTokens,
        systemPrompt,
      });

      const reflections = JSON.parse(result) as ParsedReflection[];
      if (!Array.isArray(reflections)) return 0;

      let created = 0;
      for (const reflection of reflections) {
        if (!reflection.content) continue;
        const confidence = Math.max(confidenceFloor, Math.min(0.95, reflection.confidence ?? 0.5));

        const embedding = await this.embedding.embed(reflection.content);
        const now = Date.now();
        const metaRows = await this.sql`
          INSERT INTO memory_meta
            (content, embedding, reflection_type, confidence, depth, profile_id,
             created_at, updated_at, last_accessed)
          VALUES (${reflection.content}, ${toVectorLiteral(embedding)}::vector,
                  ${type}, ${confidence}, ${depth}, ${profileId}, ${now}, ${now}, ${now})
          RETURNING id
        `;

        const metaId = metaRows[0]?.id as string;

        // Link to source child entries via meta_parent_sources
        for (const childId of childIds) {
          await this.sql`
            INSERT INTO meta_parent_sources (parent_id, child_id)
            VALUES (${metaId}, ${childId})
            ON CONFLICT DO NOTHING
          `;
        }

        created++;
      }

      return created;
    } catch {
      return 0;
    }
  }

  // ── D0 Reflection (shared with Phase 1) ────────────────────────────────

  /**
   * Run a single D0 reflection type and store results.
   * Links new entries to source T2 semantic entries via memory_meta_sources.
   */
  private async runReflection(
    type: MetaMemoryType,
    systemPrompt: string,
    content: string,
    sourceIds: string[],
    profileId: string,
    depth: number,
  ): Promise<number> {
    try {
      const result = await this.provider.summarize(content, {
        model: this.config.reflectionModel,
        maxTokens: 500,
        systemPrompt,
      });

      const reflections = JSON.parse(result) as ParsedReflection[];
      if (!Array.isArray(reflections)) return 0;

      let created = 0;
      for (const reflection of reflections) {
        if (!reflection.content) continue;
        const confidence = Math.max(
          this.config.confidenceThreshold,
          Math.min(0.9, reflection.confidence ?? 0.5),
        );

        // Check for existing similar meta entries within this profile (duplicates)
        const embedding = await this.embedding.embed(reflection.content);
        const existing = await this.sql`
          SELECT id, content, confidence, reflection_type
          FROM memory_meta
          WHERE profile_id = ${profileId}
            AND reflection_type = ${type}
            AND depth = ${depth}
            AND confidence >= 0.2
          ORDER BY embedding <=> ${toVectorLiteral(embedding)}::vector::vector
          LIMIT 1
        `;

        const existingEntry = existing[0];
        if (existingEntry) {
          const similarity = await this.computeSimilarity(embedding, existingEntry.id as string);

          if (similarity > 0.85) {
            // Confirm existing entry (bump confidence)
            const newConf = confirmConfidence(Number(existingEntry.confidence));
            await this.sql`
              UPDATE memory_meta SET
                confidence = ${newConf},
                updated_at = ${Date.now()}
              WHERE id = ${existingEntry.id as string}
            `;
            continue;
          }

          if (similarity > 0.7) {
            // Potential contradiction — decay the existing entry
            const newConf = contradictConfidence(Number(existingEntry.confidence));
            await this.sql`
              UPDATE memory_meta SET
                confidence = ${newConf},
                updated_at = ${Date.now()}
              WHERE id = ${existingEntry.id as string}
            `;
          }
        }

        // Store new meta entry (profile-scoped, depth-tagged)
        const now = Date.now();
        const metaRows = await this.sql`
          INSERT INTO memory_meta
            (content, embedding, reflection_type, confidence, depth, profile_id,
             created_at, updated_at, last_accessed)
          VALUES (${reflection.content}, ${toVectorLiteral(embedding)}::vector,
                  ${type}, ${confidence}, ${depth}, ${profileId}, ${now}, ${now}, ${now})
          RETURNING id
        `;

        const metaId = metaRows[0]?.id as string;

        // Link to source semantic entries (T2 → T3 d0)
        for (const sourceId of sourceIds) {
          await this.sql`
            INSERT INTO memory_meta_sources (meta_id, semantic_id)
            VALUES (${metaId}, ${sourceId})
            ON CONFLICT DO NOTHING
          `;
        }

        created++;
      }

      return created;
    } catch {
      // Reflection is best-effort; continue on parse errors
      return 0;
    }
  }

  // ── Phase 4: Contradiction Cascade ─────────────────────────────────────

  /**
   * When a meta entry's confidence drops below 0.2, check if parent entries
   * that sourced it should also be decayed. If >50% of a parent's source
   * children are below 0.2, decay the parent. Cascades upward through depths.
   */
  async runContradictionCascade(profileId: string): Promise<number> {
    let totalDecayed = 0;

    // Process from lowest depth upward so cascades propagate in one pass
    for (let depth = 1; depth <= this.config.maxMetaDepth; depth++) {
      const parents = await this.sql`
        SELECT DISTINCT m.id, m.confidence, m.depth
        FROM memory_meta m
        JOIN meta_parent_sources mps ON mps.parent_id = m.id
        WHERE m.profile_id = ${profileId}
          AND m.depth = ${depth}
          AND m.confidence >= 0.2
      `;

      for (const parent of parents) {
        const parentId = parent.id as string;

        // Count total children and low-confidence children
        const counts = await this.sql`
          SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE m.confidence < 0.2)::int AS low
          FROM meta_parent_sources mps
          JOIN memory_meta m ON m.id = mps.child_id
          WHERE mps.parent_id = ${parentId}
        `;

        const total = Number(counts[0]?.total ?? 0);
        const low = Number(counts[0]?.low ?? 0);

        // If >50% of sources are contradicted, decay the parent
        if (total > 0 && low / total > 0.5) {
          const newConf = contradictConfidence(Number(parent.confidence));
          await this.sql`
            UPDATE memory_meta SET
              confidence = ${newConf},
              updated_at = ${Date.now()}
            WHERE id = ${parentId}
          `;
          totalDecayed++;
        }
      }
    }

    return totalDecayed;
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  /** Compute cosine similarity between an embedding and a stored meta entry. */
  private async computeSimilarity(embedding: number[], metaId: string): Promise<number> {
    const result = await this.sql`
      SELECT 1 - (embedding <=> ${toVectorLiteral(embedding)}::vector::vector) AS similarity
      FROM memory_meta
      WHERE id = ${metaId}
    `;
    return result.length > 0 ? Number(result[0]?.similarity) : 0;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function truncateToTokens(text: string, maxTokens: number): string {
  // Rough estimate: ~4 characters per token
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

/** Format a number[] embedding for pgvector insertion. */
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
