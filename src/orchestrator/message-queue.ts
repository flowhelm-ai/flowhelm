/**
 * PostgreSQL-backed persistent message queue.
 *
 * Status-based queue: pending → processing → completed | failed → dead_letter.
 * Uses FOR UPDATE SKIP LOCKED for true atomic dequeue (PostgreSQL-native).
 * Queue inserts fire NOTIFY via a trigger — the orchestrator subscribes
 * via LISTEN and reacts instantly (no 2-second polling).
 *
 * Crash-resilient: messages stuck in 'processing' are recovered to 'pending'
 * on startup. Failed messages retry up to max_attempts, then move to
 * dead_letter for admin inspection.
 */

import type { Sql } from './connection.js';
import type { InboundMessage, Startable } from './types.js';
import type { FlowHelmDatabase, QueueRow } from './database.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type QueueStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'dead_letter';

export interface QueuedItem {
  id: number;
  message: InboundMessage;
  status: QueueStatus;
  attempts: number;
  maxAttempts: number;
  createdAt: number;
  updatedAt: number;
  error: string | null;
}

export interface MessageQueueOptions {
  database: FlowHelmDatabase;
  /** Default max retry attempts before dead-lettering. */
  maxAttempts?: number;
}

/** Callback invoked when NOTIFY fires on the queue channel. */
export type QueueNotifyHandler = (chatId: string) => void;

// ─── Message Queue ──────────────────────────────────────────────────────────

export class MessageQueue implements Startable {
  private sql: Sql | null = null;
  private readonly database: FlowHelmDatabase;
  private readonly maxAttempts: number;
  private notifyHandler: QueueNotifyHandler | null = null;

  constructor(options: MessageQueueOptions) {
    this.database = options.database;
    this.maxAttempts = options.maxAttempts ?? 3;
  }

  async start(): Promise<void> {
    this.sql = this.database.getSql();
    // Recover any messages stuck in 'processing' from a previous crash
    await this.recoverStuckMessages();
  }

  async stop(): Promise<void> {
    this.sql = null;
    this.notifyHandler = null;
  }

  private getSql(): Sql {
    if (!this.sql) {
      throw new Error('MessageQueue not started. Call start() first.');
    }
    return this.sql;
  }

  /**
   * Subscribe to queue notifications via LISTEN.
   * The handler is called with the chat_id when a new message is enqueued.
   */
  async subscribe(handler: QueueNotifyHandler): Promise<void> {
    const sql = this.getSql();
    this.notifyHandler = handler;
    await sql.listen('new_message', (payload) => {
      if (this.notifyHandler) {
        this.notifyHandler(payload);
      }
    });
  }

  /**
   * On startup, reset any 'processing' messages back to 'pending'.
   * These were being processed when the orchestrator crashed.
   */
  private async recoverStuckMessages(): Promise<void> {
    const sql = this.getSql();
    const now = Date.now();
    await sql`
      UPDATE queue SET status = 'pending', updated_at = ${now}
      WHERE status = 'processing'
    `;
  }

  /**
   * Enqueue a message for processing.
   * The NOTIFY trigger fires automatically on INSERT.
   */
  async enqueue(message: InboundMessage, maxAttempts?: number): Promise<number> {
    const sql = this.getSql();
    const now = Date.now();
    const payload = message as unknown as Parameters<typeof sql.json>[0];

    const rows = await sql<[{ id: number }]>`
      INSERT INTO queue (message_id, chat_id, channel, payload, status, attempts, max_attempts, created_at, updated_at)
      VALUES (${message.id}, ${message.userId}, ${message.channel}, ${sql.json(payload)}, 'pending', 0, ${maxAttempts ?? this.maxAttempts}, ${now}, ${now})
      RETURNING id
    `;
    return Number(rows[0].id);
  }

  /**
   * Dequeue the oldest pending message, marking it as 'processing'.
   * Uses FOR UPDATE SKIP LOCKED for true atomic dequeue.
   * Returns null if the queue is empty.
   */
  async dequeue(): Promise<QueuedItem | null> {
    const sql = this.getSql();
    const now = Date.now();

    const rows = await sql<QueueRow[]>`
      UPDATE queue SET
        status = 'processing',
        attempts = attempts + 1,
        updated_at = ${now}
      WHERE id = (
        SELECT id FROM queue
        WHERE status = 'pending'
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `;

    const row = rows[0];
    if (rows.length === 0 || !row) return null;
    return this.rowToItem(row);
  }

