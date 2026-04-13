/**
 * Thin PostgreSQL adapter for the channel container.
 *
 * The channel container writes inbound messages directly to PostgreSQL
 * (chats + memory_working + queue) instead of routing through the
 * orchestrator. This ensures crash-safe message delivery — if the
 * orchestrator is down, messages are safely queued in PG.
 *
 * Only 4 operations, ~80 lines of SQL. NOT the full FlowHelmDatabase.
 * Minimal coupling: these tables (chats, memory_working, queue) are
 * core and stable.
 */

import postgres from 'postgres';
import type { InboundMessage } from '../orchestrator/types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ChannelDbOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  /** Connection retry deadline in ms (default: 30000). */
  connectTimeout?: number;
}

// ─── Writer ─────────────────────────────────────────────────────────────────

export class ChannelDbWriter {
  private sql: postgres.Sql | undefined;
  private readonly options: ChannelDbOptions;
  private defaultProfileId: string | undefined;

  constructor(options: ChannelDbOptions) {
    this.options = options;
  }

  /**
   * Connect to PostgreSQL with retry-and-deadline.
   * Same pattern as the orchestrator's DB connection.
   */
  async connect(): Promise<void> {
    const deadline = Date.now() + (this.options.connectTimeout ?? 30_000);
    const retryInterval = 1000;

    while (Date.now() < deadline) {
      try {
        this.sql = postgres({
          host: this.options.host,
          port: this.options.port,
          user: this.options.user,
          password: this.options.password,
          database: this.options.database,
          max: 3,
          idle_timeout: 60,
        });
        // Test connection
        await this.sql`SELECT 1`;
        console.log(`[channel-db] Connected to ${this.options.host}:${String(this.options.port)}`);
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[channel-db] Connection failed: ${msg}, retrying...`);
        await new Promise((resolve) => setTimeout(resolve, retryInterval));
      }
    }

    throw new Error(
      `[channel-db] Failed to connect within ${String(this.options.connectTimeout ?? 30_000)}ms`,
    );
  }

  /**
   * Close the database connection.
   */
  async close(): Promise<void> {
    if (this.sql) {
      await this.sql.end();
      this.sql = undefined;
    }
  }

  /**
   * Resolve the default agent profile ID.
   * Cached after first call — the default profile rarely changes.
   */
  async resolveDefaultProfileId(): Promise<string> {
    if (this.defaultProfileId) return this.defaultProfileId;
    const sql = this.requireSql();

    const rows = await sql`
      SELECT id FROM agent_profiles WHERE is_default = true LIMIT 1
    `;

    if (rows.length === 0) {
      throw new Error('[channel-db] No default agent profile found');
    }

    const row = rows[0];
    if (!row) throw new Error('[channel-db] Default profile row missing');
    this.defaultProfileId = row.id as string;
    return this.defaultProfileId;
  }

  /**
   * Ensure a chat row exists. Creates it if missing, updates name on conflict.
   * Must be called before storeMessage/enqueueMessage (FK constraint).
   */
  async upsertChat(
    chatId: string,
    channel: string,
    externalId: string,
    name: string | null,
    profileId: string,
  ): Promise<void> {
    const sql = this.requireSql();
    const now = Date.now();

    await sql`
      INSERT INTO chats (id, channel, external_id, name, profile_id, created_at, updated_at)
      VALUES (${chatId}, ${channel}, ${externalId}, ${name}, ${profileId}, ${now}, ${now})
      ON CONFLICT (id) DO UPDATE SET
        name = COALESCE(EXCLUDED.name, chats.name),
        updated_at = ${now}
    `;
  }

  /**
   * Store a normalized inbound message in memory_working.
   * Written with session_id = NULL — the orchestrator backfills
   * session_id after dequeue (session management is orchestrator logic).
   */
  async storeMessage(chatId: string, message: InboundMessage): Promise<void> {
    const sql = this.requireSql();

    await sql`
      INSERT INTO memory_working (
        id, chat_id, sender_id, sender_name, content,
        audio_path, image_path, reply_to_id,
        timestamp, is_from_me, is_bot_message, session_id
      ) VALUES (
        ${message.id}, ${chatId}, ${message.userId}, ${message.senderName},
        ${message.text ?? null}, ${message.audioPath ?? null},
        ${message.imagePath ?? null}, ${message.replyToMessageId ?? null},
        ${message.timestamp}, ${message.isFromMe}, false, ${null}
      )
      ON CONFLICT (id, chat_id) DO NOTHING
    `;
  }

  /**
   * Enqueue a message for orchestrator processing.
   * The PG trigger fires NOTIFY new_message, which the orchestrator
   * receives via its existing LISTEN subscription.
   */
  async enqueueMessage(chatId: string, message: InboundMessage): Promise<void> {
    const sql = this.requireSql();
    const now = Date.now();
    const payload = message as unknown as Parameters<typeof sql.json>[0];

    await sql`
      INSERT INTO queue (message_id, chat_id, channel, payload, status, created_at, updated_at)
      VALUES (
        ${message.id}, ${chatId}, ${message.channel},
        ${sql.json(payload)}, 'pending', ${now}, ${now}
      )
    `;
  }

  private requireSql(): postgres.Sql {
    if (!this.sql) {
      throw new Error('[channel-db] Not connected — call connect() first');
    }
    return this.sql;
  }
}
