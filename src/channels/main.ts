#!/usr/bin/env node

/**
 * Channel container entrypoint.
 *
 * Reads channel configuration from environment variables, decrypts
 * credentials, connects to PostgreSQL, initializes channel adapters,
 * and starts the HTTP server.
 *
 * Environment variables:
 *   CREDENTIAL_KEY              — hex-encoded 32-byte AES decryption key
 *   CHANNEL_PORT                — HTTP server port (default: 9000)
 *   DB_HOST                     — PostgreSQL hostname
 *   DB_PORT                     — PostgreSQL port (default: 5432)
 *   DB_USER                     — PostgreSQL user
 *   DB_PASSWORD                 — PostgreSQL password
 *   DB_NAME                     — PostgreSQL database name
 *   TELEGRAM_ENABLED            — true/false
 *   TELEGRAM_ALLOWED_USERS      — comma-separated Telegram user IDs
 *   DOWNLOADS_DIR               — path for downloaded media (default: /downloads)
 *   GMAIL_ENABLED               — true/false
 *   GMAIL_TRANSPORT             — pubsub/imap
 *   GMAIL_EMAIL_ADDRESS         — sender email address
 *   GMAIL_GCP_PROJECT           — GCP project for Pub/Sub
 *   GMAIL_PUBSUB_TOPIC          — Pub/Sub topic
 *   GMAIL_PUBSUB_SUBSCRIPTION   — Pub/Sub subscription
 *   (SA key is read from the encrypted vault, not an env var)
 *   GMAIL_PULL_INTERVAL         — Pub/Sub pull interval (ms)
 *   GMAIL_IMAP_HOST             — IMAP host (default: imap.gmail.com)
 *   GMAIL_IMAP_PORT             — IMAP port (default: 993)
 *   GMAIL_NOTIFICATION_CHANNEL  — cross-channel notification target (telegram)
 *   GMAIL_NOTIFICATION_USER_ID  — notification target user ID (e.g., tg:12345)
 *   WHATSAPP_ENABLED            — true/false
 *   WHATSAPP_ALLOWED_NUMBERS    — comma-separated phone numbers (e.g., 14155551234)
 *   WHATSAPP_PRINT_QR           — true/false (print QR code in terminal)
 */

import { writeFileSync } from 'node:fs';
import { ChannelDbWriter } from './channel-db.js';
import { ChannelServer, type GwsTokenProvider } from './channel-server.js';
import { readChannelCredentials } from './credential-reader.js';
import type { ChannelAdapter, InboundMessage } from '../orchestrator/types.js';

