import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FlowHelmDatabase } from '../src/orchestrator/database.js';
import { createTestDatabase, applySchema } from './helpers/pg-container.js';
import type { Sql } from '../src/orchestrator/connection.js';
import type { CursorRow } from '../src/orchestrator/database.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

let sql: Sql;
let cleanup: () => Promise<void>;
let defaultProfileId: string;

async function createDb(): Promise<FlowHelmDatabase> {
  const db = new FlowHelmDatabase({ sql, skipInit: true });
  await db.start();
  return db;
}

function sampleChat(overrides?: Record<string, unknown>) {
  return {
    id: 'tg:123',
    channel: 'telegram',
    externalId: '123',
    name: 'Test Chat',
    isGroup: false,
    profileId: defaultProfileId,
    ...overrides,
  };
}

function sampleMessage(overrides?: Record<string, unknown>) {
  return {
    id: 'msg-1',
    chatId: 'tg:123',
    channel: 'telegram',
    externalChatId: '123',
    senderId: 'user-1',
    senderName: 'Alice',
    content: 'Hello',
    timestamp: 1000,
    isFromMe: false,
    profileId: defaultProfileId,
    ...overrides,
  };
}

// ─── Setup ────────────────────────────────────────────────────────────────

beforeEach(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;

  // Apply schema
  await applySchema(sql);

  // Fetch the default profile ID created by the seed
  const profileRows = await sql<
    [{ id: string }]
  >`SELECT id FROM agent_profiles WHERE is_default = true LIMIT 1`;
  defaultProfileId = profileRows[0].id;
});

afterEach(async () => {
  await cleanup();
});

// ─── Schema & Lifecycle ───────────────────────────────────────────────────

