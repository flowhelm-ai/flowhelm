/**
 * Async PostgreSQL database layer.
 *
 * Per-user database with version-tracked migrations, pgvector for semantic
 * search, and LISTEN/NOTIFY for event-driven queue processing. Uses
 * postgres.js tagged template literals for SQL injection prevention
 * by construction.
 *
 * Improvements over Phase 3 SQLite:
 * - Async I/O (non-blocking event loop)
 * - FOR UPDATE SKIP LOCKED (true row-level locking for queue)
 * - LISTEN/NOTIFY (instant queue event delivery, no polling)
 * - pgvector HNSW indexes (sub-ms cosine similarity search)
 * - JSONB (native structured metadata)
 * - Three-tier memory tables (long-term, knowledge base, sessions)
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Sql } from './connection.js';
import type { Startable } from './types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DatabaseOptions {
  /** postgres.js SQL connection. */
  sql: Sql;
  /** Skip schema initialization (for testing with pre-initialized pglite). */
  skipInit?: boolean;
}

// ─── Row Types ──────────────────────────────────────────────────────────────

export interface ChatRow {
  id: string;
  channel: string;
  external_id: string;
  name: string | null;
  is_group: boolean;
  created_at: number;
  updated_at: number;
}

export interface MessageRow {
  id: string;
  chat_id: string;
  sender_id: string;
  sender_name: string;
  content: string | null;
  audio_path: string | null;
  image_path: string | null;
  reply_to_id: string | null;
  timestamp: number;
  is_from_me: boolean;
  is_bot_message: boolean;
  session_id: string | null;
}

export interface QueueRow {
  id: number;
  message_id: string;
  chat_id: string;
  channel: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  max_attempts: number;
  created_at: number;
  updated_at: number;
  error: string | null;
}

export interface CursorRow {
  chat_id: string;
  timestamp: number;
  updated_at: number;
}

// ─── Database Manager ───────────────────────────────────────────────────────

export class FlowHelmDatabase implements Startable {
  private sql: Sql;
  private started = false;

  constructor(private readonly options: DatabaseOptions) {
    this.sql = options.sql;
  }

  /** Initialize schema (idempotent — safe on every startup). */
  async start(): Promise<void> {
    if (!this.options.skipInit) {
      const schemaPath = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql');
      const schemaSql = readFileSync(schemaPath, 'utf-8');
      await this.sql.unsafe(schemaSql);
    }
    this.started = true;
  }

  /** Close the database connection pool. */
  async stop(): Promise<void> {
    this.started = false;
    // Connection lifecycle is managed by the caller (connection factory)
    // We don't call sql.end() here because the connection may be shared
  }

  /** Get the postgres.js SQL tagged template function. */
  getSql(): Sql {
    if (!this.started) {
      throw new Error('Database not started. Call start() first.');
    }
    return this.sql;
  }

  /** Check if the database is ready. */
  isReady(): boolean {
    return this.started;
  }

  // ── Chat Operations ───────────────────────────────────────────────────────

  /** Upsert a chat. profileId is required for new chats. Returns the chat ID. */
  async upsertChat(chat: {
    id: string;
    channel: string;
    externalId: string;
    name?: string;
    isGroup?: boolean;
    profileId: string;
  }): Promise<string> {
    const sql = this.getSql();
    const now = Date.now();
    await sql`
      INSERT INTO chats (id, channel, external_id, name, is_group, profile_id, created_at, updated_at)
      VALUES (${chat.id}, ${chat.channel}, ${chat.externalId}, ${chat.name ?? null}, ${chat.isGroup ?? false}, ${chat.profileId}, ${now}, ${now})
      ON CONFLICT(id) DO UPDATE SET
        name = COALESCE(EXCLUDED.name, chats.name),
        updated_at = EXCLUDED.updated_at
    `;
    return chat.id;
  }

  /** Get a chat by ID. */
  async getChat(chatId: string): Promise<ChatRow | undefined> {
    const sql = this.getSql();
    const rows = await sql<ChatRow[]>`SELECT * FROM chats WHERE id = ${chatId}`;
    return rows[0];
  }

  // ── Message Operations ────────────────────────────────────────────────────

