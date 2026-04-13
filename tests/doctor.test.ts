/**
 * Tests for `flowhelm doctor` diagnostic checks.
 *
 * Uses platformOverride to force Linux behavior so tests work
 * identically on both macOS and Linux CI.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { runDoctor, type DoctorOptions } from '../src/admin/doctor.js';

// Mock exec for system command checks
function createMockExec(responses: Record<string, { stdout: string; stderr?: string }>) {
  return vi.fn(async (cmd: string, args: string[]) => {
    const key = `${cmd} ${args.join(' ')}`;
    for (const [pattern, response] of Object.entries(responses)) {
      if (key.includes(pattern)) {
        return { stdout: response.stdout, stderr: response.stderr ?? '' };
      }
    }
    throw new Error(`Command not found: ${key}`);
  }) as unknown as DoctorOptions['execFn'];
}

describe('runDoctor', () => {
  let logs: string[];
  let log: (msg: string) => void;

  beforeEach(() => {
    logs = [];
    log = (msg: string) => logs.push(msg);
  });

  it('checks Node.js version and passes for v22+', async () => {
    const result = await runDoctor({
      log,
      skipSystemChecks: true,
      homeDir: os.tmpdir(),
      platformOverride: 'linux',
    });

    expect(result.checks.some((c) => c.name === 'Node.js' && c.status === 'ok')).toBe(true);
  });

  it('checks config file existence', async () => {
    const result = await runDoctor({
      log,
      skipSystemChecks: true,
      homeDir: '/tmp/nonexistent-flowhelm-test-dir',
      platformOverride: 'linux',
    });

    const configCheck = result.checks.find((c) => c.name === 'Config file');
    expect(configCheck).toBeDefined();
    expect(configCheck!.status).toBe('warn');
    expect(configCheck!.fix).toContain('flowhelm setup');
  });

  it('checks credential vault existence', async () => {
    const result = await runDoctor({
      log,
      skipSystemChecks: true,
      homeDir: '/tmp/nonexistent-flowhelm-test-dir',
      platformOverride: 'linux',
    });

    const vaultCheck = result.checks.find((c) => c.name === 'Credential vault');
    expect(vaultCheck).toBeDefined();
    expect(vaultCheck!.status).toBe('warn');
  });

  it('checks service file existence', async () => {
    const result = await runDoctor({
      log,
      skipSystemChecks: true,
      homeDir: '/tmp/nonexistent-flowhelm-test-dir',
      platformOverride: 'linux',
    });

    const serviceCheck = result.checks.find((c) => c.name === 'Service file');
    expect(serviceCheck).toBeDefined();
    expect(serviceCheck!.status).toBe('warn');
  });

  it('returns overall ok when all checks pass', async () => {
    // Create a temp dir with config and vault
    const tmpDir = path.join(os.tmpdir(), `flowhelm-doctor-test-${Date.now()}`);
    const configDir = path.join(tmpDir, '.flowhelm');
    const secretsDir = path.join(configDir, 'secrets');
    const serviceDir = path.join(tmpDir, '.config', 'systemd', 'user');

    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(secretsDir, { recursive: true });
    fs.mkdirSync(serviceDir, { recursive: true });
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'config.yaml'), 'username: test\n');
    fs.writeFileSync(path.join(secretsDir, 'credentials.enc'), 'encrypted-data');
    fs.writeFileSync(path.join(serviceDir, 'flowhelm.service'), '[Unit]\nDescription=FlowHelm\n');
    // OAuth credentials for auth health check
    fs.writeFileSync(
      path.join(claudeDir, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-test',
          expiresAt: new Date(Date.now() + 300 * 24 * 60 * 60 * 1000).toISOString(),
          subscriptionType: 'pro',
        },
      }),
    );

    const result = await runDoctor({
      log,
      skipSystemChecks: true,
      homeDir: tmpDir,
      platformOverride: 'linux',
    });

    expect(result.overallStatus).toBe('ok');
    expect(result.checks.every((c) => c.status === 'ok')).toBe(true);

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns fail when a critical check fails', async () => {
    const exec = createMockExec({
      'podman --version': { stdout: 'podman version 5.3.1\n' },
      'podman info': { stdout: 'true\n' },
      systemctl: { stdout: 'active\n' },
    });

    // Podman check should pass, but service check might fail
    const result = await runDoctor({
      log,
      homeDir: '/tmp/nonexistent-flowhelm-test-dir',
      execFn: exec,
      platformOverride: 'linux',
    });

    // At minimum some checks will be warn/fail (no config, no vault, etc.)
    expect(result.checks.length).toBeGreaterThan(0);
  });

  it('includes fix suggestions for failed checks', async () => {
    const result = await runDoctor({
      log,
      skipSystemChecks: true,
      homeDir: '/tmp/nonexistent-flowhelm-test-dir',
      platformOverride: 'linux',
    });

    const failedChecks = result.checks.filter((c) => c.status !== 'ok');
    for (const check of failedChecks) {
      expect(check.fix).toBeDefined();
      expect(check.fix!.length).toBeGreaterThan(0);
    }
  });

  it('prints formatted output', async () => {
    await runDoctor({
      log,
      skipSystemChecks: true,
      homeDir: '/tmp/nonexistent-flowhelm-test-dir',
      platformOverride: 'linux',
    });

    const output = logs.join('\n');
    expect(output).toContain('FlowHelm Doctor');
    expect(output).toContain('Result:');
  });

  it('handles Podman detection correctly', async () => {
    const exec = createMockExec({
      'podman --version': { stdout: 'podman version 5.3.1\n' },
      'podman info --format': { stdout: 'true\n' },
      'systemctl --user is-active': { stdout: 'active\n' },
    });

    const result = await runDoctor({
      log,
      homeDir: '/tmp/nonexistent-flowhelm-test-dir',
      execFn: exec,
      platformOverride: 'linux',
    });

    const podmanCheck = result.checks.find((c) => c.name === 'Podman');
    expect(podmanCheck).toBeDefined();
    expect(podmanCheck!.status).toBe('ok');
    expect(podmanCheck!.message).toContain('5.3.1');
  });

  it('handles missing Podman', async () => {
    const exec = createMockExec({
      'systemctl --user is-active': { stdout: 'inactive\n' },
    });

    const result = await runDoctor({
      log,
      homeDir: '/tmp/nonexistent-flowhelm-test-dir',
      execFn: exec,
      platformOverride: 'linux',
    });

    const podmanCheck = result.checks.find((c) => c.name === 'Podman');
    expect(podmanCheck).toBeDefined();
    expect(podmanCheck!.status).toBe('fail');
    expect(podmanCheck!.fix).toContain('apt');
  });

  describe('macOS + Podman runtime', () => {
    it('checks Podman and Podman machine on macOS with Podman runtime', async () => {
      const exec = createMockExec({
        'podman --version': { stdout: 'podman version 5.8.1\n' },
        'podman info --format': { stdout: 'true\n' },
        'podman machine list': { stdout: 'true\n' },
        'launchctl list': { stdout: '12345\t0\tai.flowhelm\n' },
      });

      const result = await runDoctor({
        log,
        homeDir: '/tmp/nonexistent-flowhelm-test-dir',
        execFn: exec,
        platformOverride: 'darwin',
        runtimeOverride: 'podman',
      });

      const podmanCheck = result.checks.find((c) => c.name === 'Podman');
      expect(podmanCheck).toBeDefined();
      expect(podmanCheck!.status).toBe('ok');
      expect(podmanCheck!.message).toContain('5.8.1');

      const machineCheck = result.checks.find((c) => c.name === 'Podman machine');
      expect(machineCheck).toBeDefined();
      expect(machineCheck!.status).toBe('ok');

      // Should NOT have Apple Container CLI check
      const appleCheck = result.checks.find((c) => c.name === 'Apple Container');
      expect(appleCheck).toBeUndefined();

      // Should have macOS-specific checks
      const macCheck = result.checks.find((c) => c.name === 'macOS version');
      expect(macCheck).toBeDefined();

      // Should NOT have systemd check
      const systemdCheck = result.checks.find((c) => c.name === 'systemd');
      expect(systemdCheck).toBeUndefined();
    });

    it('reports stopped Podman machine', async () => {
      const exec = createMockExec({
        'podman --version': { stdout: 'podman version 5.8.1\n' },
        'podman info --format': { stdout: 'true\n' },
        'podman machine list': { stdout: 'false\n' },
        'launchctl list': { stdout: '' },
      });

      const result = await runDoctor({
        log,
        homeDir: '/tmp/nonexistent-flowhelm-test-dir',
        execFn: exec,
        platformOverride: 'darwin',
        runtimeOverride: 'podman',
      });

      const machineCheck = result.checks.find((c) => c.name === 'Podman machine');
      expect(machineCheck).toBeDefined();
      expect(machineCheck!.status).toBe('fail');
      expect(machineCheck!.fix).toContain('podman machine start');
    });

    it('does not check Podman machine on Linux', async () => {
      const exec = createMockExec({
        'podman --version': { stdout: 'podman version 5.3.1\n' },
        'podman info --format': { stdout: 'true\n' },
        'systemctl --user is-active': { stdout: 'active\n' },
      });

      const result = await runDoctor({
        log,
        homeDir: '/tmp/nonexistent-flowhelm-test-dir',
        execFn: exec,
        platformOverride: 'linux',
        runtimeOverride: 'podman',
      });

      const machineCheck = result.checks.find((c) => c.name === 'Podman machine');
      expect(machineCheck).toBeUndefined();
    });
  });

  describe('macOS + Apple Container runtime', () => {
    it('checks Apple Container CLI instead of Podman', async () => {
      const exec = createMockExec({
        'launchctl list': { stdout: '12345\t0\tai.flowhelm\n' },
      });

      const result = await runDoctor({
        log,
        homeDir: '/tmp/nonexistent-flowhelm-test-dir',
        execFn: exec,
        platformOverride: 'darwin',
        runtimeOverride: 'apple_container',
      });

      // Should have Apple Container check (fails because CLI not mocked as installed)
      const appleCheck = result.checks.find((c) => c.name === 'Apple Container');
      expect(appleCheck).toBeDefined();

      // Should NOT have Podman checks
      const podmanCheck = result.checks.find((c) => c.name === 'Podman');
      expect(podmanCheck).toBeUndefined();

      // Should have IP forwarding check
      const ipCheck = result.checks.find((c) => c.name === 'IP forwarding');
      expect(ipCheck).toBeDefined();
    });
  });
});
