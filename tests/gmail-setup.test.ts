/**
 * Tests for the flowhelm setup gmail CLI command.
 *
 * Covers: config writing, secrets storage, transport validation,
 * skill recommendations, error cases.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupGmailCommand } from '../src/admin/cli.js';
import type { SetupContext } from '../src/admin/cli.js';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

// ─── Helpers ───────────────────────────────────────────────────────────────

let tempDir: string;
let logs: string[];
let errors: string[];

function createSetupContext(): SetupContext {
  return {
    configDir: tempDir,
    skillStore: {
      isInstalled: vi.fn(async () => false),
    } as unknown as SetupContext['skillStore'],
    registryClient: {} as unknown as SetupContext['registryClient'],
    log: (msg: string) => logs.push(msg),
    error: (msg: string) => errors.push(msg),
  };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'flowhelm-gmail-setup-'));
  logs = [];
  errors = [];
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('setupGmailCommand', () => {
  it('writes Gmail config to config.yaml', async () => {
    const ctx = createSetupContext();
    const result = await setupGmailCommand(
      {
        emailAddress: 'user@gmail.com',
        oauthClientId: 'client-id',
        oauthClientSecret: 'client-secret',
        oauthRefreshToken: 'refresh-token',
        gcpProject: 'my-project',
        transport: 'pubsub',
      },
      ctx,
    );

    expect(result.success).toBe(true);

    const configRaw = await readFile(join(tempDir, 'config.yaml'), 'utf-8');
    const config = parseYaml(configRaw) as Record<string, unknown>;
    const channels = config['channels'] as Record<string, unknown>;
    const gmail = channels['gmail'] as Record<string, unknown>;

    expect(gmail['enabled']).toBe(true);
    expect(gmail['emailAddress']).toBe('user@gmail.com');
    expect(gmail['transport']).toBe('pubsub');
    expect(gmail['gcpProject']).toBe('my-project');
    expect(gmail['oauthClientId']).toBe('client-id');
    expect(gmail['oauthClientSecret']).toBe('client-secret');
  });

  it('stores credentials in encrypted vault', async () => {
    const ctx = createSetupContext();
    await setupGmailCommand(
      {
        emailAddress: 'user@gmail.com',
        oauthClientId: 'id',
        oauthClientSecret: 'secret',
        oauthRefreshToken: 'my-refresh-token',
        gcpProject: 'proj',
      },
      ctx,
    );

    // Vault file (credentials.enc) should exist in secrets dir
    const secretsDir = join(tempDir, 'secrets');
    const files = await readdir(secretsDir);
    expect(files).toContain('credentials.enc');
    // Verify the log confirms vault storage
    expect(logs.join('\n')).toContain('encrypted vault');
  });

  it('does NOT store refresh token in config file', async () => {
    const ctx = createSetupContext();
    await setupGmailCommand(
      {
        emailAddress: 'user@gmail.com',
        oauthClientId: 'id',
        oauthClientSecret: 'secret',
        oauthRefreshToken: 'secret-refresh-token',
        gcpProject: 'proj',
      },
      ctx,
    );

    const configRaw = await readFile(join(tempDir, 'config.yaml'), 'utf-8');
    expect(configRaw).not.toContain('secret-refresh-token');
    expect(configRaw).not.toContain('oauthRefreshToken');
    expect(configRaw).not.toContain('refreshToken');
  });

  it('fails when pubsub transport lacks gcpProject', async () => {
    const ctx = createSetupContext();
    const result = await setupGmailCommand(
      {
        emailAddress: 'user@gmail.com',
        oauthClientId: 'id',
        oauthClientSecret: 'secret',
        oauthRefreshToken: 'token',
        transport: 'pubsub',
        // No gcpProject
      },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('--gcp-project');
  });

  it('succeeds with IMAP transport without gcpProject', async () => {
    const ctx = createSetupContext();
    const result = await setupGmailCommand(
      {
        emailAddress: 'user@gmail.com',
        oauthClientId: 'id',
        oauthClientSecret: 'secret',
        oauthRefreshToken: 'token',
        transport: 'imap',
      },
      ctx,
    );

    expect(result.success).toBe(true);

    const configRaw = await readFile(join(tempDir, 'config.yaml'), 'utf-8');
    const config = parseYaml(configRaw) as Record<string, unknown>;
    const gmail = (config['channels'] as Record<string, unknown>)['gmail'] as Record<
      string,
      unknown
    >;
    expect(gmail['transport']).toBe('imap');
  });

  it('includes notificationChannel when specified', async () => {
    const ctx = createSetupContext();
    await setupGmailCommand(
      {
        emailAddress: 'user@gmail.com',
        oauthClientId: 'id',
        oauthClientSecret: 'secret',
        oauthRefreshToken: 'token',
        gcpProject: 'proj',
        notificationChannel: 'telegram',
      },
      ctx,
    );

    const configRaw = await readFile(join(tempDir, 'config.yaml'), 'utf-8');
    const config = parseYaml(configRaw) as Record<string, unknown>;
    const gmail = (config['channels'] as Record<string, unknown>)['gmail'] as Record<
      string,
      unknown
    >;
    expect(gmail['notificationChannel']).toBe('telegram');
  });

  it('recommends gmail and calendar skills when not installed', async () => {
    const ctx = createSetupContext();
    await setupGmailCommand(
      {
        emailAddress: 'user@gmail.com',
        oauthClientId: 'id',
        oauthClientSecret: 'secret',
        oauthRefreshToken: 'token',
        gcpProject: 'proj',
      },
      ctx,
    );

    const output = logs.join('\n');
    expect(output).toContain('flowhelm install gmail');
    expect(output).toContain('flowhelm install calendar');
  });

  it('does not recommend skills when already installed', async () => {
    const ctx = createSetupContext();
    (ctx.skillStore.isInstalled as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    await setupGmailCommand(
      {
        emailAddress: 'user@gmail.com',
        oauthClientId: 'id',
        oauthClientSecret: 'secret',
        oauthRefreshToken: 'token',
        gcpProject: 'proj',
      },
      ctx,
    );

    const output = logs.join('\n');
    expect(output).toContain('already installed');
    expect(output).not.toContain('flowhelm install gmail');
  });

  it('stores service account key in vault when provided', async () => {
    const { writeFile: writeFileFn } = await import('node:fs/promises');
    const saKeyPath = join(tempDir, 'sa-key.json');
    const saKey = JSON.stringify({
      type: 'service_account',
      client_email: 'test@project.iam.gserviceaccount.com',
      private_key: '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n',
    });
    await writeFileFn(saKeyPath, saKey);

    const ctx = createSetupContext();
    await setupGmailCommand(
      {
        emailAddress: 'user@gmail.com',
        oauthClientId: 'id',
        oauthClientSecret: 'secret',
        oauthRefreshToken: 'token',
        gcpProject: 'proj',
        serviceAccountKeyPath: saKeyPath,
      },
      ctx,
    );

    // SA key should be stored in vault, not referenced in config
    const configRaw = await readFile(join(tempDir, 'config.yaml'), 'utf-8');
    expect(configRaw).not.toContain('serviceAccountKeyPath');
    expect(logs.join('\n')).toContain('Service account key stored in encrypted vault');
  });

  it('stores inline SA key JSON in vault (no file path needed)', async () => {
    const saKeyJson = JSON.stringify({
      type: 'service_account',
      project_id: 'test-proj',
      client_email: 'sa@test-proj.iam.gserviceaccount.com',
      private_key: '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n',
    });

    const ctx = createSetupContext();
    await setupGmailCommand(
      {
        emailAddress: 'user@gmail.com',
        oauthClientId: 'id',
        oauthClientSecret: 'secret',
        oauthRefreshToken: 'token',
        gcpProject: 'proj',
        serviceAccountKeyJson: saKeyJson,
      },
      ctx,
    );

    // SA key should be stored in vault
    expect(logs.join('\n')).toContain('Service account key stored in encrypted vault');
    // Config should not contain the SA key content
    const configRaw = await readFile(join(tempDir, 'config.yaml'), 'utf-8');
    expect(configRaw).not.toContain('private_key');
  });

  it('logs Pub/Sub setup checklist for pubsub transport', async () => {
    const ctx = createSetupContext();
    await setupGmailCommand(
      {
        emailAddress: 'user@gmail.com',
        oauthClientId: 'id',
        oauthClientSecret: 'secret',
        oauthRefreshToken: 'token',
        gcpProject: 'proj',
        transport: 'pubsub',
      },
      ctx,
    );

    const output = logs.join('\n');
    expect(output).toContain('Pub/Sub setup checklist');
    expect(output).toContain('flowhelm-gmail');
  });

  it('logs IMAP info for imap transport', async () => {
    const ctx = createSetupContext();
    await setupGmailCommand(
      {
        emailAddress: 'user@gmail.com',
        oauthClientId: 'id',
        oauthClientSecret: 'secret',
        oauthRefreshToken: 'token',
        transport: 'imap',
      },
      ctx,
    );

    const output = logs.join('\n');
    expect(output).toContain('IMAP IDLE');
    expect(output).toContain('imap.gmail.com');
  });

  it('merges with existing config without overwriting', async () => {
    const ctx = createSetupContext();

    // Pre-existing Telegram config
    const { writeFile: wf, mkdir: mk } = await import('node:fs/promises');
    const { stringify: stringifyYaml } = await import('yaml');
    await mk(tempDir, { recursive: true });
    await wf(
      join(tempDir, 'config.yaml'),
      stringifyYaml({
        username: 'testuser',
        channels: { telegram: { botToken: 'tok123', allowedUsers: [] } },
      }),
    );

    await setupGmailCommand(
      {
        emailAddress: 'user@gmail.com',
        oauthClientId: 'id',
        oauthClientSecret: 'secret',
        oauthRefreshToken: 'token',
        gcpProject: 'proj',
      },
      ctx,
    );

    const configRaw = await readFile(join(tempDir, 'config.yaml'), 'utf-8');
    const config = parseYaml(configRaw) as Record<string, unknown>;
    expect((config as any).username).toBe('testuser');

    const channels = config['channels'] as Record<string, unknown>;
    expect(channels['telegram']).toBeDefined();
    expect(channels['gmail']).toBeDefined();
  });
});
