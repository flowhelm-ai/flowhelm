/**
 * Tests for `flowhelm status` command.
 *
 * Uses platformInfoOverride to force Linux platform behavior so tests
 * work identically on both macOS and Linux CI.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getStatus, type StatusOptions } from '../src/admin/status.js';
import type { PlatformInfo } from '../src/container/platform.js';

function createMockExec(responses: Record<string, string>) {
  return vi.fn(async (cmd: string, args: string[]) => {
    const key = `${cmd} ${args.join(' ')}`;
    for (const [pattern, stdout] of Object.entries(responses)) {
      if (key.includes(pattern)) {
        return { stdout, stderr: '' };
      }
    }
    throw new Error(`Command not found: ${key}`);
  }) as unknown as StatusOptions['execFn'];
}

/** Force Linux platform info for deterministic test behavior. */
const linuxPlatform: PlatformInfo = {
  os: 'linux',
  runtime: 'podman',
  serviceManager: 'systemd',
  binaryPath: 'podman',
  version: '5.3.1',
};

describe('getStatus', () => {
  let logs: string[];
  let log: (msg: string) => void;

  beforeEach(() => {
    logs = [];
    log = (msg: string) => logs.push(msg);
  });

  it('returns version in status info', async () => {
    const exec = createMockExec({
      'systemctl --user is-active': 'unknown\n',
      'podman ps': '',
    });

    const status = await getStatus({ log, execFn: exec, platformInfoOverride: linuxPlatform });
    expect(status.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('detects active orchestrator', async () => {
    const exec = createMockExec({
      'systemctl --user is-active': 'active\n',
      'podman ps': '',
    });

    const status = await getStatus({ log, execFn: exec, platformInfoOverride: linuxPlatform });
    expect(status.orchestratorState).toBe('active');
  });

  it('detects inactive orchestrator', async () => {
    const exec = createMockExec({
      'systemctl --user is-active': 'inactive\n',
      'podman ps': '',
    });

    const status = await getStatus({ log, execFn: exec, platformInfoOverride: linuxPlatform });
    expect(status.orchestratorState).toBe('inactive');
  });

  it('returns unknown when systemctl fails', async () => {
    const exec = createMockExec({
      'podman ps': '',
    });

    const status = await getStatus({ log, execFn: exec, platformInfoOverride: linuxPlatform });
    expect(status.orchestratorState).toBe('unknown');
  });

  it('lists running containers', async () => {
    const exec = createMockExec({
      'systemctl --user is-active': 'active\n',
      'podman ps':
        'flowhelm-proxy-stan\tUp 2 hours\nflowhelm-db-stan\tUp 2 hours\nflowhelm-channel-stan\tExited (0)\n',
    });

    const status = await getStatus({ log, execFn: exec, platformInfoOverride: linuxPlatform });
    expect(status.containers).toHaveLength(3);
    expect(status.containers[0]).toEqual({
      name: 'flowhelm-proxy-stan',
      role: 'proxy',
      state: 'running',
    });
    expect(status.containers[1]).toEqual({
      name: 'flowhelm-db-stan',
      role: 'database',
      state: 'running',
    });
    expect(status.containers[2]).toEqual({
      name: 'flowhelm-channel-stan',
      role: 'channel',
      state: 'stopped',
    });
  });

  it('handles no containers', async () => {
    const exec = createMockExec({
      'systemctl --user is-active': 'active\n',
      'podman ps': '',
    });

    const status = await getStatus({ log, execFn: exec, platformInfoOverride: linuxPlatform });
    expect(status.containers).toHaveLength(0);
  });

  it('outputs JSON when --json flag is set', async () => {
    const exec = createMockExec({
      'systemctl --user is-active': 'active\n',
      'podman ps': '',
    });

    const status = await getStatus({
      log,
      json: true,
      execFn: exec,
      platformInfoOverride: linuxPlatform,
    });

    // The log should have received a JSON string
    expect(logs.length).toBe(1);
    const parsed = JSON.parse(logs[0]!) as typeof status;
    expect(parsed.version).toBe(status.version);
    expect(parsed.orchestratorState).toBe('active');
  });

  it('outputs human-readable format by default', async () => {
    const exec = createMockExec({
      'systemctl --user is-active': 'active\n',
      'podman ps': 'flowhelm-proxy-stan\tUp 1 hour\n',
    });

    await getStatus({ log, execFn: exec, platformInfoOverride: linuxPlatform });

    const output = logs.join('\n');
    expect(output).toContain('FlowHelm v');
    expect(output).toContain('Orchestrator: active');
    expect(output).toContain('flowhelm-proxy-stan');
  });

  it('shows platform and runtime info', async () => {
    const exec = createMockExec({
      'systemctl --user is-active': 'active\n',
      'podman ps': '',
    });

    const status = await getStatus({ log, execFn: exec, platformInfoOverride: linuxPlatform });

    expect(status.platform).toBe('Linux');
    expect(status.runtime).toBe('Podman');
  });

  it('shows macOS platform when override is darwin', async () => {
    const macosPlatform: PlatformInfo = {
      os: 'darwin',
      runtime: 'apple_container',
      serviceManager: 'launchd',
      binaryPath: 'container',
      version: '1.0.0',
    };
    const exec = createMockExec({
      'launchctl list': 'ai.flowhelm\t0\n',
      'container ls': '[]',
    });

    const status = await getStatus({ log, execFn: exec, platformInfoOverride: macosPlatform });

    expect(status.platform).toBe('macOS');
    expect(status.runtime).toBe('Apple Container');
    expect(status.orchestratorState).toBe('active');
  });
});
