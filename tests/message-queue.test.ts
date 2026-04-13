import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FlowHelmDatabase } from '../src/orchestrator/database.js';
import { MessageQueue } from '../src/orchestrator/message-queue.js';
import { createTestDatabase, applySchema } from './helpers/pg-container.js';
import type { Sql } from '../src/orchestrator/connection.js';
import type { InboundMessage } from '../src/orchestrator/types.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

let sql: Sql;
let cleanup: () => Promise<void>;
let defaultProfileId: string;

function makeMessage(overrides?: Partial<InboundMessage>): InboundMessage {
  return {
    id: 'msg-1',
    channel: 'telegram',
    userId: 'tg:123',
    senderName: 'Alice',
    text: 'Hello',
    timestamp: Date.now(),
    isFromMe: false,
    metadata: {},
    ...overrides,
  };
}

async function createStack(): Promise<{ database: FlowHelmDatabase; queue: MessageQueue }> {
  const database = new FlowHelmDatabase({ sql, skipInit: true });
  await database.start();
  const queue = new MessageQueue({ database, maxAttempts: 3 });
  await queue.start();
  return { database, queue };
}

async function ensureChat(chatId = 'tg:123') {
  const now = Date.now();
  await sql`
    INSERT INTO chats (id, channel, external_id, is_group, profile_id, created_at, updated_at)
    VALUES (${chatId}, 'telegram', ${chatId.replace('tg:', '')}, false, ${defaultProfileId}, ${now}, ${now})
    ON CONFLICT (id) DO NOTHING
  `;
}

// ─── Setup ────────────────────────────────────────────────────────────────

beforeEach(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;

  // Apply schema
  await applySchema(sql);

  const profileRows = await sql`SELECT id FROM agent_profiles WHERE is_default = true LIMIT 1`;
  defaultProfileId = profileRows[0].id as string;
});

afterEach(async () => {
  await cleanup();
});

// ─── Tests ────────────────────────────────────────────────────────────────

