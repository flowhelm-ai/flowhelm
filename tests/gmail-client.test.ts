/**
 * Tests for the Gmail REST API client.
 *
 * Covers: OAuth token refresh, message operations, watch lifecycle,
 * profile retrieval, email parsing, base64url encoding/decoding.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  GmailClient,
  parseGmailMessage,
  getHeader,
  decodeBase64Url,
  encodeBase64Url,
  buildRawEmail,
} from '../src/channels/gmail/gmail-client.js';
import type { GmailMessage, GmailMessagePayload } from '../src/channels/gmail/gmail-client.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

function createMockFetch(
  responses: Array<{ status: number; body?: unknown; contentType?: string }>,
) {
  let callIndex = 0;
  return vi.fn(async () => {
    const resp = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;
    return {
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status,
      statusText: resp.status === 200 ? 'OK' : 'Error',
      text: async () => JSON.stringify(resp.body ?? {}),
      json: async () => resp.body ?? {},
      headers: {
        get: (name: string) => {
          if (name === 'content-type') return resp.contentType ?? 'application/json';
          return null;
        },
      },
    } as unknown as Response;
  });
}

function createClient(fetchFn: typeof fetch) {
  return new GmailClient({
    emailAddress: 'test@gmail.com',
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    refreshToken: 'test-refresh-token',
    fetchFn,
  });
}

const TOKEN_RESPONSE = {
  access_token: 'fresh-access-token',
  expires_in: 3600,
};

function buildMockMessage(overrides: Partial<GmailMessage> = {}): GmailMessage {
  return {
    id: 'msg-1',
    threadId: 'thread-1',
    labelIds: ['INBOX', 'IMPORTANT'],
    snippet: 'Hello this is a test',
    internalDate: '1712500000000',
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: 'Alice <alice@example.com>' },
        { name: 'To', value: 'test@gmail.com' },
        { name: 'Subject', value: 'Test Email' },
      ],
      body: {
        data: Buffer.from('Hello World', 'utf-8')
          .toString('base64')
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, ''),
        size: 11,
      },
    },
    ...overrides,
  };
}

// ─── OAuth Token Refresh ───────────────────────────────────────────────────

describe('GmailClient OAuth', () => {
  it('refreshes access token on first API call', async () => {
    const mockFetch = createMockFetch([
      { status: 200, body: TOKEN_RESPONSE },
      { status: 200, body: { emailAddress: 'test@gmail.com', historyId: '123', messagesTotal: 5 } },
    ]);

    const client = createClient(mockFetch);
    await client.getProfile();

    // First call should be token refresh
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const firstCall = mockFetch.mock.calls[0];
    expect(firstCall[0]).toBe('https://oauth2.googleapis.com/token');
  });

  it('reuses cached token within expiry window', async () => {
    const mockFetch = createMockFetch([
      { status: 200, body: TOKEN_RESPONSE },
      { status: 200, body: { emailAddress: 'test@gmail.com', historyId: '123', messagesTotal: 5 } },
      { status: 200, body: { emailAddress: 'test@gmail.com', historyId: '456', messagesTotal: 5 } },
    ]);

    const client = createClient(mockFetch);
    await client.getProfile();
    await client.getProfile();

    // Should only refresh once
    expect(mockFetch).toHaveBeenCalledTimes(3); // 1 token + 2 API
  });

  it('throws on token refresh failure', async () => {
    const mockFetch = createMockFetch([{ status: 401, body: { error: 'invalid_grant' } }]);

    const client = createClient(mockFetch);
    await expect(client.getProfile()).rejects.toThrow('OAuth token refresh failed');
  });
});

// ─── Gmail API Operations ─────────────────────────────────────────────────

describe('GmailClient API', () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let client: GmailClient;

  beforeEach(() => {
    mockFetch = createMockFetch([
      { status: 200, body: TOKEN_RESPONSE },
      { status: 200, body: {} }, // placeholder — overridden per test
    ]);
    client = createClient(mockFetch);
  });

  it('getProfile returns email and historyId', async () => {
    mockFetch = createMockFetch([
      { status: 200, body: TOKEN_RESPONSE },
      {
        status: 200,
        body: { emailAddress: 'test@gmail.com', historyId: '999', messagesTotal: 42 },
      },
    ]);
    client = createClient(mockFetch);

    const profile = await client.getProfile();
    expect(profile.emailAddress).toBe('test@gmail.com');
    expect(profile.historyId).toBe('999');
  });

  it('listHistory calls correct URL with labels', async () => {
    mockFetch = createMockFetch([
      { status: 200, body: TOKEN_RESPONSE },
      { status: 200, body: { history: [], historyId: '100' } },
    ]);
    client = createClient(mockFetch);

    await client.listHistory('50', ['INBOX']);

    const apiCall = mockFetch.mock.calls[1];
    const url = apiCall[0] as string;
    expect(url).toContain('/users/me/history');
    expect(url).toContain('startHistoryId=50');
    expect(url).toContain('labelIds=INBOX');
  });

  it('getMessage fetches with correct format', async () => {
    const msg = buildMockMessage();
    mockFetch = createMockFetch([
      { status: 200, body: TOKEN_RESPONSE },
      { status: 200, body: msg },
    ]);
    client = createClient(mockFetch);

    const result = await client.getMessage('msg-1', 'full');
    expect(result.id).toBe('msg-1');

    const apiCall = mockFetch.mock.calls[1];
    const url = apiCall[0] as string;
    expect(url).toContain('format=full');
  });

  it('sendMessage posts raw email', async () => {
    mockFetch = createMockFetch([
      { status: 200, body: TOKEN_RESPONSE },
      { status: 200, body: { id: 'sent-1', threadId: 'thread-1' } },
    ]);
    client = createClient(mockFetch);

    const result = await client.sendMessage('base64url-encoded-message');
    expect(result.id).toBe('sent-1');

    const apiCall = mockFetch.mock.calls[1];
    const options = apiCall[1] as RequestInit;
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body as string)).toEqual({ raw: 'base64url-encoded-message' });
  });

  it('createWatch sends topic and labels', async () => {
    mockFetch = createMockFetch([
      { status: 200, body: TOKEN_RESPONSE },
      { status: 200, body: { historyId: '100', expiration: '1712600000000' } },
    ]);
    client = createClient(mockFetch);

    const result = await client.createWatch('projects/my-proj/topics/my-topic', ['INBOX']);
    expect(result.historyId).toBe('100');

    const apiCall = mockFetch.mock.calls[1];
    const body = JSON.parse((apiCall[1] as RequestInit).body as string);
    expect(body.topicName).toBe('projects/my-proj/topics/my-topic');
    expect(body.labelIds).toEqual(['INBOX']);
  });

  it('stopWatch calls POST stop endpoint', async () => {
    mockFetch = createMockFetch([
      { status: 200, body: TOKEN_RESPONSE },
      { status: 204, contentType: 'text/plain' },
    ]);
    client = createClient(mockFetch);

    await client.stopWatch();

    const apiCall = mockFetch.mock.calls[1];
    const url = apiCall[0] as string;
    expect(url).toContain('/users/me/stop');
  });

  it('throws on API error', async () => {
    mockFetch = createMockFetch([
      { status: 200, body: TOKEN_RESPONSE },
      { status: 404, body: { error: { message: 'Not Found' } } },
    ]);
    client = createClient(mockFetch);

    await expect(client.getMessage('nonexistent')).rejects.toThrow('Gmail API GET');
  });
});

// ─── Email Parsing ─────────────────────────────────────────────────────────

describe('parseGmailMessage', () => {
  it('parses a basic message', () => {
    const msg = buildMockMessage();
    const parsed = parseGmailMessage(msg);

    expect(parsed.id).toBe('msg-1');
    expect(parsed.from).toBe('Alice <alice@example.com>');
    expect(parsed.subject).toBe('Test Email');
    expect(parsed.snippet).toBe('Hello this is a test');
    expect(parsed.isImportant).toBe(true);
    expect(parsed.isStarred).toBe(false);
  });

  it('extracts body text from text/plain', () => {
    const msg = buildMockMessage();
    const parsed = parseGmailMessage(msg);
    expect(parsed.bodyText).toBe('Hello World');
  });

  it('extracts body from multipart message', () => {
    const msg = buildMockMessage({
      payload: {
        mimeType: 'multipart/alternative',
        headers: [
          { name: 'From', value: 'bob@example.com' },
          { name: 'Subject', value: 'Multipart' },
          { name: 'To', value: 'test@gmail.com' },
        ],
        parts: [
          {
            mimeType: 'text/plain',
            headers: [],
            body: {
              data: Buffer.from('Plain text body')
                .toString('base64')
                .replace(/\+/g, '-')
                .replace(/\//g, '_'),
              size: 15,
            },
          },
          {
            mimeType: 'text/html',
            headers: [],
            body: {
              data: Buffer.from('<p>HTML body</p>')
                .toString('base64')
                .replace(/\+/g, '-')
                .replace(/\//g, '_'),
              size: 16,
            },
          },
        ],
      },
    });

    const parsed = parseGmailMessage(msg);
    expect(parsed.bodyText).toBe('Plain text body');
  });

  it('detects starred and important labels', () => {
    const msg = buildMockMessage({ labelIds: ['INBOX', 'STARRED', 'IMPORTANT'] });
    const parsed = parseGmailMessage(msg);
    expect(parsed.isStarred).toBe(true);
    expect(parsed.isImportant).toBe(true);
  });

  it('returns empty attachments for plain text email', () => {
    const msg = buildMockMessage();
    const parsed = parseGmailMessage(msg);
    expect(parsed.attachments).toEqual([]);
  });

  it('extracts single attachment from multipart/mixed', () => {
    const msg = buildMockMessage({
      payload: {
        mimeType: 'multipart/mixed',
        headers: [
          { name: 'From', value: 'alice@example.com' },
          { name: 'To', value: 'test@gmail.com' },
          { name: 'Subject', value: 'With attachment' },
        ],
        parts: [
          {
            mimeType: 'text/plain',
            headers: [],
            body: { data: Buffer.from('Body text').toString('base64'), size: 9 },
          },
          {
            mimeType: 'application/pdf',
            headers: [{ name: 'Content-Disposition', value: 'attachment; filename="report.pdf"' }],
            body: { attachmentId: 'att-1', size: 102400 } as { data?: string; size: number },
          },
        ],
      },
    });

    const parsed = parseGmailMessage(msg);
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]).toEqual({
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      size: 102400,
      attachmentId: 'att-1',
    });
  });

  it('extracts multiple attachments', () => {
    const msg = buildMockMessage({
      payload: {
        mimeType: 'multipart/mixed',
        headers: [
          { name: 'From', value: 'bob@example.com' },
          { name: 'To', value: 'test@gmail.com' },
          { name: 'Subject', value: 'Multiple files' },
        ],
        parts: [
          {
            mimeType: 'text/plain',
            headers: [],
            body: { data: Buffer.from('See attached').toString('base64'), size: 12 },
          },
          {
            mimeType: 'image/png',
            headers: [{ name: 'Content-Type', value: 'image/png; name="screenshot.png"' }],
            body: { attachmentId: 'att-2', size: 256000 } as { data?: string; size: number },
          },
          {
            mimeType: 'application/zip',
            headers: [{ name: 'Content-Disposition', value: 'attachment; filename="archive.zip"' }],
            body: { attachmentId: 'att-3', size: 5242880 } as { data?: string; size: number },
          },
        ],
      },
    });

    const parsed = parseGmailMessage(msg);
    expect(parsed.attachments).toHaveLength(2);
    expect(parsed.attachments[0]!.filename).toBe('screenshot.png');
    expect(parsed.attachments[0]!.mimeType).toBe('image/png');
    expect(parsed.attachments[1]!.filename).toBe('archive.zip');
    expect(parsed.attachments[1]!.size).toBe(5242880);
  });

  it('extracts filename from Content-Type name parameter', () => {
    const msg = buildMockMessage({
      payload: {
        mimeType: 'multipart/mixed',
        headers: [
          { name: 'From', value: 'test@example.com' },
          { name: 'To', value: 'user@gmail.com' },
          { name: 'Subject', value: 'Name in content-type' },
        ],
        parts: [
          {
            mimeType: 'text/plain',
            headers: [],
            body: { data: Buffer.from('text').toString('base64'), size: 4 },
          },
          {
            mimeType: 'application/octet-stream',
            headers: [{ name: 'Content-Type', value: 'application/octet-stream; name="data.bin"' }],
            body: { attachmentId: 'att-4', size: 1024 } as { data?: string; size: number },
          },
        ],
      },
    });

    const parsed = parseGmailMessage(msg);
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]!.filename).toBe('data.bin');
  });

  it('does not treat text/plain body as attachment', () => {
    const msg = buildMockMessage({
      payload: {
        mimeType: 'multipart/mixed',
        headers: [
          { name: 'From', value: 'test@example.com' },
          { name: 'To', value: 'user@gmail.com' },
          { name: 'Subject', value: 'No attachments' },
        ],
        parts: [
          {
            mimeType: 'text/plain',
            headers: [{ name: 'Content-Type', value: 'text/plain; charset=utf-8' }],
            body: { data: Buffer.from('Just text').toString('base64'), size: 9 },
          },
          {
            mimeType: 'text/html',
            headers: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
            body: { data: Buffer.from('<p>HTML</p>').toString('base64'), size: 11 },
          },
        ],
      },
    });

    const parsed = parseGmailMessage(msg);
    expect(parsed.attachments).toEqual([]);
  });

  it('handles nested multipart with attachments', () => {
    const msg = buildMockMessage({
      payload: {
        mimeType: 'multipart/mixed',
        headers: [
          { name: 'From', value: 'nested@example.com' },
          { name: 'To', value: 'user@gmail.com' },
          { name: 'Subject', value: 'Nested' },
        ],
        parts: [
          {
            mimeType: 'multipart/alternative',
            headers: [],
            parts: [
              {
                mimeType: 'text/plain',
                headers: [],
                body: { data: Buffer.from('text').toString('base64'), size: 4 },
              },
              {
                mimeType: 'text/html',
                headers: [],
                body: { data: Buffer.from('<p>html</p>').toString('base64'), size: 11 },
              },
            ],
          },
          {
            mimeType: 'image/jpeg',
            headers: [{ name: 'Content-Disposition', value: 'attachment; filename="photo.jpg"' }],
            body: { attachmentId: 'att-5', size: 500000 } as { data?: string; size: number },
          },
        ],
      },
    });

    const parsed = parseGmailMessage(msg);
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]!.filename).toBe('photo.jpg');
    expect(parsed.attachments[0]!.mimeType).toBe('image/jpeg');
    expect(parsed.attachments[0]!.size).toBe(500000);
    expect(parsed.attachments[0]!.attachmentId).toBe('att-5');
  });
});

describe('getHeader', () => {
  it('finds header case-insensitively', () => {
    const payload: GmailMessagePayload = {
      mimeType: 'text/plain',
      headers: [{ name: 'Content-Type', value: 'text/html' }],
    };
    expect(getHeader(payload, 'content-type')).toBe('text/html');
  });

  it('returns empty string for missing header', () => {
    const payload: GmailMessagePayload = { mimeType: 'text/plain', headers: [] };
    expect(getHeader(payload, 'X-Missing')).toBe('');
  });
});

// ─── Base64 URL ─────────────────────────────────────────────────────────────

describe('base64url', () => {
  it('encodeBase64Url produces URL-safe output', () => {
    const encoded = encodeBase64Url('Hello, World!');
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
    expect(encoded).not.toContain('=');
  });

  it('decodeBase64Url reverses encodeBase64Url', () => {
    const original = 'Test message with special chars: +/=';
    const encoded = encodeBase64Url(original);
    const decoded = decodeBase64Url(encoded);
    expect(decoded).toBe(original);
  });
});

// ─── Email Building ────────────────────────────────────────────────────────

describe('buildRawEmail', () => {
  it('builds a basic email', () => {
    const raw = buildRawEmail({
      from: 'user@gmail.com',
      to: 'recipient@example.com',
      subject: 'Test Subject',
      body: 'Hello!',
    });

    const decoded = decodeBase64Url(raw);
    expect(decoded).toContain('From: user@gmail.com');
    expect(decoded).toContain('To: recipient@example.com');
    expect(decoded).toContain('Subject: Test Subject');
    expect(decoded).toContain('Hello!');
  });

  it('includes In-Reply-To and References headers', () => {
    const raw = buildRawEmail({
      from: 'user@gmail.com',
      to: 'recipient@example.com',
      subject: 'Re: Original',
      body: 'Reply body',
      inReplyTo: '<original@example.com>',
      references: '<original@example.com>',
    });

    const decoded = decodeBase64Url(raw);
    expect(decoded).toContain('In-Reply-To: <original@example.com>');
    expect(decoded).toContain('References: <original@example.com>');
  });
});