  /**
   * Dequeue the oldest pending message for a specific chat.
   */
  async dequeueForChat(chatId: string): Promise<QueuedItem | null> {
    const sql = this.getSql();
    const now = Date.now();

    const rows = await sql<QueueRow[]>`
      UPDATE queue SET
        status = 'processing',
        attempts = attempts + 1,
        updated_at = ${now}
      WHERE id = (
        SELECT id FROM queue
        WHERE status = 'pending' AND chat_id = ${chatId}
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `;

    const row = rows[0];
    if (rows.length === 0 || !row) return null;
    return this.rowToItem(row);
  }

  /**
   * Acknowledge successful processing. Marks the item as 'completed'.
   */
  async acknowledge(queueId: number): Promise<void> {
    const sql = this.getSql();
    const now = Date.now();
    await sql`
      UPDATE queue SET status = 'completed', updated_at = ${now}
      WHERE id = ${queueId}
    `;
  }

  /**
   * Mark processing as failed. If max attempts exhausted, moves to dead_letter.
   * Otherwise, returns to 'pending' for retry.
   */
  async fail(queueId: number, error: string): Promise<void> {
    const sql = this.getSql();
    const now = Date.now();

    await sql`
      UPDATE queue SET
        status = CASE
          WHEN attempts >= max_attempts THEN 'dead_letter'
          ELSE 'pending'
        END,
        error = ${error},
        updated_at = ${now}
      WHERE id = ${queueId}
    `;
  }

  /**
   * Get the count of messages by status.
   */
  async counts(): Promise<Record<QueueStatus, number>> {
    const sql = this.getSql();
    const rows = await sql<Array<{ status: string; count: number }>>`
      SELECT status, COUNT(*)::integer as count FROM queue
      GROUP BY status
    `;

    const result: Record<QueueStatus, number> = {
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      dead_letter: 0,
    };

    for (const row of rows) {
      if (row.status in result) {
        result[row.status as QueueStatus] = row.count;
      }
    }

    return result;
  }

  /** Get all dead-lettered messages (for admin inspection). */
  async getDeadLetters(): Promise<QueuedItem[]> {
    const sql = this.getSql();
    const rows = await sql<QueueRow[]>`
      SELECT * FROM queue WHERE status = 'dead_letter' ORDER BY created_at ASC
    `;
    return rows.map((r) => this.rowToItem(r));
  }

  /**
   * Get distinct chat IDs with pending messages.
   * Used on startup to drain messages whose NOTIFY was missed.
   */
  async pendingChatIds(): Promise<string[]> {
    const sql = this.getSql();
    const rows = await sql<Array<{ chat_id: string }>>`
      SELECT DISTINCT chat_id FROM queue WHERE status = 'pending' ORDER BY chat_id
    `;
    return rows.map((r) => r.chat_id);
  }

  /** Get pending count (useful for health checks). */
  async pendingCount(): Promise<number> {
    const sql = this.getSql();
    const rows = await sql<[{ count: number }]>`
      SELECT COUNT(*)::integer as count FROM queue WHERE status = 'pending'
    `;
    return rows[0].count;
  }

  /**
   * Purge completed messages older than the given age (ms).
   * Returns the number of rows deleted.
   */
  async purgeCompleted(olderThanMs: number): Promise<number> {
    const sql = this.getSql();
    const cutoff = Date.now() - olderThanMs;
    const result = await sql`
      DELETE FROM queue WHERE status = 'completed' AND updated_at < ${cutoff}
    `;
    return result.count;
  }

  /**
   * Retry a specific dead-lettered message (move back to pending).
   */
  async retryDeadLetter(queueId: number): Promise<boolean> {
    const sql = this.getSql();
    const now = Date.now();
    const result = await sql`
      UPDATE queue SET status = 'pending', attempts = 0, error = NULL, updated_at = ${now}
      WHERE id = ${queueId} AND status = 'dead_letter'
    `;
    return result.count > 0;
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private rowToItem(row: QueueRow): QueuedItem {
    // postgres.js auto-parses JSONB, so payload is already an object
    const message = row.payload as unknown as InboundMessage;
    return {
      id: Number(row.id),
      message,
      status: row.status as QueueStatus,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      error: row.error,
    };
  }
}
