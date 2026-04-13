import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryReflectionJob } from '../src/orchestrator/reflection.js';
import { createTestDatabase, applySchema } from './helpers/pg-container.js';
import type { Sql } from '../src/orchestrator/connection.js';
import type { MemorySummarizationProvider, EmbeddingProvider } from '../src/orchestrator/types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

let sql: Sql;
let cleanup: () => Promise<void>;
let defaultProfileId: string;

function makeMockProvider(
  overrides: Partial<MemorySummarizationProvider> = {},
): MemorySummarizationProvider {
  return {
    summarize: vi.fn().mockResolvedValue('[]'),
    ...overrides,
  };
}

function makeMockEmbedding(overrides: Partial<EmbeddingProvider> = {}): EmbeddingProvider {
  return {
    embed: vi.fn().mockResolvedValue(Array(384).fill(0.01)),
    embedBatch: vi.fn().mockResolvedValue([Array(384).fill(0.01)]),
    dimensions: 384,
    ...overrides,
  };
}

const DEFAULT_CONFIG = {
  enabled: true,
  schedule: '0 3 * * *',
  reflectionModel: 'claude-haiku-4-5-20251001',
  maxInputTokens: 4000,
  minSemanticEntries: 3,
  confidenceThreshold: 0.3,
};

async function seedSemanticEntries(count: number, createdAt?: number): Promise<void> {
  const now = createdAt ?? Date.now();
  const embeddingStr = `[${Array(384).fill(0.02).join(',')}]`;
  for (let i = 0; i < count; i++) {
    await sql.unsafe(
      `INSERT INTO memory_semantic
        (content, embedding, memory_type, importance, depth, token_count,
         profile_id, created_at, updated_at, last_accessed, access_count)
      VALUES (
        $1, '${embeddingStr}',
        'fact', 0.6, 0, 10,
        $2, $3, $4, $5, 0
      )`,
      ['Semantic entry ' + String(i), defaultProfileId, now + i, now + i, now + i],
    );
  }
}

// ─── Setup / Teardown ────────────────────────────────────────────────────

beforeEach(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;
  await applySchema(sql);
  const profileRows = await sql`SELECT id FROM agent_profiles WHERE is_default = true LIMIT 1`;
  defaultProfileId = profileRows[0].id as string;
});

afterEach(async () => {
  await cleanup();
});

// ─── Tests ───────────────────────────────────────────────────────────────

