/**
 * Tests for the Gmail Watch lifecycle manager.
 *
 * Covers: watch creation, renewal, stop, historyId tracking,
 * restoration from persisted state.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { GmailWatchManager } from '../src/channels/gmail/watch.js';
import type { GmailClient, GmailWatchResponse } from '../src/channels/gmail/gmail-client.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

function createMockClient(overrides: Partial<GmailClient> = {}): GmailClient {
  return {
    createWatch: vi.fn(
      async (): Promise<GmailWatchResponse> => ({
        historyId: '100',
        expiration: String(Date.now() + 7 * 24 * 60 * 60 * 1000),
      }),
    ),
    stopWatch: vi.fn(async () => {}),
    ...overrides,
  } as unknown as GmailClient;
}

function createManager(
  client?: GmailClient,
  options?: { renewalInterval?: number; onHistoryIdUpdate?: (id: string) => void },
) {
  return new GmailWatchManager({
    client: client ?? createMockClient(),
    topicName: 'projects/test/topics/flowhelm-gmail',
    renewalInterval: options?.renewalInterval ?? 100_000_000, // Very long to avoid auto-renew
    onHistoryIdUpdate: options?.onHistoryIdUpdate,
  });
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('GmailWatchManager', () => {
  let manager: GmailWatchManager;

  afterEach(async () => {
    if (manager) {
      await manager.stopWatch();
    }
  });

  it('creates a watch and sets state', async () => {
    const client = createMockClient();
    manager = createManager(client);

    const response = await manager.createWatch();

    expect(response.historyId).toBe('100');
    expect(client.createWatch).toHaveBeenCalledWith('projects/test/topics/flowhelm-gmail', [
      'INBOX',
    ]);

    const state = manager.getState();
    expect(state.active).toBe(true);
    expect(state.historyId).toBe('100');
    expect(state.expiration).toBeGreaterThan(Date.now());
  });

  it('uses initialHistoryId if provided', async () => {
    manager = createManager();
    await manager.createWatch('50');

    expect(manager.getHistoryId()).toBe('50');
  });

  it('stops watch and marks inactive', async () => {
    const client = createMockClient();
    manager = createManager(client);
    await manager.createWatch();

    await manager.stopWatch();

    expect(client.stopWatch).toHaveBeenCalled();
    expect(manager.getState().active).toBe(false);
  });

  it('handles stop failure gracefully (expired watch)', async () => {
    const client = createMockClient({
      stopWatch: vi.fn(async () => {
        throw new Error('Watch already expired');
      }),
    } as Partial<GmailClient>);
    manager = createManager(client);
    await manager.createWatch();

    // Should not throw
    await manager.stopWatch();
    expect(manager.getState().active).toBe(false);
  });

  it('renews watch preserving current historyId', async () => {
    const client = createMockClient({
      createWatch: vi.fn(
        async (): Promise<GmailWatchResponse> => ({
          historyId: '200',
          expiration: String(Date.now() + 7 * 24 * 60 * 60 * 1000),
        }),
      ),
    } as Partial<GmailClient>);
    manager = createManager(client);

    // Create with initial historyId
    await manager.createWatch('150');
    expect(manager.getHistoryId()).toBe('150');

    // Renew — should keep our historyId, not the response's
    await manager.renewWatch();
    expect(manager.getHistoryId()).toBe('150');
    expect(manager.getState().active).toBe(true);
  });

  it('updateHistoryId advances only forward', () => {
    manager = createManager();
    manager.restoreHistoryId('100');

    manager.updateHistoryId('200');
    expect(manager.getHistoryId()).toBe('200');

    // Trying to go backwards should be ignored
    manager.updateHistoryId('150');
    expect(manager.getHistoryId()).toBe('200');
  });

  it('updateHistoryId calls onHistoryIdUpdate callback', () => {
    const callback = vi.fn();
    manager = createManager(undefined, { onHistoryIdUpdate: callback });
    manager.restoreHistoryId('100');

    manager.updateHistoryId('200');
    expect(callback).toHaveBeenCalledWith('200');
  });

  it('restoreHistoryId sets historyId without creating a watch', () => {
    manager = createManager();
    manager.restoreHistoryId('500');

    expect(manager.getHistoryId()).toBe('500');
    expect(manager.getState().active).toBe(false);
  });
});
