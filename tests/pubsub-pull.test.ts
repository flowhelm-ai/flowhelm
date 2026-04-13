/**
 * Tests for the Pub/Sub REST pull daemon.
 *
 * Covers: pull mechanics, notification parsing, acknowledgement,
 * service account JWT creation, error handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { PubSubPullDaemon, createServiceAccountJwt } from '../src/channels/gmail/pubsub-pull.js';
import type { GmailNotification, ServiceAccountKey } from '../src/channels/gmail/pubsub-pull.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

// Generate a real RSA key pair for tests (runs once at module load)
const { privateKey: testPrivateKeyObj } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const TEST_PRIVATE_KEY_PEM = testPrivateKeyObj.export({ type: 'pkcs1', format: 'pem' }) as string;

const MOCK_SA_KEY: ServiceAccountKey = {
  client_email: 'test@test-project.iam.gserviceaccount.com',
  private_key: TEST_PRIVATE_KEY_PEM,
  project_id: 'test-project',
};

function createMockFetch(
  pullBody: unknown = { receivedMessages: [] },
  tokenBody: unknown = { access_token: 'test-token', expires_in: 3600 },
) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : '';

    // Token exchange
    if (urlStr.includes('oauth2.googleapis.com/token')) {
      return {
        ok: true,
        status: 200,
        json: async () => tokenBody,
        text: async () => JSON.stringify(tokenBody),
        headers: { get: () => 'application/json' },
      } as unknown as Response;
    }

    // Pull
    if (urlStr.includes(':pull')) {
      return {
        ok: true,
        status: 200,
        json: async () => pullBody,
        text: async () => JSON.stringify(pullBody),
        headers: { get: () => 'application/json' },
      } as unknown as Response;
    }

    // Acknowledge
    if (urlStr.includes(':acknowledge')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => '{}',
        headers: { get: () => 'application/json' },
      } as unknown as Response;
    }

    return {
      ok: false,
      status: 404,
      text: async () => 'Not Found',
      headers: { get: () => null },
    } as unknown as Response;
  });
}

function encodeNotification(data: GmailNotification): string {
  return Buffer.from(JSON.stringify(data), 'utf-8').toString('base64');
}

function createDaemon(fetchFn: typeof fetch, options?: { pullInterval?: number }) {
  return new PubSubPullDaemon({
    projectId: 'test-project',
    subscriptionName: 'test-sub',
    serviceAccountKeyPath: '/tmp/sa-key.json',
    pullInterval: options?.pullInterval ?? 100_000, // Very long default to avoid auto-pulls during tests
    serviceAccountKey: MOCK_SA_KEY,
    fetchFn,
  });
}

// ─── Pull Mechanics ──────────────────────────────────────────────────────

describe('PubSubPullDaemon', () => {
  let daemon: PubSubPullDaemon;

  afterEach(async () => {
    if (daemon?.isRunning()) {
      await daemon.stop();
    }
  });

  it('starts and stops without error', async () => {
    const mockFetch = createMockFetch();
    daemon = createDaemon(mockFetch);

    await daemon.start();
    expect(daemon.isRunning()).toBe(true);

    await daemon.stop();
    expect(daemon.isRunning()).toBe(false);
  });

  it('performs initial pull on start', async () => {
    const mockFetch = createMockFetch();
    daemon = createDaemon(mockFetch);

    await daemon.start();

    // Token exchange + at least one pull
    const pullCalls = mockFetch.mock.calls.filter((c) => (c[0] as string).includes(':pull'));
    expect(pullCalls.length).toBeGreaterThanOrEqual(1);

    await daemon.stop();
  });

  it('emits notification for valid Pub/Sub messages', async () => {
    const notification = { emailAddress: 'user@gmail.com', historyId: '12345' };
    const mockFetch = createMockFetch({
      receivedMessages: [
        {
          ackId: 'ack-1',
          message: {
            data: encodeNotification(notification),
            messageId: 'pubsub-msg-1',
            publishTime: '2024-01-01T00:00:00Z',
          },
        },
      ],
    });

    daemon = createDaemon(mockFetch);
    const received: GmailNotification[] = [];
    daemon.onNotification((n) => received.push(n));

    await daemon.start();

    // Wait for the pull cycle to process
    await new Promise((r) => setTimeout(r, 100));

    expect(received).toHaveLength(1);
    expect(received[0].emailAddress).toBe('user@gmail.com');
    expect(received[0].historyId).toBe('12345');

    await daemon.stop();
  });

  it('acknowledges messages after processing', async () => {
    const mockFetch = createMockFetch({
      receivedMessages: [
        {
          ackId: 'ack-42',
          message: {
            data: encodeNotification({ emailAddress: 'a@b.com', historyId: '1' }),
            messageId: 'msg-1',
            publishTime: '2024-01-01T00:00:00Z',
          },
        },
      ],
    });

    daemon = createDaemon(mockFetch);
    await daemon.start();
    await new Promise((r) => setTimeout(r, 100));

    const ackCalls = mockFetch.mock.calls.filter((c) => (c[0] as string).includes(':acknowledge'));
    expect(ackCalls.length).toBeGreaterThanOrEqual(1);

    const ackBody = JSON.parse((ackCalls[0][1] as RequestInit).body as string);
    expect(ackBody.ackIds).toContain('ack-42');

    await daemon.stop();
  });

  it('handles malformed notification data gracefully', async () => {
    const mockFetch = createMockFetch({
      receivedMessages: [
        {
          ackId: 'ack-bad',
          message: {
            data: Buffer.from('not-valid-json', 'utf-8').toString('base64'),
            messageId: 'msg-bad',
            publishTime: '2024-01-01T00:00:00Z',
          },
        },
      ],
    });

    daemon = createDaemon(mockFetch);
    const received: GmailNotification[] = [];
    daemon.onNotification((n) => received.push(n));

    await daemon.start();
    await new Promise((r) => setTimeout(r, 100));

    // Should not emit, but should ack to prevent redelivery
    expect(received).toHaveLength(0);

    await daemon.stop();
  });

  it('handles empty pull response', async () => {
    const mockFetch = createMockFetch({ receivedMessages: [] });
    daemon = createDaemon(mockFetch);
    const received: GmailNotification[] = [];
    daemon.onNotification((n) => received.push(n));

    await daemon.start();
    await new Promise((r) => setTimeout(r, 100));

    expect(received).toHaveLength(0);
    await daemon.stop();
  });
});

// ─── JWT Creation ─────────────────────────────────────────────────────────

describe('createServiceAccountJwt', () => {
  it('creates a valid 3-part JWT', () => {
    const jwt = createServiceAccountJwt(
      MOCK_SA_KEY.client_email,
      MOCK_SA_KEY.private_key,
      'https://www.googleapis.com/auth/pubsub',
    );

    const parts = jwt.split('.');
    expect(parts).toHaveLength(3);

    // Decode header
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    expect(header.alg).toBe('RS256');
    expect(header.typ).toBe('JWT');

    // Decode payload
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    expect(payload.iss).toBe(MOCK_SA_KEY.client_email);
    expect(payload.scope).toBe('https://www.googleapis.com/auth/pubsub');
    expect(payload.exp).toBeGreaterThan(payload.iat);
  });

  it('respects custom lifetime', () => {
    const jwt = createServiceAccountJwt(
      MOCK_SA_KEY.client_email,
      MOCK_SA_KEY.private_key,
      'https://www.googleapis.com/auth/pubsub',
      600, // 10 minutes
    );

    const parts = jwt.split('.');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    expect(payload.exp - payload.iat).toBe(600);
  });
});
