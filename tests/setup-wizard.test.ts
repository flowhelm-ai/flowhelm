/**
 * Tests for the interactive setup wizard.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Writable } from 'node:stream';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { runSetupWizard } from '../src/admin/setup-wizard.js';
import type { PlatformInfo } from '../src/container/platform.js';

// ─── Test helpers ───────────────────────────────────────────────────────────

/** Create a mock readline interface that feeds canned answers. */
function createMockRL(answers: string[]) {
  let idx = 0;
  const outputChunks: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      outputChunks.push(chunk.toString());
      callback();
    },
  });

  // Create a real-ish readline with a fake input
  const input = Readable.from(['']);
  const rl = createInterface({ input, output, terminal: false });

  // Override question to feed answers sequentially
  vi.spyOn(rl, 'question').mockImplementation((_q: string, cb: unknown) => {
    const answer = answers[idx] ?? '';
    idx++;
    (cb as (a: string) => void)(answer);
    return rl;
  });

  return { rl, output, outputChunks, getOutput: () => outputChunks.join('') };
}

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'flowhelm-wizard-test-'));
}

// Mock auth module globally to avoid real validation
vi.mock('../src/auth/setup-flow.js', () => ({
  runAuthSetup: vi.fn(async () => ({ method: 'api_key', success: true })),
  runApiKeyFlow: vi.fn(async () => ({ method: 'api_key', success: true })),
}));

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('runSetupWizard', () => {
  let tmpDir: string;
  let configDir: string;
  let dataDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
    configDir = path.join(tmpDir, '.flowhelm');
    dataDir = configDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs full wizard with all sections (fresh install, no re-run menu)', async () => {
    // No existing config → re-run detection is skipped → no "5" needed
    // Flow: auth (mocked), runtime, channels, voice, identity, summary
    const { rl, output } = createMockRL([
      // runAuthSection → mocked (no prompt consumed)
      '1', // Runtime: CLI
      '4', // Channels: none
      '3', // Voice: none
      'Personal assistant', // Agent role
      'Test User', // User name
      'UTC', // Timezone
      'n', // Don't start
    ]);

    const result = await runSetupWizard({
      configDir,
      dataDir,
      rl,
      output,
    });

    expect(result.success).toBe(true);
    expect(result.sections.length).toBeGreaterThan(0);

    // Config file should be created
    const configPath = path.join(configDir, 'config.yaml');
    expect(fs.existsSync(configPath)).toBe(true);

    const configContent = fs.readFileSync(configPath, 'utf-8');
    expect(configContent).toContain('cli');

    rl.close();
  });

  it('handles re-run detection with exit option', async () => {
    // Create existing config
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'config.yaml'), 'username: test\n');

    const { rl, output } = createMockRL([
      '6', // Exit (option 6)
    ]);

    const result = await runSetupWizard({
      configDir,
      dataDir,
      rl,
      output,
    });

    expect(result.success).toBe(true);
    expect(result.sections).toHaveLength(0);

    rl.close();
  });

  it('re-run detection with start-fresh falls through to full wizard', async () => {
    // Create existing config so re-run menu shows
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'config.yaml'), 'username: test\n');

    const { rl, output } = createMockRL([
      '5', // Start fresh
      // Then full wizard:
      '1', // Runtime: CLI
      '4', // Channels: none
      '3', // Voice: none
      'Assistant',
      'User',
      'UTC',
      'n',
    ]);

    const result = await runSetupWizard({
      configDir,
      dataDir,
      rl,
      output,
    });

    expect(result.success).toBe(true);
    expect(result.sections.length).toBeGreaterThan(0);

    rl.close();
  });

  it('writes voice config when whisper_cpp is selected', async () => {
    const { rl, output } = createMockRL([
      '1', // Runtime: CLI
      '4', // No channels
      '2', // whisper.cpp
      'Test Agent',
      'Test User',
      'UTC',
      'n',
    ]);

    const result = await runSetupWizard({
      configDir,
      dataDir,
      rl,
      output,
      skipModelDownload: true,
    });

    expect(result.success).toBe(true);

    const configContent = fs.readFileSync(path.join(configDir, 'config.yaml'), 'utf-8');
    expect(configContent).toContain('enabled: true');
    expect(configContent).toContain('provider: whisper_cpp');

    rl.close();
  });

  it('writes voice config and stores OpenAI key in credential vault', async () => {
    const { rl, output } = createMockRL([
      '1', // Runtime: CLI
      '4', // No channels
      '1', // OpenAI Whisper API
      'sk-test-openai-key', // API key
      'Test Agent',
      'Test User',
      'UTC',
      'n',
    ]);

    const result = await runSetupWizard({
      configDir,
      dataDir,
      rl,
      output,
    });

    expect(result.success).toBe(true);

    // Config should contain provider but NOT the API key (key is in vault)
    const configContent = fs.readFileSync(path.join(configDir, 'config.yaml'), 'utf-8');
    expect(configContent).toContain('enabled: true');
    expect(configContent).toContain('provider: openai_whisper');
    expect(configContent).not.toContain('openaiApiKey');
    expect(configContent).not.toContain('sk-test-openai-key');

    // Credential vault should exist with the OpenAI key
    const secretsDir = path.join(configDir, 'secrets');
    expect(fs.existsSync(path.join(secretsDir, 'credentials.enc'))).toBe(true);
    expect(fs.existsSync(path.join(secretsDir, 'credentials.key'))).toBe(true);

    rl.close();
  });

  it('writes SDK runtime to config when selected', async () => {
    const { rl, output } = createMockRL([
      '2', // SDK runtime
      '4', // No channels
      '3', // No voice
      'Research aide',
      'Researcher',
      'US/Pacific',
      'n',
    ]);

    const result = await runSetupWizard({
      configDir,
      dataDir,
      rl,
      output,
    });

    expect(result.success).toBe(true);

    const configContent = fs.readFileSync(path.join(configDir, 'config.yaml'), 'utf-8');
    expect(configContent).toContain('sdk');

    rl.close();
  });

  it('stores identity in config', async () => {
    const { rl, output } = createMockRL([
      '1', // Runtime: CLI
      '4', // No channels
      '3', // No voice
      'Executive assistant',
      'Jane Doe',
      'Europe/London',
      'n',
    ]);

    const result = await runSetupWizard({
      configDir,
      dataDir,
      rl,
      output,
    });

    expect(result.success).toBe(true);

    const configContent = fs.readFileSync(path.join(configDir, 'config.yaml'), 'utf-8');
    expect(configContent).toContain('Executive assistant');
    expect(configContent).toContain('Jane Doe');
    expect(configContent).toContain('Europe/London');

    rl.close();
  });

  it('enables channel container when Telegram is configured', async () => {
    const { rl, output } = createMockRL([
      '1', // Runtime: CLI
      '1', // Telegram
      '123:ABC-test-token', // Bot token
      '12345678', // User ID
      '3', // No voice
      'Assistant',
      'User',
      'UTC',
      'n',
    ]);

    const result = await runSetupWizard({
      configDir,
      dataDir,
      rl,
      output,
    });

    expect(result.success).toBe(true);

    const configContent = fs.readFileSync(path.join(configDir, 'config.yaml'), 'utf-8');
    expect(configContent).toContain('channelContainer');
    expect(configContent).toContain('enabled: true');

    rl.close();
  });

  it('non-interactive mode writes config from flags', async () => {
    const outputChunks: string[] = [];
    const output = new Writable({
      write(chunk, _encoding, callback) {
        outputChunks.push(chunk.toString());
        callback();
      },
    });

    const result = await runSetupWizard({
      configDir,
      dataDir,
      output,
      noInteractive: true,
      flags: {
        'anthropic-key': 'sk-ant-test',
        runtime: 'cli',
        voice: 'none',
        'agent-role': 'Automated assistant',
        'user-name': 'Bot User',
        'user-timezone': 'UTC',
      },
    });

    expect(result.success).toBe(true);

    const configPath = path.join(configDir, 'config.yaml');
    expect(fs.existsSync(configPath)).toBe(true);

    const configContent = fs.readFileSync(configPath, 'utf-8');
    expect(configContent).toContain('Automated assistant');
    expect(configContent).toContain('Bot User');
  });

  it('derives username from USER env var and strips flowhelm- prefix', async () => {
    const origUser = process.env['USER'];
    process.env['USER'] = 'flowhelm-testuser';

    const { rl, output } = createMockRL(['1', '4', '3', 'Assist', 'User', 'UTC', 'n']);

    const result = await runSetupWizard({ configDir, dataDir, rl, output });
    expect(result.success).toBe(true);

    const configContent = fs.readFileSync(path.join(configDir, 'config.yaml'), 'utf-8');
    expect(configContent).toContain('testuser');
    expect(configContent).not.toContain('flowhelm-testuser');

    process.env['USER'] = origUser;
    rl.close();
  });

  describe('macOS platform detection in wizard', () => {
    const macPodmanPlatform: PlatformInfo = {
      os: 'darwin',
      runtime: 'podman',
      serviceManager: 'launchd',
      binaryPath: 'podman',
      version: '5.8.1',
    };

    const macAppleContainerPlatform: PlatformInfo = {
      os: 'darwin',
      runtime: 'apple_container',
      serviceManager: 'launchd',
      binaryPath: 'container',
      version: '1.0.0',
    };

    const linuxPlatform: PlatformInfo = {
      os: 'linux',
      runtime: 'podman',
      serviceManager: 'systemd',
      binaryPath: 'podman',
      version: '5.3.1',
    };

    it('shows Podman runtime info on macOS with Podman', async () => {
      const { rl, output, getOutput } = createMockRL(['1', '4', '3', 'Agent', 'User', 'UTC', 'n']);

      await runSetupWizard({
        configDir,
        dataDir,
        rl,
        output,
        platformInfoOverride: macPodmanPlatform,
      });

      const out = getOutput();
      expect(out).toContain('macOS');
      expect(out).toContain('Podman 5.8.1');
      expect(out).toContain('launchd');
      // Should NOT mention Apple Container
      expect(out).not.toContain('Apple Container');
      expect(out).not.toContain('IP forwarding');

      rl.close();
    });

    it('shows Apple Container runtime info on macOS Tahoe', async () => {
      const { rl, output, getOutput } = createMockRL(['1', '4', '3', 'Agent', 'User', 'UTC', 'n']);

      await runSetupWizard({
        configDir,
        dataDir,
        rl,
        output,
        platformInfoOverride: macAppleContainerPlatform,
      });

      const out = getOutput();
      expect(out).toContain('macOS');
      expect(out).toContain('Apple Container 1.0.0');
      expect(out).toContain('IP forwarding');

      rl.close();
    });

    it('shows Linux platform info on Linux', async () => {
      const { rl, output, getOutput } = createMockRL(['1', '4', '3', 'Agent', 'User', 'UTC', 'n']);

      await runSetupWizard({
        configDir,
        dataDir,
        rl,
        output,
        platformInfoOverride: linuxPlatform,
      });

      const out = getOutput();
      expect(out).toContain('Linux');
      expect(out).toContain('Podman 5.3.1');
      expect(out).toContain('systemd');
      // Should NOT mention Apple Container or Podman machine
      expect(out).not.toContain('Apple Container');
      expect(out).not.toContain('Podman machine');

      rl.close();
    });
  });

  it('WhatsApp option writes enabled to config', async () => {
    const { rl, output } = createMockRL([
      '1', // Runtime: CLI
      '2', // WhatsApp
      '3', // No voice
      'Agent',
      'User',
      'UTC',
      'n',
    ]);

    const result = await runSetupWizard({
      configDir,
      dataDir,
      rl,
      output,
    });

    expect(result.success).toBe(true);

    const configContent = fs.readFileSync(path.join(configDir, 'config.yaml'), 'utf-8');
    expect(configContent).toContain('whatsapp');

    rl.close();
  });
});