describe('MessageQueue', () => {
  let database: FlowHelmDatabase;
  let queue: MessageQueue;

  beforeEach(async () => {
    ({ database, queue } = await createStack());
    await ensureChat();
  });

  afterEach(async () => {
    await queue.stop();
    await database.stop();
  });

  // ─── Enqueue ──────────────────────────────────────────────────────────

  describe('enqueue', () => {
    it('enqueues a message and returns a queue ID', async () => {
      const id = await queue.enqueue(makeMessage());
      expect(id).toBeGreaterThan(0);
    });

    it('enqueues multiple messages with incrementing IDs', async () => {
      const id1 = await queue.enqueue(makeMessage({ id: 'msg-1' }));
      const id2 = await queue.enqueue(makeMessage({ id: 'msg-2' }));
      expect(id2).toBeGreaterThan(id1);
    });

    it('stores the full message payload as JSON', async () => {
      const msg = makeMessage({ text: 'payload test' });
      await queue.enqueue(msg);
      const item = await queue.dequeue();
      expect(item).not.toBeNull();
      expect(item!.message.text).toBe('payload test');
      expect(item!.message.channel).toBe('telegram');
    });

    it('respects custom maxAttempts', async () => {
      await queue.enqueue(makeMessage(), 5);
      const item = await queue.dequeue();
      expect(item!.maxAttempts).toBe(5);
    });
  });

  // ─── Dequeue ──────────────────────────────────────────────────────────

  describe('dequeue', () => {
    it('returns null when queue is empty', async () => {
      expect(await queue.dequeue()).toBeNull();
    });

    it('returns the oldest pending message', async () => {
      await queue.enqueue(makeMessage({ id: 'msg-1', text: 'first' }));
      await queue.enqueue(makeMessage({ id: 'msg-2', text: 'second' }));

      const item = await queue.dequeue();
      expect(item!.message.text).toBe('first');
    });

    it('marks dequeued item as processing', async () => {
      await queue.enqueue(makeMessage());
      const item = await queue.dequeue();
      expect(item!.status).toBe('processing');
    });

    it('increments attempts on dequeue', async () => {
      await queue.enqueue(makeMessage());
      const item = await queue.dequeue();
      expect(item!.attempts).toBe(1);
    });

    it('does not return already-processing messages', async () => {
      await queue.enqueue(makeMessage({ id: 'msg-1' }));
      await queue.dequeue(); // msg-1 is now processing

      await queue.enqueue(makeMessage({ id: 'msg-2' }));
      const item = await queue.dequeue();
      expect(item!.message.id).toBe('msg-2');
    });

    it('does not return completed messages', async () => {
      await queue.enqueue(makeMessage());
      const item = (await queue.dequeue())!;
      await queue.acknowledge(item.id);

      expect(await queue.dequeue()).toBeNull();
    });
  });

  // ─── Dequeue for Chat ─────────────────────────────────────────────────

  describe('dequeueForChat', () => {
    it('returns null when no messages for chat', async () => {
      expect(await queue.dequeueForChat('tg:999')).toBeNull();
    });

    it('only returns messages for the specified chat', async () => {
      await ensureChat('tg:456');
      await queue.enqueue(makeMessage({ id: 'msg-1', userId: 'tg:123' }));
      await queue.enqueue(makeMessage({ id: 'msg-2', userId: 'tg:456' }));

      const item = await queue.dequeueForChat('tg:456');
      expect(item).not.toBeNull();
      expect(item!.message.userId).toBe('tg:456');
    });
  });

  // ─── Acknowledge ──────────────────────────────────────────────────────

  describe('acknowledge', () => {
    it('marks item as completed', async () => {
      await queue.enqueue(makeMessage());
      const item = (await queue.dequeue())!;
      await queue.acknowledge(item.id);

      const counts = await queue.counts();
      expect(counts.completed).toBe(1);
      expect(counts.processing).toBe(0);
    });
  });

  // ─── Fail & Retry ────────────────────────────────────────────────────

  describe('fail and retry', () => {
    it('returns failed item to pending for retry', async () => {
      await queue.enqueue(makeMessage());
      const item = (await queue.dequeue())!;
      await queue.fail(item.id, 'API timeout');

      const counts = await queue.counts();
      expect(counts.pending).toBe(1);
      expect(counts.processing).toBe(0);
    });

    it('stores the error message', async () => {
      await queue.enqueue(makeMessage());
      const item = (await queue.dequeue())!;
      await queue.fail(item.id, 'Connection refused');

      // Re-dequeue to inspect
      const retried = (await queue.dequeue())!;
      expect(retried.error).toBe('Connection refused');
    });

    it('moves to dead_letter after max attempts exhausted', async () => {
      await queue.enqueue(makeMessage(), 2); // max 2 attempts

      // Attempt 1
      const item1 = (await queue.dequeue())!;
      expect(item1.attempts).toBe(1);
      await queue.fail(item1.id, 'error 1');

      // Attempt 2
      const item2 = (await queue.dequeue())!;
      expect(item2.attempts).toBe(2);
      await queue.fail(item2.id, 'error 2');

      // Should be dead-lettered now
      const counts = await queue.counts();
      expect(counts.dead_letter).toBe(1);
      expect(counts.pending).toBe(0);
    });

    it('dead-lettered messages appear in getDeadLetters()', async () => {
      await queue.enqueue(makeMessage(), 1); // max 1 attempt
      const item = (await queue.dequeue())!;
      await queue.fail(item.id, 'fatal error');

      const dead = await queue.getDeadLetters();
      expect(dead).toHaveLength(1);
      expect(dead[0]!.error).toBe('fatal error');
      expect(dead[0]!.message.id).toBe('msg-1');
    });

    it('retryDeadLetter moves item back to pending with reset attempts', async () => {
      await queue.enqueue(makeMessage(), 1);
      const item = (await queue.dequeue())!;
      await queue.fail(item.id, 'error');

      const retried = await queue.retryDeadLetter(item.id);
      expect(retried).toBe(true);

      const counts = await queue.counts();
      expect(counts.pending).toBe(1);
      expect(counts.dead_letter).toBe(0);

      // Can be dequeued again
      const reprocessed = (await queue.dequeue())!;
      expect(reprocessed.attempts).toBe(1);
      expect(reprocessed.error).toBeNull();
    });

    it('retryDeadLetter returns false for non-dead-letter items', async () => {
      await queue.enqueue(makeMessage());
      const item = (await queue.dequeue())!;
      expect(await queue.retryDeadLetter(item.id)).toBe(false);
    });
  });

  // ─── Crash Recovery ───────────────────────────────────────────────────

  describe('crash recovery', () => {
    it('recovers processing messages to pending on start()', async () => {
      await queue.enqueue(makeMessage({ id: 'msg-1' }));
      await queue.enqueue(makeMessage({ id: 'msg-2' }));

      // Dequeue both (marks as processing)
      await queue.dequeue();
      await queue.dequeue();

      let counts = await queue.counts();
      expect(counts.processing).toBe(2);

      // Simulate crash: stop and create a new queue on the same database
      await queue.stop();
      const queue2 = new MessageQueue({ database, maxAttempts: 3 });
      await queue2.start(); // Should recover stuck messages

      counts = await queue2.counts();
      expect(counts.pending).toBe(2);
      expect(counts.processing).toBe(0);

      // Messages can be dequeued again
      const item = await queue2.dequeue();
      expect(item).not.toBeNull();

      await queue2.stop();
    });

    it('does not affect completed or dead_letter messages during recovery', async () => {
      await queue.enqueue(makeMessage({ id: 'msg-1' }));
      await queue.enqueue(makeMessage({ id: 'msg-2' }), 1);

      // Complete msg-1
      const item1 = (await queue.dequeue())!;
      await queue.acknowledge(item1.id);

      // Dead-letter msg-2
      const item2 = (await queue.dequeue())!;
      await queue.fail(item2.id, 'fatal');

      await queue.stop();
      const queue2 = new MessageQueue({ database, maxAttempts: 3 });
      await queue2.start();

      const counts = await queue2.counts();
      expect(counts.completed).toBe(1);
      expect(counts.dead_letter).toBe(1);
      expect(counts.pending).toBe(0);
      expect(counts.processing).toBe(0);

      await queue2.stop();
    });
  });

  // ─── Counts & Maintenance ─────────────────────────────────────────────

  describe('counts and maintenance', () => {
    it('counts returns zeroes on empty queue', async () => {
      const counts = await queue.counts();
      expect(counts.pending).toBe(0);
      expect(counts.processing).toBe(0);
      expect(counts.completed).toBe(0);
      expect(counts.failed).toBe(0);
      expect(counts.dead_letter).toBe(0);
    });

    it('pendingCount returns correct value', async () => {
      expect(await queue.pendingCount()).toBe(0);
      await queue.enqueue(makeMessage({ id: 'msg-1' }));
      await queue.enqueue(makeMessage({ id: 'msg-2' }));
      expect(await queue.pendingCount()).toBe(2);
    });

    it('purgeCompleted removes old completed items', async () => {
      await queue.enqueue(makeMessage());
      const item = (await queue.dequeue())!;
      await queue.acknowledge(item.id);

      // Backdate the updated_at to simulate an old item
      const oldTimestamp = Date.now() - 7_200_000; // 2 hours ago
      await sql`UPDATE queue SET updated_at = ${oldTimestamp} WHERE id = ${item.id}`;

      // Purge items older than 1 hour
      const purged = await queue.purgeCompleted(3_600_000);
      expect(purged).toBe(1);
      expect((await queue.counts()).completed).toBe(0);
    });

    it('purgeCompleted does not remove recent items', async () => {
      await queue.enqueue(makeMessage());
      const item = (await queue.dequeue())!;
      await queue.acknowledge(item.id);

      // Purge items older than 1 hour (nothing should match)
      const purged = await queue.purgeCompleted(3_600_000);
      expect(purged).toBe(0);
      expect((await queue.counts()).completed).toBe(1);
    });
  });

  // ─── FIFO Ordering ────────────────────────────────────────────────────

  describe('FIFO ordering', () => {
    it('dequeues in FIFO order across multiple messages', async () => {
      const messages: string[] = [];
      for (let i = 0; i < 5; i++) {
        await queue.enqueue(makeMessage({ id: `msg-${String(i)}`, text: `message ${String(i)}` }));
      }

      for (let i = 0; i < 5; i++) {
        const item = (await queue.dequeue())!;
        messages.push(item.message.text!);
        await queue.acknowledge(item.id);
      }

      expect(messages).toEqual(['message 0', 'message 1', 'message 2', 'message 3', 'message 4']);
    });

    it('retried messages go to the back based on created_at ordering', async () => {
      await queue.enqueue(makeMessage({ id: 'msg-1', text: 'first' }));
      await queue.enqueue(makeMessage({ id: 'msg-2', text: 'second' }));

      // Fail msg-1 (returns to pending)
      const item1 = (await queue.dequeue())!;
      expect(item1.message.text).toBe('first');
      await queue.fail(item1.id, 'retry me');

      // msg-1 has earlier created_at, so it gets dequeued again first
      const item2 = (await queue.dequeue())!;
      expect(item2.message.text).toBe('first');
    });
  });

  // ─── LISTEN/NOTIFY ────────────────────────────────────────────────────

  describe('LISTEN/NOTIFY', () => {
    it('fires notification on enqueue', async () => {
      const notifications: string[] = [];

      await queue.subscribe((chatId) => {
        notifications.push(chatId);
      });

      await queue.enqueue(makeMessage({ userId: 'tg:123' }));

      // NOTIFY is delivered asynchronously — give it a moment
      await new Promise((r) => setTimeout(r, 200));

      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toBe('tg:123');
    });
  });

  // ─── Lifecycle Safety ─────────────────────────────────────────────────

  describe('lifecycle safety', () => {
    it('throws when enqueue called before start()', async () => {
      const db2 = new FlowHelmDatabase({ sql, skipInit: true });
      await db2.start();
      const q2 = new MessageQueue({ database: db2, maxAttempts: 3 });
      // q2.start() NOT called
      await expect(q2.enqueue(makeMessage())).rejects.toThrow('not started');
      await db2.stop();
    });
  });
});