  /** Store a message. Also upserts the chat. Requires profileId for new chats. */
  async storeMessage(msg: {
    id: string;
    chatId: string;
    channel: string;
    externalChatId: string;
    senderId: string;
    senderName: string;
    content?: string;
    audioPath?: string;
    imagePath?: string;
    replyToId?: string;
    timestamp: number;
    isFromMe: boolean;
    isBotMessage?: boolean;
    sessionId?: string;
    profileId: string;
  }): Promise<void> {
    const sql = this.getSql();

    // Ensure chat exists
    await this.upsertChat({
      id: msg.chatId,
      channel: msg.channel,
      externalId: msg.externalChatId,
      profileId: msg.profileId,
    });

    await sql`
      INSERT INTO memory_working (id, chat_id, sender_id, sender_name, content, audio_path, image_path,
        reply_to_id, timestamp, is_from_me, is_bot_message, session_id)
      VALUES (${msg.id}, ${msg.chatId}, ${msg.senderId}, ${msg.senderName},
        ${msg.content ?? null}, ${msg.audioPath ?? null}, ${msg.imagePath ?? null},
        ${msg.replyToId ?? null}, ${msg.timestamp}, ${msg.isFromMe}, ${msg.isBotMessage ?? false},
        ${msg.sessionId ?? null})
      ON CONFLICT (id, chat_id) DO NOTHING
    `;
  }

  /**
   * Backfill session_id on a message written by the channel container.
   *
   * The channel container writes messages with session_id = NULL because
   * session management is orchestrator logic. After dequeue, the
   * orchestrator calls this to associate the message with its session.
   */
  async backfillSessionId(messageId: string, chatId: string, sessionId: string): Promise<void> {
    const sql = this.getSql();
    await sql`
      UPDATE memory_working SET session_id = ${sessionId}
      WHERE id = ${messageId} AND chat_id = ${chatId} AND session_id IS NULL
    `;
  }

  /**
   * Get messages for a chat since a timestamp, ordered chronologically.
   * Uses the efficient subquery pattern: get newest N, then re-sort ASC.
   */
  async getMessagesSince(
    chatId: string,
    sinceTimestamp: number,
    limit = 50,
  ): Promise<MessageRow[]> {
    const sql = this.getSql();
    return sql<MessageRow[]>`
      SELECT * FROM (
        SELECT * FROM memory_working
        WHERE chat_id = ${chatId} AND timestamp > ${sinceTimestamp} AND is_bot_message = false
        ORDER BY timestamp DESC
        LIMIT ${limit}
      ) sub ORDER BY timestamp ASC
    `;
  }

  /** Get the most recent N messages for a chat (all types). */
  async getRecentMessages(chatId: string, limit = 20): Promise<MessageRow[]> {
    const sql = this.getSql();
    return sql<MessageRow[]>`
      SELECT * FROM (
        SELECT * FROM memory_working
        WHERE chat_id = ${chatId}
        ORDER BY timestamp DESC
        LIMIT ${limit}
      ) sub ORDER BY timestamp ASC
    `;
  }

  // ── Cursor Operations ─────────────────────────────────────────────────────

  /** Get the processing cursor for a chat. Returns 0 if not set. */
  async getCursor(chatId: string): Promise<number> {
    const sql = this.getSql();
    const rows = await sql<[{ timestamp: string | number }]>`
      SELECT timestamp FROM cursors WHERE chat_id = ${chatId}
    `;
    return rows[0] ? Number(rows[0].timestamp) : 0;
  }

  /** Set the processing cursor for a chat. */
  async setCursor(chatId: string, timestamp: number): Promise<void> {
    const sql = this.getSql();
    const now = Date.now();
    await sql`
      INSERT INTO cursors (chat_id, timestamp, updated_at)
      VALUES (${chatId}, ${timestamp}, ${now})
      ON CONFLICT(chat_id) DO UPDATE SET
        timestamp = EXCLUDED.timestamp,
        updated_at = EXCLUDED.updated_at
    `;
  }

  /** Get all cursors. */
  async getAllCursors(): Promise<CursorRow[]> {
    const sql = this.getSql();
    return sql<CursorRow[]>`SELECT * FROM cursors`;
  }

  // ── State Operations ──────────────────────────────────────────────────────

  /** Get a global state value. */
  async getState(key: string): Promise<string | undefined> {
    const sql = this.getSql();
    const rows = await sql<[{ value: string }]>`SELECT value FROM state WHERE key = ${key}`;
    return rows[0]?.value;
  }

  /** Set a global state value. */
  async setState(key: string, value: string): Promise<void> {
    const sql = this.getSql();
    await sql`
      INSERT INTO state (key, value) VALUES (${key}, ${value})
      ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value
    `;
  }
}
