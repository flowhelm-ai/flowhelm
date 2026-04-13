/**
 * Phase 18 tests: Platform detection and launchd service management.
 *
 * Tests macOS version detection, Apple Silicon detection, service manager
 * selection, launchd plist generation, and Apple Container network checks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateLaunchdPlist,
  installLaunchdService,
  removeLaunchdService,
  readLaunchdService,
} from '../src/admin/launchd-generator.js';
import {
  VMNET_SUBNET,
  VMNET_BRIDGE,
  VMNET_HOST_GATEWAY,
  generateNetworkSetupCommands,
  generateFirewallBlockCommand,
} from '../src/container/apple-network.js';

// ═══════════════════════════════════════════════════════════════════════════
// Launchd Generator
// ═══════════════════════════════════════════════════════════════════════════

describe('LaunchdGenerator', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'flowhelm-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('generateLaunchdPlist produces valid plist XML', () => {
    const plist = generateLaunchdPlist({
      username: 'stan',
      homeDir: '/Users/stan',
    });

    expect(plist.label).toBe('ai.flowhelm');
    expect(plist.plistPath).toBe('/Users/stan/Library/LaunchAgents/ai.flowhelm.plist');
    expect(plist.content).toContain('<?xml version="1.0"');
    expect(plist.content).toContain('<!DOCTYPE plist');
    expect(plist.content).toContain('<key>Label</key>');
    expect(plist.content).toContain('<string>ai.flowhelm</string>');
    expect(plist.content).toContain('<key>KeepAlive</key>');
    expect(plist.content).toContain('<true/>');
    expect(plist.content).toContain('<key>RunAtLoad</key>');
  });

  it('generateLaunchdPlist includes ProgramArguments with flowhelm start', () => {
    const plist = generateLaunchdPlist({
      username: 'stan',
      homeDir: '/Users/stan',
    });

    expect(plist.content).toContain('<key>ProgramArguments</key>');
    expect(plist.content).toContain('/usr/local/bin/flowhelm');
    expect(plist.content).toContain('<string>start</string>');
  });

  it('generateLaunchdPlist uses custom binary path', () => {
    const plist = generateLaunchdPlist({
      username: 'stan',
      homeDir: '/Users/stan',
      binaryPath: '/opt/homebrew/bin/flowhelm',
    });

    expect(plist.content).toContain('/opt/homebrew/bin/flowhelm');
  });

  it('generateLaunchdPlist includes environment variables', () => {
    const plist = generateLaunchdPlist({
      username: 'stan',
      homeDir: '/Users/stan',
    });

    expect(plist.content).toContain('<key>EnvironmentVariables</key>');
    expect(plist.content).toContain('<key>HOME</key>');
    expect(plist.content).toContain('<string>/Users/stan</string>');
    expect(plist.content).toContain('<key>FLOWHELM_CONFIG_DIR</key>');
    expect(plist.content).toContain('<string>/Users/stan/.flowhelm</string>');
    expect(plist.content).toContain('<key>NODE_ENV</key>');
    expect(plist.content).toContain('<string>production</string>');
  });

  it('generateLaunchdPlist includes agent runtime env when specified', () => {
    const plist = generateLaunchdPlist({
      username: 'stan',
      homeDir: '/Users/stan',
      agentRuntime: 'sdk',
    });

    expect(plist.content).toContain('<key>FLOWHELM_AGENT_RUNTIME</key>');
    expect(plist.content).toContain('<string>sdk</string>');
  });

  it('generateLaunchdPlist includes log paths', () => {
    const plist = generateLaunchdPlist({
      username: 'stan',
      homeDir: '/Users/stan',
    });

    expect(plist.content).toContain('<key>StandardOutPath</key>');
    expect(plist.content).toContain('/Users/stan/.flowhelm/logs/flowhelm.log');
    expect(plist.content).toContain('<key>StandardErrorPath</key>');
    expect(plist.content).toContain('/Users/stan/.flowhelm/logs/flowhelm.error.log');
  });

  it('generateLaunchdPlist includes WorkingDirectory', () => {
    const plist = generateLaunchdPlist({
      username: 'stan',
      homeDir: '/Users/stan',
    });

    expect(plist.content).toContain('<key>WorkingDirectory</key>');
    expect(plist.content).toContain('<string>/Users/stan</string>');
  });

  it('generateLaunchdPlist includes ThrottleInterval', () => {
    const plist = generateLaunchdPlist({
      username: 'stan',
      homeDir: '/Users/stan',
    });

    expect(plist.content).toContain('<key>ThrottleInterval</key>');
    expect(plist.content).toContain('<integer>5</integer>');
  });

  it('generateLaunchdPlist includes PATH with Homebrew', () => {
    const plist = generateLaunchdPlist({
      username: 'stan',
      homeDir: '/Users/stan',
    });

    expect(plist.content).toContain('/opt/homebrew/bin');
  });

  it('generateLaunchdPlist escapes XML special characters', () => {
    const plist = generateLaunchdPlist({
      username: 'stan',
      homeDir: '/Users/stan & <co>',
    });

    expect(plist.content).toContain('&amp;');
    expect(plist.content).toContain('&lt;co&gt;');
  });

  it('installLaunchdService writes plist file to disk', async () => {
    const plist = await installLaunchdService({
      username: 'stan',
      homeDir: tmpDir,
    });

    const expectedPath = join(tmpDir, 'Library', 'LaunchAgents', 'ai.flowhelm.plist');
    expect(plist.plistPath).toBe(expectedPath);

    const content = await readFile(expectedPath, 'utf-8');
    expect(content).toContain('<key>Label</key>');
  });

  it('installLaunchdService creates parent directories', async () => {
    await installLaunchdService({
      username: 'stan',
      homeDir: tmpDir,
    });

    // Verify directories were created
    await access(join(tmpDir, 'Library', 'LaunchAgents'));
    await access(join(tmpDir, '.flowhelm', 'logs'));
  });

  it('removeLaunchdService deletes plist file', async () => {
    await installLaunchdService({
      username: 'stan',
      homeDir: tmpDir,
    });

    await removeLaunchdService(tmpDir);

    const exists = await readLaunchdService(tmpDir);
    expect(exists).toBeNull();
  });

  it('removeLaunchdService is idempotent (no error on missing file)', async () => {
    // Should not throw
    await removeLaunchdService(tmpDir);
  });

  it('readLaunchdService returns content or null', async () => {
    // Before install
    expect(await readLaunchdService(tmpDir)).toBeNull();

    // After install
    await installLaunchdService({
      username: 'stan',
      homeDir: tmpDir,
    });
    const content = await readLaunchdService(tmpDir);
    expect(content).toContain('<key>Label</key>');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Apple Container Network
// ═══════════════════════════════════════════════════════════════════════════

describe('Apple Container Network', () => {
  it('VMNET_SUBNET is 192.168.64.0/24', () => {
    expect(VMNET_SUBNET).toBe('192.168.64.0/24');
  });

  it('VMNET_BRIDGE is bridge100', () => {
    expect(VMNET_BRIDGE).toBe('bridge100');
  });

  it('VMNET_HOST_GATEWAY is 192.168.64.1', () => {
    expect(VMNET_HOST_GATEWAY).toBe('192.168.64.1');
  });

  it('generateNetworkSetupCommands returns sysctl and pfctl commands', () => {
    const commands = generateNetworkSetupCommands();
    const joined = commands.join('\n');

    expect(joined).toContain('sysctl -w net.inet.ip.forwarding=1');
    expect(joined).toContain('/etc/sysctl.conf');
    expect(joined).toContain('pfctl');
    expect(joined).toContain('192.168.64.0/24');
    expect(joined).toContain('nat on en0');
  });

  it('generateFirewallBlockCommand blocks specified port', () => {
    const commands = generateFirewallBlockCommand(3001);
    const joined = commands.join('\n');

    expect(joined).toContain('block in on en0 proto tcp to any port 3001');
    expect(joined).toContain('/etc/pf.conf');
  });

  it('generateFirewallBlockCommand works with different ports', () => {
    const commands = generateFirewallBlockCommand(10255);
    const joined = commands.join('\n');

    expect(joined).toContain('port 10255');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Doctor macOS checks
// ═══════════════════════════════════════════════════════════════════════════

describe('Doctor macOS checks', () => {
  it('runDoctor with platformOverride=darwin includes macOS checks', async () => {
    // Import here to avoid side effects at module level
    const { runDoctor } = await import('../src/admin/doctor.js');
    const logs: string[] = [];

    const result = await runDoctor({
      log: (msg) => logs.push(msg),
      homeDir: '/tmp/nonexistent-flowhelm-test-dir',
      skipSystemChecks: true,
      platformOverride: 'darwin',
    });

    // When skipSystemChecks is true, macOS system checks are skipped
    // but the service file check should use macOS path
    const serviceCheck = result.checks.find((c) => c.name === 'Service file');
    expect(serviceCheck).toBeDefined();
    expect(serviceCheck!.message).toContain('launchd');
  });

  it('runDoctor with platformOverride=linux includes Linux checks', async () => {
    const { runDoctor } = await import('../src/admin/doctor.js');
    const logs: string[] = [];

    const result = await runDoctor({
      log: (msg) => logs.push(msg),
      homeDir: '/tmp/nonexistent-flowhelm-test-dir',
      skipSystemChecks: true,
      platformOverride: 'linux',
    });

    const serviceCheck = result.checks.find((c) => c.name === 'Service file');
    expect(serviceCheck).toBeDefined();
    expect(serviceCheck!.message).toContain('systemd');
  });
});
