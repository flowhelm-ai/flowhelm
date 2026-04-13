/**
 * Tests for the WhatsApp channel adapter.
 *
 * Tests cover: transport abstraction, vault-backed auth state,
 * message normalization (text, voice, image), access control,
 * outbound delivery, message splitting, JID parsing, reconnection.
 *
 * Uses mock WhatsApp transport — no real Baileys connections.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile as fsWriteFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InboundMessage, OutboundMessage } from '../src/orchestrator/types.js';
import type {
  WhatsAppTransport,
  TransportMessage,
  TransportSendContent,
  TransportConnectionState,
  TransportEventHandlers,
} from '../src/channels/whatsapp/transport.js';
import {
  WhatsAppAdapter,
  parseWhatsAppJid,
  splitMessage,
} from '../src/channels/whatsapp/adapter.js';
import { useVaultAuthState, clearVaultAuthState } from '../src/channels/whatsapp/auth-state.js';
import { CredentialStore } from '../src/proxy/credential-store.js';
import type { AuthenticationState } from '@whiskeysockets/baileys';

// ─── Mock Transport ──────────────────────────────────────────────────────────

class MockTransport implements WhatsAppTransport {
  private state: TransportConnectionState = 'disconnected';
  private handlers: TransportEventHandlers | undefined;
  readonly sentMessages: Array<{ jid: string; content: TransportSendContent }> = [];
  connectCalls = 0;
  disconnectCalls = 0;

  async connect(_authState: AuthenticationState, handlers: TransportEventHandlers): Promise<void> {
    this.connectCalls++;
    this.handlers = handlers;
    this.state = 'connected';
    handlers.onConnectionState('connected');
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls++;
    this.state = 'disconnected';
    this.handlers?.onConnectionState('disconnected');
  }

  async sendMessage(jid: string, content: TransportSendContent): Promise<void> {
    if (this.state !== 'connected') throw new Error('Not connected');
    this.sentMessages.push({ jid, content });
  }

  connectionState(): TransportConnectionState {
    return this.state;
  }

  // Test helpers
  simulateMessage(msg: TransportMessage): void {
    this.handlers?.onMessage(msg);
  }

  simulateQrCode(qr: string): void {
    this.handlers?.onQrCode(qr);
  }

  simulateDisconnect(): void {
    this.state = 'disconnected';
    this.handlers?.onConnectionState('disconnected');
  }

  async simulateAuthUpdate(): Promise<void> {
    await this.handlers?.onAuthStateUpdate();
  }
}

// ─── Test Fixtures ────────────────────────────────────────────────────────────

let tempDir: string;
let secretsDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'flowhelm-wa-test-'));
  secretsDir = join(tempDir, 'secrets');
  await mkdir(secretsDir, { recursive: true });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function createCredentialStore(): CredentialStore {
  return new CredentialStore({ secretsDir });
}

function createMockTransport(): MockTransport {
  return new MockTransport();
}

function createAdapter(
  transport: MockTransport,
  store: CredentialStore,
  options?: Partial<ConstructorParameters<typeof WhatsAppAdapter>[0]>,
): WhatsAppAdapter {
  return new WhatsAppAdapter({
    transport,
    credentialStore: store,
    downloadDir: join(tempDir, 'downloads'),
    allowedNumbers: [],
    ...options,
  });
}

function makeTextMessage(overrides: Partial<TransportMessage> = {}): TransportMessage {
  return {
    id: 'MSG001',
    senderJid: '14155551234@s.whatsapp.net',
    chatJid: '14155551234@s.whatsapp.net',
    senderName: 'Alice',
    text: 'Hello from WhatsApp',
    isFromMe: false,
    timestamp: 1712500000,
    ...overrides,
  };
}

function makeVoiceMessage(overrides: Partial<TransportMessage> = {}): TransportMessage {
  return {
    id: 'MSG002',
    senderJid: '14155551234@s.whatsapp.net',
    chatJid: '14155551234@s.whatsapp.net',
    senderName: 'Alice',
    isFromMe: false,
    timestamp: 1712500000,
    audioBuffer: Buffer.from('fake-ogg-audio-data'),
    audioMimeType: 'audio/ogg; codecs=opus',
    ...overrides,
  };
}

function makeImageMessage(overrides: Partial<TransportMessage> = {}): TransportMessage {
  return {
    id: 'MSG003',
    senderJid: '14155551234@s.whatsapp.net',
    chatJid: '14155551234@s.whatsapp.net',
    senderName: 'Alice',
    isFromMe: false,
    timestamp: 1712500000,
    imageBuffer: Buffer.from('fake-jpeg-image-data'),
    imageMimeType: 'image/jpeg',
    caption: 'Check this out',
    ...overrides,
  };
}

// ─── Transport Abstraction ──────────────────────────────────────────────────

describe('MockTransport (transport abstraction)', () => {
  it('implements WhatsAppTransport interface', () => {
    const t = createMockTransport();
    expect(t.connectionState()).toBe('disconnected');
    expect(typeof t.connect).toBe('function');
    expect(typeof t.disconnect).toBe('function');
    expect(typeof t.sendMessage).toBe('function');
  });

  it('transitions to connected state on connect', async () => {
    const t = createMockTransport();
    const store = createCredentialStore();
    const { state } = await useVaultAuthState({ store });
    const onState = vi.fn();
    await t.connect(state, {
      onMessage: vi.fn(),
      onQrCode: vi.fn(),
      onConnectionState: onState,
      onAuthStateUpdate: vi.fn(),
    });
    expect(t.connectionState()).toBe('connected');
    expect(onState).toHaveBeenCalledWith('connected');
  });

  it('sends messages when connected', async () => {
    const t = createMockTransport();
    const store = createCredentialStore();
    const { state } = await useVaultAuthState({ store });
    await t.connect(state, {
      onMessage: vi.fn(),
      onQrCode: vi.fn(),
      onConnectionState: vi.fn(),
      onAuthStateUpdate: vi.fn(),
    });
    await t.sendMessage('14155551234@s.whatsapp.net', { text: 'hi' });
    expect(t.sentMessages).toHaveLength(1);
    expect(t.sentMessages[0]!.content.text).toBe('hi');
  });

  it('throws when sending while disconnected', async () => {
    const t = createMockTransport();
    await expect(t.sendMessage('14155551234@s.whatsapp.net', { text: 'hi' })).rejects.toThrow(
      'Not connected',
    );
  });
});

// ─── Vault-Backed Auth State ────────────────────────────────────────────────

describe('useVaultAuthState', () => {
  it('initializes fresh auth creds on first use', async () => {
    const store = createCredentialStore();
    const { state, saveCreds } = await useVaultAuthState({ store });

    expect(state.creds).toBeDefined();
    expect(state.creds.signedIdentityKey).toBeDefined();
    expect(state.creds.noiseKey).toBeDefined();
    expect(state.creds.registrationId).toBeGreaterThan(0);
    expect(state.keys).toBeDefined();
    expect(typeof saveCreds).toBe('function');
  });

  it('persists creds to vault on first init', async () => {
    const store = createCredentialStore();
    await useVaultAuthState({ store });

    const credsJson = await store.getSecret('whatsapp-auth-creds');
    expect(credsJson).toBeDefined();
    const parsed = JSON.parse(credsJson!);
    expect(parsed.registrationId).toBeDefined();
  });

  it('restores existing creds from vault', async () => {
    const store = createCredentialStore();
    const { state: first } = await useVaultAuthState({ store });
    const regId = first.creds.registrationId;

    // Second init should restore the same creds
    const { state: second } = await useVaultAuthState({ store });
    expect(second.creds.registrationId).toBe(regId);
  });

  it('saveCreds persists updates to vault', async () => {
    const store = createCredentialStore();
    const { state, saveCreds } = await useVaultAuthState({ store });

    // Mutate creds (Baileys does this in-place)
    state.creds.nextPreKeyId = 999;
    await saveCreds();

    // Restore and verify
    const { state: restored } = await useVaultAuthState({ store });
    expect(restored.creds.nextPreKeyId).toBe(999);
  });

  it('keys.set and keys.get round-trip signal keys', async () => {
    const store = createCredentialStore();
    const { state } = await useVaultAuthState({ store });

    // Store a pre-key
    const keyPair = {
      public: new Uint8Array([1, 2, 3, 4]),
      private: new Uint8Array([5, 6, 7, 8]),
    };
    await state.keys.set({ 'pre-key': { '1': keyPair } });

    // Retrieve it
    const result = await state.keys.get('pre-key', ['1']);
    expect(result['1']).toBeDefined();
    expect(Buffer.from(result['1']!.public)).toEqual(Buffer.from(keyPair.public));
    expect(Buffer.from(result['1']!.private)).toEqual(Buffer.from(keyPair.private));
  });

  it('keys.set deletes keys with null value', async () => {
    const store = createCredentialStore();
    const { state } = await useVaultAuthState({ store });

    const keyPair = {
      public: new Uint8Array([1, 2, 3]),
      private: new Uint8Array([4, 5, 6]),
    };
    await state.keys.set({ 'pre-key': { '1': keyPair } });
    await state.keys.set({ 'pre-key': { '1': null } });

    const result = await state.keys.get('pre-key', ['1']);
    expect(result['1']).toBeUndefined();
  });

  it('keys.get returns empty for missing keys', async () => {
    const store = createCredentialStore();
    const { state } = await useVaultAuthState({ store });

    const result = await state.keys.get('session', ['nonexistent']);
    expect(result['nonexistent']).toBeUndefined();
  });
});

describe('clearVaultAuthState', () => {
  it('removes all WhatsApp auth data from vault', async () => {
    const store = createCredentialStore();
    const { state, saveCreds } = await useVaultAuthState({ store });

    // Store some keys
    await state.keys.set({
      'pre-key': { '1': { public: new Uint8Array([1]), private: new Uint8Array([2]) } },
      session: { abc: new Uint8Array([3, 4, 5]) },
    });
    await saveCreds();

    // Clear
    await clearVaultAuthState(store);

    // Verify creds are gone
    expect(await store.getSecret('whatsapp-auth-creds')).toBeUndefined();

    // Verify keys are gone (load raw rules)
    const rules = await store.load();
    const waKeys = Object.keys(rules.secrets).filter((k) => k.startsWith('wa-key:'));
    expect(waKeys).toHaveLength(0);
  });

  it('is idempotent (no error when already empty)', async () => {
    const store = createCredentialStore();
    await expect(clearVaultAuthState(store)).resolves.not.toThrow();
  });
});

// ─── WhatsApp Adapter ───────────────────────────────────────────────────────

describe('WhatsAppAdapter', () => {
  describe('connect / disconnect', () => {
    it('connects via transport', async () => {
      const transport = createMockTransport();
      const store = createCredentialStore();
      const adapter = createAdapter(transport, store);

      await adapter.connect();
      expect(adapter.isConnected()).toBe(true);
      expect(transport.connectCalls).toBe(1);
    });

    it('disconnects via transport', async () => {
      const transport = createMockTransport();
      const store = createCredentialStore();
      const adapter = createAdapter(transport, store);

      await adapter.connect();
      await adapter.disconnect();
      expect(transport.disconnectCalls).toBe(1);
    });

    it('isConnected reflects transport state', async () => {
      const transport = createMockTransport();
      const store = createCredentialStore();
      const adapter = createAdapter(transport, store);

      expect(adapter.isConnected()).toBe(false);
      await adapter.connect();
      expect(adapter.isConnected()).toBe(true);
    });
  });

  describe('inbound message normalization', () => {
    it('normalizes text messages', async () => {
      const transport = createMockTransport();
      const store = createCredentialStore();
      const adapter = createAdapter(transport, store);
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));

      await adapter.connect();
      transport.simulateMessage(makeTextMessage());

      // Wait for async handler
      await vi.waitFor(() => expect(received).toHaveLength(1));

      const msg = received[0]!;
      expect(msg.id).toBe('MSG001');
      expect(msg.channel).toBe('whatsapp');
      expect(msg.userId).toBe('wa:14155551234@s.whatsapp.net');
      expect(msg.senderName).toBe('Alice');
      expect(msg.text).toBe('Hello from WhatsApp');
      expect(msg.isFromMe).toBe(false);
      expect(msg.timestamp).toBe(1712500000000); // seconds → ms
    });

    it('normalizes voice messages and saves audio file', async () => {
      const transport = createMockTransport();
      const store = createCredentialStore();
      const adapter = createAdapter(transport, store);
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));

      await adapter.connect();
      transport.simulateMessage(makeVoiceMessage());

      await vi.waitFor(() => expect(received).toHaveLength(1));

      const msg = received[0]!;
      expect(msg.audioPath).toBeDefined();
      expect(msg.audioPath!.endsWith('.ogg')).toBe(true);
      expect(msg.metadata['mimeType']).toBe('audio/ogg; codecs=opus');

      // Verify file was written
      const content = await readFile(msg.audioPath!);
      expect(content.toString()).toBe('fake-ogg-audio-data');
    });

    it('normalizes image messages and saves image file', async () => {
      const transport = createMockTransport();
      const store = createCredentialStore();
      const adapter = createAdapter(transport, store);
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));

      await adapter.connect();
      transport.simulateMessage(makeImageMessage());

      await vi.waitFor(() => expect(received).toHaveLength(1));

      const msg = received[0]!;
      expect(msg.imagePath).toBeDefined();
      expect(msg.imagePath!.endsWith('.jpg')).toBe(true);
      expect(msg.text).toBe('Check this out'); // caption
      expect(msg.metadata['mimeType']).toBe('image/jpeg');

      const content = await readFile(msg.imagePath!);
      expect(content.toString()).toBe('fake-jpeg-image-data');
    });

    it('preserves quoted message ID', async () => {
      const transport = createMockTransport();
      const store = createCredentialStore();
      const adapter = createAdapter(transport, store);
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));

      await adapter.connect();
      transport.simulateMessage(makeTextMessage({ quotedMessageId: 'REPLY123' }));

      await vi.waitFor(() => expect(received).toHaveLength(1));
      expect(received[0]!.replyToMessageId).toBe('REPLY123');
    });

    it('skips messages from self', async () => {
      const transport = createMockTransport();
      const store = createCredentialStore();
      const adapter = createAdapter(transport, store);
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));

      await adapter.connect();
      transport.simulateMessage(makeTextMessage({ isFromMe: true }));

      // Give handler time to run
      await new Promise((r) => setTimeout(r, 50));
      expect(received).toHaveLength(0);
    });

    it('includes sender and chat JID in metadata', async () => {
      const transport = createMockTransport();
      const store = createCredentialStore();
      const adapter = createAdapter(transport, store);
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));

      await adapter.connect();
      transport.simulateMessage(
        makeTextMessage({
          senderJid: '442071234567@s.whatsapp.net',
          chatJid: '120363012345@g.us',
        }),
      );

      await vi.waitFor(() => expect(received).toHaveLength(1));
      expect(received[0]!.metadata['senderJid']).toBe('442071234567@s.whatsapp.net');
      expect(received[0]!.metadata['chatJid']).toBe('120363012345@g.us');
      expect(received[0]!.userId).toBe('wa:120363012345@g.us');
    });
  });

  describe('access control', () => {
    it('allows all numbers when allowedNumbers is empty', async () => {
      const transport = createMockTransport();
      const store = createCredentialStore();
      const adapter = createAdapter(transport, store, { allowedNumbers: [] });
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));

      await adapter.connect();
      transport.simulateMessage(makeTextMessage({ senderJid: '99999@s.whatsapp.net' }));

      await vi.waitFor(() => expect(received).toHaveLength(1));
    });

    it('blocks numbers not in allowedNumbers', async () => {
      const transport = createMockTransport();
      const store = createCredentialStore();
      const adapter = createAdapter(transport, store, {
        allowedNumbers: ['14155551234'],
      });
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));

      await adapter.connect();
      transport.simulateMessage(makeTextMessage({ senderJid: '99999@s.whatsapp.net' }));

      await new Promise((r) => setTimeout(r, 50));
      expect(received).toHaveLength(0);
    });

    it('allows numbers in allowedNumbers', async () => {
      const transport = createMockTransport();
      const store = createCredentialStore();
      const adapter = createAdapter(transport, store, {
        allowedNumbers: ['14155551234'],
      });
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));

      await adapter.connect();
      transport.simulateMessage(makeTextMessage());

      await vi.waitFor(() => expect(received).toHaveLength(1));
    });
  });

  describe('outbound delivery', () => {
    it('sends text via transport', async () => {
      const transport = createMockTransport();
      const store = createCredentialStore();
      const adapter = createAdapter(transport, store);

      await adapter.connect();
      await adapter.send({
        channel: 'whatsapp',
        userId: 'wa:14155551234@s.whatsapp.net',
        text: 'Reply from bot',
      });

      expect(transport.sentMessages).toHaveLength(1);
      expect(transport.sentMessages[0]!.jid).toBe('14155551234@s.whatsapp.net');
      expect(transport.sentMessages[0]!.content.text).toBe('Reply from bot');
    });

    it('throws when sending while disconnected', async () => {
      const transport = createMockTransport();
      const store = createCredentialStore();
      const adapter = createAdapter(transport, store);

      await expect(
        adapter.send({
          channel: 'whatsapp',
          userId: 'wa:14155551234@s.whatsapp.net',
          text: 'Should fail',
        }),
      ).rejects.toThrow('not connected');
    });

    it('splits long messages', async () => {
      const transport = createMockTransport();
      const store = createCredentialStore();
      const adapter = createAdapter(transport, store);

      await adapter.connect();
      const longText = 'A'.repeat(5000);
      await adapter.send({
        channel: 'whatsapp',
        userId: 'wa:14155551234@s.whatsapp.net',
        text: longText,
      });

      expect(transport.sentMessages.length).toBeGreaterThan(1);
    });
  });

  describe('QR code callback', () => {
    it('invokes onQrCode callback', async () => {
      const transport = createMockTransport();
      const store = createCredentialStore();
      const qrCodes: string[] = [];
      const adapter = createAdapter(transport, store, {
        onQrCode: (qr) => qrCodes.push(qr),
      });

      await adapter.connect();
      transport.simulateQrCode('QR_DATA_123');

      expect(qrCodes).toEqual(['QR_DATA_123']);
    });
  });

  describe('auth state persistence', () => {
    it('saves creds on auth state update', async () => {
      const transport = createMockTransport();
      const store = createCredentialStore();
      const adapter = createAdapter(transport, store);

      await adapter.connect();

      // Trigger creds update (Baileys fires this on session changes)
      await transport.simulateAuthUpdate();

      // Verify creds are in vault
      const credsJson = await store.getSecret('whatsapp-auth-creds');
      expect(credsJson).toBeDefined();
    });
  });

  describe('multiple handlers', () => {
    it('emits to all registered handlers', async () => {
      const transport = createMockTransport();
      const store = createCredentialStore();
      const adapter = createAdapter(transport, store);
      const received1: InboundMessage[] = [];
      const received2: InboundMessage[] = [];
      adapter.onMessage((msg) => received1.push(msg));
      adapter.onMessage((msg) => received2.push(msg));

      await adapter.connect();
      transport.simulateMessage(makeTextMessage());

      await vi.waitFor(() => expect(received1).toHaveLength(1));
      expect(received2).toHaveLength(1);
    });
  });
});

// ─── Helpers ────────────────────────────────────────────────────────────────

describe('parseWhatsAppJid', () => {
  it('parses DM JID', () => {
    expect(parseWhatsAppJid('wa:14155551234@s.whatsapp.net')).toBe('14155551234@s.whatsapp.net');
  });

  it('parses group JID', () => {
    expect(parseWhatsAppJid('wa:120363012345@g.us')).toBe('120363012345@g.us');
  });

  it('throws for invalid format', () => {
    expect(() => parseWhatsAppJid('tg:12345')).toThrow('Invalid WhatsApp chat ID');
    expect(() => parseWhatsAppJid('14155551234')).toThrow('Invalid WhatsApp chat ID');
  });
});

describe('splitMessage', () => {
  it('returns single chunk for short messages', () => {
    expect(splitMessage('Hello')).toEqual(['Hello']);
  });

  it('splits on newline boundary', () => {
    const text = 'A'.repeat(3000) + '\n' + 'B'.repeat(2000);
    const chunks = splitMessage(text, 4096);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe('A'.repeat(3000));
    expect(chunks[1]).toBe('B'.repeat(2000));
  });

  it('splits on space when no newline', () => {
    const text = 'word '.repeat(1000).trim();
    const chunks = splitMessage(text, 4096);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }
  });

  it('hard-splits when no break point', () => {
    const text = 'A'.repeat(10000);
    const chunks = splitMessage(text, 4096);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toBe('A'.repeat(4096));
    expect(chunks[1]).toBe('A'.repeat(4096));
    expect(chunks[2]).toBe('A'.repeat(1808));
  });

  it('handles exact max length', () => {
    const text = 'A'.repeat(4096);
    expect(splitMessage(text, 4096)).toEqual([text]);
  });

  it('handles empty trailing after split', () => {
    const text = 'A'.repeat(4096) + '\n';
    const chunks = splitMessage(text, 4096);
    // Trailing newline gets trimStart'd to empty, not added as chunk
    expect(chunks).toHaveLength(1);
  });
});

// ─── CredentialStore keyOverride ────────────────────────────────────────────

describe('CredentialStore keyOverride', () => {
  it('uses provided key instead of reading from file', async () => {
    const store = createCredentialStore();
    const key = await store.ensureKey();

    // Create a new store with keyOverride — no key file needed
    const overrideDir = join(tempDir, 'override-secrets');
    await mkdir(overrideDir, { recursive: true });

    // Copy enc file to new dir
    const rules = await store.load();
    const { encrypt } = await import('../src/proxy/credential-store.js');
    const encrypted = encrypt(Buffer.from(JSON.stringify(rules), 'utf-8'), key);
    await fsWriteFile(join(overrideDir, 'credentials.enc'), encrypted);

    // Create store with keyOverride — no credentials.key file exists
    const overrideStore = new CredentialStore({
      secretsDir: overrideDir,
      keyOverride: key,
    });

    const loaded = await overrideStore.load();
    expect(loaded).toBeDefined();
    expect(loaded.credentials).toEqual([]);
  });

  it('can save via keyOverride store', async () => {
    const store = createCredentialStore();
    const key = await store.ensureKey();

    const overrideStore = new CredentialStore({
      secretsDir: secretsDir,
      keyOverride: key,
    });

    await overrideStore.setSecret('test-key', 'test-value');
    const val = await overrideStore.getSecret('test-key');
    expect(val).toBe('test-value');
  });
});
