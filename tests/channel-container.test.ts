import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes, createCipheriv } from 'node:crypto';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTestDatabase,
  applySchema,
  HOST_PORT,
  PG_USER,
  PG_PASSWORD,
} from './helpers/pg-container.js';
import type { Sql } from '../src/orchestrator/connection.js';
import type { InboundMessage, ChannelAdapter, OutboundMessage } from '../src/orchestrator/types.js';

// ─── Config Schema: Channel Container Section ────────────────────────────

describe('Config schema: channelContainer section', () => {
  it('provides sensible defaults when channelContainer is omitted', async () => {
    const { flowhelmConfigSchema } = await import('../src/config/schema.js');
    const config = flowhelmConfigSchema.parse({ username: 'testuser' });

    expect(config.channelContainer.enabled).toBe(false);
    expect(config.channelContainer.image).toBe('ghcr.io/flowhelm-ai/flowhelm-channel:0.1.0');
    expect(config.channelContainer.memoryLimit).toBe('256m');
    expect(config.channelContainer.cpuLimit).toBe('0.5');
    expect(config.channelContainer.port).toBe(9000);
  });

  it('accepts custom channel container configuration', async () => {
    const { flowhelmConfigSchema } = await import('../src/config/schema.js');
    const config = flowhelmConfigSchema.parse({
      username: 'testuser',
      channelContainer: {
        enabled: true,
        image: 'flowhelm-channel:v2',
        memoryLimit: '512m',
        cpuLimit: '1.0',
        port: 9999,
      },
    });

    expect(config.channelContainer.enabled).toBe(true);
    expect(config.channelContainer.image).toBe('flowhelm-channel:v2');
    expect(config.channelContainer.memoryLimit).toBe('512m');
    expect(config.channelContainer.cpuLimit).toBe('1.0');
    expect(config.channelContainer.port).toBe(9999);
  });

  it('rejects invalid port numbers', async () => {
    const { flowhelmConfigSchema } = await import('../src/config/schema.js');
    expect(() =>
      flowhelmConfigSchema.parse({
        username: 'testuser',
        channelContainer: { port: 80 },
      }),
    ).toThrow();
  });
});

// ─── Channel Types ───────────────────────────────────────────────────────

describe('Channel types', () => {
  it('exports all required types', async () => {
    const types = await import('../src/channels/channel-types.js');
    expect(types).toBeDefined();
  });
});

// ─── NAMING ─────────────────────────────────────────────────────────────

describe('NAMING.channelContainer', () => {
  it('generates correct container name', async () => {
    const { NAMING } = await import('../src/container/lifecycle.js');
    expect(NAMING.channelContainer('stan')).toBe('flowhelm-channel-stan');
    expect(NAMING.channelContainer('alice')).toBe('flowhelm-channel-alice');
  });
});

// ─── ChannelDbWriter ────────────────────────────────────────────────────

