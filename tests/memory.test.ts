import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryManager } from '../src/orchestrator/memory.js';
import { IdentityManager } from '../src/orchestrator/identity.js';
import { ProfileManager } from '../src/orchestrator/profile-manager.js';
import { TransformersEmbeddingProvider } from '../src/orchestrator/embeddings.js';
import { createTestDatabase, applySchema } from './helpers/pg-container.js';
import type { Sql } from '../src/orchestrator/connection.js';
import type { EmbeddingProvider } from '../src/orchestrator/types.js';

// ─── Shared Setup ─────────────────────────────────────────────────────────

let sql: Sql;
let cleanup: () => Promise<void>;
let embedding: EmbeddingProvider;
let defaultProfileId: string;
let profileManager: ProfileManager;

// Reuse a single embedding provider across all tests (model loaded once)
const sharedEmbedding = new TransformersEmbeddingProvider();

async function createChat(chatId = 'tg:123') {
  const now = Date.now();
  await sql`
    INSERT INTO chats (id, channel, external_id, is_group, profile_id, created_at, updated_at)
    VALUES (${chatId}, 'telegram', ${chatId.replace('tg:', '')}, false, ${defaultProfileId}, ${now}, ${now})
    ON CONFLICT (id) DO NOTHING
  `;
}

async function storeMessage(opts: {
  id: string;
  chatId: string;
  senderName: string;
  content: string;
  timestamp: number;
  sessionId?: string;
}) {
  await sql`
    INSERT INTO memory_working (id, chat_id, sender_id, sender_name, content, timestamp, is_from_me, is_bot_message, session_id)
    VALUES (${opts.id}, ${opts.chatId}, 'user-1', ${opts.senderName}, ${opts.content}, ${opts.timestamp}, false, false, ${opts.sessionId ?? null})
    ON CONFLICT (id, chat_id) DO NOTHING
  `;
}

beforeEach(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;
  embedding = sharedEmbedding;

  await applySchema(sql);

  const profileRows = await sql`SELECT id FROM agent_profiles WHERE is_default = true LIMIT 1`;
  defaultProfileId = profileRows[0].id as string;
  profileManager = new ProfileManager({ sql, maxProfilesPerUser: 10 });
});

afterEach(async () => {
  await cleanup();
});

// ─── Semantic Memory ─────────────────────────────────────────────────────

