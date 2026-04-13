/**
 * Tests for the gws CLI wrapper.
 *
 * Covers: Gmail operations, Calendar operations, binary availability check.
 * Uses a mock exec function — no real gws binary required.
 */

import { describe, it, expect, vi } from 'vitest';
import { GwsClient } from '../src/channels/gmail/gws.js';
import type { ExecFn } from '../src/channels/gmail/gws.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

function createMockExec(stdout: string, stderr = ''): ExecFn {
  return vi.fn(async () => ({ stdout, stderr }));
}

function createClient(execFn: ExecFn): GwsClient {
  return new GwsClient({ execFn, binaryPath: '/usr/bin/gws' });
}

// ─── Gmail Operations ──────────────────────────────────────────────────────

describe('GwsClient Gmail', () => {
  it('gmailList calls gws with correct args', async () => {
    const execFn = createMockExec(
      JSON.stringify({
        messages: [
          { id: 'msg-1', threadId: 'thread-1' },
          { id: 'msg-2', threadId: 'thread-2' },
        ],
      }),
    );
    const client = createClient(execFn);

    const result = await client.gmailList('is:unread', 5);

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('msg-1');

    expect(execFn).toHaveBeenCalledWith(
      '/usr/bin/gws',
      expect.arrayContaining(['gmail', 'users', 'messages', 'list', '--userId', 'me']),
      expect.anything(),
    );
    const args = (execFn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(args).toContain('--q');
    expect(args).toContain('is:unread');
    expect(args).toContain('--maxResults');
    expect(args).toContain('5');
  });

  it('gmailList returns empty array when no messages', async () => {
    const execFn = createMockExec(JSON.stringify({}));
    const client = createClient(execFn);
    const result = await client.gmailList();
    expect(result).toEqual([]);
  });

  it('gmailGet calls with message ID and format', async () => {
    const msg = {
      id: 'msg-1',
      threadId: 'thread-1',
      snippet: 'Hello',
      payload: { headers: [{ name: 'Subject', value: 'Test' }] },
      labelIds: ['INBOX'],
      internalDate: '1712500000000',
    };
    const execFn = createMockExec(JSON.stringify(msg));
    const client = createClient(execFn);

    const result = await client.gmailGet('msg-1', 'full');
    expect(result.id).toBe('msg-1');
    expect(result.snippet).toBe('Hello');

    const args = (execFn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(args).toContain('--id');
    expect(args).toContain('msg-1');
  });

  it('gmailSend calls send with base64 raw message', async () => {
    const execFn = createMockExec(JSON.stringify({ id: 'sent-1', threadId: 't1' }));
    const client = createClient(execFn);

    const result = await client.gmailSend('bob@example.com', 'Hi Bob', 'Hello from test');
    expect(result.id).toBe('sent-1');

    const args = (execFn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(args).toContain('--requestBody');
    // Verify the requestBody contains a base64url-encoded raw field
    const bodyIdx = args.indexOf('--requestBody') + 1;
    const body = JSON.parse(args[bodyIdx]);
    expect(body.raw).toBeDefined();
    expect(typeof body.raw).toBe('string');
  });

  it('gmailSearch delegates to gmailList', async () => {
    const execFn = createMockExec(JSON.stringify({ messages: [{ id: 'm1', threadId: 't1' }] }));
    const client = createClient(execFn);

    const result = await client.gmailSearch('from:alice@example.com');
    expect(result).toHaveLength(1);
  });

  it('gmailLabels returns label list', async () => {
    const execFn = createMockExec(
      JSON.stringify({
        labels: [
          { id: 'INBOX', name: 'INBOX', type: 'system' },
          { id: 'Label_1', name: 'Work', type: 'user' },
        ],
      }),
    );
    const client = createClient(execFn);

    const labels = await client.gmailLabels();
    expect(labels).toHaveLength(2);
    expect(labels[1].name).toBe('Work');
  });

  it('gmailHistory passes startHistoryId', async () => {
    const execFn = createMockExec(JSON.stringify({ history: [] }));
    const client = createClient(execFn);

    await client.gmailHistory('12345');

    const args = (execFn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(args).toContain('--startHistoryId');
    expect(args).toContain('12345');
  });
});

// ─── Calendar Operations ───────────────────────────────────────────────────

describe('GwsClient Calendar', () => {
  it('calendarList returns events', async () => {
    const execFn = createMockExec(
      JSON.stringify({
        items: [
          {
            id: 'ev-1',
            summary: 'Team Meeting',
            start: { dateTime: '2024-04-08T10:00:00Z' },
            end: { dateTime: '2024-04-08T11:00:00Z' },
            status: 'confirmed',
          },
        ],
      }),
    );
    const client = createClient(execFn);

    const events = await client.calendarList(10);
    expect(events).toHaveLength(1);
    expect(events[0].summary).toBe('Team Meeting');

    const args = (execFn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(args).toContain('calendar');
    expect(args).toContain('events');
    expect(args).toContain('list');
  });

  it('calendarList with time range', async () => {
    const execFn = createMockExec(JSON.stringify({ items: [] }));
    const client = createClient(execFn);

    await client.calendarList(5, '2024-04-01T00:00:00Z', '2024-04-30T00:00:00Z');

    const args = (execFn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(args).toContain('--timeMin');
    expect(args).toContain('2024-04-01T00:00:00Z');
    expect(args).toContain('--timeMax');
    expect(args).toContain('2024-04-30T00:00:00Z');
  });

  it('calendarCreate sends event data', async () => {
    const execFn = createMockExec(
      JSON.stringify({
        id: 'ev-new',
        summary: 'Lunch',
        start: { dateTime: '2024-04-08T12:00:00Z' },
        end: { dateTime: '2024-04-08T13:00:00Z' },
        status: 'confirmed',
      }),
    );
    const client = createClient(execFn);

    const event = await client.calendarCreate({
      summary: 'Lunch',
      start: '2024-04-08T12:00:00Z',
      end: '2024-04-08T13:00:00Z',
      location: 'Cafe',
    });

    expect(event.id).toBe('ev-new');
    expect(event.summary).toBe('Lunch');

    const args = (execFn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(args).toContain('--requestBody');
    const bodyIdx = args.indexOf('--requestBody') + 1;
    const body = JSON.parse(args[bodyIdx]);
    expect(body.summary).toBe('Lunch');
    expect(body.location).toBe('Cafe');
  });

  it('calendarDelete calls with eventId', async () => {
    const execFn = createMockExec('');
    const client = createClient(execFn);

    await client.calendarDelete('ev-delete');

    const args = (execFn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(args).toContain('--eventId');
    expect(args).toContain('ev-delete');
  });
});

// ─── Error Handling ──────────────────────────────────────────────────────

describe('GwsClient errors', () => {
  it('propagates exec errors', async () => {
    const execFn = vi.fn(async () => {
      throw new Error('gws not found');
    }) as unknown as ExecFn;
    const client = createClient(execFn);

    await expect(client.gmailList()).rejects.toThrow('gws not found');
  });

  it('throws on invalid JSON output', async () => {
    const execFn = createMockExec('not-json');
    const client = createClient(execFn);

    await expect(client.gmailList()).rejects.toThrow();
  });
});