describe('ChannelDbWriter', () => {
  let sql: Sql;
  let cleanup: () => Promise<void>;
  let dbName: string;
  let defaultProfileId: string;

  const CHAT_ID = 'tg:123';

  const makeMessage = (overrides: Partial<InboundMessage> = {}): InboundMessage => ({
    id: `msg-${Date.now()}`,
    channel: 'telegram',
    userId: CHAT_ID,
    senderName: 'Test User',
    text: 'Hello world',
    timestamp: Date.now(),
    isFromMe: false,
    metadata: {},
    ...overrides,
  });

  /** Create a ChannelDbWriter connected to the test database. */
  const makeWriter = async () => {
    const { ChannelDbWriter } = await import('../src/channels/channel-db.js');
    const writer = new ChannelDbWriter({
      host: 'localhost',
      port: HOST_PORT,
      user: PG_USER,
      password: PG_PASSWORD,
      database: dbName,
    });
    await writer.connect();
    return writer;
  };

  beforeEach(async () => {
    const testDb = await createTestDatabase();
    sql = testDb.sql;
    dbName = testDb.dbName;
    cleanup = testDb.cleanup;
    await applySchema(sql);

    // Schema creates a default profile automatically
    const [profile] = await sql<[{ id: string }]>`
      SELECT id FROM agent_profiles WHERE is_default = true LIMIT 1
    `;
    defaultProfileId = profile!.id;
  });

  afterEach(async () => {
    await cleanup();
  });

  it('resolveDefaultProfileId returns the default profile', async () => {
    const writer = await makeWriter();
    const profileId = await writer.resolveDefaultProfileId();
    expect(profileId).toBe(defaultProfileId);
    await writer.close();
  });

  it('upsertChat creates a new chat row', async () => {
    const writer = await makeWriter();
    await writer.upsertChat(CHAT_ID, 'telegram', '123', 'Test User', defaultProfileId);

    const rows = await sql`SELECT * FROM chats WHERE id = ${CHAT_ID}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.channel).toBe('telegram');
    expect(rows[0]!.external_id).toBe('123');
    await writer.close();
  });

  it('upsertChat updates name on conflict', async () => {
    const writer = await makeWriter();
    await writer.upsertChat(CHAT_ID, 'telegram', '123', 'Old Name', defaultProfileId);
    await writer.upsertChat(CHAT_ID, 'telegram', '123', 'New Name', defaultProfileId);

    const rows = await sql`SELECT * FROM chats WHERE id = ${CHAT_ID}`;
    expect(rows[0]!.name).toBe('New Name');
    await writer.close();
  });

  it('storeMessage writes to memory_working with session_id NULL', async () => {
    const writer = await makeWriter();
    await writer.upsertChat(CHAT_ID, 'telegram', '123', 'Test', defaultProfileId);

    const msg = makeMessage({ id: 'msg-store-test' });
    await writer.storeMessage(CHAT_ID, msg);

    const rows =
      await sql`SELECT * FROM memory_working WHERE id = 'msg-store-test' AND chat_id = ${CHAT_ID}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toBe('Hello world');
    expect(rows[0]!.sender_name).toBe('Test User');
    expect(rows[0]!.session_id).toBeNull();
    expect(rows[0]!.is_from_me).toBe(false);
    expect(rows[0]!.is_bot_message).toBe(false);
    await writer.close();
  });

  it('storeMessage is idempotent (ON CONFLICT DO NOTHING)', async () => {
    const writer = await makeWriter();
    await writer.upsertChat(CHAT_ID, 'telegram', '123', 'Test', defaultProfileId);

    const msg = makeMessage({ id: 'msg-idempotent' });
    await writer.storeMessage(CHAT_ID, msg);
    // Second insert should not throw
    await writer.storeMessage(CHAT_ID, msg);

    const rows =
      await sql`SELECT * FROM memory_working WHERE id = 'msg-idempotent' AND chat_id = ${CHAT_ID}`;
    expect(rows).toHaveLength(1);
    await writer.close();
  });

  it('enqueueMessage creates a queue entry', async () => {
    const writer = await makeWriter();
    await writer.upsertChat(CHAT_ID, 'telegram', '123', 'Test', defaultProfileId);

    const msg = makeMessage({ id: 'msg-queue-test' });
    await writer.enqueueMessage(CHAT_ID, msg);

    const rows = await sql`SELECT * FROM queue WHERE message_id = 'msg-queue-test'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.chat_id).toBe(CHAT_ID);
    expect(rows[0]!.channel).toBe('telegram');
    expect(rows[0]!.status).toBe('pending');
    await writer.close();
  });

  it('throws when not connected', async () => {
    const { ChannelDbWriter } = await import('../src/channels/channel-db.js');
    const writer = new ChannelDbWriter({
      host: 'localhost',
      port: HOST_PORT,
      user: PG_USER,
      password: PG_PASSWORD,
      database: 'nonexistent',
    });

    await expect(writer.resolveDefaultProfileId()).rejects.toThrow('Not connected');
  });
});

// ─── ChannelServer ──────────────────────────────────────────────────────

describe('ChannelServer', () => {
  let server: InstanceType<typeof import('../src/channels/channel-server.js').ChannelServer>;
  let port: number;

  // Mock adapter
  const makeMockAdapter = (connected = true): ChannelAdapter => ({
    name: 'telegram',
    type: 'telegram' as const,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn(),
    isConnected: vi.fn().mockReturnValue(connected),
  });

  beforeEach(async () => {
    const { ChannelServer } = await import('../src/channels/channel-server.js');
    port = 30000 + Math.floor(Math.random() * 10000);
    const adapters = new Map<string, ChannelAdapter>();
    adapters.set('telegram', makeMockAdapter());

    server = new ChannelServer({ port, adapters });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('responds to /healthz with channel status', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      status: string;
      channels: Record<string, string>;
      uptimeMs: number;
    };
    expect(body.status).toBe('ok');
    expect(body.channels['telegram']).toBe('connected');
    expect(typeof body.uptimeMs).toBe('number');
  });

  it('responds to /status with detailed channel info', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/status`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      channels: Record<string, { status: string; errorCount: number }>;
    };
    expect(body.channels['telegram']!.status).toBe('connected');
    expect(body.channels['telegram']!.errorCount).toBe(0);
  });

  it('returns 404 for unknown endpoints', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/unknown`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('NOT_FOUND');
  });

  it('POST /send delivers message to adapter', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: 'telegram',
        userId: 'tg:123',
        text: 'Hello!',
      }),
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
  });

  it('POST /send returns 404 for unknown channel', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: 'whatsapp',
        userId: 'wa:123',
        text: 'Hello!',
      }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('CHANNEL_NOT_FOUND');
  });

  it('POST /send returns 400 for missing fields', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'telegram' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INVALID_REQUEST');
  });

  it('POST /gws returns 503 when not configured', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/gws`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: 'gmail +send --to test@example.com --subject Test --body Hello',
      }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('GWS_DISABLED');
  });
});

