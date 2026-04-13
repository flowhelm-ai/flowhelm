/**
 * Tests for auth health monitoring (Phase 14).
 *
 * Tests cover: OAuth token expiry detection, API key validation,
 * missing credentials, doctor integration, status integration,
 * CLI auth commands, and config save/switch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  checkAuthHealth,
  getAuthStatus,
  type AuthMonitorOptions,
} from '../src/auth/auth-monitor.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function mockReadFile(files: Record<string, string>) {
  return async (path: string | Buffer | URL, _encoding?: string): Promise<string> => {
    const p = typeof path === 'string' ? path : path.toString();
    for (const [pattern, content] of Object.entries(files)) {
      if (p.includes(pattern)) return content;
    }
    throw new Error(`ENOENT: no such file: ${p}`);
  };
}

function oauthJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: 'sk-ant-oat01-test-token',
      expiresAt: new Date(Date.now() + 300 * 24 * 60 * 60 * 1000).toISOString(),
      subscriptionType: 'pro',
      rateLimitTier: 'pro',
      ...overrides,
    },
  });
}

function opts(files: Record<string, string>, warnDays?: number): AuthMonitorOptions {
  return {
    homeDir: '/test-home',
    readFileFn: mockReadFile(files) as AuthMonitorOptions['readFileFn'],
    warnDays,
  };
}

// ─── checkAuthHealth ────────────────────────────────────────────────────────

describe('checkAuthHealth', () => {
  it('returns missing when no credentials exist', async () => {
    const results = await checkAuthHealth(opts({}));
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('none');
    expect(results[0].status).toBe('missing');
    expect(results[0].fix).toContain('flowhelm setup');
  });

  it('detects valid OAuth token with days remaining', async () => {
    const results = await checkAuthHealth(
      opts({
        '.credentials.json': oauthJson(),
      }),
    );
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('oauth');
    expect(results[0].status).toBe('ok');
    expect(results[0].daysRemaining).toBeGreaterThan(200);
    expect(results[0].subscriptionType).toBe('pro');
  });

  it('detects expiring OAuth token within warn threshold', async () => {
    const expiresAt = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString();
    const results = await checkAuthHealth(
      opts({
        '.credentials.json': oauthJson({ expiresAt }),
      }),
    );
    expect(results[0].status).toBe('expiring');
    expect(results[0].daysRemaining).toBeLessThanOrEqual(15);
    expect(results[0].fix).toContain('renew');
  });

  it('detects expired OAuth token', async () => {
    const expiresAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const results = await checkAuthHealth(
      opts({
        '.credentials.json': oauthJson({ expiresAt }),
      }),
    );
    expect(results[0].status).toBe('expired');
    expect(results[0].daysRemaining).toBeLessThan(0);
    expect(results[0].fix).toContain('re-authenticate');
  });

  it('uses custom warn threshold', async () => {
    // 45 days remaining, default threshold 30 → ok. Custom threshold 60 → expiring.
    const expiresAt = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000).toISOString();

    const defaultResult = await checkAuthHealth(
      opts({
        '.credentials.json': oauthJson({ expiresAt }),
      }),
    );
    expect(defaultResult[0].status).toBe('ok');

    const customResult = await checkAuthHealth(
      opts(
        {
          '.credentials.json': oauthJson({ expiresAt }),
        },
        60,
      ),
    );
    expect(customResult[0].status).toBe('expiring');
  });

  it('handles OAuth file with missing accessToken', async () => {
    const results = await checkAuthHealth(
      opts({
        '.credentials.json': JSON.stringify({ claudeAiOauth: {} }),
      }),
    );
    expect(results[0].status).toBe('warn');
    expect(results[0].message).toContain('missing access token');
  });

  it('handles malformed OAuth JSON', async () => {
    const results = await checkAuthHealth(
      opts({
        '.credentials.json': 'not json',
      }),
    );
    expect(results[0].status).toBe('warn');
    expect(results[0].message).toContain('malformed');
  });

  it('handles OAuth without expiresAt field', async () => {
    const json = JSON.stringify({
      claudeAiOauth: { accessToken: 'sk-ant-oat01-test', subscriptionType: 'max' },
    });
    const results = await checkAuthHealth(opts({ '.credentials.json': json }));
    expect(results[0].status).toBe('ok');
    expect(results[0].message).toContain('no expiry set');
  });

  it('detects valid API key', async () => {
    const results = await checkAuthHealth(
      opts({
        'api-key': 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890ABCDEF',
      }),
    );
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('api_key');
    expect(results[0].status).toBe('ok');
    expect(results[0].message).toContain('sk-ant-api');
    // Key should be masked
    expect(results[0].message).toContain('...');
  });

  it('detects invalid API key format', async () => {
    const results = await checkAuthHealth(
      opts({
        'api-key': 'not-a-valid-key',
      }),
    );
    expect(results[0].type).toBe('api_key');
    expect(results[0].status).toBe('warn');
    expect(results[0].message).toContain('invalid');
  });

  it('detects empty API key file', async () => {
    const results = await checkAuthHealth(
      opts({
        'api-key': '',
      }),
    );
    expect(results[0].type).toBe('api_key');
    expect(results[0].status).toBe('warn');
    expect(results[0].message).toContain('empty');
  });

  it('returns both OAuth and API key when both configured', async () => {
    const results = await checkAuthHealth(
      opts({
        '.credentials.json': oauthJson(),
        'api-key': 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890ABCDEF',
      }),
    );
    expect(results).toHaveLength(2);
    const types = results.map((r) => r.type);
    expect(types).toContain('oauth');
    expect(types).toContain('api_key');
  });
});

// ─── getAuthStatus ──────────────────────────────────────────────────────────

describe('getAuthStatus', () => {
  it('returns worst status when multiple auths configured', async () => {
    const expiresAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const result = await getAuthStatus(
      opts({
        '.credentials.json': oauthJson({ expiresAt }), // expired
        'api-key': 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890ABCDEF', // ok
      }),
    );
    expect(result.status).toBe('expired');
  });

  it('returns ok when all healthy', async () => {
    const result = await getAuthStatus(
      opts({
        '.credentials.json': oauthJson(),
      }),
    );
    expect(result.status).toBe('ok');
  });

  it('returns missing when nothing configured', async () => {
    const result = await getAuthStatus(opts({}));
    expect(result.status).toBe('missing');
  });
});

// ─── Doctor integration ─────────────────────────────────────────────────────

describe('doctor auth checks', () => {
  it('doctor includes auth token checks', async () => {
    // Import doctor dynamically to avoid side effects
    const { runDoctor } = await import('../src/admin/doctor.js');
    const logs: string[] = [];
    const result = await runDoctor({
      log: (msg: string) => logs.push(msg),
      homeDir: '/nonexistent-test-dir',
      skipSystemChecks: true,
    });

    // Should have an auth-related check (will be 'missing' for nonexistent dir)
    const authCheck = result.checks.find(
      (c) => c.name === 'Auth' || c.name === 'OAuth token' || c.name === 'API key',
    );
    expect(authCheck).toBeDefined();
  });
});

// ─── Config saveConfig ──────────────────────────────────────────────────────

describe('saveConfig', () => {
  it('saves config to YAML file', async () => {
    const { saveConfig, loadConfig } = await import('../src/config/loader.js');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const yaml = await import('yaml');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowhelm-test-'));
    const configPath = path.join(tmpDir, 'config.yaml');
    try {
      // Create a minimal config file with required username field
      fs.writeFileSync(configPath, yaml.stringify({ username: 'testuser' }));
      const config = loadConfig(['--config', configPath]);
      config.auth.method = 'subscription_bridge';
      config.agent.credentialMethod = 'oauth';
      saveConfig(config, tmpDir);

      const written = fs.readFileSync(configPath, 'utf-8');
      expect(written).toContain('subscription_bridge');
      expect(written).toContain('oauth');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── CLI auth command ───────────────────────────────────────────────────────

describe('CLI auth status', () => {
  it('cli dispatches auth command', async () => {
    const { cli } = await import('../src/cli.js');

    // Mock console.log to capture output
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    try {
      await cli(['node', 'flowhelm', 'auth', 'status']);
    } catch {
      // May throw if process.exit is called — that's fine
    } finally {
      console.log = originalLog;
    }

    // Should have printed auth status
    expect(logs.some((l) => l.includes('Authentication Status'))).toBe(true);
  });
});
