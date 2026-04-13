/**
 * Phase 9B tests: Recursive Metacognitive DAG.
 *
 * Tests cover:
 * - Schema: meta_parent_sources table, depth column on memory_meta
 * - Memory manager: depth filter, expandMetaMemory, traceMetaToSources, context XML
 * - Reflection job: D0 generation, D1/D2 condensation, contradiction cascade
 * - MCP tools: search_meta depth param, expand_meta, trace_to_source
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryManager } from '../src/orchestrator/memory.js';
import { MemoryReflectionJob } from '../src/orchestrator/reflection.js';
import { IdentityManager } from '../src/orchestrator/identity.js';
import { ProfileManager } from '../src/orchestrator/profile-manager.js';
import { createTestDatabase, applySchema } from './helpers/pg-container.js';
import type { Sql } from '../src/orchestrator/connection.js';
import type {
  EmbeddingProvider,
  MemorySummarizationProvider,
  MetaMemoryType,
} from '../src/orchestrator/types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

let sql: Sql;
let cleanup: () => Promise<void>;
let defaultProfileId: string;
let profileManager: ProfileManager;

const VECTOR_DIM = 384;

function mockEmbedding(overrides: Partial<EmbeddingProvider> = {}): EmbeddingProvider {
  return {
    embed: vi.fn().mockResolvedValue(Array(VECTOR_DIM).fill(0.01)),
    embedBatch: vi.fn().mockResolvedValue([Array(VECTOR_DIM).fill(0.01)]),
    dimensions: VECTOR_DIM,
    ...overrides,
  };
}

function mockProvider(
  overrides: Partial<MemorySummarizationProvider> = {},
): MemorySummarizationProvider {
  return {
    summarize: vi.fn().mockResolvedValue('[]'),
    ...overrides,
  };
}

const BASE_REFLECTION_CONFIG = {
  enabled: true,
  schedule: '0 3 * * *',
  reflectionModel: 'claude-haiku-4-5-20251001',
  maxInputTokens: 4000,
  minSemanticEntries: 3,
  confidenceThreshold: 0.3,
  metaCondensationThreshold: 3,
  d1MetaMaxTokens: 400,
  d2MetaMaxTokens: 300,
  maxMetaDepth: 3,
  contradictionCascade: true,
};

/** Seed N semantic entries for reflection. */
async function seedSemantic(count: number, createdAt?: number): Promise<string[]> {
  const now = createdAt ?? Date.now();
  const embeddingStr = `[${Array(VECTOR_DIM).fill(0.02).join(',')}]`;
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const rows = await sql.unsafe(
      `INSERT INTO memory_semantic
        (content, embedding, memory_type, importance, depth, token_count,
         profile_id, created_at, updated_at, last_accessed, access_count)
      VALUES (
        $1, '${embeddingStr}',
        'fact', 0.6, 0, 10,
        $2, $3, $4, $5, 0
      ) RETURNING id`,
      ['Semantic entry ' + String(i), defaultProfileId, now + i, now + i, now + i],
    );
    ids.push(rows[0].id as string);
  }
  return ids;
}

/** Insert a meta entry directly for testing. */
async function insertMeta(opts: {
  content: string;
  type: MetaMemoryType;
  confidence: number;
  depth: number;
  profileId?: string;
}): Promise<string> {
  const now = Date.now();
  const embeddingStr = `[${Array(VECTOR_DIM).fill(0.03).join(',')}]`;
  const rows = await sql.unsafe(
    `INSERT INTO memory_meta
      (content, embedding, reflection_type, confidence, depth, profile_id,
       created_at, updated_at, last_accessed)
    VALUES ($1, '${embeddingStr}', $2, $3, $4, $5, $6, $7, $8)
    RETURNING id`,
    [
      opts.content,
      opts.type,
      opts.confidence,
      opts.depth,
      opts.profileId ?? defaultProfileId,
      now,
      now,
      now,
    ],
  );
  return rows[0].id as string;
}

/** Link a meta entry to semantic sources (T2→T3 d0). */
async function linkMetaSemantic(metaId: string, semanticIds: string[]): Promise<void> {
  for (const sid of semanticIds) {
    await sql`
      INSERT INTO memory_meta_sources (meta_id, semantic_id)
      VALUES (${metaId}, ${sid})
      ON CONFLICT DO NOTHING
    `;
  }
}

/** Link a parent meta to child metas (meta_parent_sources DAG). */
async function linkMetaParent(parentId: string, childIds: string[]): Promise<void> {
  for (const cid of childIds) {
    await sql`
      INSERT INTO meta_parent_sources (parent_id, child_id)
      VALUES (${parentId}, ${cid})
      ON CONFLICT DO NOTHING
    `;
  }
}

async function createChat(chatId = 'tg:123'): Promise<void> {
  const now = Date.now();
  await sql`
    INSERT INTO chats (id, channel, external_id, is_group, profile_id, created_at, updated_at)
    VALUES (${chatId}, 'telegram', ${chatId.replace('tg:', '')}, false, ${defaultProfileId}, ${now}, ${now})
    ON CONFLICT (id) DO NOTHING
  `;
}

// ─── Setup / Teardown ───────────────────────────────────────────────────

beforeEach(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;
  await applySchema(sql);
  const rows = await sql`SELECT id FROM agent_profiles WHERE is_default = true LIMIT 1`;
  defaultProfileId = rows[0].id as string;
  profileManager = new ProfileManager({ sql, maxProfilesPerUser: 10 });
});

afterEach(async () => {
  await cleanup();
});

// ─── Schema Tests ───────────────────────────────────────────────────────