describe('ChannelServer with disconnected adapter', () => {
  it('POST /send returns 503 for disconnected channel', async () => {
    const { ChannelServer } = await import('../src/channels/channel-server.js');
    const port = 30000 + Math.floor(Math.random() * 10000);

    const disconnected: ChannelAdapter = {
      name: 'telegram',
      type: 'telegram' as const,
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
      onMessage: vi.fn(),
      isConnected: vi.fn().mockReturnValue(false),
    };

    const adapters = new Map<string, ChannelAdapter>();
    adapters.set('telegram', disconnected);

    const server = new ChannelServer({ port, adapters });
    await server.start();

    try {
      const res = await fetch(`http://127.0.0.1:${port}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: 'telegram',
          userId: 'tg:123',
          text: 'Hello!',
        }),
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe('CHANNEL_DISCONNECTED');
    } finally {
      await server.stop();
    }
  });

  it('/healthz reports degraded when all adapters disconnected', async () => {
    const { ChannelServer } = await import('../src/channels/channel-server.js');
    const port = 30000 + Math.floor(Math.random() * 10000);

    const disconnected: ChannelAdapter = {
      name: 'telegram',
      type: 'telegram' as const,
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
      onMessage: vi.fn(),
      isConnected: vi.fn().mockReturnValue(false),
    };

    const adapters = new Map<string, ChannelAdapter>();
    adapters.set('telegram', disconnected);

    const server = new ChannelServer({ port, adapters });
    await server.start();

    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe('degraded');
    } finally {
      await server.stop();
    }
  });
});

describe('ChannelServer POST /gws', () => {
  it('POST /gws returns 400 when command is missing', async () => {
    const { ChannelServer } = await import('../src/channels/channel-server.js');
    const port = 30000 + Math.floor(Math.random() * 10000);

    const gwsTokenProvider = vi.fn().mockResolvedValue('test-token');
    const server = new ChannelServer({
      port,
      adapters: new Map(),
      gwsTokenProvider,
    });
    await server.start();

    try {
      const res = await fetch(`http://127.0.0.1:${port}/gws`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe('INVALID_REQUEST');
    } finally {
      await server.stop();
    }
  });
});

// ─── ChannelClient ──────────────────────────────────────────────────────

describe('ChannelClient', () => {
  let serverPort: number;
  let mockAdapter: ChannelAdapter;
  let channelServer: InstanceType<typeof import('../src/channels/channel-server.js').ChannelServer>;

  beforeEach(async () => {
    const { ChannelServer } = await import('../src/channels/channel-server.js');
    serverPort = 30000 + Math.floor(Math.random() * 10000);

    mockAdapter = {
      name: 'telegram',
      type: 'telegram' as const,
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
      onMessage: vi.fn(),
      isConnected: vi.fn().mockReturnValue(true),
    };

    const adapters = new Map<string, ChannelAdapter>();
    adapters.set('telegram', mockAdapter);

    channelServer = new ChannelServer({ port: serverPort, adapters });
    await channelServer.start();
  });

  afterEach(async () => {
    await channelServer.stop();
  });

  it('send() calls server and returns', async () => {
    const { ChannelClient } = await import('../src/channels/channel-client.js');
    const client = new ChannelClient({ baseUrl: `http://127.0.0.1:${serverPort}` });

    await client.send('telegram', 'tg:123', 'Hello from client');
    expect(mockAdapter.send).toHaveBeenCalled();
  });

  it('health() returns channel status', async () => {
    const { ChannelClient } = await import('../src/channels/channel-client.js');
    const client = new ChannelClient({ baseUrl: `http://127.0.0.1:${serverPort}` });

    const health = await client.health();
    expect(health.status).toBe('ok');
    expect(health.channels['telegram']).toBe('connected');
  });

  it('status() returns detailed info', async () => {
    const { ChannelClient } = await import('../src/channels/channel-client.js');
    const client = new ChannelClient({ baseUrl: `http://127.0.0.1:${serverPort}` });

    const status = await client.status();
    expect(status.channels['telegram']!.status).toBe('connected');
    expect(status.channels['telegram']!.errorCount).toBe(0);
  });

  it('isReachable() returns true for running server', async () => {
    const { ChannelClient } = await import('../src/channels/channel-client.js');
    const client = new ChannelClient({ baseUrl: `http://127.0.0.1:${serverPort}` });

    expect(await client.isReachable()).toBe(true);
  });

  it('isReachable() returns false for unreachable server', async () => {
    const { ChannelClient } = await import('../src/channels/channel-client.js');
    const client = new ChannelClient({ baseUrl: 'http://127.0.0.1:1' });

    expect(await client.isReachable()).toBe(false);
  });

  it('send() throws on server error', async () => {
    const { ChannelClient } = await import('../src/channels/channel-client.js');
    const client = new ChannelClient({ baseUrl: `http://127.0.0.1:${serverPort}` });

    await expect(client.send('whatsapp', 'wa:123', 'Hello')).rejects.toThrow('Channel send failed');
  });
});

// ─── CredentialReader ───────────────────────────────────────────────────

describe('readChannelCredentials', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'flowhelm-cred-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('decrypts credentials and extracts telegram bot token', async () => {
    const { readChannelCredentials } = await import('../src/channels/credential-reader.js');

    // Create encrypted credentials
    const key = randomBytes(32);
    const rules = {
      credentials: [
        {
          name: 'telegram-bot',
          hostPattern: 'api.telegram.org',
          header: 'Authorization',
          value: 'bot123:abc',
        },
      ],
      pinningBypass: [],
    };

    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const plaintext = Buffer.from(JSON.stringify(rules), 'utf-8');
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const encData = Buffer.concat([iv, authTag, encrypted]);

    const encPath = join(tmpDir, 'credentials.enc');
    await writeFile(encPath, encData);

    const creds = await readChannelCredentials(encPath, key.toString('hex'));
    expect(creds.telegramBotToken).toBe('bot123:abc');
  });

  it('extracts gmail credentials', async () => {
    const { readChannelCredentials } = await import('../src/channels/credential-reader.js');

    const key = randomBytes(32);
    const rules = {
      credentials: [
        { name: 'gmail-oauth-client-id', value: 'client-123' },
        { name: 'gmail-oauth-client-secret', value: 'secret-456' },
        { name: 'gmail-oauth-refresh-token', value: 'refresh-789' },
        { name: 'gmail-email-address', value: 'user@gmail.com' },
      ],
      pinningBypass: [],
    };

    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const plaintext = Buffer.from(JSON.stringify(rules), 'utf-8');
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const encData = Buffer.concat([iv, authTag, encrypted]);

    const encPath = join(tmpDir, 'credentials.enc');
    await writeFile(encPath, encData);

    const creds = await readChannelCredentials(encPath, key.toString('hex'));
    expect(creds.gmailOauthClientId).toBe('client-123');
    expect(creds.gmailOauthClientSecret).toBe('secret-456');
    expect(creds.gmailOauthRefreshToken).toBe('refresh-789');
    expect(creds.gmailEmailAddress).toBe('user@gmail.com');
  });

  it('returns empty fields when no matching credentials', async () => {
    const { readChannelCredentials } = await import('../src/channels/credential-reader.js');

    const key = randomBytes(32);
    const rules = { credentials: [], pinningBypass: [] };

    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const plaintext = Buffer.from(JSON.stringify(rules), 'utf-8');
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const encData = Buffer.concat([iv, authTag, encrypted]);

    const encPath = join(tmpDir, 'credentials.enc');
    await writeFile(encPath, encData);

    const creds = await readChannelCredentials(encPath, key.toString('hex'));
    expect(creds.telegramBotToken).toBeUndefined();
    expect(creds.gmailOauthClientId).toBeUndefined();
  });

  it('throws on invalid key length', async () => {
    const { readChannelCredentials } = await import('../src/channels/credential-reader.js');
    const encPath = join(tmpDir, 'credentials.enc');
    await writeFile(encPath, Buffer.alloc(64));

    await expect(readChannelCredentials(encPath, 'deadbeef')).rejects.toThrow(
      'Invalid credential key',
    );
  });

  it('throws on tampered ciphertext', async () => {
    const { readChannelCredentials } = await import('../src/channels/credential-reader.js');

    const key = randomBytes(32);
    // Write garbage data
    const encPath = join(tmpDir, 'credentials.enc');
    await writeFile(encPath, randomBytes(64));

    await expect(readChannelCredentials(encPath, key.toString('hex'))).rejects.toThrow();
  });
});