describe('FlowHelmDatabase', () => {
  describe('schema and lifecycle', () => {
    it('creates all expected tables', async () => {
      const rows = await sql<Array<{ tablename: string }>>`
        SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
      `;
      const names = rows.map((r) => r.tablename);
      expect(names).toContain('chats');
      expect(names).toContain('memory_working');
      expect(names).toContain('queue');
      expect(names).toContain('cursors');
      expect(names).toContain('state');
      expect(names).toContain('sessions');
      expect(names).toContain('memory_semantic');
      expect(names).toContain('memory_meta');
      expect(names).toContain('memory_external');
      expect(names).toContain('agent_profiles');
    });

    it('throws when getSql() called before start()', () => {
      const freshDb = new FlowHelmDatabase({ sql });
      expect(() => freshDb.getSql()).toThrow('Database not started');
    });

    it('isReady returns false before start, true after', async () => {
      const freshDb = new FlowHelmDatabase({ sql, skipInit: true });
      expect(freshDb.isReady()).toBe(false);
      await freshDb.start();
      expect(freshDb.isReady()).toBe(true);
      await freshDb.stop();
      expect(freshDb.isReady()).toBe(false);
    });

    it('schema is idempotent — can run twice', async () => {
      const db2 = new FlowHelmDatabase({ sql });
      await expect(db2.start()).resolves.not.toThrow();
    });
  });

  // ─── Chat Operations ──────────────────────────────────────────────────

  describe('chat operations', () => {
    let db: FlowHelmDatabase;
    beforeEach(async () => {
      db = await createDb();
    });
    afterEach(async () => {
      await db.stop();
    });

    it('upserts a new chat', async () => {
      await db.upsertChat(sampleChat());
      const chat = await db.getChat('tg:123');
      expect(chat).toBeDefined();
      expect(chat!.channel).toBe('telegram');
      expect(chat!.external_id).toBe('123');
      expect(chat!.name).toBe('Test Chat');
      expect(chat!.is_group).toBe(false);
    });

    it('updates name on conflict', async () => {
      await db.upsertChat(sampleChat());
      await db.upsertChat(sampleChat({ name: 'Updated Chat' }));
      const chat = await db.getChat('tg:123');
      expect(chat!.name).toBe('Updated Chat');
    });

    it('preserves existing name when upsert provides null', async () => {
      await db.upsertChat(sampleChat({ name: 'Original' }));
      await db.upsertChat(sampleChat({ name: undefined }));
      const chat = await db.getChat('tg:123');
      expect(chat!.name).toBe('Original');
    });

    it('returns undefined for non-existent chat', async () => {
      expect(await db.getChat('nonexistent')).toBeUndefined();
    });

    it('enforces unique (channel, external_id) constraint', async () => {
      await db.upsertChat(sampleChat({ id: 'chat-1', channel: 'telegram', externalId: '123' }));
      await expect(
        db.upsertChat(sampleChat({ id: 'chat-2', channel: 'telegram', externalId: '123' })),
      ).rejects.toThrow();
    });

    it('allows same external_id across different channels', async () => {
      await db.upsertChat(sampleChat({ id: 'tg:123', channel: 'telegram', externalId: '123' }));
      await db.upsertChat(sampleChat({ id: 'wa:123', channel: 'whatsapp', externalId: '123' }));
      expect(await db.getChat('tg:123')).toBeDefined();
      expect(await db.getChat('wa:123')).toBeDefined();
    });
  });

  // ─── Message Operations ────────────────────────────────────────────────

  describe('message operations', () => {
    let db: FlowHelmDatabase;
    beforeEach(async () => {
      db = await createDb();
    });
    afterEach(async () => {
      await db.stop();
    });

    it('stores a message and auto-creates the chat', async () => {
      await db.storeMessage(sampleMessage());
      const chat = await db.getChat('tg:123');
      expect(chat).toBeDefined();

      const msgs = await db.getRecentMessages('tg:123');
      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.content).toBe('Hello');
    });

    it('ignores duplicate messages (ON CONFLICT DO NOTHING)', async () => {
      await db.storeMessage(sampleMessage());
      await db.storeMessage(sampleMessage()); // Same id + chat_id
      const msgs = await db.getRecentMessages('tg:123');
      expect(msgs).toHaveLength(1);
    });

    it('stores messages with same id in different chats', async () => {
      await db.storeMessage(
        sampleMessage({ id: 'msg-1', chatId: 'tg:123', externalChatId: '123' }),
      );
      await db.storeMessage(
        sampleMessage({ id: 'msg-1', chatId: 'tg:456', externalChatId: '456' }),
      );

      expect(await db.getRecentMessages('tg:123')).toHaveLength(1);
      expect(await db.getRecentMessages('tg:456')).toHaveLength(1);
    });

    it('stores optional fields (audio, image, reply)', async () => {
      await db.storeMessage(
        sampleMessage({
          audioPath: '/tmp/voice.ogg',
          imagePath: '/tmp/photo.jpg',
          replyToId: 'msg-0',
        }),
      );
      const msgs = await db.getRecentMessages('tg:123');
      expect(msgs[0]!.audio_path).toBe('/tmp/voice.ogg');
      expect(msgs[0]!.image_path).toBe('/tmp/photo.jpg');
      expect(msgs[0]!.reply_to_id).toBe('msg-0');
    });

    it('uses integer timestamps for efficient range queries', async () => {
      await db.storeMessage(sampleMessage({ id: 'msg-1', timestamp: 1000 }));
      await db.storeMessage(sampleMessage({ id: 'msg-2', timestamp: 2000 }));
      await db.storeMessage(sampleMessage({ id: 'msg-3', timestamp: 3000 }));

      const since = await db.getMessagesSince('tg:123', 1500);
      expect(since).toHaveLength(2);
      expect(since[0]!.id).toBe('msg-2');
      expect(since[1]!.id).toBe('msg-3');
    });

    it('getMessagesSince excludes bot messages', async () => {
      await db.storeMessage(sampleMessage({ id: 'msg-1', timestamp: 1000 }));
      await db.storeMessage(sampleMessage({ id: 'msg-2', timestamp: 2000, isBotMessage: true }));
      await db.storeMessage(sampleMessage({ id: 'msg-3', timestamp: 3000 }));

      const since = await db.getMessagesSince('tg:123', 500);
      expect(since).toHaveLength(2);
      expect(since.every((m) => m.is_bot_message === false)).toBe(true);
    });

    it('getMessagesSince respects limit and returns chronological order', async () => {
      for (let i = 1; i <= 10; i++) {
        await db.storeMessage(sampleMessage({ id: `msg-${String(i)}`, timestamp: i * 1000 }));
      }

      const result = await db.getMessagesSince('tg:123', 0, 3);
      expect(result).toHaveLength(3);
      // Should be the 3 most recent, in ASC order
      expect(result[0]!.id).toBe('msg-8');
      expect(result[1]!.id).toBe('msg-9');
      expect(result[2]!.id).toBe('msg-10');
    });

    it('getRecentMessages returns all message types in order', async () => {
      await db.storeMessage(sampleMessage({ id: 'msg-1', timestamp: 1000 }));
      await db.storeMessage(sampleMessage({ id: 'msg-2', timestamp: 2000, isBotMessage: true }));
      await db.storeMessage(sampleMessage({ id: 'msg-3', timestamp: 3000 }));

      const recent = await db.getRecentMessages('tg:123');
      expect(recent).toHaveLength(3);
      expect(recent[0]!.id).toBe('msg-1');
      expect(recent[2]!.id).toBe('msg-3');
    });

    it('stores session_id when provided', async () => {
      await db.upsertChat(sampleChat());
      // Create a session first
      const sessionRows = await sql<[{ id: string }]>`
        INSERT INTO sessions (chat_id, started_at) VALUES ('tg:123', 1000) RETURNING id
      `;
      const sessionId = sessionRows[0].id;

      await db.storeMessage(sampleMessage({ sessionId }));
      const msgs = await db.getRecentMessages('tg:123');
      expect(msgs[0]!.session_id).toBe(sessionId);
    });
  });

  // ─── Cursor Operations ──────────────────────────────────────────────────

  describe('cursor operations', () => {
    let db: FlowHelmDatabase;
    beforeEach(async () => {
      db = await createDb();
    });
    afterEach(async () => {
      await db.stop();
    });

    it('returns 0 for non-existent cursor', async () => {
      expect(await db.getCursor('tg:123')).toBe(0);
    });

    it('sets and gets a cursor', async () => {
      await db.upsertChat(sampleChat());
      await db.setCursor('tg:123', 5000);
      expect(await db.getCursor('tg:123')).toBe(5000);
    });

    it('updates cursor on conflict', async () => {
      await db.upsertChat(sampleChat());
      await db.setCursor('tg:123', 1000);
      await db.setCursor('tg:123', 5000);
      expect(await db.getCursor('tg:123')).toBe(5000);
    });

    it('getAllCursors returns all cursors', async () => {
      await db.upsertChat(sampleChat({ id: 'tg:1', externalId: '1' }));
      await db.upsertChat(sampleChat({ id: 'tg:2', externalId: '2' }));
      await db.setCursor('tg:1', 1000);
      await db.setCursor('tg:2', 2000);

      const cursors = await db.getAllCursors();
      expect(cursors).toHaveLength(2);
      const map = new Map(cursors.map((c: CursorRow) => [c.chat_id, Number(c.timestamp)]));
      expect(map.get('tg:1')).toBe(1000);
      expect(map.get('tg:2')).toBe(2000);
    });

    it('per-chat cursors are independent', async () => {
      await db.upsertChat(sampleChat({ id: 'tg:1', externalId: '1' }));
      await db.upsertChat(sampleChat({ id: 'tg:2', externalId: '2' }));
      await db.setCursor('tg:1', 1000);
      await db.setCursor('tg:2', 9999);

      expect(await db.getCursor('tg:1')).toBe(1000);
      expect(await db.getCursor('tg:2')).toBe(9999);
    });
  });

  // ─── State Operations ──────────────────────────────────────────────────

  describe('state operations', () => {
    let db: FlowHelmDatabase;
    beforeEach(async () => {
      db = await createDb();
    });
    afterEach(async () => {
      await db.stop();
    });

    it('returns undefined for non-existent key', async () => {
      expect(await db.getState('missing')).toBeUndefined();
    });

    it('sets and gets state', async () => {
      await db.setState('last_poll', '12345');
      expect(await db.getState('last_poll')).toBe('12345');
    });

    it('updates state on conflict', async () => {
      await db.setState('key', 'v1');
      await db.setState('key', 'v2');
      expect(await db.getState('key')).toBe('v2');
    });
  });

  // ─── Foreign Key Enforcement ────────────────────────────────────────────

  describe('foreign key enforcement', () => {
    it('rejects queue insert for non-existent chat', async () => {
      await expect(
        sql`INSERT INTO queue (message_id, chat_id, channel, payload, status, attempts, max_attempts, created_at, updated_at)
            VALUES ('msg', 'nonexistent', 'telegram', '{}', 'pending', 0, 3, 0, 0)`,
      ).rejects.toThrow();
    });

    it('rejects cursor insert for non-existent chat', async () => {
      await expect(
        sql`INSERT INTO cursors (chat_id, timestamp, updated_at)
            VALUES ('nonexistent', 0, 0)`,
      ).rejects.toThrow();
    });

    it('rejects message insert for non-existent chat', async () => {
      await expect(
        sql`INSERT INTO messages (id, chat_id, sender_id, sender_name, timestamp)
            VALUES ('msg-1', 'nonexistent', 'user-1', 'Alice', 1000)`,
      ).rejects.toThrow();
    });
  });
});