describe('MemoryManager', () => {
  describe('semantic memory', () => {
    let mm: MemoryManager;

    beforeEach(async () => {
      mm = new MemoryManager({
        sql,
        embeddingProvider: embedding,
        identityManager: new IdentityManager({ sql }),
        profileManager,
      });
      await mm.start();
    });

    afterEach(async () => {
      await mm.stop();
    });

    it('storeSemanticMemory returns an ID', async () => {
      const id = await mm.storeSemanticMemory({
        content: 'User prefers English for all communications',
        memoryType: 'preference',
        importance: 0.9,
        profileId: defaultProfileId,
      });
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    }, 60_000);

    it('querySemanticMemory finds stored entries by semantic similarity', async () => {
      await mm.storeSemanticMemory({
        content: 'User prefers English for all communications',
        memoryType: 'preference',
        importance: 0.9,
        profileId: defaultProfileId,
      });
      await mm.storeSemanticMemory({
        content: 'john.smith@company.com is a colleague',
        memoryType: 'contact',
        profileId: defaultProfileId,
      });
      await mm.storeSemanticMemory({
        content: 'PostgreSQL is the main database technology',
        memoryType: 'fact',
        profileId: defaultProfileId,
      });

      const results = await mm.querySemanticMemory(
        'What language preference does the user have?',
        defaultProfileId,
      );
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].entry.content).toContain('English');
    }, 60_000);

    it('querySemanticMemory filters by memoryType', async () => {
      await mm.storeSemanticMemory({
        content: 'Prefers dark mode',
        memoryType: 'preference',
        profileId: defaultProfileId,
      });
      await mm.storeSemanticMemory({
        content: 'John is a colleague',
        memoryType: 'contact',
        profileId: defaultProfileId,
      });

      const results = await mm.querySemanticMemory('preferences', defaultProfileId, {
        memoryType: 'preference',
      });
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r) => r.entry.memoryType === 'preference')).toBe(true);
    }, 60_000);

    it('querySemanticMemory returns compositeScore in results', async () => {
      await mm.storeSemanticMemory({
        content: 'User prefers dark mode UI',
        memoryType: 'preference',
        importance: 0.8,
        profileId: defaultProfileId,
      });

      const results = await mm.querySemanticMemory('dark mode', defaultProfileId);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].compositeScore).toBeTypeOf('number');
      expect(results[0].compositeScore).toBeGreaterThan(0);
      expect(results[0].similarity).toBeTypeOf('number');
      expect(results[0].similarity).toBeGreaterThan(0);
    }, 60_000);

    it('querySemanticMemory respects limit', async () => {
      for (let i = 0; i < 5; i++) {
        await mm.storeSemanticMemory({
          content: `Memory number ${String(i)} about various topics`,
          memoryType: 'fact',
          profileId: defaultProfileId,
        });
      }

      const results = await mm.querySemanticMemory('memory', defaultProfileId, { limit: 2 });
      expect(results).toHaveLength(2);
    }, 60_000);

    it('deleteSemanticMemory removes entry', async () => {
      const id = await mm.storeSemanticMemory({
        content: 'To be deleted soon',
        memoryType: 'fact',
        profileId: defaultProfileId,
      });
      const deleted = await mm.deleteSemanticMemory(id);
      expect(deleted).toBe(true);

      const results = await mm.querySemanticMemory('To be deleted soon', defaultProfileId);
      expect(results.find((r) => r.entry.id === id)).toBeUndefined();
    }, 60_000);

    it('deleteSemanticMemory returns false for non-existent ID', async () => {
      const deleted = await mm.deleteSemanticMemory('00000000-0000-0000-0000-000000000000');
      expect(deleted).toBe(false);
    });

    it('default importance varies by memory type', async () => {
      const instructionId = await mm.storeSemanticMemory({
        content: 'Always respond formally',
        memoryType: 'instruction',
        profileId: defaultProfileId,
      });
      const procedureId = await mm.storeSemanticMemory({
        content: 'Follow the deployment checklist',
        memoryType: 'procedure',
        profileId: defaultProfileId,
      });
      const summaryId = await mm.storeSemanticMemory({
        content: 'Discussed project timelines in the meeting',
        memoryType: 'summary',
        profileId: defaultProfileId,
      });
      const factId = await mm.storeSemanticMemory({
        content: 'The office is in Helsinki',
        memoryType: 'fact',
        profileId: defaultProfileId,
      });

      const rows = await sql<Array<{ id: string; importance: number }>>`
        SELECT id, importance FROM memory_semantic
        WHERE id IN (${instructionId}, ${procedureId}, ${summaryId}, ${factId})
      `;

      const byId = Object.fromEntries(rows.map((r) => [r.id, Number(r.importance)]));
      expect(byId[instructionId]).toBe(1.0);
      expect(byId[procedureId]).toBe(0.8);
      expect(byId[summaryId]).toBe(0.7);
      expect(byId[factId]).toBe(0.5);
    }, 60_000);
  });

  // ─── External Memory ──────────────────────────────────────────────────────

  describe('external memory', () => {
    let mm: MemoryManager;

    beforeEach(async () => {
      mm = new MemoryManager({
        sql,
        embeddingProvider: embedding,
        identityManager: new IdentityManager({ sql }),
        profileManager,
        externalSimilarityThreshold: 0.3,
      });
      await mm.start();
    });

    afterEach(async () => {
      await mm.stop();
    });

    it('storeExternalMemory and query', async () => {
      const id = await mm.storeExternalMemory({
        content: 'Q3 budget was approved at $500K for the engineering team',
        sourceType: 'document',
        sourceRef: 'budget-2024.pdf',
        profileId: defaultProfileId,
      });
      expect(id).toMatch(/^[0-9a-f-]{36}$/);

      const results = await mm.queryExternalMemory('engineering budget approval', defaultProfileId);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].entry.content).toContain('budget');
      expect(results[0].similarity).toBeGreaterThan(0);
    }, 60_000);

    it('queryExternalMemory filters by source', async () => {
      await mm.storeExternalMemory({
        content: 'Document about quarterly earnings',
        sourceType: 'document',
        sourceRef: 'doc-1',
        profileId: defaultProfileId,
      });
      await mm.storeExternalMemory({
        content: 'User note about quarterly review',
        sourceType: 'user_provided',
        sourceRef: 'note-1',
        profileId: defaultProfileId,
      });

      const results = await mm.queryExternalMemory('quarterly', defaultProfileId, {
        source: 'document',
      });
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r) => r.entry.sourceType === 'document')).toBe(true);
    }, 60_000);

    it('queryExternalMemory filters below similarity threshold', async () => {
      // Use a high threshold so semantically unrelated content is filtered out
      const strictMm = new MemoryManager({
        sql,
        embeddingProvider: embedding,
        identityManager: new IdentityManager({ sql }),
        profileManager,
        externalSimilarityThreshold: 0.99,
      });
      await strictMm.start();

      await strictMm.storeExternalMemory({
        content: 'The recipe for banana bread requires flour and eggs',
        sourceType: 'document',
        sourceRef: 'recipe.txt',
        profileId: defaultProfileId,
      });

      // A completely unrelated query should return no results above 0.99 threshold
      const results = await strictMm.queryExternalMemory(
        'quantum physics particle acceleration experiments',
        defaultProfileId,
      );
      expect(results).toHaveLength(0);

      await strictMm.stop();
    }, 60_000);

    it('removeExternalBySource removes all matching entries', async () => {
      await mm.storeExternalMemory({
        content: 'Part 1 of the document about project planning',
        sourceType: 'document',
        sourceRef: 'doc-123',
        profileId: defaultProfileId,
      });
      await mm.storeExternalMemory({
        content: 'Part 2 of the document about project planning',
        sourceType: 'document',
        sourceRef: 'doc-123',
        profileId: defaultProfileId,
      });
      await mm.storeExternalMemory({
        content: 'Unrelated document about something else',
        sourceType: 'document',
        sourceRef: 'doc-456',
        profileId: defaultProfileId,
      });

      const removed = await mm.removeExternalBySource('doc-123', defaultProfileId);
      expect(removed).toBe(2);

      // doc-456 should still exist
      const rows = await sql<[{ count: number }]>`
        SELECT COUNT(*)::integer AS count FROM memory_external
      `;
      expect(rows[0].count).toBe(1);
    }, 60_000);
  });

  // ─── Session Management ──────────────────────────────────────────────────

  describe('session management', () => {
    let mm: MemoryManager;

    beforeEach(async () => {
      mm = new MemoryManager({
        sql,
        embeddingProvider: embedding,
        identityManager: new IdentityManager({ sql }),
        profileManager,
      });
      await mm.start();
      await createChat();
    });

    afterEach(async () => {
      await mm.stop();
    });

    it('startSession creates a new session', async () => {
      const sessionId = await mm.startSession('tg:123');
      expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('endSession marks ended_at', async () => {
      const sessionId = await mm.startSession('tg:123');
      await mm.endSession(sessionId);

      const rows = await sql<Array<{ ended_at: number | null }>>`
        SELECT ended_at FROM sessions WHERE id = ${sessionId}
      `;
      expect(rows[0].ended_at).not.toBeNull();
      expect(Number(rows[0].ended_at)).toBeGreaterThan(0);
    });

    it('getActiveSession returns null when no active session', async () => {
      const active = await mm.getActiveSession('tg:123');
      expect(active).toBeNull();
    });

    it('getActiveSession returns the most recent active session', async () => {
      const firstId = await mm.startSession('tg:123');
      await mm.endSession(firstId);

      const secondId = await mm.startSession('tg:123');

      const active = await mm.getActiveSession('tg:123');
      expect(active).not.toBeNull();
      expect(active!.id).toBe(secondId);
      expect(active!.chatId).toBe('tg:123');
      expect(active!.endedAt).toBeUndefined();
    });

    it('getSessionMessages returns messages in chronological order', async () => {
      const sessionId = await mm.startSession('tg:123');

      await storeMessage({
        id: 'msg-1',
        chatId: 'tg:123',
        senderName: 'Alice',
        content: 'Hello',
        timestamp: 1000,
        sessionId,
      });
      await storeMessage({
        id: 'msg-2',
        chatId: 'tg:123',
        senderName: 'Bot',
        content: 'Hi there',
        timestamp: 2000,
        sessionId,
      });
      await storeMessage({
        id: 'msg-3',
        chatId: 'tg:123',
        senderName: 'Alice',
        content: 'How are you?',
        timestamp: 3000,
        sessionId,
      });

      const msgs = await mm.getSessionMessages(sessionId);
      expect(msgs).toHaveLength(3);
      expect(msgs[0].content).toBe('Hello');
      expect(msgs[1].content).toBe('Hi there');
      expect(msgs[2].content).toBe('How are you?');
    });
  });

  // ─── Memory Stats ────────────────────────────────────────────────────────

  describe('memory stats', () => {
    let mm: MemoryManager;

    beforeEach(async () => {
      mm = new MemoryManager({
        sql,
        embeddingProvider: embedding,
        identityManager: new IdentityManager({ sql }),
        profileManager,
      });
      await mm.start();
      await createChat();
    });

    afterEach(async () => {
      await mm.stop();
    });

    it('getMemoryStats returns counts by tier and type', async () => {
      // Semantic entries
      await mm.storeSemanticMemory({
        content: 'Pref 1',
        memoryType: 'preference',
        profileId: defaultProfileId,
      });
      await mm.storeSemanticMemory({
        content: 'Pref 2',
        memoryType: 'preference',
        profileId: defaultProfileId,
      });
      await mm.storeSemanticMemory({
        content: 'Fact 1',
        memoryType: 'fact',
        profileId: defaultProfileId,
      });

      // External entries
      await mm.storeExternalMemory({
        content: 'A document chunk',
        sourceType: 'document',
        sourceRef: 'doc-1',
        profileId: defaultProfileId,
      });

      // Working memory (messages)
      const sessionId = await mm.startSession('tg:123');
      await storeMessage({
        id: 'msg-1',
        chatId: 'tg:123',
        senderName: 'Alice',
        content: 'Hello',
        timestamp: 1000,
        sessionId,
      });
      await storeMessage({
        id: 'msg-2',
        chatId: 'tg:123',
        senderName: 'Alice',
        content: 'World',
        timestamp: 2000,
        sessionId,
      });

      // Insert a meta entry directly (created by the reflection job)
      const now = Date.now();
      const vector = await embedding.embed('test insight content');
      await sql`
        INSERT INTO memory_meta (content, embedding, reflection_type, confidence, profile_id, created_at, updated_at, last_accessed)
        VALUES ('test insight', ${`[${vector.join(',')}]`}::vector, 'insight', ${0.8}, ${defaultProfileId}, ${now}, ${now}, ${now})
      `;

      const stats = await mm.getMemoryStats(defaultProfileId);
      expect(stats.semantic_preference).toBe(2);
      expect(stats.semantic_fact).toBe(1);
      expect(stats.external_document).toBe(1);
      expect(stats.meta_insight).toBe(1);
      expect(stats.working_messages).toBe(2);
    }, 60_000);
  });

  // ─── DAG Traversal (expandMemory) ────────────────────────────────────────

  describe('expandMemory', () => {
    let mm: MemoryManager;

    beforeEach(async () => {
      mm = new MemoryManager({
        sql,
        embeddingProvider: embedding,
        identityManager: new IdentityManager({ sql }),
        profileManager,
      });
      await mm.start();
    });

    afterEach(async () => {
      await mm.stop();
    });

    it('returns empty for non-existent ID', async () => {
      const result = await mm.expandMemory('00000000-0000-0000-0000-000000000000');
      expect(result).toEqual({});
    });
  });

  // ─── Meta Memory Queries ──────────────────────────────────────────────────

  describe('meta memory queries', () => {
    let mm: MemoryManager;

    beforeEach(async () => {
      mm = new MemoryManager({
        sql,
        embeddingProvider: embedding,
        identityManager: new IdentityManager({ sql }),
        profileManager,
      });
      await mm.start();
    });

    afterEach(async () => {
      await mm.stop();
    });

    it('queryMetaMemory returns inserted meta entries', async () => {
      const now = Date.now();
      const vector = await embedding.embed(
        'The user learns best through practical examples and code snippets',
      );
      await sql`
        INSERT INTO memory_meta (content, embedding, reflection_type, confidence, profile_id, created_at, updated_at, last_accessed)
        VALUES ('The user learns best through practical examples', ${`[${vector.join(',')}]`}::vector, 'insight', ${0.8}, ${defaultProfileId}, ${now}, ${now}, ${now})
      `;

      const results = await mm.queryMetaMemory('how does the user learn best', defaultProfileId);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].entry.content).toContain('practical examples');
      expect(results[0].compositeScore).toBeGreaterThan(0);
    }, 60_000);

    it('queryMetaMemory filters by type', async () => {
      const now = Date.now();
      const insightVec = await embedding.embed('important insight about learning patterns');
      const heuristicVec = await embedding.embed('always check the logs before debugging further');

      await sql`
        INSERT INTO memory_meta (content, embedding, reflection_type, confidence, profile_id, created_at, updated_at, last_accessed)
        VALUES ('insight about learning', ${`[${insightVec.join(',')}]`}::vector, 'insight', ${0.8}, ${defaultProfileId}, ${now}, ${now}, ${now})
      `;
      await sql`
        INSERT INTO memory_meta (content, embedding, reflection_type, confidence, profile_id, created_at, updated_at, last_accessed)
        VALUES ('check logs before debugging', ${`[${heuristicVec.join(',')}]`}::vector, 'heuristic', ${0.8}, ${defaultProfileId}, ${now}, ${now}, ${now})
      `;

      const results = await mm.queryMetaMemory('learning and debugging', defaultProfileId, {
        type: 'heuristic',
      });
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r) => r.entry.reflectionType === 'heuristic')).toBe(true);
    }, 60_000);
  });

  // ─── Context Assembly (buildAgentContext) ─────────────────────────────────

  describe('buildAgentContext', () => {
    let mm: MemoryManager;
    let identityManager: IdentityManager;

    beforeEach(async () => {
      identityManager = new IdentityManager({ sql });
      mm = new MemoryManager({
        sql,
        embeddingProvider: embedding,
        identityManager,
        profileManager,
        workingMemoryLimit: 5,
        semanticMemoryLimit: 3,
        metaMemoryLimit: 3,
        externalMemoryLimit: 3,
        externalSimilarityThreshold: 0.3,
        metaInjection: { strategy: 'flat' },
      });
      await mm.start();
      await createChat();
    });

    afterEach(async () => {
      await mm.stop();
    });

    it('returns XML with all tiers', async () => {
      const context = await mm.buildAgentContext('tg:123', 'Hello');
      expect(context).toContain('<context');
      expect(context).toContain('</context>');
    }, 60_000);

    it('includes identity section', async () => {
      await identityManager.setAgentIdentity(defaultProfileId, {
        role: 'Personal Assistant',
        expertise: ['scheduling', 'email'],
        tone: 'professional but warm',
      });

      const context = await mm.buildAgentContext('tg:123', 'Hello');
      expect(context).toContain('<identity>');
      expect(context).toContain('Personal Assistant');
      expect(context).toContain('</identity>');
    }, 60_000);

    it('includes meta_memory section when meta entries exist', async () => {
      const now = Date.now();
      const vector = await embedding.embed('the user prefers concise answers');
      await sql`
        INSERT INTO memory_meta (content, embedding, reflection_type, confidence, profile_id, created_at, updated_at, last_accessed)
        VALUES ('user prefers concise answers', ${`[${vector.join(',')}]`}::vector, 'insight', ${0.8}, ${defaultProfileId}, ${now}, ${now}, ${now})
      `;

      const context = await mm.buildAgentContext('tg:123', 'preferences for communication style');
      expect(context).toContain('<meta_memory>');
      expect(context).toContain('user prefers concise answers');
      expect(context).toContain('</meta_memory>');
    }, 60_000);

    it('includes semantic_memory section', async () => {
      await mm.storeSemanticMemory({
        content: 'User prefers English for all communications',
        memoryType: 'preference',
        importance: 0.9,
        profileId: defaultProfileId,
      });

      const context = await mm.buildAgentContext('tg:123', 'What language does the user prefer?');
      expect(context).toContain('<semantic_memory>');
      expect(context).toContain('User prefers English');
      expect(context).toContain('type="preference"');
      expect(context).toContain('</semantic_memory>');
    }, 60_000);

    it('omits external_memory when no results above threshold', async () => {
      // Use a very high threshold so nothing qualifies
      const strictMm = new MemoryManager({
        sql,
        embeddingProvider: embedding,
        identityManager,
        profileManager,
        externalSimilarityThreshold: 0.99,
      });
      await strictMm.start();

      await strictMm.storeExternalMemory({
        content: 'Banana bread recipe with flour and eggs',
        sourceType: 'document',
        sourceRef: 'recipe.txt',
        profileId: defaultProfileId,
      });

      const context = await strictMm.buildAgentContext(
        'tg:123',
        'quantum physics particle acceleration',
      );
      expect(context).not.toContain('<external_memory>');

      await strictMm.stop();
    }, 60_000);

    it('includes working_memory from active session', async () => {
      const sessionId = await mm.startSession('tg:123');
      await storeMessage({
        id: 'msg-1',
        chatId: 'tg:123',
        senderName: 'Alice',
        content: 'Hello there',
        timestamp: 1000,
        sessionId,
      });

      const context = await mm.buildAgentContext('tg:123', 'test');
      expect(context).toContain('<working_memory>');
      expect(context).toContain('Hello there');
      expect(context).toContain('sender="Alice"');
      expect(context).toContain('</working_memory>');
    }, 60_000);

    it('includes date attribute', async () => {
      const context = await mm.buildAgentContext('tg:123', 'test');
      // date attribute should be in ISO date format (YYYY-MM-DD)
      expect(context).toMatch(/date="\d{4}-\d{2}-\d{2}"/);
    }, 60_000);

    it('includes timezone when provided', async () => {
      const context = await mm.buildAgentContext('tg:123', 'Hello', {
        timezone: 'Europe/Helsinki',
      });
      expect(context).toContain('timezone="Europe/Helsinki"');
    }, 60_000);
  });

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  describe('lifecycle', () => {
    it('throws when not started', async () => {
      const mm = new MemoryManager({
        sql,
        embeddingProvider: embedding,
        identityManager: new IdentityManager({ sql }),
        profileManager,
      });
      await expect(
        mm.storeSemanticMemory({
          content: 'test',
          memoryType: 'fact',
          profileId: defaultProfileId,
        }),
      ).rejects.toThrow('not started');
    });
  });
});
