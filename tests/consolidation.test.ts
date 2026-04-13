import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryConsolidationJob } from '../src/orchestrator/consolidation.js';
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
    summarize: vi.fn().mockResolvedValue('This is a summary of the conversation.'),
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
  schedule: '0 */6 * * *',
  consolidationModel: 'claude-haiku-4-5-20251001',
  minUnconsolidatedMessages: 5,
  chunkSize: 5,
  consolidationThreshold: 3,
  d0MaxTokens: 400,
  d1MaxTokens: 500,
};

async function insertSession(chatId: string, ended = true): Promise<string> {
  const rows = await sql`
    INSERT INTO sessions (chat_id, started_at, ended_at)
    VALUES (${chatId}, ${Date.now() - 10000}, ${ended ? Date.now() : null})
    RETURNING id
  `;
  return rows[0].id as string;
}

async function insertChat(chatId: string): Promise<void> {
  await sql`
    INSERT INTO chats (id, channel, external_id, profile_id, created_at, updated_at)
    VALUES (${chatId}, 'telegram', ${chatId}, ${defaultProfileId}, ${Date.now()}, ${Date.now()})
    ON CONFLICT DO NOTHING
  `;
}

async function insertWorkingMemory(
  chatId: string,
  sessionId: string,
  content: string,
  senderName = 'user',
  isBotMessage = false,
): Promise<string> {
  const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await sql`
    INSERT INTO memory_working
      (id, chat_id, sender_id, sender_name, content,
       timestamp, is_from_me, is_bot_message, session_id)
    VALUES (${id}, ${chatId}, ${chatId}, ${senderName},
            ${content}, ${Date.now()}, ${false}, ${isBotMessage}, ${sessionId})
  `;
  return id;
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

describe('MemoryConsolidationJob', () => {
  it('returns 0 when no unconsolidated messages exist', async () => {
    const job = new MemoryConsolidationJob({
      sql,
      summarizationProvider: makeMockProvider(),
      embeddingProvider: makeMockEmbedding(),
      config: DEFAULT_CONFIG,
    });

    const count = await job.run();
    expect(count).toBe(0);
  });

  it('returns 0 when below minUnconsolidatedMessages threshold', async () => {
    const chatId = 'chat-consolidation-threshold';
    await insertChat(chatId);
    const sessionId = await insertSession(chatId, true);

    // Insert fewer than minUnconsolidatedMessages (5)
    for (let i = 0; i < 3; i++) {
      await insertWorkingMemory(chatId, sessionId, `Message ${i}`);
    }

    const job = new MemoryConsolidationJob({
      sql,
      summarizationProvider: makeMockProvider(),
      embeddingProvider: makeMockEmbedding(),
      config: DEFAULT_CONFIG,
    });

    const count = await job.run();
    expect(count).toBe(0);
  });

  it('consolidates ended sessions into d0 summaries', async () => {
    const chatId = 'chat-d0';
    await insertChat(chatId);
    const sessionId = await insertSession(chatId, true);

    for (let i = 0; i < 6; i++) {
      await insertWorkingMemory(chatId, sessionId, `Test message number ${i}`);
    }

    const provider = makeMockProvider();
    const job = new MemoryConsolidationJob({
      sql,
      summarizationProvider: provider,
      embeddingProvider: makeMockEmbedding(),
      config: DEFAULT_CONFIG,
    });

    const count = await job.run();
    expect(count).toBe(1); // One session processed

    // Verify d0 summary was stored in memory_semantic
    const summaries = await sql`
      SELECT * FROM memory_semantic WHERE memory_type = 'summary' AND depth = 0
    `;
    expect(summaries.length).toBeGreaterThanOrEqual(1);
    expect(summaries[0].source_session).toBe(sessionId);
  });

  it('links d0 summaries to source messages via summary_message_sources', async () => {
    const chatId = 'chat-dag-links';
    await insertChat(chatId);
    const sessionId = await insertSession(chatId, true);

    const messageIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = await insertWorkingMemory(chatId, sessionId, `Link test msg ${i}`);
      messageIds.push(id);
    }

    const job = new MemoryConsolidationJob({
      sql,
      summarizationProvider: makeMockProvider(),
      embeddingProvider: makeMockEmbedding(),
      config: DEFAULT_CONFIG,
    });

    await job.run();

    // All messages should be linked to a summary
    const links = await sql`
      SELECT * FROM summary_message_sources WHERE chat_id = ${chatId}
    `;
    expect(links.length).toBe(5);

    // Each original message should be linked
    for (const msgId of messageIds) {
      const found = links.find((l) => l.message_id === msgId);
      expect(found).toBeDefined();
    }
  });

  it('chunks messages by chunkSize', async () => {
    const chatId = 'chat-chunks';
    await insertChat(chatId);
    const sessionId = await insertSession(chatId, true);

    // Insert 12 messages with chunkSize=5 → 3 chunks (5+5+2)
    for (let i = 0; i < 12; i++) {
      await insertWorkingMemory(chatId, sessionId, `Chunk msg ${i}`);
    }

    const provider = makeMockProvider();
    const job = new MemoryConsolidationJob({
      sql,
      summarizationProvider: provider,
      embeddingProvider: makeMockEmbedding(),
      config: DEFAULT_CONFIG,
    });

    await job.run();

    // Should have created 3 d0 summaries (one per chunk)
    const summaries = await sql`
      SELECT * FROM memory_semantic WHERE memory_type = 'summary' AND depth = 0
    `;
    expect(summaries.length).toBe(3);
  });

  it('extracts facts from summarized messages', async () => {
    const chatId = 'chat-facts';
    await insertChat(chatId);
    const sessionId = await insertSession(chatId, true);

    for (let i = 0; i < 5; i++) {
      await insertWorkingMemory(chatId, sessionId, `Fact extraction msg ${i}`);
    }

    const provider = makeMockProvider({
      summarize: vi
        .fn()
        .mockResolvedValueOnce('Summary of the conversation.') // d0 summary
        .mockResolvedValueOnce(
          JSON.stringify([
            // fact extraction
            { content: 'User prefers dark mode', type: 'preference', importance: 0.7 },
            { content: 'User uses TypeScript', type: 'fact', importance: 0.5 },
          ]),
        ),
    });

    const job = new MemoryConsolidationJob({
      sql,
      summarizationProvider: provider,
      embeddingProvider: makeMockEmbedding(),
      config: DEFAULT_CONFIG,
    });

    await job.run();

    // Check that extracted facts were stored
    const facts = await sql`
      SELECT * FROM memory_semantic WHERE memory_type IN ('preference', 'fact')
    `;
    expect(facts.length).toBe(2);
    expect(facts.map((f) => f.content)).toContain('User prefers dark mode');
    expect(facts.map((f) => f.content)).toContain('User uses TypeScript');
  });

  it('handles malformed JSON from fact extraction gracefully', async () => {
    const chatId = 'chat-malformed';
    await insertChat(chatId);
    const sessionId = await insertSession(chatId, true);

    for (let i = 0; i < 5; i++) {
      await insertWorkingMemory(chatId, sessionId, `Malformed msg ${i}`);
    }

    const provider = makeMockProvider({
      summarize: vi
        .fn()
        .mockResolvedValueOnce('Summary text.') // d0 summary
        .mockResolvedValueOnce('not valid json {{{'), // malformed fact extraction
    });

    const job = new MemoryConsolidationJob({
      sql,
      summarizationProvider: provider,
      embeddingProvider: makeMockEmbedding(),
      config: DEFAULT_CONFIG,
    });

    // Should not throw — fact extraction is best-effort
    const count = await job.run();
    expect(count).toBe(1);

    // Summary should still be created, but no facts
    const summaries = await sql`
      SELECT * FROM memory_semantic WHERE memory_type = 'summary'
    `;
    expect(summaries.length).toBe(1);

    const facts = await sql`
      SELECT * FROM memory_semantic WHERE memory_type NOT IN ('summary')
    `;
    expect(facts.length).toBe(0);
  });

  it('skips sessions that are not yet ended', async () => {
    const chatId = 'chat-open-session';
    await insertChat(chatId);
    const endedSessionId = await insertSession(chatId, true);
    const _openSessionId = await insertSession(chatId, false);

    // Put enough messages in the ended session to meet threshold
    for (let i = 0; i < 6; i++) {
      await insertWorkingMemory(chatId, endedSessionId, `Ended msg ${i}`);
    }
    // Put messages in the open session
    for (let i = 0; i < 6; i++) {
      await insertWorkingMemory(chatId, _openSessionId, `Open msg ${i}`);
    }

    const job = new MemoryConsolidationJob({
      sql,
      summarizationProvider: makeMockProvider(),
      embeddingProvider: makeMockEmbedding(),
      config: { ...DEFAULT_CONFIG, minUnconsolidatedMessages: 5 },
    });

    const count = await job.run();
    // Only the ended session should be processed
    expect(count).toBe(1);
  });

  it('prevents concurrent runs (re-entrancy guard)', async () => {
    const chatId = 'chat-reentrant';
    await insertChat(chatId);
    const sessionId = await insertSession(chatId, true);
    for (let i = 0; i < 5; i++) {
      await insertWorkingMemory(chatId, sessionId, `Reentrant msg ${i}`);
    }

    // Slow provider to simulate long-running consolidation
    const provider = makeMockProvider({
      summarize: vi
        .fn()
        .mockImplementation(
          () => new Promise((resolve) => setTimeout(() => resolve('summary'), 200)),
        ),
    });

    const job = new MemoryConsolidationJob({
      sql,
      summarizationProvider: provider,
      embeddingProvider: makeMockEmbedding(),
      config: DEFAULT_CONFIG,
    });

    // Start two runs concurrently
    const [count1, count2] = await Promise.all([job.run(), job.run()]);

    // One should process, the other should return 0
    expect(count1 + count2).toBe(1);
  });

  it('updates last_consolidation_at in state table', async () => {
    const chatId = 'chat-state-ts';
    await insertChat(chatId);
    const sessionId = await insertSession(chatId, true);
    for (let i = 0; i < 5; i++) {
      await insertWorkingMemory(chatId, sessionId, `State msg ${i}`);
    }

    const job = new MemoryConsolidationJob({
      sql,
      summarizationProvider: makeMockProvider(),
      embeddingProvider: makeMockEmbedding(),
      config: DEFAULT_CONFIG,
    });

    const before = Date.now();
    await job.run();

    const stateRows = await sql`
      SELECT value FROM state WHERE key = 'last_consolidation_at'
    `;
    expect(stateRows.length).toBe(1);
    expect(Number(stateRows[0].value)).toBeGreaterThanOrEqual(before);
  });

  it('condenses d0 summaries into d1 when consolidationThreshold is met', async () => {
    const chatId = 'chat-d1';
    await insertChat(chatId);

    // Create one ended session with enough messages to generate 3+ d0 summaries.
    // chunkSize = 5, consolidationThreshold = 3, so 15 messages → 3 d0 chunks.
    const sessionId = await insertSession(chatId, true);
    for (let i = 0; i < 15; i++) {
      await insertWorkingMemory(chatId, sessionId, `Session msg ${i}`);
    }

    let callCount = 0;
    const provider = makeMockProvider({
      summarize: vi.fn().mockImplementation(() => {
        callCount++;
        // First 3 calls: d0 summaries for each chunk of 5 messages
        // Next 3 calls: fact extraction for each chunk
        // Final call: d1 condensation
        if (callCount <= 3) return Promise.resolve('D0 session summary.');
        if (callCount <= 6) return Promise.resolve('[]'); // fact extraction
        return Promise.resolve('Condensed d1 overview.');
      }),
    });

    const job = new MemoryConsolidationJob({
      sql,
      summarizationProvider: provider,
      embeddingProvider: makeMockEmbedding(),
      config: DEFAULT_CONFIG,
    });

    await job.run();

    // Check for d1 summary
    const d1Summaries = await sql`
      SELECT * FROM memory_semantic WHERE memory_type = 'summary' AND depth = 1
    `;
    expect(d1Summaries.length).toBeGreaterThanOrEqual(1);

    // Check d1 is linked to d0 children
    const parentLinks = await sql`SELECT * FROM summary_parent_sources`;
    expect(parentLinks.length).toBeGreaterThanOrEqual(3);
  });

  it('does not condense when below consolidationThreshold', async () => {
    const chatId = 'chat-no-d1';
    await insertChat(chatId);

    // Create only 2 sessions (threshold = 3)
    for (let s = 0; s < 2; s++) {
      const sessionId = await insertSession(chatId, true);
      for (let i = 0; i < 5; i++) {
        await insertWorkingMemory(chatId, sessionId, `Session ${s} msg ${i}`);
      }
    }

    const provider = makeMockProvider({
      summarize: vi
        .fn()
        .mockResolvedValue('D0 summary.')
        // fact extraction returns empty
        .mockResolvedValueOnce('D0 summary.')
        .mockResolvedValueOnce('[]')
        .mockResolvedValueOnce('D0 summary.')
        .mockResolvedValueOnce('[]'),
    });

    const job = new MemoryConsolidationJob({
      sql,
      summarizationProvider: provider,
      embeddingProvider: makeMockEmbedding(),
      config: DEFAULT_CONFIG,
    });

    await job.run();

    const d1Summaries = await sql`
      SELECT * FROM memory_semantic WHERE memory_type = 'summary' AND depth = 1
    `;
    expect(d1Summaries.length).toBe(0);
  });

  it('start() is a no-op when disabled', async () => {
    const job = new MemoryConsolidationJob({
      sql,
      summarizationProvider: makeMockProvider(),
      embeddingProvider: makeMockEmbedding(),
      config: { ...DEFAULT_CONFIG, enabled: false },
    });

    // Should not throw
    await job.start();
    await job.stop();
  });

  it('stop() waits for in-progress run to complete', async () => {
    const chatId = 'chat-stop-wait';
    await insertChat(chatId);
    const sessionId = await insertSession(chatId, true);
    for (let i = 0; i < 5; i++) {
      await insertWorkingMemory(chatId, sessionId, `Stop msg ${i}`);
    }

    const provider = makeMockProvider({
      summarize: vi
        .fn()
        .mockImplementation(
          () => new Promise((resolve) => setTimeout(() => resolve('summary'), 150)),
        ),
    });

    const job = new MemoryConsolidationJob({
      sql,
      summarizationProvider: provider,
      embeddingProvider: makeMockEmbedding(),
      config: DEFAULT_CONFIG,
    });

    // Start a run in the background
    const runPromise = job.run();

    // Immediately stop — should wait for run to finish
    await new Promise((r) => setTimeout(r, 50));
    await job.stop();
    await runPromise;

    // The run should have completed
    const summaries = await sql`
      SELECT * FROM memory_semantic WHERE memory_type = 'summary'
    `;
    expect(summaries.length).toBeGreaterThanOrEqual(1);
  });
});
