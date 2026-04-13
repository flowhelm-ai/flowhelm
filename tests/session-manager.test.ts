import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { SessionManager } from '../src/agent/session-manager.js';

// ─── Mock SQL ──────────────────────────────────────────────────────────────

function createMockSql() {
  const queryResults: Record<string, unknown[]> = {};
  let lastQuery = '';

  const sqlFn = (strings: TemplateStringsArray, ...values: unknown[]) => {
    lastQuery = strings.join('?');

    // Route queries based on content (most specific first)
    if (
      lastQuery.includes('SELECT') &&
      lastQuery.includes('ORDER BY') &&
      lastQuery.includes('updated_at')
    ) {
      return Promise.resolve(queryResults['listActive'] ?? []);
    }
    if (
      lastQuery.includes('SELECT') &&
      lastQuery.includes('agent_sessions') &&
      lastQuery.includes('expires_at >')
    ) {
      return Promise.resolve(queryResults['getActive'] ?? []);
    }
    if (lastQuery.includes('DELETE') && lastQuery.includes('RETURNING')) {
      return Promise.resolve(queryResults['cleanup'] ?? []);
    }
    if (lastQuery.includes('DELETE')) {
      return Promise.resolve([]);
    }
    if (lastQuery.includes('INSERT') || lastQuery.includes('ON CONFLICT')) {
      return Promise.resolve([]);
    }
    if (lastQuery.includes('UPDATE')) {
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  };

  // Add postgres.js helper methods to the mock
  sqlFn.json = (value: unknown) => value;

  return {
    sql: sqlFn as unknown,
    setQueryResult: (key: string, value: unknown[]) => {
      queryResults[key] = value;
    },
    getLastQuery: () => lastQuery,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SessionManager
// ═══════════════════════════════════════════════════════════════════════════

describe('SessionManager', () => {
  let manager: SessionManager;
  let mockSql: ReturnType<typeof createMockSql>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockSql = createMockSql();
    manager = new SessionManager({
      sql: mockSql.sql as any,
      idleTimeout: 3_600_000, // 60 min
      hardExpiry: 86_400_000, // 24h
      cleanupInterval: 300_000, // 5 min
    });
  });

  afterEach(() => {
    manager.stop();
    vi.useRealTimers();
  });

  // ── getActiveSession ──────────────────────────────────────────────────

  describe('getActiveSession', () => {
    it('returns null when no session exists', async () => {
      const result = await manager.getActiveSession('tg:123');
      expect(result).toBeNull();
    });

    it('returns session when found', async () => {
      mockSql.setQueryResult('getActive', [
        {
          chat_id: 'tg:123',
          session_id: 'sess-abc',
          session_files: { 'main.jsonl': 'content' },
          last_assistant_uuid: 'uuid-xyz',
          message_count: 5,
          created_at: 1000,
          updated_at: 2000,
          expires_at: 9999999999,
        },
      ]);

      const result = await manager.getActiveSession('tg:123');
      expect(result).not.toBeNull();
      expect(result!.chatId).toBe('tg:123');
      expect(result!.sessionId).toBe('sess-abc');
      expect(result!.sessionFiles).toEqual({ 'main.jsonl': 'content' });
      expect(result!.lastAssistantUuid).toBe('uuid-xyz');
      expect(result!.messageCount).toBe(5);
    });
  });

  // ── saveSession ───────────────────────────────────────────────────────

  describe('saveSession', () => {
    it('saves a session via UPSERT', async () => {
      await expect(
        manager.saveSession('tg:123', 'sess-new', { 'main.jsonl': 'data' }),
      ).resolves.not.toThrow();
    });

    it('saves with optional metadata', async () => {
      await expect(
        manager.saveSession(
          'tg:123',
          'sess-new',
          { 'main.jsonl': 'data' },
          {
            lastAssistantUuid: 'uuid-last',
            messageCount: 10,
          },
        ),
      ).resolves.not.toThrow();
    });
  });

  // ── deleteSession ─────────────────────────────────────────────────────

  describe('deleteSession', () => {
    it('deletes a session', async () => {
      await expect(manager.deleteSession('tg:123')).resolves.not.toThrow();
    });
  });

  // ── restoreToFilesystem ───────────────────────────────────────────────

  describe('restoreToFilesystem', () => {
    it('returns null when no session exists', async () => {
      const result = await manager.restoreToFilesystem('tg:999', '/tmp/test-restore');
      expect(result).toBeNull();
    });

    it('restores session files to target directory', async () => {
      const { mkdir, writeFile, readFile, rm } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const targetDir = join('/tmp', `flowhelm-test-${Date.now()}`);

      try {
        mockSql.setQueryResult('getActive', [
          {
            chat_id: 'tg:restore',
            session_id: 'sess-restore',
            session_files: {
              'main.jsonl': '{"type":"system"}\n',
              'subagents/agent-1.jsonl': '{"type":"user"}\n',
            },
            last_assistant_uuid: null,
            message_count: 1,
            created_at: 1000,
            updated_at: 2000,
            expires_at: 9999999999,
          },
        ]);

        const result = await manager.restoreToFilesystem('tg:restore', targetDir);
        expect(result).not.toBeNull();
        expect(result!.sessionId).toBe('sess-restore');

        // Verify files were written
        const mainContent = await readFile(join(targetDir, 'main.jsonl'), 'utf-8');
        expect(mainContent).toBe('{"type":"system"}\n');

        const subContent = await readFile(join(targetDir, 'subagents', 'agent-1.jsonl'), 'utf-8');
        expect(subContent).toBe('{"type":"user"}\n');
      } finally {
        await rm(targetDir, { recursive: true, force: true });
      }
    });
  });

  // ── saveFromFilesystem ────────────────────────────────────────────────

  describe('saveFromFilesystem', () => {
    it('reads session files and saves to PG', async () => {
      const { mkdir, writeFile, rm } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const sourceDir = join('/tmp', `flowhelm-test-src-${Date.now()}`);

      try {
        // Create test files
        await mkdir(join(sourceDir, 'subagents'), { recursive: true });
        await writeFile(join(sourceDir, 'main.jsonl'), '{"type":"test"}');
        await writeFile(join(sourceDir, 'sessions-index.json'), '{}');
        await writeFile(join(sourceDir, 'subagents', 'agent-1.jsonl'), '{"type":"sub"}');
        // Non-session file should be ignored
        await writeFile(join(sourceDir, 'README.md'), '# ignored');

        await expect(
          manager.saveFromFilesystem('tg:save', sourceDir, 'sess-save', { messageCount: 3 }),
        ).resolves.not.toThrow();
      } finally {
        await rm(sourceDir, { recursive: true, force: true });
      }
    });

    it('handles non-existent source directory', async () => {
      await expect(
        manager.saveFromFilesystem('tg:nodir', '/nonexistent/path', 'sess-none'),
      ).resolves.not.toThrow();
    });
  });

  // ── cleanupExpired ────────────────────────────────────────────────────

  describe('cleanupExpired', () => {
    it('returns count of deleted sessions', async () => {
      mockSql.setQueryResult('cleanup', [{ chat_id: 'tg:1' }, { chat_id: 'tg:2' }]);
      const count = await manager.cleanupExpired();
      expect(count).toBe(2);
    });

    it('returns 0 when no expired sessions', async () => {
      mockSql.setQueryResult('cleanup', []);
      const count = await manager.cleanupExpired();
      expect(count).toBe(0);
    });
  });

  // ── touchSession ──────────────────────────────────────────────────────

  describe('touchSession', () => {
    it('updates expiry without error', async () => {
      await expect(manager.touchSession('tg:touch')).resolves.not.toThrow();
    });
  });

  // ── listActiveSessions ────────────────────────────────────────────────

  describe('listActiveSessions', () => {
    it('returns empty array when no sessions', async () => {
      const result = await manager.listActiveSessions();
      expect(result).toEqual([]);
    });

    it('returns all active sessions', async () => {
      mockSql.setQueryResult('listActive', [
        {
          chat_id: 'tg:1',
          session_id: 'sess-1',
          session_files: {},
          last_assistant_uuid: null,
          message_count: 1,
          created_at: 1000,
          updated_at: 2000,
          expires_at: 9999999999,
        },
        {
          chat_id: 'tg:2',
          session_id: 'sess-2',
          session_files: {},
          last_assistant_uuid: null,
          message_count: 3,
          created_at: 1000,
          updated_at: 3000,
          expires_at: 9999999999,
        },
      ]);

      const result = await manager.listActiveSessions();
      expect(result).toHaveLength(2);
      expect(result[0].chatId).toBe('tg:1');
      expect(result[1].chatId).toBe('tg:2');
    });
  });

  // ── Cleanup Timer ─────────────────────────────────────────────────────

  describe('cleanup timer', () => {
    it('starts and stops cleanup timer', () => {
      manager.start();
      // Timer is running — just verify no errors
      manager.stop();
    });

    it('does not start duplicate timers', () => {
      manager.start();
      manager.start(); // Should be no-op
      manager.stop();
    });
  });
});
