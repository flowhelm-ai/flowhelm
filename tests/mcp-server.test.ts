import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer, cleanupStaleSockets } from '../src/orchestrator/mcp-server.js';
import { MemoryManager } from '../src/orchestrator/memory.js';
import { IdentityManager } from '../src/orchestrator/identity.js';
import { FlowHelmDatabase } from '../src/orchestrator/database.js';
import { ProfileManager } from '../src/orchestrator/profile-manager.js';
import { TransformersEmbeddingProvider } from '../src/orchestrator/embeddings.js';
import { createTestDatabase, applySchema } from './helpers/pg-container.js';
import type { Sql } from '../src/orchestrator/connection.js';
import type { EmbeddingProvider } from '../src/orchestrator/types.js';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as crypto from 'node:crypto';

// ─── Shared Embedding Provider (loaded once across all tests) ────────────

const sharedEmbedding = new TransformersEmbeddingProvider();

// ─── Test State ──────────────────────────────────────────────────────────

let sql: Sql;
let cleanup: () => Promise<void>;
let embedding: EmbeddingProvider;
let memory: MemoryManager;
let identity: IdentityManager;
let database: FlowHelmDatabase;
let server: McpServer;
let defaultProfileId: string;
let profileManager: ProfileManager;

const SOCKET_DIR = path.join(os.tmpdir(), 'flowhelm-test-mcp');

// ─── Helpers ─────────────────────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const response = await server.handleRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  if (response?.result && typeof response.result === 'object' && 'content' in response.result) {
    const content = (response.result as { content: Array<{ text: string }> }).content;
    if (content?.[0]?.text) {
      return JSON.parse(content[0].text);
    }
  }
  return response?.result;
}

async function callToolRaw(name: string, args: Record<string, unknown> = {}) {
  return server.handleRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  });
}

function getToolError(response: { result?: unknown } | null): string | undefined {
  if (!response?.result) return undefined;
  const result = response.result as {
    content?: Array<{ text: string }>;
    isError?: boolean;
  };
  if (!result.isError) return undefined;
  const parsed = JSON.parse(result.content![0].text);
  return parsed.error;
}

async function createChat(chatId = 'tg:123'): Promise<void> {
  const now = Date.now();
  await sql`
    INSERT INTO chats (id, channel, external_id, is_group, profile_id, created_at, updated_at)
    VALUES (${chatId}, 'telegram', '123', false, ${defaultProfileId}, ${now}, ${now})
    ON CONFLICT DO NOTHING
  `;
}

async function storeWorkingMessage(
  id: string,
  chatId: string,
  content: string,
  timestamp: number,
): Promise<void> {
  await sql`
    INSERT INTO memory_working (id, chat_id, sender_id, sender_name, content, timestamp, is_from_me, is_bot_message)
    VALUES (${id}, ${chatId}, 'user-1', 'User', ${content}, ${timestamp}, false, false)
    ON CONFLICT DO NOTHING
  `;
}

// ─── Setup / Teardown ────────────────────────────────────────────────────

beforeEach(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;
  embedding = sharedEmbedding;

  await applySchema(sql);

  const profileRows = await sql`SELECT id FROM agent_profiles WHERE is_default = true LIMIT 1`;
  defaultProfileId = profileRows[0].id as string;
  profileManager = new ProfileManager({ sql, maxProfilesPerUser: 10 });

  database = new FlowHelmDatabase({ sql, skipInit: true });
  await database.start();

  identity = new IdentityManager({ sql });

  memory = new MemoryManager({
    sql,
    embeddingProvider: embedding,
    identityManager: identity,
    profileManager,
  });
  await memory.start();

  fs.mkdirSync(SOCKET_DIR, { recursive: true });
  const socketPath = path.join(SOCKET_DIR, `test-${Date.now()}.sock`);

  server = new McpServer({
    socketPath,
    memory,
    identity,
    profileManager,
    database,
    defaultChatId: 'tg:123',
  });

  // Start the server so profileId is resolved (needed for tool calls)
  await server.start();
});

afterEach(async () => {
  if (server.isListening()) {
    await server.stop();
  }
  await memory.stop();
  await database.stop();
  await cleanup();
});