// ─── ChannelManager ─────────────────────────────────────────────────────

describe('ChannelManager', () => {
  it('buildContainerConfig generates correct config', async () => {
    const { ChannelManager } = await import('../src/channels/channel-manager.js');

    const manager = new ChannelManager({
      runtime: {} as never,
      username: 'stan',
      config: {
        image: 'flowhelm-channel:latest',
        memoryLimit: '256m',
        cpuLimit: '0.5',
        port: 9000,
      },
      downloadsDir: '/home/stan/.flowhelm/downloads',
      logsDir: '/home/stan/.flowhelm/logs/channels',
      credentialsEncPath: '/home/stan/.flowhelm/secrets/credentials.enc',
      credentialKeyHex: 'a'.repeat(64),
      dbHost: 'flowhelm-db-stan',
      dbPort: 5432,
      dbUser: 'flowhelm',
      dbPassword: 'test-password',
      dbName: 'flowhelm',
      channelEnv: { TELEGRAM_ENABLED: 'true', GMAIL_ENABLED: 'false' },
      hostPort: 19000,
    });

    expect(manager.containerName).toBe('flowhelm-channel-stan');
    expect(manager.networkName).toBe('flowhelm-network-stan');
    expect(manager.channelUrl).toBe('http://flowhelm-channel-stan:9000');
    expect(manager.hostUrl).toBe('http://127.0.0.1:19000');

    const config = manager.buildContainerConfig();
    expect(config.name).toBe('flowhelm-channel-stan');
    expect(config.image).toBe('flowhelm-channel:latest');
    expect(config.memoryLimit).toBe('256m');
    expect(config.cpuLimit).toBe('0.5');
    expect(config.pidsLimit).toBe(128);
    expect(config.readOnly).toBe(true);
    expect(config.network).toBe('flowhelm-network-stan');
    expect(config.env!['CREDENTIAL_KEY']).toBe('a'.repeat(64));
    expect(config.env!['CHANNEL_PORT']).toBe('9000');
    expect(config.env!['DB_HOST']).toBe('flowhelm-db-stan');
    expect(config.env!['DB_PORT']).toBe('5432');
    expect(config.env!['DB_USER']).toBe('flowhelm');
    expect(config.env!['DB_PASSWORD']).toBe('test-password');
    expect(config.env!['DB_NAME']).toBe('flowhelm');
    expect(config.env!['TELEGRAM_ENABLED']).toBe('true');
    expect(config.env!['GMAIL_ENABLED']).toBe('false');
    expect(config.env!['NODE_ENV']).toBe('production');
    expect(config.mounts).toHaveLength(3);
    expect(config.tmpfs).toHaveLength(1);
    expect(config.securityOpts).toContain('no-new-privileges');
    expect(config.userNamespace).toBe('keep-id:uid=1000,gid=1000');
  });
});

