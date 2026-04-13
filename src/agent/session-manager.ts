/**
 * Session manager for warm container PG backup/restore.
 *
 * Session files (JSONL transcripts, subagent data, tool results) live
 * in the container filesystem during warm operation. PG stores a JSONB
 * snapshot for crash recovery — restored only on cold start.
 *
 * One active session per chat (UPSERT on chat_id). Idle timeout stops
 * the container after inactivity. Hard expiry prevents unbounded sessions.
 * Periodic cleanup sweeps expired entries.
 */

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import type { Sql } from '../orchestrator/connection.js';
import type { AgentSession, AgentSessionRow } from './types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SessionManagerOptions {
  sql: Sql;
  /** Warm container idle timeout in ms (default: 60 min). */
  idleTimeout: number;
  /** Hard session expiry in ms (default: 24h). */
  hardExpiry: number;
  /** Cleanup interval in ms (default: 5 min). */
  cleanupInterval: number;
}

// ─── Session Manager ────────────────────────────────────────────────────────

export class SessionManager {
  private readonly sql: Sql;
  private readonly idleTimeout: number;
  private readonly hardExpiry: number;
  private readonly cleanupInterval: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: SessionManagerOptions) {
    this.sql = options.sql;
    this.idleTimeout = options.idleTimeout;
    this.hardExpiry = options.hardExpiry;
    this.cleanupInterval = options.cleanupInterval;
  }

  /**
   * Start the periodic cleanup timer.
   */
  start(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      void this.cleanupExpired();
    }, this.cleanupInterval);
  }

  /**
   * Stop the cleanup timer.
   */
  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Get the active session for a chat, or null if none/expired.
   */
  async getActiveSession(chatId: string): Promise<AgentSession | null> {
    const rows = await this.sql<AgentSessionRow[]>`
      SELECT chat_id, session_id, session_files, last_assistant_uuid,
             message_count, created_at, updated_at, expires_at
      FROM agent_sessions
      WHERE chat_id = ${chatId}
        AND expires_at > ${Date.now()}
    `;
    const row = rows[0];
    if (rows.length === 0 || !row) return null;
    return this.rowToSession(row);
  }

  /**
   * Save or update a session (UPSERT on chat_id).
   *
   * Called async after each agent message to back up session state.
   * The session files map contains relative paths as keys and file
   * contents as values.
   */
  async saveSession(
    chatId: string,
    sessionId: string,
    sessionFiles: Record<string, string>,
    options?: {
      lastAssistantUuid?: string;
      messageCount?: number;
    },
  ): Promise<void> {
    const now = Date.now();
    const expiresAt = now + this.hardExpiry;
    const lastUuid = options?.lastAssistantUuid ?? null;
    const msgCount = options?.messageCount ?? 1;

    await this.sql`
      INSERT INTO agent_sessions (
        chat_id, session_id, session_files, last_assistant_uuid,
        message_count, created_at, updated_at, expires_at
      )
      VALUES (
        ${chatId}, ${sessionId}, ${this.sql.json(sessionFiles)},
        ${lastUuid}, ${msgCount}, ${now}, ${now}, ${expiresAt}
      )
      ON CONFLICT (chat_id)
      DO UPDATE SET
        session_id = EXCLUDED.session_id,
        session_files = EXCLUDED.session_files,
        last_assistant_uuid = EXCLUDED.last_assistant_uuid,
        message_count = EXCLUDED.message_count,
        updated_at = EXCLUDED.updated_at,
        expires_at = EXCLUDED.expires_at
    `;
  }

  /**
   * Delete a session (e.g., on container removal).
   */
  async deleteSession(chatId: string): Promise<void> {
    await this.sql`DELETE FROM agent_sessions WHERE chat_id = ${chatId}`;
  }

  /**
   * Restore session files from PG to a host directory.
   *
   * Used on cold start to reconstruct the session filesystem
   * inside a new container's session directory.
   */
  async restoreToFilesystem(chatId: string, targetDir: string): Promise<AgentSession | null> {
    const session = await this.getActiveSession(chatId);
    if (!session) return null;

    for (const [relativePath, content] of Object.entries(session.sessionFiles)) {
      const fullPath = path.join(targetDir, relativePath);
      await mkdir(path.dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content, 'utf-8');
    }

    return session;
  }

  /**
   * Save session files from a host directory to PG.
   *
   * Reads all files under sourceDir recursively, builds a flat
   * JSONB map { "relative/path": "content" }, and UPSERTs to PG.
   * Filters to known session file patterns (JSONL, JSON, index files).
   */
  async saveFromFilesystem(
    chatId: string,
    sourceDir: string,
    sessionId: string,
    options?: {
      lastAssistantUuid?: string;
      messageCount?: number;
    },
  ): Promise<void> {
    const sessionFiles = await this.readSessionDir(sourceDir);
    await this.saveSession(chatId, sessionId, sessionFiles, options);
  }

  /**
   * Delete all expired sessions.
   * Returns the number of sessions cleaned up.
   */
  async cleanupExpired(): Promise<number> {
    const result = await this.sql`
      DELETE FROM agent_sessions
      WHERE expires_at <= ${Date.now()}
      RETURNING chat_id
    `;
    return result.length;
  }

  /**
   * Refresh the expiry for a session (called on each activity to extend idle timeout).
   */
  async touchSession(chatId: string): Promise<void> {
    const now = Date.now();
    const expiresAt = now + this.idleTimeout;
    await this.sql`
      UPDATE agent_sessions
      SET updated_at = ${now}, expires_at = ${expiresAt}
      WHERE chat_id = ${chatId}
    `;
  }

  /**
   * Get all active (non-expired) sessions.
   */
  async listActiveSessions(): Promise<AgentSession[]> {
    const rows = await this.sql<AgentSessionRow[]>`
      SELECT chat_id, session_id, session_files, last_assistant_uuid,
             message_count, created_at, updated_at, expires_at
      FROM agent_sessions
      WHERE expires_at > ${Date.now()}
      ORDER BY updated_at DESC
    `;
    return rows.map((r) => this.rowToSession(r));
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /**
   * Recursively read a directory tree into a flat { path: content } map.
   * Only includes files matching session patterns.
   */
  private async readSessionDir(dir: string): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    await this.walkDir(dir, dir, files);
    return files;
  }

  private async walkDir(
    baseDir: string,
    currentDir: string,
    files: Record<string, string>,
  ): Promise<void> {
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await this.walkDir(baseDir, fullPath, files);
      } else if (this.isSessionFile(entry.name)) {
        try {
          const content = await readFile(fullPath, 'utf-8');
          const relativePath = path.relative(baseDir, fullPath);
          files[relativePath] = content;
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  /**
   * Check if a file is a session-related file worth backing up.
   * Includes JSONL transcripts, JSON metadata, and index files.
   */
  private isSessionFile(filename: string): boolean {
    return (
      filename.endsWith('.jsonl') ||
      filename.endsWith('.json') ||
      filename === 'sessions-index.json'
    );
  }

  private rowToSession(row: AgentSessionRow): AgentSession {
    // postgres.js may return JSONB as a string — parse if needed
    const sessionFiles: Record<string, string> =
      typeof row.session_files === 'string'
        ? (JSON.parse(row.session_files) as Record<string, string>)
        : row.session_files;

    return {
      chatId: row.chat_id,
      sessionId: row.session_id,
      sessionFiles,
      lastAssistantUuid: row.last_assistant_uuid,
      messageCount: row.message_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
    };
  }
}