// ─── Protocol Tests ─────────────────────────────────────────────────────

describe('McpServer', () => {
  describe('protocol', () => {
    it('initialize returns protocol version 2024-11-05', async () => {
      const response = await server.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {},
      });

      expect(response).not.toBeNull();
      expect(response!.jsonrpc).toBe('2.0');
      expect(response!.id).toBe(1);

      const result = response!.result as Record<string, unknown>;
      expect(result.protocolVersion).toBe('2024-11-05');
      expect(result.capabilities).toEqual({ tools: {} });
      expect(result.serverInfo).toEqual({ name: 'flowhelm', version: '2.0.0' });
    });

    it('tools/list returns 23 tools', async () => {
      const response = await server.handleRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      });

      expect(response).not.toBeNull();
      const result = response!.result as { tools: Array<{ name: string }> };
      expect(result.tools).toHaveLength(25);

      const names = result.tools.map((t) => t.name);
      // Memory tools (14)
      expect(names).toContain('search_semantic');
      expect(names).toContain('search_external');
      expect(names).toContain('recall_conversation');
      expect(names).toContain('store_semantic');
      expect(names).toContain('get_memory_stats');
      expect(names).toContain('expand_memory');
      expect(names).toContain('search_meta');
      expect(names).toContain('expand_meta');
      expect(names).toContain('trace_to_source');
      expect(names).toContain('get_identity');
      expect(names).toContain('observe_personality');
      expect(names).toContain('observe_user');
      expect(names).toContain('propose_identity_update');
      expect(names).toContain('update_user_identity');
      // Profile tools (3)
      expect(names).toContain('list_profiles');
      expect(names).toContain('get_current_profile');
      expect(names).toContain('switch_chat_profile');
      // Admin tools (7, ADR-033)
      expect(names).toContain('install_skill');
      expect(names).toContain('uninstall_skill');
      expect(names).toContain('list_skills');
      expect(names).toContain('search_skills');
      expect(names).toContain('update_config');
      expect(names).toContain('get_auth_url');
      expect(names).toContain('get_system_status');
      // Google Workspace tool (1 — replaces 7 individual tools)
      expect(names).toContain('google_workspace');
    });

    it('returns -32601 for unknown method', async () => {
      const response = await server.handleRequest({
        jsonrpc: '2.0',
        id: 3,
        method: 'nonexistent/method',
      });

      expect(response).not.toBeNull();
      expect(response!.error).toBeDefined();
      expect(response!.error!.code).toBe(-32601);
      expect(response!.error!.message).toContain('Method not found');
    });

    it('returns -32602 when tools/call is missing tool name', async () => {
      const response = await server.handleRequest({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { arguments: {} },
      });

      expect(response).not.toBeNull();
      expect(response!.error).toBeDefined();
      expect(response!.error!.code).toBe(-32602);
      expect(response!.error!.message).toContain('Missing tool name');
    });

    it('returns -32602 for unknown tool name', async () => {
      const response = await server.handleRequest({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'nonexistent_tool', arguments: {} },
      });

      expect(response).not.toBeNull();
      expect(response!.error).toBeDefined();
      expect(response!.error!.code).toBe(-32602);
      expect(response!.error!.message).toContain('Unknown tool');
    });
  });

  // ─── search_semantic ──────────────────────────────────────────────────

  describe('search_semantic', () => {
    it('requires query', async () => {
      const response = await callToolRaw('search_semantic', {});
      expect(getToolError(response)).toContain('query is required');
    });

    it('returns results after store_semantic', async () => {
      await callTool('store_semantic', {
        content: 'User prefers dark mode for coding',
        type: 'preference',
        importance: 0.9,
      });

      const results = (await callTool('search_semantic', {
        query: 'dark mode preference',
      })) as Array<Record<string, unknown>>;

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].content).toBe('User prefers dark mode for coding');
      expect(results[0].type).toBe('preference');
      expect(results[0].importance).toBe(0.9);
      expect(results[0].similarity).toBeTypeOf('number');
      expect(results[0].score).toBeTypeOf('number');
    });

    it('filters by type', async () => {
      await callTool('store_semantic', {
        content: 'User works at Acme Corp',
        type: 'fact',
      });
      await callTool('store_semantic', {
        content: 'User prefers morning meetings',
        type: 'preference',
      });

      const results = (await callTool('search_semantic', {
        query: 'user information',
        type: 'fact',
      })) as Array<Record<string, unknown>>;

      for (const r of results) {
        expect(r.type).toBe('fact');
      }
    });

    it('respects limit', async () => {
      // Store multiple entries
      for (let i = 0; i < 5; i++) {
        await callTool('store_semantic', {
          content: `Fact number ${String(i)} about testing`,
          type: 'fact',
        });
      }

      const results = (await callTool('search_semantic', {
        query: 'fact about testing',
        limit: 2,
      })) as Array<Record<string, unknown>>;

      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('validates type', async () => {
      const response = await callToolRaw('search_semantic', {
        query: 'test',
        type: 'invalid_type',
      });
      expect(getToolError(response)).toContain('Invalid type');
    });
  });

  // ─── search_external ──────────────────────────────────────────────────

  describe('search_external', () => {
    it('requires query', async () => {
      const response = await callToolRaw('search_external', {});
      expect(getToolError(response)).toContain('query is required');
    });

    it('returns results', async () => {
      // Store external memory directly
      await memory.storeExternalMemory({
        content: 'Project requirements: build a dashboard with real-time analytics',
        sourceType: 'document',
        sourceRef: 'doc/requirements.md',
        profileId: defaultProfileId,
      });

      const results = (await callTool('search_external', {
        query: 'dashboard requirements',
      })) as Array<Record<string, unknown>>;

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].content).toContain('dashboard');
      expect(results[0].source).toBe('document');
      expect(results[0].source_ref).toBe('doc/requirements.md');
      expect(results[0].similarity).toBeTypeOf('number');
    });

    it('validates source', async () => {
      const response = await callToolRaw('search_external', {
        query: 'test',
        source: 'invalid_source',
      });
      expect(getToolError(response)).toContain('Invalid source');
    });
  });

  // ─── recall_conversation ──────────────────────────────────────────────

  describe('recall_conversation', () => {
    it('returns messages for chat_id', async () => {
      await createChat('tg:456');
      await storeWorkingMessage('msg-1', 'tg:456', 'Hello there', 1712300000000);
      await storeWorkingMessage('msg-2', 'tg:456', 'How are you?', 1712300001000);

      const results = (await callTool('recall_conversation', {
        chat_id: 'tg:456',
      })) as Array<Record<string, unknown>>;

      expect(results).toHaveLength(2);
      expect(results[0].content).toBe('Hello there');
      expect(results[1].content).toBe('How are you?');
      expect(results[0].sender).toBe('User');
      expect(results[0].is_assistant).toBe(false);
      // Time should be ISO string
      expect(results[0].time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('returns messages for session_id', async () => {
      await createChat('tg:123');
      const sessionId = await memory.startSession('tg:123');

      await sql`
        INSERT INTO memory_working (id, chat_id, sender_id, sender_name, content, timestamp, is_from_me, is_bot_message, session_id)
        VALUES ('s-msg-1', 'tg:123', 'user-1', 'Stan', 'Session message', ${1712300000000}, false, false, ${sessionId})
      `;

      const results = (await callTool('recall_conversation', {
        session_id: sessionId,
      })) as Array<Record<string, unknown>>;

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].content).toBe('Session message');
      expect(results[0].sender).toBe('Stan');
    });

    it('requires chat_id or session_id', async () => {
      // Server has defaultChatId='tg:123', so create that chat for the fallback to work
      // Test with a server that has NO defaultChatId
      const noDefaultServer = new McpServer({
        socketPath: path.join(SOCKET_DIR, `test-nodefault-${Date.now()}.sock`),
        memory,
        identity,
        profileManager,
        database,
      });

      const response = await noDefaultServer.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'recall_conversation', arguments: {} },
      });

      const result = response!.result as {
        content: Array<{ text: string }>;
        isError: boolean;
      };
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain('chat_id or session_id is required');
    });
  });

  // ─── store_semantic ───────────────────────────────────────────────────

  describe('store_semantic', () => {
    it('requires content and type', async () => {
      const noContent = await callToolRaw('store_semantic', { type: 'fact' });
      expect(getToolError(noContent)).toContain('content is required');

      const noType = await callToolRaw('store_semantic', { content: 'Some content' });
      expect(getToolError(noType)).toContain('type is required');
    });

    it('validates content max length', async () => {
      const longContent = 'x'.repeat(2001);
      const response = await callToolRaw('store_semantic', {
        content: longContent,
        type: 'fact',
      });
      expect(getToolError(response)).toContain('2000 characters');
    });

    it('validates type', async () => {
      const response = await callToolRaw('store_semantic', {
        content: 'Test content',
        type: 'invalid_type',
      });
      expect(getToolError(response)).toContain('Invalid type');
    });

    it('stores with custom importance', async () => {
      const result = (await callTool('store_semantic', {
        content: 'Important instruction: always use TypeScript',
        type: 'instruction',
        importance: 0.95,
      })) as { id: string; stored: boolean };

      expect(result.stored).toBe(true);
      expect(result.id).toBeDefined();

      // Verify the stored importance via search
      const searchResults = (await callTool('search_semantic', {
        query: 'always use TypeScript',
        type: 'instruction',
      })) as Array<Record<string, unknown>>;

      expect(searchResults.length).toBeGreaterThanOrEqual(1);
      expect(searchResults[0].importance).toBe(0.95);
    });

    it('returns id and stored: true', async () => {
      const result = (await callTool('store_semantic', {
        content: 'User is a software engineer',
        type: 'fact',
      })) as { id: string; stored: boolean };

      expect(result.id).toBeDefined();
      expect(typeof result.id).toBe('string');
      expect(result.stored).toBe(true);
    });
  });

  // ─── get_memory_stats ─────────────────────────────────────────────────

  describe('get_memory_stats', () => {
    it('returns counts', async () => {
      // Store some entries across tiers
      await callTool('store_semantic', {
        content: 'A fact for stats',
        type: 'fact',
      });
      await callTool('store_semantic', {
        content: 'A preference for stats',
        type: 'preference',
      });

      const stats = (await callTool('get_memory_stats')) as Record<string, number>;

      // Should have semantic entries
      expect(stats.semantic_fact).toBeGreaterThanOrEqual(1);
      expect(stats.semantic_preference).toBeGreaterThanOrEqual(1);
      // working_messages should be a number (possibly 0)
      expect(typeof stats.working_messages).toBe('number');
    });
  });

  // ─── expand_memory ────────────────────────────────────────────────────

  describe('expand_memory', () => {
    it('requires memory_id', async () => {
      const response = await callToolRaw('expand_memory', {});
      expect(getToolError(response)).toContain('memory_id is required');
    });

    it('returns empty for non-existent id', async () => {
      const result = (await callTool('expand_memory', {
        memory_id: crypto.randomUUID(),
      })) as { type: string; data: unknown[] };

      expect(result.type).toBe('empty');
      expect(result.data).toEqual([]);
    });
  });

  // ─── search_meta ──────────────────────────────────────────────────────

  describe('search_meta', () => {
    it('requires query', async () => {
      const response = await callToolRaw('search_meta', {});
      expect(getToolError(response)).toContain('query is required');
    });

    it('returns results for meta entries', async () => {
      // Insert a meta memory entry directly
      const vector = await embedding.embed(
        'User asks detailed follow-up questions indicating analytical thinking',
      );
      await sql`
        INSERT INTO memory_meta (content, embedding, reflection_type, confidence, profile_id, created_at, updated_at, last_accessed)
        VALUES (
          'User asks detailed follow-up questions indicating analytical thinking',
          ${`[${vector.join(',')}]`}::vector,
          'insight',
          ${0.8},
          ${defaultProfileId},
          ${Date.now()},
          ${Date.now()},
          ${Date.now()}
        )
      `;

      const results = (await callTool('search_meta', {
        query: 'analytical thinking follow-up questions',
      })) as Array<Record<string, unknown>>;

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].content).toContain('analytical thinking');
      expect(results[0].reflection_type).toBe('insight');
      expect(results[0].confidence).toBeTypeOf('number');
      expect(results[0].similarity).toBeTypeOf('number');
      expect(results[0].score).toBeTypeOf('number');
    });

    it('validates type', async () => {
      const response = await callToolRaw('search_meta', {
        query: 'test',
        type: 'invalid_type',
      });
      expect(getToolError(response)).toContain('Invalid type');
    });
  });

  // ─── get_identity ─────────────────────────────────────────────────────

  describe('get_identity', () => {
    it('returns all 4 sections', async () => {
      const result = (await callTool('get_identity')) as Record<string, unknown>;

      // All 4 sections should be present (may be null/empty for fresh DB)
      expect(result).toHaveProperty('agent_identity');
      expect(result).toHaveProperty('agent_personality');
      expect(result).toHaveProperty('user_identity');
      expect(result).toHaveProperty('user_personality');

      // Personality arrays should be arrays
      expect(Array.isArray(result.agent_personality)).toBe(true);
      expect(Array.isArray(result.user_personality)).toBe(true);
    });

    it('returns personality with confidence', async () => {
      // Set up identity and personality
      await identity.setAgentIdentity(defaultProfileId, {
        role: 'assistant',
        expertise: ['typescript', 'cloud'],
        tone: 'professional',
      });
      await identity.observeAgentPersonality(defaultProfileId, 'humor', 'Dry wit, occasional puns');

      const result = (await callTool('get_identity')) as {
        agent_identity: Record<string, unknown>;
        agent_personality: Array<{ dimension: string; content: string; confidence: number }>;
      };

      expect(result.agent_identity).toBeDefined();
      expect(result.agent_identity).not.toBeNull();

      expect(result.agent_personality.length).toBeGreaterThanOrEqual(1);
      const humor = result.agent_personality.find((p) => p.dimension === 'humor');
      expect(humor).toBeDefined();
      expect(humor!.content).toBe('Dry wit, occasional puns');
      expect(humor!.confidence).toBeTypeOf('number');
      expect(humor!.confidence).toBeGreaterThan(0);
    });
  });

  // ─── observe_personality ──────────────────────────────────────────────

  describe('observe_personality', () => {
    it('requires dimension and observation', async () => {
      const noDim = await callToolRaw('observe_personality', { observation: 'test' });
      expect(getToolError(noDim)).toContain('dimension is required');

      const noObs = await callToolRaw('observe_personality', { dimension: 'humor' });
      expect(getToolError(noObs)).toContain('observation is required');
    });

    it('validates dimension', async () => {
      const response = await callToolRaw('observe_personality', {
        dimension: 'invalid_dim',
        observation: 'test',
      });
      expect(getToolError(response)).toContain('Invalid dimension');
    });

    it('creates at 0.8 confidence', async () => {
      const result = (await callTool('observe_personality', {
        dimension: 'humor',
        observation: 'Appreciates deadpan humor',
      })) as { dimension: string; content: string; confidence: number; evidence_count: number };

      expect(result.dimension).toBe('humor');
      expect(result.content).toBe('Appreciates deadpan humor');
      expect(result.confidence).toBe(0.8);
      expect(result.evidence_count).toBe(1);
    });

    it('updates existing and bumps confidence', async () => {
      // First observation
      const first = (await callTool('observe_personality', {
        dimension: 'rapport',
        observation: 'Casual and friendly',
      })) as { confidence: number; evidence_count: number };

      expect(first.confidence).toBe(0.8);
      expect(first.evidence_count).toBe(1);

      // Second observation (same dimension updates it)
      const second = (await callTool('observe_personality', {
        dimension: 'rapport',
        observation: 'Very casual and friendly',
      })) as { confidence: number; evidence_count: number };

      // Confidence should grow via confirmConfidence(0.8) = min(0.95, 0.8 + (1-0.8)*0.1) = 0.82
      expect(second.confidence).toBeGreaterThan(first.confidence);
      expect(second.evidence_count).toBe(2);
    });
  });

  // ─── observe_user ─────────────────────────────────────────────────────

  describe('observe_user', () => {
    it('requires dimension and observation', async () => {
      const noDim = await callToolRaw('observe_user', { observation: 'test' });
      expect(getToolError(noDim)).toContain('dimension is required');

      const noObs = await callToolRaw('observe_user', { dimension: 'work_patterns' });
      expect(getToolError(noObs)).toContain('observation is required');
    });

    it('validates dimension', async () => {
      const response = await callToolRaw('observe_user', {
        dimension: 'invalid_dim',
        observation: 'test',
      });
      expect(getToolError(response)).toContain('Invalid dimension');
    });

    it('creates at 0.3 confidence for inferred source', async () => {
      const result = (await callTool('observe_user', {
        dimension: 'work_patterns',
        observation: 'Prefers deep work blocks in the morning',
      })) as {
        dimension: string;
        content: string;
        confidence: number;
        source: string;
        evidence_count: number;
      };

      expect(result.dimension).toBe('work_patterns');
      expect(result.content).toBe('Prefers deep work blocks in the morning');
      expect(result.confidence).toBe(0.3);
      expect(result.source).toBe('inferred');
      expect(result.evidence_count).toBe(1);
    });
  });

  // ─── propose_identity_update ──────────────────────────────────────────

  describe('propose_identity_update', () => {
    it('requires field, new_value, and reason', async () => {
      const noField = await callToolRaw('propose_identity_update', {
        new_value: 'test',
        reason: 'test',
      });
      expect(getToolError(noField)).toContain('field is required');

      const noValue = await callToolRaw('propose_identity_update', {
        field: 'role',
        reason: 'test',
      });
      expect(getToolError(noValue)).toContain('new_value is required');

      const noReason = await callToolRaw('propose_identity_update', {
        field: 'role',
        new_value: 'test',
      });
      expect(getToolError(noReason)).toContain('reason is required');
    });

    it('validates field', async () => {
      const response = await callToolRaw('propose_identity_update', {
        field: 'invalid_field',
        new_value: 'test',
        reason: 'test',
      });
      expect(getToolError(response)).toContain('Invalid field');
    });

    it('returns proposal_id', async () => {
      // Set up agent identity first (needed for proposals to make sense)
      await identity.setAgentIdentity(defaultProfileId, {
        role: 'assistant',
        expertise: ['general'],
        tone: 'professional',
      });

      const result = (await callTool('propose_identity_update', {
        field: 'tone',
        new_value: 'casual and warm',
        reason: 'User consistently uses informal language',
      })) as {
        proposal_id: string;
        field: string;
        new_value: string;
        reason: string;
        status: string;
      };

      expect(result.proposal_id).toBeDefined();
      expect(typeof result.proposal_id).toBe('string');
      expect(result.field).toBe('tone');
      expect(result.new_value).toBe('casual and warm');
      expect(result.reason).toBe('User consistently uses informal language');
      expect(result.status).toBe('pending_user_confirmation');
    });
  });

  // ─── update_user_identity ─────────────────────────────────────────────

  describe('update_user_identity', () => {
    it('requires field and value', async () => {
      const noField = await callToolRaw('update_user_identity', { value: 'test' });
      expect(getToolError(noField)).toContain('field is required');

      const noValue = await callToolRaw('update_user_identity', { field: 'name' });
      expect(getToolError(noValue)).toContain('value is required');
    });

    it('validates field', async () => {
      const response = await callToolRaw('update_user_identity', {
        field: 'invalid_field',
        value: 'test',
      });
      expect(getToolError(response)).toContain('Invalid field');
    });

    it('updates the record', async () => {
      const result = (await callTool('update_user_identity', {
        field: 'name',
        value: 'Alice',
      })) as { updated: boolean; user_identity: Record<string, unknown> };

      expect(result.updated).toBe(true);
      expect(result.user_identity).toBeDefined();
      expect(result.user_identity.name).toBe('Alice');

      // Verify via get_identity
      const idResult = (await callTool('get_identity')) as {
        user_identity: Record<string, unknown>;
      };
      expect(idResult.user_identity).not.toBeNull();
      expect(idResult.user_identity!.name).toBe('Alice');
    });
  });

  // ─── cleanupStaleSockets ──────────────────────────────────────────────

  describe('cleanupStaleSockets', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowhelm-test-ipc-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('removes -memory.sock files from directory', () => {
      fs.writeFileSync(path.join(tmpDir, 'tg-123-memory.sock'), '');
      fs.writeFileSync(path.join(tmpDir, 'wa-456-memory.sock'), '');

      cleanupStaleSockets(tmpDir);

      const remaining = fs.readdirSync(tmpDir);
      expect(remaining).toHaveLength(0);
    });

    it('ignores non-sock files', () => {
      fs.writeFileSync(path.join(tmpDir, 'tg-123-memory.sock'), '');
      fs.writeFileSync(path.join(tmpDir, 'config.json'), '{}');
      fs.writeFileSync(path.join(tmpDir, 'notes.txt'), 'hello');

      cleanupStaleSockets(tmpDir);

      const remaining = fs.readdirSync(tmpDir);
      expect(remaining).toHaveLength(2);
      expect(remaining).toContain('config.json');
      expect(remaining).toContain('notes.txt');
    });

    it('handles non-existent directory gracefully', () => {
      const nonExistent = path.join(os.tmpdir(), `flowhelm-nonexistent-${crypto.randomUUID()}`);
      expect(() => cleanupStaleSockets(nonExistent)).not.toThrow();
    });
  });

  // ─── UDS Lifecycle ────────────────────────────────────────────────────

  describe('UDS lifecycle', () => {
    let freshServer: McpServer;

    beforeEach(async () => {
      // Stop the global server so we can test start/stop lifecycle with a fresh one
      if (server.isListening()) await server.stop();
      const freshSocketPath = path.join(SOCKET_DIR, `test-uds-${Date.now()}.sock`);
      freshServer = new McpServer({
        socketPath: freshSocketPath,
        memory,
        identity,
        profileManager,
        database,
        defaultChatId: 'tg:123',
      });
    });

    afterEach(async () => {
      if (freshServer.isListening()) await freshServer.stop();
    });

    it('start() creates socket and listens for connections', async () => {
      expect(freshServer.isListening()).toBe(false);

      await freshServer.start();

      expect(freshServer.isListening()).toBe(true);
      expect(fs.existsSync(freshServer.getSocketPath())).toBe(true);
    });

    it('stop() closes connections and removes socket file', async () => {
      await freshServer.start();
      expect(freshServer.isListening()).toBe(true);

      await freshServer.stop();

      expect(freshServer.isListening()).toBe(false);
      expect(fs.existsSync(freshServer.getSocketPath())).toBe(false);
    });

    it('accepts connections and processes JSON-RPC messages over UDS', async () => {
      await freshServer.start();

      const response = await new Promise<string>((resolve, reject) => {
        const client = net.createConnection(freshServer.getSocketPath(), () => {
          const request = JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
          });
          client.write(request + '\n');
        });

        let data = '';
        client.on('data', (chunk) => {
          data += chunk.toString();
          const newlineIdx = data.indexOf('\n');
          if (newlineIdx !== -1) {
            const line = data.slice(0, newlineIdx);
            client.end();
            resolve(line);
          }
        });

        client.on('error', reject);
        setTimeout(() => {
          client.destroy();
          reject(new Error('Timed out waiting for response'));
        }, 5000);
      });

      const parsed = JSON.parse(response);
      expect(parsed.jsonrpc).toBe('2.0');
      expect(parsed.id).toBe(1);
      expect(parsed.result.protocolVersion).toBe('2024-11-05');
      expect(parsed.result.serverInfo.name).toBe('flowhelm');
    });
  });

  // ─── Edge Cases ───────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('returns null for notifications/initialized', async () => {
      const response = await server.handleRequest({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      });

      expect(response).toBeNull();
    });

    it('preserves null id in request', async () => {
      const response = await server.handleRequest({
        jsonrpc: '2.0',
        id: undefined as unknown as number,
        method: 'initialize',
      });

      expect(response).not.toBeNull();
      expect(response!.id).toBeNull();
    });

    it('getSocketPath returns the configured path', () => {
      expect(server.getSocketPath()).toMatch(/flowhelm-test-mcp/);
    });

    it('tool error wraps exceptions with isError flag', async () => {
      // Trigger an error by querying with a stopped memory manager
      await memory.stop();

      const response = await callToolRaw('search_semantic', { query: 'test' });
      const result = response!.result as {
        content: Array<{ text: string }>;
        isError: boolean;
      };
      expect(result.isError).toBe(true);

      // Re-start for teardown
      await memory.start();
    });
  });
});