// ─── Lifecycle cleanup includes channel container ───────────────────────

describe('ContainerLifecycleManager cleanup includes channel container', () => {
  it('stop() filters channel containers for the user', async () => {
    const { ContainerLifecycleManager } = await import('../src/container/lifecycle.js');

    const mockContainers = [
      { id: 'c1', name: 'flowhelm-agent-stan-1', state: 'running' as const, image: '', ports: [] },
      { id: 'c2', name: 'flowhelm-proxy-stan', state: 'running' as const, image: '', ports: [] },
      { id: 'c3', name: 'flowhelm-channel-stan', state: 'running' as const, image: '', ports: [] },
      { id: 'c4', name: 'flowhelm-service-stan', state: 'running' as const, image: '', ports: [] },
      { id: 'c5', name: 'flowhelm-agent-alice-1', state: 'running' as const, image: '', ports: [] },
    ];

    const stoppedIds: string[] = [];
    const removedIds: string[] = [];

    const mockRuntime = {
      list: vi.fn().mockResolvedValue(mockContainers),
      stop: vi.fn().mockImplementation((id: string) => {
        stoppedIds.push(id);
        return Promise.resolve();
      }),
      remove: vi.fn().mockImplementation((id: string) => {
        removedIds.push(id);
        return Promise.resolve();
      }),
      exists: vi.fn(),
      isHealthy: vi.fn(),
      create: vi.fn(),
      start: vi.fn(),
      exec: vi.fn(),
      networkExists: vi.fn(),
      createNetwork: vi.fn(),
    };

    const manager = new ContainerLifecycleManager({
      runtime: mockRuntime as never,
      username: 'stan',
    });

    await manager.stop();

    // Should stop stan's containers but not alice's
    expect(stoppedIds).toContain('c1');
    expect(stoppedIds).toContain('c2');
    expect(stoppedIds).toContain('c3');
    expect(stoppedIds).toContain('c4');
    expect(stoppedIds).not.toContain('c5');
  });
});