async function main(): Promise<void> {
  const port = parseInt(process.env['CHANNEL_PORT'] ?? '9000', 10);

  // ── Decrypt credentials ─────────────────────────────────────────────────
  const credentialKey = process.env['CREDENTIAL_KEY'];
  if (!credentialKey) {
    throw new Error('CREDENTIAL_KEY env var is required');
  }

  const credentialsPath = process.env['CREDENTIALS_PATH'] ?? '/secrets/credentials.enc';
  const credentials = await readChannelCredentials(credentialsPath, credentialKey);
  console.log('[channel] Credentials decrypted');

  // ── Connect to PostgreSQL ───────────────────────────────────────────────
  const dbWriter = new ChannelDbWriter({
    host: process.env['DB_HOST'] ?? 'localhost',
    port: parseInt(process.env['DB_PORT'] ?? '5432', 10),
    user: process.env['DB_USER'] ?? 'flowhelm',
    password: process.env['DB_PASSWORD'] ?? '',
    database: process.env['DB_NAME'] ?? 'flowhelm',
  });

  await dbWriter.connect();
  const defaultProfileId = await dbWriter.resolveDefaultProfileId();
  console.log(`[channel] Default profile: ${defaultProfileId}`);

  // ── Create message handler (shared by all adapters) ─────────────────────
  const handleInbound = async (msg: InboundMessage): Promise<void> => {
    const chatId = msg.userId;
    const externalId = msg.userId.replace(/^(tg|wa|gmail):/, '');

    try {
      await dbWriter.upsertChat(chatId, msg.channel, externalId, msg.senderName, defaultProfileId);
      await dbWriter.storeMessage(chatId, msg);
      await dbWriter.enqueueMessage(chatId, msg);
      console.log(`[channel] Queued ${msg.channel} message ${msg.id} for ${chatId}`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[channel] Failed to queue message ${msg.id}: ${errMsg}`);
    }
  };

  // ── Initialize adapters ─────────────────────────────────────────────────
  const adapters = new Map<string, ChannelAdapter>();
  let gwsTokenProvider: GwsTokenProvider | undefined;

  // Telegram
  if (process.env['TELEGRAM_ENABLED'] === 'true' && credentials.telegramBotToken) {
    try {
      const allowedUsersRaw = process.env['TELEGRAM_ALLOWED_USERS'] ?? '';
      const allowedUsers = allowedUsersRaw
        ? allowedUsersRaw
            .split(',')
            .map((s) => parseInt(s.trim(), 10))
            .filter((n) => !isNaN(n))
        : [];
      const downloadDir = process.env['DOWNLOADS_DIR'] ?? '/downloads';

      const { createTelegramAdapter } = await import('./telegram/index.js');
      const adapter = createTelegramAdapter(
        { botToken: credentials.telegramBotToken, allowedUsers },
        downloadDir,
      );
      if (adapter) {
        adapter.onMessage((msg) => void handleInbound(msg));
        await adapter.connect();
        adapters.set('telegram', adapter);
        console.log('[channel] Telegram adapter connected');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[channel] Telegram adapter failed to connect: ${msg}`);
    }
  }

  // WhatsApp
  if (process.env['WHATSAPP_ENABLED'] === 'true') {
    try {
      const allowedNumbersRaw = process.env['WHATSAPP_ALLOWED_NUMBERS'] ?? '';
      const allowedNumbers = allowedNumbersRaw
        ? allowedNumbersRaw
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      const downloadDir = process.env['DOWNLOADS_DIR'] ?? '/downloads';
      const printQr = process.env['WHATSAPP_PRINT_QR'] === 'true';

      // WhatsApp needs CredentialStore for vault-backed auth state
      const { CredentialStore } = await import('../proxy/credential-store.js');
      const credentialStore = new CredentialStore({
        secretsDir: credentialsPath.replace(/\/credentials\.enc$/, ''),
        keyOverride: Buffer.from(credentialKey, 'hex'),
      });

      const { WhatsAppAdapter, BaileysTransport } = await import('./whatsapp/index.js');
      const transport = new BaileysTransport({ printQrInTerminal: printQr });
      const whatsappAdapter = new WhatsAppAdapter({
        transport,
        credentialStore,
        downloadDir,
        allowedNumbers,
      });

      whatsappAdapter.onMessage((msg) => void handleInbound(msg));
      await whatsappAdapter.connect();
      adapters.set('whatsapp', whatsappAdapter);
      console.log('[channel] WhatsApp adapter connected');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[channel] WhatsApp adapter failed to connect: ${msg}`);
    }
  }

  // Gmail
  if (process.env['GMAIL_ENABLED'] === 'true') {
    try {
      const transportMode = (process.env['GMAIL_TRANSPORT'] ?? 'pubsub') as 'pubsub' | 'imap';
      const emailAddress = credentials.gmailEmailAddress ?? process.env['GMAIL_EMAIL_ADDRESS'];

      if (
        emailAddress &&
        credentials.gmailOauthClientId &&
        credentials.gmailOauthClientSecret &&
        credentials.gmailOauthRefreshToken
      ) {
        // Cross-channel notification: Gmail->Telegram (both adapters in same process)
        const notificationChannel = process.env['GMAIL_NOTIFICATION_CHANNEL'];
        const notificationAdapter =
          notificationChannel === 'telegram' ? adapters.get('telegram') : undefined;
        const notificationUserId = process.env['GMAIL_NOTIFICATION_USER_ID'];

        const { createGmailAdapter } = await import('./gmail/index.js');
        // Write SA key from vault to tmpfs (memory-only, never touches disk).
        // PubSubPullDaemon reads it as a file — we materialize it from the vault.
        let saKeyPath: string | undefined;
        if (credentials.gmailServiceAccountKey) {
          saKeyPath = '/tmp/gmail-sa-key.json';
          writeFileSync(saKeyPath, credentials.gmailServiceAccountKey, { mode: 0o400 });
          console.log('[channel] Gmail SA key written to tmpfs');
        }

        const gmailAdapter = createGmailAdapter(
          {
            enabled: true,
            emailAddress,
            transport: transportMode,
            oauthClientId: credentials.gmailOauthClientId,
            oauthClientSecret: credentials.gmailOauthClientSecret,
            gcpProject: process.env['GMAIL_GCP_PROJECT'],
            pubsubTopic: process.env['GMAIL_PUBSUB_TOPIC'],
            pubsubSubscription: process.env['GMAIL_PUBSUB_SUBSCRIPTION'],
            serviceAccountKeyPath: saKeyPath,
            pullInterval: process.env['GMAIL_PULL_INTERVAL']
              ? parseInt(process.env['GMAIL_PULL_INTERVAL'], 10)
              : undefined,
            imapHost: process.env['GMAIL_IMAP_HOST'],
            imapPort: process.env['GMAIL_IMAP_PORT']
              ? parseInt(process.env['GMAIL_IMAP_PORT'], 10)
              : undefined,
            notificationChannel: notificationChannel as 'telegram' | 'whatsapp' | undefined,
          },
          { oauthRefreshToken: credentials.gmailOauthRefreshToken },
          notificationAdapter,
          notificationUserId,
        );

        if (gmailAdapter) {
          gmailAdapter.onMessage((msg) => void handleInbound(msg));
          await gmailAdapter.connect();
          adapters.set('gmail', gmailAdapter);

          // Provide OAuth token for gws CLI execution (POST /gws endpoint).
          // GmailClient handles token refresh automatically — gws gets a
          // fresh access token injected via GOOGLE_WORKSPACE_CLI_TOKEN env var.
          const gmailClient = gmailAdapter.client;
          gwsTokenProvider = () => gmailClient.getAccessToken();

          console.log(`[channel] Gmail adapter connected (transport=${transportMode})`);
        }
      } else {
        console.warn('[channel] Gmail enabled but credentials incomplete — skipping');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[channel] Gmail adapter failed to connect: ${msg}`);
    }
  }

  // ── Start HTTP server ───────────────────────────────────────────────────
  const server = new ChannelServer({
    port,
    adapters,
    gwsTokenProvider,
  });

  await server.start();
  console.log(
    `[channel] Channel container ready on port ${String(port)} (${String(adapters.size)} adapter(s))`,
  );

  // ── Graceful shutdown ───────────────────────────────────────────────────
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[channel] Received ${signal}, shutting down...`);

    // Disconnect all adapters
    for (const [name, adapter] of adapters) {
      try {
        await adapter.disconnect();
        console.log(`[channel] ${name} adapter disconnected`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[channel] Failed to disconnect ${name}: ${msg}`);
      }
    }

    await server.stop();
    await dbWriter.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // ── SIGHUP: reload credentials ──────────────────────────────────────────
  process.on('SIGHUP', () => {
    console.log('[channel] Received SIGHUP — credential reload not yet implemented');
  });
}

main().catch((err) => {
  console.error('[channel] Fatal error:', err);
  process.exit(1);
});