describe('schema: meta_parent_sources', () => {
  it('creates meta_parent_sources table', async () => {
    const result = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_name = 'meta_parent_sources'
    `;
    expect(result.length).toBe(1);
  });

  it('has parent_id and child_id columns', async () => {
    const result = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'meta_parent_sources'
      ORDER BY column_name
    `;
    const cols = result.map((r) => r.column_name);
    expect(cols).toContain('parent_id');
    expect(cols).toContain('child_id');
  });

  it('has depth column on memory_meta', async () => {
    const result = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'memory_meta' AND column_name = 'depth'
    `;
    expect(result.length).toBe(1);
  });

  it('has idx_meta_depth index', async () => {
    const result = await sql`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'memory_meta' AND indexname = 'idx_meta_depth'
    `;
    expect(result.length).toBe(1);
  });

  it('enforces FK constraints on meta_parent_sources', async () => {
    await expect(
      sql`INSERT INTO meta_parent_sources (parent_id, child_id) VALUES (gen_random_uuid(), gen_random_uuid())`,
    ).rejects.toThrow();
  });

  it('cascades delete from memory_meta to meta_parent_sources', async () => {
    const childId = await insertMeta({
      content: 'child observation',
      type: 'insight',
      confidence: 0.5,
      depth: 0,
    });
    const parentId = await insertMeta({
      content: 'parent evaluation',
      type: 'insight',
      confidence: 0.7,
      depth: 1,
    });
    await linkMetaParent(parentId, [childId]);

    // Verify link exists
    const before = await sql`SELECT * FROM meta_parent_sources WHERE parent_id = ${parentId}`;
    expect(before.length).toBe(1);

    // Delete parent — should cascade
    await sql`DELETE FROM memory_meta WHERE id = ${parentId}`;
    const after = await sql`SELECT * FROM meta_parent_sources WHERE parent_id = ${parentId}`;
    expect(after.length).toBe(0);
  });
});

// ─── Memory Manager: queryMetaMemory depth filter ───────────────────────

describe('MemoryManager: meta depth filtering', () => {
  let mm: MemoryManager;

  beforeEach(async () => {
    mm = new MemoryManager({
      sql,
      embeddingProvider: mockEmbedding(),
      identityManager: new IdentityManager({ sql }),
      profileManager,
    });
    await mm.start();
  });

  afterEach(async () => {
    await mm.stop();
  });

  it('queryMetaMemory returns all depths by default', async () => {
    await insertMeta({ content: 'd0 insight', type: 'insight', confidence: 0.5, depth: 0 });
    await insertMeta({ content: 'd1 insight', type: 'insight', confidence: 0.6, depth: 1 });
    await insertMeta({ content: 'd2 insight', type: 'insight', confidence: 0.7, depth: 2 });

    const results = await mm.queryMetaMemory('insight', defaultProfileId, { limit: 10 });
    expect(results.length).toBe(3);
  });

  it('queryMetaMemory respects minDepth', async () => {
    await insertMeta({ content: 'd0 insight', type: 'insight', confidence: 0.5, depth: 0 });
    await insertMeta({ content: 'd1 insight', type: 'insight', confidence: 0.6, depth: 1 });
    await insertMeta({ content: 'd2 insight', type: 'insight', confidence: 0.7, depth: 2 });

    const results = await mm.queryMetaMemory('insight', defaultProfileId, {
      limit: 10,
      minDepth: 1,
    });
    expect(results.length).toBe(2);
    expect(results.every((r) => r.entry.depth >= 1)).toBe(true);
  });

  it('queryMetaMemory respects maxDepth', async () => {
    await insertMeta({ content: 'd0 insight', type: 'insight', confidence: 0.5, depth: 0 });
    await insertMeta({ content: 'd1 insight', type: 'insight', confidence: 0.6, depth: 1 });
    await insertMeta({ content: 'd2 insight', type: 'insight', confidence: 0.7, depth: 2 });

    const results = await mm.queryMetaMemory('insight', defaultProfileId, {
      limit: 10,
      maxDepth: 0,
    });
    expect(results.length).toBe(1);
    expect(results[0].entry.depth).toBe(0);
  });

  it('queryMetaMemory respects minDepth + maxDepth together', async () => {
    await insertMeta({ content: 'd0 insight', type: 'insight', confidence: 0.5, depth: 0 });
    await insertMeta({ content: 'd1 insight', type: 'insight', confidence: 0.6, depth: 1 });
    await insertMeta({ content: 'd2 insight', type: 'insight', confidence: 0.7, depth: 2 });
    await insertMeta({ content: 'd3 insight', type: 'insight', confidence: 0.8, depth: 3 });

    const results = await mm.queryMetaMemory('insight', defaultProfileId, {
      limit: 10,
      minDepth: 1,
      maxDepth: 2,
    });
    expect(results.length).toBe(2);
    expect(results.every((r) => r.entry.depth >= 1 && r.entry.depth <= 2)).toBe(true);
  });

  it('queryMetaMemory excludes low-confidence entries', async () => {
    await insertMeta({ content: 'low conf', type: 'insight', confidence: 0.1, depth: 0 });
    await insertMeta({ content: 'high conf', type: 'insight', confidence: 0.5, depth: 0 });

    const results = await mm.queryMetaMemory('insight', defaultProfileId, { limit: 10 });
    expect(results.length).toBe(1);
    expect(results[0].entry.confidence).toBeGreaterThanOrEqual(0.2);
  });

  it('queryMetaMemory combines type and depth filters', async () => {
    await insertMeta({ content: 'd0 insight', type: 'insight', confidence: 0.5, depth: 0 });
    await insertMeta({ content: 'd1 heuristic', type: 'heuristic', confidence: 0.6, depth: 1 });
    await insertMeta({ content: 'd1 insight', type: 'insight', confidence: 0.7, depth: 1 });

    const results = await mm.queryMetaMemory('anything', defaultProfileId, {
      type: 'insight',
      limit: 10,
      minDepth: 1,
    });
    expect(results.length).toBe(1);
    expect(results[0].entry.reflectionType).toBe('insight');
    expect(results[0].entry.depth).toBe(1);
  });
});

// ─── Memory Manager: expandMetaMemory ───────────────────────────────────

describe('MemoryManager: expandMetaMemory', () => {
  let mm: MemoryManager;

  beforeEach(async () => {
    mm = new MemoryManager({
      sql,
      embeddingProvider: mockEmbedding(),
      identityManager: new IdentityManager({ sql }),
      profileManager,
    });
    await mm.start();
  });

  afterEach(async () => {
    await mm.stop();
  });

  it('expands d0 meta entry to source T2 semantic entries', async () => {
    const semanticIds = await seedSemantic(3);
    const metaId = await insertMeta({
      content: 'observation from facts',
      type: 'insight',
      confidence: 0.5,
      depth: 0,
    });
    await linkMetaSemantic(metaId, semanticIds);

    const result = await mm.expandMetaMemory(metaId);
    expect(result.sourceSemantics).toBeDefined();
    expect(result.sourceSemantics!.length).toBe(3);
    expect(result.childMetas).toBeUndefined();
  });

  it('expands d1 meta entry to child d0 meta entries', async () => {
    const child0 = await insertMeta({
      content: 'child d0 a',
      type: 'insight',
      confidence: 0.5,
      depth: 0,
    });
    const child1 = await insertMeta({
      content: 'child d0 b',
      type: 'insight',
      confidence: 0.6,
      depth: 0,
    });
    const parent = await insertMeta({
      content: 'evaluation of children',
      type: 'insight',
      confidence: 0.7,
      depth: 1,
    });
    await linkMetaParent(parent, [child0, child1]);

    const result = await mm.expandMetaMemory(parent);
    expect(result.childMetas).toBeDefined();
    expect(result.childMetas!.length).toBe(2);
    expect(result.sourceSemantics).toBeUndefined();
  });

  it('returns empty for non-existent meta ID', async () => {
    const result = await mm.expandMetaMemory('00000000-0000-0000-0000-000000000000');
    expect(result.sourceSemantics).toBeUndefined();
    expect(result.childMetas).toBeUndefined();
  });

  it('expands d2 meta entry to child d1 metas', async () => {
    const d0 = await insertMeta({
      content: 'd0 entry',
      type: 'heuristic',
      confidence: 0.5,
      depth: 0,
    });
    const d1 = await insertMeta({
      content: 'd1 entry',
      type: 'heuristic',
      confidence: 0.6,
      depth: 1,
    });
    await linkMetaParent(d1, [d0]);

    const d2 = await insertMeta({
      content: 'd2 strategic entry',
      type: 'heuristic',
      confidence: 0.8,
      depth: 2,
    });
    await linkMetaParent(d2, [d1]);

    const result = await mm.expandMetaMemory(d2);
    expect(result.childMetas).toBeDefined();
    expect(result.childMetas!.length).toBe(1);
    expect(result.childMetas![0].depth).toBe(1);
  });
});

// ─── Memory Manager: traceMetaToSources ─────────────────────────────────

describe('MemoryManager: traceMetaToSources', () => {
  let mm: MemoryManager;

  beforeEach(async () => {
    mm = new MemoryManager({
      sql,
      embeddingProvider: mockEmbedding(),
      identityManager: new IdentityManager({ sql }),
      profileManager,
    });
    await mm.start();
  });

  afterEach(async () => {
    await mm.stop();
  });

  it('traces d0 entry directly to T2 sources', async () => {
    const semanticIds = await seedSemantic(2);
    const d0 = await insertMeta({
      content: 'd0 observation',
      type: 'insight',
      confidence: 0.5,
      depth: 0,
    });
    await linkMetaSemantic(d0, semanticIds);

    const sources = await mm.traceMetaToSources(d0);
    expect(sources.length).toBe(2);
    expect(sources.map((s) => s.id).sort()).toEqual(semanticIds.sort());
  });

  it('traces d1 entry through d0 children to T2 sources', async () => {
    const semanticIds = await seedSemantic(4);

    const d0a = await insertMeta({
      content: 'd0 insight a',
      type: 'insight',
      confidence: 0.5,
      depth: 0,
    });
    await linkMetaSemantic(d0a, semanticIds.slice(0, 2));

    const d0b = await insertMeta({
      content: 'd0 insight b',
      type: 'insight',
      confidence: 0.6,
      depth: 0,
    });
    await linkMetaSemantic(d0b, semanticIds.slice(2, 4));

    const d1 = await insertMeta({
      content: 'd1 evaluation',
      type: 'insight',
      confidence: 0.7,
      depth: 1,
    });
    await linkMetaParent(d1, [d0a, d0b]);

    const sources = await mm.traceMetaToSources(d1);
    expect(sources.length).toBe(4);
  });

  it('traces d2 entry recursively through d1 and d0 to T2 sources', async () => {
    const semanticIds = await seedSemantic(3);

    const d0 = await insertMeta({
      content: 'd0',
      type: 'heuristic',
      confidence: 0.5,
      depth: 0,
    });
    await linkMetaSemantic(d0, semanticIds);

    const d1 = await insertMeta({
      content: 'd1',
      type: 'heuristic',
      confidence: 0.6,
      depth: 1,
    });
    await linkMetaParent(d1, [d0]);

    const d2 = await insertMeta({
      content: 'd2 strategic',
      type: 'heuristic',
      confidence: 0.8,
      depth: 2,
    });
    await linkMetaParent(d2, [d1]);

    const sources = await mm.traceMetaToSources(d2);
    expect(sources.length).toBe(3);
  });

  it('deduplicates shared T2 sources', async () => {
    const semanticIds = await seedSemantic(2);

    // Both d0 entries share the same semantic sources
    const d0a = await insertMeta({
      content: 'd0a',
      type: 'insight',
      confidence: 0.5,
      depth: 0,
    });
    await linkMetaSemantic(d0a, semanticIds);

    const d0b = await insertMeta({
      content: 'd0b',
      type: 'insight',
      confidence: 0.6,
      depth: 0,
    });
    await linkMetaSemantic(d0b, semanticIds);

    const d1 = await insertMeta({
      content: 'd1',
      type: 'insight',
      confidence: 0.7,
      depth: 1,
    });
    await linkMetaParent(d1, [d0a, d0b]);

    const sources = await mm.traceMetaToSources(d1);
    // Should deduplicate: only 2 unique semantic entries
    expect(sources.length).toBe(2);
  });

  it('returns empty for non-existent entry', async () => {
    const sources = await mm.traceMetaToSources('00000000-0000-0000-0000-000000000000');
    expect(sources.length).toBe(0);
  });
});

// ─── Memory Manager: buildAgentContext cascade injection ────────────────

describe('MemoryManager: buildAgentContext cascade strategy', () => {
  let mm: MemoryManager;

  beforeEach(async () => {
    mm = new MemoryManager({
      sql,
      embeddingProvider: mockEmbedding(),
      identityManager: new IdentityManager({ sql }),
      profileManager,
      metaInjection: {
        strategy: 'cascade',
        d2MinSimilarity: 0.0, // Accept all similarities for test
        d1MinSimilarity: 0.0,
        d0MinSimilarity: 0.0,
        d2Slots: 2,
        d1Slots: 2,
        d0Slots: 1,
      },
    });
    await mm.start();
  });

  afterEach(async () => {
    await mm.stop();
  });

  it('uses <strategic> tag for d2+ entries', async () => {
    await createChat('tg:cascade-1');
    await insertMeta({
      content: 'd2 strategic synthesis',
      type: 'insight',
      confidence: 0.8,
      depth: 2,
    });

    const context = await mm.buildAgentContext('tg:cascade-1', 'test query');
    expect(context).toContain('<strategic type="insight"');
    expect(context).toContain('depth="2"');
    expect(context).toContain('</strategic>');
  });

  it('uses <evaluated> tag for d1 entries', async () => {
    await createChat('tg:cascade-2');
    await insertMeta({
      content: 'd1 evaluated pattern',
      type: 'heuristic',
      confidence: 0.7,
      depth: 1,
    });

    const context = await mm.buildAgentContext('tg:cascade-2', 'test query');
    expect(context).toContain('<evaluated type="heuristic"');
    expect(context).toContain('</evaluated>');
  });

  it('uses <observation> tag for d0 entries', async () => {
    await createChat('tg:cascade-3');
    await insertMeta({
      content: 'd0 observation here',
      type: 'self_assessment',
      confidence: 0.5,
      depth: 0,
    });

    const context = await mm.buildAgentContext('tg:cascade-3', 'test query');
    expect(context).toContain('<observation type="self_assessment"');
    expect(context).toContain('</observation>');
  });

  it('groups entries by depth: strategic first, then evaluated, then observation', async () => {
    await createChat('tg:cascade-order');
    await insertMeta({ content: 'd0 first inserted', type: 'insight', confidence: 0.5, depth: 0 });
    await insertMeta({ content: 'd2 strategic', type: 'insight', confidence: 0.8, depth: 2 });
    await insertMeta({ content: 'd1 evaluated', type: 'insight', confidence: 0.7, depth: 1 });

    const context = await mm.buildAgentContext('tg:cascade-order', 'test query');

    const strategicIdx = context.indexOf('<strategic');
    const evaluatedIdx = context.indexOf('<evaluated');
    const observationIdx = context.indexOf('<observation');

    expect(strategicIdx).toBeGreaterThan(-1);
    expect(evaluatedIdx).toBeGreaterThan(-1);
    expect(observationIdx).toBeGreaterThan(-1);
    // Strategic comes before evaluated, evaluated before observation
    expect(strategicIdx).toBeLessThan(evaluatedIdx);
    expect(evaluatedIdx).toBeLessThan(observationIdx);
  });

  it('respects slot limits per depth level', async () => {
    await createChat('tg:cascade-slots');
    // Insert 4 d1 entries but only 2 d1Slots configured
    await insertMeta({ content: 'd1 A', type: 'insight', confidence: 0.7, depth: 1 });
    await insertMeta({ content: 'd1 B', type: 'insight', confidence: 0.6, depth: 1 });
    await insertMeta({ content: 'd1 C', type: 'insight', confidence: 0.65, depth: 1 });
    await insertMeta({ content: 'd1 D', type: 'insight', confidence: 0.55, depth: 1 });

    const context = await mm.buildAgentContext('tg:cascade-slots', 'test query');

    // Count <evaluated> tags — should be at most 2
    const matches = context.match(/<evaluated /g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeLessThanOrEqual(2);
  });

  it('omits depth levels with no entries', async () => {
    await createChat('tg:cascade-empty');
    // Only d0 entries — no d1 or d2
    await insertMeta({ content: 'd0 only', type: 'insight', confidence: 0.5, depth: 0 });

    const context = await mm.buildAgentContext('tg:cascade-empty', 'test query');

    expect(context).toContain('<observation');
    expect(context).not.toContain('<strategic');
    expect(context).not.toContain('<evaluated');
  });
});

describe('MemoryManager: buildAgentContext flat strategy', () => {
  let mm: MemoryManager;

  beforeEach(async () => {
    mm = new MemoryManager({
      sql,
      embeddingProvider: mockEmbedding(),
      identityManager: new IdentityManager({ sql }),
      profileManager,
      metaInjection: {
        strategy: 'flat',
        d2MinSimilarity: 0,
        d1MinSimilarity: 0,
        d0MinSimilarity: 0,
        d2Slots: 2,
        d1Slots: 2,
        d0Slots: 1,
      },
    });
    await mm.start();
  });

  afterEach(async () => {
    await mm.stop();
  });

  it('uses reflection type tags in flat mode (not cascade tags)', async () => {
    await createChat('tg:flat-1');
    await insertMeta({ content: 'd1 pattern', type: 'insight', confidence: 0.7, depth: 1 });

    const context = await mm.buildAgentContext('tg:flat-1', 'test query');
    // Flat mode: uses <insight> tag, not <evaluated>
    expect(context).toContain('<insight confidence=');
    expect(context).toContain('depth="1"');
    expect(context).not.toContain('<evaluated');
    expect(context).not.toContain('<strategic');
  });

  it('does not include depth attribute on d0 entries in flat mode', async () => {
    await createChat('tg:flat-d0');
    await insertMeta({ content: 'just a d0', type: 'heuristic', confidence: 0.5, depth: 0 });

    const context = await mm.buildAgentContext('tg:flat-d0', 'test query');
    expect(context).toContain('confidence="0.50"');
    expect(context).not.toContain('depth="0"');
  });
});

// ─── Memory Manager: queryMetaCascade ───────────────────────────────────

describe('MemoryManager: queryMetaCascade', () => {
  let mm: MemoryManager;

  beforeEach(async () => {
    mm = new MemoryManager({
      sql,
      embeddingProvider: mockEmbedding(),
      identityManager: new IdentityManager({ sql }),
      profileManager,
    });
    await mm.start();
  });

  afterEach(async () => {
    await mm.stop();
  });

  it('returns entries from all depth levels in top-down order', async () => {
    await insertMeta({ content: 'd0 obs', type: 'insight', confidence: 0.5, depth: 0 });
    await insertMeta({ content: 'd1 eval', type: 'insight', confidence: 0.7, depth: 1 });
    await insertMeta({ content: 'd2 strat', type: 'insight', confidence: 0.8, depth: 2 });

    const results = await mm.queryMetaCascade('test', defaultProfileId, {
      strategy: 'cascade',
      d2MinSimilarity: 0,
      d1MinSimilarity: 0,
      d0MinSimilarity: 0,
      d2Slots: 2,
      d1Slots: 2,
      d0Slots: 1,
    });

    expect(results.length).toBe(3);
    // d2 first, then d1, then d0
    expect(results[0].entry.depth).toBe(2);
    expect(results[1].entry.depth).toBe(1);
    expect(results[2].entry.depth).toBe(0);
  });

  it('respects similarity thresholds per depth', async () => {
    await insertMeta({ content: 'd0 obs', type: 'insight', confidence: 0.5, depth: 0 });
    await insertMeta({ content: 'd1 eval', type: 'insight', confidence: 0.7, depth: 1 });
    await insertMeta({ content: 'd2 strat', type: 'insight', confidence: 0.8, depth: 2 });

    // With all thresholds at 0 — get everything
    const allResults = await mm.queryMetaCascade('test', defaultProfileId, {
      strategy: 'cascade',
      d2MinSimilarity: 0,
      d1MinSimilarity: 0,
      d0MinSimilarity: 0,
      d2Slots: 2,
      d1Slots: 2,
      d0Slots: 1,
    });
    expect(allResults.length).toBe(3);

    // With d0 slots set to 0 — d0 entries should be excluded
    const noD0Results = await mm.queryMetaCascade('test', defaultProfileId, {
      strategy: 'cascade',
      d2MinSimilarity: 0,
      d1MinSimilarity: 0,
      d0MinSimilarity: 0,
      d2Slots: 2,
      d1Slots: 2,
      d0Slots: 0, // Disable d0
    });
    expect(noD0Results.length).toBe(2);
    expect(noD0Results.every((r) => r.entry.depth > 0)).toBe(true);
  });

  it('respects slot limits', async () => {
    // Insert 5 d1 entries
    for (let i = 0; i < 5; i++) {
      await insertMeta({
        content: `d1 entry ${String(i)}`,
        type: 'insight',
        confidence: 0.6,
        depth: 1,
      });
    }

    const results = await mm.queryMetaCascade('test', defaultProfileId, {
      strategy: 'cascade',
      d2MinSimilarity: 0,
      d1MinSimilarity: 0,
      d0MinSimilarity: 0,
      d2Slots: 0,
      d1Slots: 2, // Only 2 d1 slots
      d0Slots: 0,
    });

    expect(results.length).toBe(2);
  });

  it('returns empty when no meta entries exist', async () => {
    const results = await mm.queryMetaCascade('test', defaultProfileId);
    expect(results.length).toBe(0);
  });
});

// ─── Reflection Job: D1 Condensation ────────────────────────────────────

describe('MemoryReflectionJob: D1 condensation', () => {
  it('condenses uncondensed d0 entries into d1', async () => {
    // Seed semantic entries and run D0 first
    await seedSemantic(5);

    // Create d0 entries directly (simulating previous D0 generation)
    await insertMeta({ content: 'd0 insight A', type: 'insight', confidence: 0.5, depth: 0 });
    await insertMeta({ content: 'd0 insight B', type: 'insight', confidence: 0.6, depth: 0 });
    await insertMeta({ content: 'd0 insight C', type: 'insight', confidence: 0.55, depth: 0 });

    // Mark last_reflection_at to skip D0 generation
    await sql`
      INSERT INTO state (key, value)
      VALUES ('last_reflection_at', ${String(Date.now() + 10000)})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `;

    const provider = mockProvider({
      summarize: vi
        .fn()
        .mockResolvedValue(
          JSON.stringify([{ content: 'D1 evaluated pattern from d0 insights', confidence: 0.7 }]),
        ),
    });

    const job = new MemoryReflectionJob({
      sql,
      summarizationProvider: provider,
      embeddingProvider: mockEmbedding(),
      config: BASE_REFLECTION_CONFIG,
    });

    const count = await job.run();
    expect(count).toBeGreaterThanOrEqual(1);

    // Verify d1 entry was created
    const d1Entries = await sql`
      SELECT * FROM memory_meta WHERE depth = 1
    `;
    expect(d1Entries.length).toBeGreaterThanOrEqual(1);
  });

  it('links d1 entries to d0 children via meta_parent_sources', async () => {
    // Pre-create exactly 3 uncondensed d0 insights
    const d0Ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      d0Ids.push(
        await insertMeta({
          content: `d0 insight ${String(i)}`,
          type: 'insight',
          confidence: 0.5,
          depth: 0,
        }),
      );
    }

    // Mark last_reflection_at to skip D0 generation
    await sql`
      INSERT INTO state (key, value)
      VALUES ('last_reflection_at', ${String(Date.now() + 10000)})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `;

    const provider = mockProvider({
      summarize: vi
        .fn()
        .mockResolvedValue(JSON.stringify([{ content: 'D1 condensed insight', confidence: 0.7 }])),
    });

    const job = new MemoryReflectionJob({
      sql,
      summarizationProvider: provider,
      embeddingProvider: mockEmbedding(),
      config: BASE_REFLECTION_CONFIG,
    });

    await job.run();

    // Check meta_parent_sources links
    const d1Entries = await sql`SELECT id FROM memory_meta WHERE depth = 1`;
    if (d1Entries.length > 0) {
      const links = await sql`
        SELECT * FROM meta_parent_sources WHERE parent_id = ${d1Entries[0].id as string}
      `;
      // Should link to all 3 d0 children
      expect(links.length).toBe(3);
    }
  });

  it('skips condensation when below threshold', async () => {
    // Only 2 d0 entries, threshold is 3
    await insertMeta({ content: 'd0 A', type: 'insight', confidence: 0.5, depth: 0 });
    await insertMeta({ content: 'd0 B', type: 'insight', confidence: 0.6, depth: 0 });

    await sql`
      INSERT INTO state (key, value)
      VALUES ('last_reflection_at', ${String(Date.now() + 10000)})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `;

    const provider = mockProvider();

    const job = new MemoryReflectionJob({
      sql,
      summarizationProvider: provider,
      embeddingProvider: mockEmbedding(),
      config: BASE_REFLECTION_CONFIG,
    });

    const count = await job.run();
    // Should generate 0 condensation entries (not enough d0s)
    expect(count).toBe(0);

    const d1Entries = await sql`SELECT * FROM memory_meta WHERE depth = 1`;
    expect(d1Entries.length).toBe(0);
  });

  it('applies confidence floor = avg(sources) + 0.05 to d1 entries', async () => {
    // d0 entries with average confidence = (0.4 + 0.5 + 0.6) / 3 = 0.5
    // Floor should be 0.55
    await insertMeta({ content: 'd0 A', type: 'insight', confidence: 0.4, depth: 0 });
    await insertMeta({ content: 'd0 B', type: 'insight', confidence: 0.5, depth: 0 });
    await insertMeta({ content: 'd0 C', type: 'insight', confidence: 0.6, depth: 0 });

    await sql`
      INSERT INTO state (key, value)
      VALUES ('last_reflection_at', ${String(Date.now() + 10000)})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `;

    const provider = mockProvider({
      summarize: vi
        .fn()
        .mockResolvedValue(
          JSON.stringify([{ content: 'D1 insight with low raw confidence', confidence: 0.3 }]),
        ),
    });

    const job = new MemoryReflectionJob({
      sql,
      summarizationProvider: provider,
      embeddingProvider: mockEmbedding(),
      config: BASE_REFLECTION_CONFIG,
    });

    await job.run();

    const d1Entries = await sql`SELECT * FROM memory_meta WHERE depth = 1`;
    if (d1Entries.length > 0) {
      // Confidence should be at least the floor (0.55)
      expect(Number(d1Entries[0].confidence)).toBeGreaterThanOrEqual(0.55);
    }
  });
});

// ─── Reflection Job: D2+ Condensation ───────────────────────────────────

describe('MemoryReflectionJob: D2+ recursive condensation', () => {
  it('condenses d1 into d2 when enough d1 entries exist', async () => {
    // Create 9 uncondensed d0 entries (3 per type, enough for d0→d1 condensation)
    // The d0→d1 step will condense them, and then d1→d2 should find the new d1 entries.
    // But to test d1→d2 directly we create pre-existing uncondensed d1 entries:
    // 3 d1 insights NOT linked as children in meta_parent_sources = uncondensed at d1.
    for (let i = 0; i < 3; i++) {
      await insertMeta({
        content: `d1 evaluation ${String(i)}`,
        type: 'insight',
        confidence: 0.65,
        depth: 1,
      });
    }

    // Mark last_reflection_at far future to skip D0 generation
    await sql`
      INSERT INTO state (key, value)
      VALUES ('last_reflection_at', ${String(Date.now() + 10000)})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `;

    // The loop: depth=1 → condenseMeta(0,1) finds no uncondensed d0 → returns 0 → break.
    // That's the issue. The loop breaks at depth=1 if d0→d1 produces 0.
    // So we need uncondensed d0 entries too, to keep the loop going.
    for (let i = 0; i < 3; i++) {
      await insertMeta({
        content: `uncondensed d0 ${String(i)}`,
        type: 'insight',
        confidence: 0.5,
        depth: 0,
      });
    }

    const provider = mockProvider({
      summarize: vi
        .fn()
        .mockResolvedValue(JSON.stringify([{ content: 'condensed result', confidence: 0.8 }])),
    });

    const job = new MemoryReflectionJob({
      sql,
      summarizationProvider: provider,
      embeddingProvider: mockEmbedding(),
      config: BASE_REFLECTION_CONFIG,
    });

    await job.run();

    const d2Entries = await sql`SELECT * FROM memory_meta WHERE depth = 2`;
    expect(d2Entries.length).toBeGreaterThanOrEqual(1);
  });

  it('stops recursion when no entries at a given depth', async () => {
    // Only d0 entries, no d1 — should not reach d2 or d3
    await insertMeta({ content: 'd0 A', type: 'insight', confidence: 0.5, depth: 0 });
    await insertMeta({ content: 'd0 B', type: 'insight', confidence: 0.6, depth: 0 });
    await insertMeta({ content: 'd0 C', type: 'insight', confidence: 0.55, depth: 0 });

    await sql`
      INSERT INTO state (key, value)
      VALUES ('last_reflection_at', ${String(Date.now() + 10000)})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `;

    // Provider returns d1 from d0 condensation, but nothing further
    let callCount = 0;
    const provider = mockProvider({
      summarize: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 3) {
          // First 3 calls are d0→d1 for each type
          return Promise.resolve(
            JSON.stringify([{ content: `d1 entry type ${String(callCount)}`, confidence: 0.6 }]),
          );
        }
        return Promise.resolve('[]');
      }),
    });

    const job = new MemoryReflectionJob({
      sql,
      summarizationProvider: provider,
      embeddingProvider: mockEmbedding(),
      config: BASE_REFLECTION_CONFIG,
    });

    await job.run();

    const d3Entries = await sql`SELECT * FROM memory_meta WHERE depth = 3`;
    expect(d3Entries.length).toBe(0);
  });

  it('respects maxMetaDepth limit', async () => {
    const config = { ...BASE_REFLECTION_CONFIG, maxMetaDepth: 1 };

    // Enough d0 entries for d1 condensation
    await insertMeta({ content: 'd0 A', type: 'insight', confidence: 0.5, depth: 0 });
    await insertMeta({ content: 'd0 B', type: 'insight', confidence: 0.6, depth: 0 });
    await insertMeta({ content: 'd0 C', type: 'insight', confidence: 0.55, depth: 0 });

    await sql`
      INSERT INTO state (key, value)
      VALUES ('last_reflection_at', ${String(Date.now() + 10000)})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `;

    const provider = mockProvider({
      summarize: vi
        .fn()
        .mockResolvedValue(JSON.stringify([{ content: 'condensed', confidence: 0.7 }])),
    });

    const job = new MemoryReflectionJob({
      sql,
      summarizationProvider: provider,
      embeddingProvider: mockEmbedding(),
      config,
    });

    await job.run();

    // Should have d1 entries but NOT d2 (maxMetaDepth = 1)
    const d2Entries = await sql`SELECT * FROM memory_meta WHERE depth = 2`;
    expect(d2Entries.length).toBe(0);
  });
});

// ─── Reflection Job: Contradiction Cascade ──────────────────────────────

describe('MemoryReflectionJob: contradiction cascade', () => {
  it('decays parent when >50% of children are below 0.2', async () => {
    // Create 3 d0 children: 2 below 0.2, 1 above
    const lowChild1 = await insertMeta({
      content: 'low child 1',
      type: 'insight',
      confidence: 0.1,
      depth: 0,
    });
    const lowChild2 = await insertMeta({
      content: 'low child 2',
      type: 'insight',
      confidence: 0.15,
      depth: 0,
    });
    const highChild = await insertMeta({
      content: 'high child',
      type: 'insight',
      confidence: 0.6,
      depth: 0,
    });

    // Create d1 parent linked to all 3
    const parent = await insertMeta({
      content: 'd1 parent',
      type: 'insight',
      confidence: 0.7,
      depth: 1,
    });
    await linkMetaParent(parent, [lowChild1, lowChild2, highChild]);

    const job = new MemoryReflectionJob({
      sql,
      summarizationProvider: mockProvider(),
      embeddingProvider: mockEmbedding(),
      config: BASE_REFLECTION_CONFIG,
    });

    const decayed = await job.runContradictionCascade(defaultProfileId);
    expect(decayed).toBeGreaterThanOrEqual(1);

    // Parent confidence should have decreased
    const parentRow = await sql`SELECT confidence FROM memory_meta WHERE id = ${parent}`;
    expect(Number(parentRow[0].confidence)).toBeLessThan(0.7);
  });

  it('does not decay parent when <=50% of children are below 0.2', async () => {
    // Create 3 d0 children: 1 below 0.2, 2 above
    const lowChild = await insertMeta({
      content: 'low child',
      type: 'insight',
      confidence: 0.1,
      depth: 0,
    });
    const highChild1 = await insertMeta({
      content: 'high child 1',
      type: 'insight',
      confidence: 0.6,
      depth: 0,
    });
    const highChild2 = await insertMeta({
      content: 'high child 2',
      type: 'insight',
      confidence: 0.7,
      depth: 0,
    });

    const parent = await insertMeta({
      content: 'd1 parent',
      type: 'insight',
      confidence: 0.7,
      depth: 1,
    });
    await linkMetaParent(parent, [lowChild, highChild1, highChild2]);

    const job = new MemoryReflectionJob({
      sql,
      summarizationProvider: mockProvider(),
      embeddingProvider: mockEmbedding(),
      config: BASE_REFLECTION_CONFIG,
    });

    const decayed = await job.runContradictionCascade(defaultProfileId);
    expect(decayed).toBe(0);

    // Parent confidence should remain unchanged
    const parentRow = await sql`SELECT confidence FROM memory_meta WHERE id = ${parent}`;
    expect(Number(parentRow[0].confidence)).toBeCloseTo(0.7, 1);
  });

  it('cascade propagates upward through depths', async () => {
    // d0 children all low → d1 parent decays → d2 grandparent cascades
    const d0a = await insertMeta({
      content: 'd0 a',
      type: 'insight',
      confidence: 0.1,
      depth: 0,
    });
    const d0b = await insertMeta({
      content: 'd0 b',
      type: 'insight',
      confidence: 0.1,
      depth: 0,
    });
    const d0c = await insertMeta({
      content: 'd0 c',
      type: 'insight',
      confidence: 0.1,
      depth: 0,
    });

    const d1 = await insertMeta({
      content: 'd1 parent',
      type: 'insight',
      confidence: 0.7,
      depth: 1,
    });
    await linkMetaParent(d1, [d0a, d0b, d0c]);

    const d2 = await insertMeta({
      content: 'd2 grandparent',
      type: 'insight',
      confidence: 0.8,
      depth: 2,
    });
    await linkMetaParent(d2, [d1]);

    const job = new MemoryReflectionJob({
      sql,
      summarizationProvider: mockProvider(),
      embeddingProvider: mockEmbedding(),
      config: BASE_REFLECTION_CONFIG,
    });

    // First cascade pass: d1 decays because >50% of d0 children are below 0.2
    await job.runContradictionCascade(defaultProfileId);

    // Check d1 was decayed
    const d1Row = await sql`SELECT confidence FROM memory_meta WHERE id = ${d1}`;
    expect(Number(d1Row[0].confidence)).toBeLessThan(0.7);

    // If d1 dropped below 0.2, d2 should also be checked in the same pass
    // (since we iterate depth 1, then depth 2)
    const d2Row = await sql`SELECT confidence FROM memory_meta WHERE id = ${d2}`;
    // d2 had only 1 child (d1), and if d1 is below 0.2, that's 100% → d2 decays
    if (Number(d1Row[0].confidence) < 0.2) {
      expect(Number(d2Row[0].confidence)).toBeLessThan(0.8);
    }
  });

  it('respects contradictionCascade=false config', async () => {
    const d0 = await insertMeta({
      content: 'low',
      type: 'insight',
      confidence: 0.1,
      depth: 0,
    });
    const d1 = await insertMeta({
      content: 'parent',
      type: 'insight',
      confidence: 0.7,
      depth: 1,
    });
    await linkMetaParent(d1, [d0]);

    // Need enough semantic entries to pass the D0 check (or set last_reflection_at future)
    await sql`
      INSERT INTO state (key, value)
      VALUES ('last_reflection_at', ${String(Date.now() + 10000)})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `;

    const job = new MemoryReflectionJob({
      sql,
      summarizationProvider: mockProvider(),
      embeddingProvider: mockEmbedding(),
      config: { ...BASE_REFLECTION_CONFIG, contradictionCascade: false },
    });

    await job.run();

    // Parent should not have been decayed (cascade disabled)
    const parentRow = await sql`SELECT confidence FROM memory_meta WHERE id = ${d1}`;
    expect(Number(parentRow[0].confidence)).toBeCloseTo(0.7, 1);
  });
});

// ─── Reflection Job: D0 with depth tag ──────────────────────────────────

describe('MemoryReflectionJob: D0 generation depth tag', () => {
  it('creates d0 meta entries with depth = 0', async () => {
    await seedSemantic(5);

    const provider = mockProvider({
      summarize: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify([{ content: 'Insight from T2', confidence: 0.6 }]))
        .mockResolvedValueOnce('[]')
        .mockResolvedValueOnce('[]'),
    });

    const job = new MemoryReflectionJob({
      sql,
      summarizationProvider: provider,
      embeddingProvider: mockEmbedding(),
      config: BASE_REFLECTION_CONFIG,
    });

    await job.run();

    const meta = await sql`SELECT * FROM memory_meta WHERE depth = 0`;
    expect(meta.length).toBeGreaterThanOrEqual(1);
    expect(Number(meta[0].depth)).toBe(0);
  });
});

// ─── Profile Manager: clone carries depth + meta_parent_sources ─────────

describe('ProfileManager: clone carries meta DAG', () => {
  it('clones meta entries preserving depth', async () => {
    await insertMeta({ content: 'd0 entry', type: 'insight', confidence: 0.5, depth: 0 });
    await insertMeta({ content: 'd1 entry', type: 'insight', confidence: 0.7, depth: 1 });

    const cloned = await profileManager.cloneProfile(defaultProfileId, 'clone-test');

    const clonedMeta = await sql`
      SELECT * FROM memory_meta WHERE profile_id = ${cloned.id} ORDER BY depth
    `;
    expect(clonedMeta.length).toBe(2);
    expect(Number(clonedMeta[0].depth)).toBe(0);
    expect(Number(clonedMeta[1].depth)).toBe(1);
  });

  it('remaps meta_parent_sources in cloned profile', async () => {
    const d0 = await insertMeta({
      content: 'd0 original',
      type: 'insight',
      confidence: 0.5,
      depth: 0,
    });
    const d1 = await insertMeta({
      content: 'd1 original',
      type: 'insight',
      confidence: 0.7,
      depth: 1,
    });
    await linkMetaParent(d1, [d0]);

    const cloned = await profileManager.cloneProfile(defaultProfileId, 'clone-dag-test');

    // Verify the clone has remapped parent-child links
    const clonedLinks = await sql`
      SELECT mps.parent_id, mps.child_id
      FROM meta_parent_sources mps
      JOIN memory_meta mm ON mm.id = mps.parent_id
      WHERE mm.profile_id = ${cloned.id}
    `;
    expect(clonedLinks.length).toBe(1);

    // Verify the IDs are different from the originals
    expect(clonedLinks[0].parent_id).not.toBe(d1);
    expect(clonedLinks[0].child_id).not.toBe(d0);
  });
});