describe('MemoryReflectionJob', () => {
  it('returns 0 when disabled', async () => {
    const job = new MemoryReflectionJob({
      sql,
      summarizationProvider: makeMockProvider(),
      embeddingProvider: makeMockEmbedding(),
      config: { ...DEFAULT_CONFIG, enabled: false },
    });

    const count = await job.run();
    expect(count).toBe(0);
  });

  it('returns 0 when not enough semantic entries since last reflection', async () => {
    // Seed fewer than minSemanticEntries
    await seedSemanticEntries(2);

    const job = new MemoryReflectionJob({
      sql,
      summarizationProvider: makeMockProvider(),
      embeddingProvider: makeMockEmbedding(),
      config: DEFAULT_CONFIG,
    });

    const count = await job.run();
    expect(count).toBe(0);
  });

  it('generates insights from semantic entries', async () => {
    await seedSemanticEntries(5);

    const provider = makeMockProvider({
      summarize: vi
        .fn()
        .mockResolvedValueOnce(
          JSON.stringify([
            { content: 'User prefers concise responses across all topics.', confidence: 0.6 },
          ]),
        )
        .mockResolvedValueOnce('[]') // heuristics
        .mockResolvedValueOnce('[]'), // self-assessment
    });

    const job = new MemoryReflectionJob({
      sql,
      summarizationProvider: provider,
      embeddingProvider: makeMockEmbedding(),
      config: DEFAULT_CONFIG,
    });

    const count = await job.run();
    expect(count).toBe(1);

    // Verify meta entry was created
    const meta = await sql`SELECT * FROM memory_meta WHERE reflection_type = 'insight'`;
    expect(meta.length).toBe(1);
    expect(meta[0].content).toBe('User prefers concise responses across all topics.');
    expect(Number(meta[0].confidence)).toBeCloseTo(0.6, 1);
  });

  it('generates heuristics from semantic entries', async () => {
    await seedSemanticEntries(5);

    const provider = makeMockProvider({
      summarize: vi
        .fn()
        .mockResolvedValueOnce('[]') // insights
        .mockResolvedValueOnce(
          JSON.stringify([{ content: 'Always confirm before deleting files.', confidence: 0.7 }]),
        )
        .mockResolvedValueOnce('[]'), // self-assessment
    });

    const job = new MemoryReflectionJob({
      sql,
      summarizationProvider: provider,
      embeddingProvider: makeMockEmbedding(),
      config: DEFAULT_CONFIG,
    });

    const count = await job.run();
    expect(count).toBe(1);

    const meta = await sql`SELECT * FROM memory_meta WHERE reflection_type = 'heuristic'`;
    expect(meta.length).toBe(1);
    expect(meta[0].content).toBe('Always confirm before deleting files.');
  });

  it('generates self-assessments from semantic entries', async () => {
    await seedSemanticEntries(5);

    const provider = makeMockProvider({
      summarize: vi
        .fn()
        .mockResolvedValueOnce('[]') // insights
        .mockResolvedValueOnce('[]') // heuristics
        .mockResolvedValueOnce(
          JSON.stringify([
            { content: 'Strong at code generation, weak at UI design feedback.', confidence: 0.5 },
          ]),
        ),
    });

    const job = new MemoryReflectionJob({
      sql,
      summarizationProvider: provider,
      embeddingProvider: makeMockEmbedding(),
      config: DEFAULT_CONFIG,
    });

    const count = await job.run();
    expect(count).toBe(1);

    const meta = await sql`SELECT * FROM memory_meta WHERE reflection_type = 'self_assessment'`;
    expect(meta.length).toBe(1);
  });

  it('links meta entries to source semantic entries', async () => {
    await seedSemanticEntries(4);

    const provider = makeMockProvider({
      summarize: vi
        .fn()
        .mockResolvedValueOnce(
          JSON.stringify([{ content: 'Cross-cutting insight.', confidence: 0.5 }]),
        )
        .mockResolvedValueOnce('[]')
        .mockResolvedValueOnce('[]'),
    });

    const job = new MemoryReflectionJob({
      sql,
      summarizationProvider: provider,
      embeddingProvider: makeMockEmbedding(),
      config: DEFAULT_CONFIG,
    });

    await job.run();

    // Each meta entry should be linked to all source semantic entries
    const links = await sql`SELECT * FROM memory_meta_sources`;
    expect(links.length).toBe(4); // 4 source entries × 1 meta entry
  });

  it('updates last_reflection_at in state table', async () => {
    await seedSemanticEntries(5);

    const job = new MemoryReflectionJob({
      sql,
      summarizationProvider: makeMockProvider(),
      embeddingProvider: makeMockEmbedding(),
      config: DEFAULT_CONFIG,
    });

    const before = Date.now();
    await job.run();

    const stateRows = await sql`
      SELECT value FROM state WHERE key = 'last_reflection_at'
    `;
    expect(stateRows.length).toBe(1);
    expect(Number(stateRows[0].value)).toBeGreaterThanOrEqual(before);
  });

  it('prevents concurrent runs (re-entrancy guard)', async () => {
    await seedSemanticEntries(5);

    const provider = makeMockProvider({
      summarize: vi
        .fn()
        .mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve('[]'), 200))),
    });

    const job = new MemoryReflectionJob({
      sql,
      summarizationProvider: provider,
      embeddingProvider: makeMockEmbedding(),
      config: DEFAULT_CONFIG,
    });

    const [count1, count2] = await Promise.all([job.run(), job.run()]);
    // One should run, the other should return 0
    expect(Math.min(count1, count2)).toBe(0);
  });

  it('clamps confidence to the configured threshold minimum', async () => {
    await seedSemanticEntries(5);

    const provider = makeMockProvider({
      summarize: vi
        .fn()
        .mockResolvedValueOnce(
          JSON.stringify([
            { content: 'Low confidence insight.', confidence: 0.1 }, // Below threshold of 0.3
          ]),
        )
        .mockResolvedValueOnce('[]')
        .mockResolvedValueOnce('[]'),
    });

    const job = new MemoryReflectionJob({
      sql,
      summarizationProvider: provider,
      embeddingProvider: makeMockEmbedding(),
      config: DEFAULT_CONFIG,
    });

    await job.run();

    const meta = await sql`SELECT * FROM memory_meta`;
    expect(meta.length).toBe(1);
    // Confidence should be clamped to the threshold (0.3), not the raw 0.1
    expect(Number(meta[0].confidence)).toBeGreaterThanOrEqual(0.3);
  });

  it('handles malformed JSON from provider gracefully', async () => {
    await seedSemanticEntries(5);

    const provider = makeMockProvider({
      summarize: vi
        .fn()
        .mockResolvedValueOnce('not valid json!!!')
        .mockResolvedValueOnce('{broken}')
        .mockResolvedValueOnce('[]'),
    });

    const job = new MemoryReflectionJob({
      sql,
      summarizationProvider: provider,
      embeddingProvider: makeMockEmbedding(),
      config: DEFAULT_CONFIG,
    });

    // Should not throw
    const count = await job.run();
    expect(count).toBe(0);

    // No meta entries should exist
    const meta = await sql`SELECT * FROM memory_meta`;
    expect(meta.length).toBe(0);
  });

  it('only reflects on entries created since last reflection', async () => {
    // First, set a last_reflection_at timestamp
    const cutoff = Date.now();
    await sql`
      INSERT INTO state (key, value) VALUES ('last_reflection_at', ${String(cutoff)})
    `;

    // Seed entries BEFORE the cutoff (should be ignored)
    await seedSemanticEntries(10, cutoff - 10000);

    const job = new MemoryReflectionJob({
      sql,
      summarizationProvider: makeMockProvider(),
      embeddingProvider: makeMockEmbedding(),
      config: DEFAULT_CONFIG,
    });

    const count = await job.run();
    // Should return 0 because all entries are before last_reflection_at
    expect(count).toBe(0);
  });
});
