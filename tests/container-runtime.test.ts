/**
 * Phase 2 tests: Container Runtime Abstraction.
 *
 * Tests command building, output parsing, resource limits, platform detection,
 * lifecycle management, and Apple Container stub. Uses injectable command
 * executor — no real Podman binary needed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CommandResult, ContainerConfig } from '../src/orchestrator/types.js';
import { PodmanRuntime } from '../src/container/podman-runtime.js';
import { AppleContainerRuntime } from '../src/container/apple-runtime.js';
import {
  validateMemoryLimit,
  validateCpuLimit,
  validatePidsLimit,
  buildResourceLimitArgs,
} from '../src/container/resource-limits.js';
import { ContainerLifecycleManager, NAMING } from '../src/container/lifecycle.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Create a mock command executor. Uses vitest's mock.calls for call tracking. */
function createMockExecutor() {
  const executor = vi.fn(async (_cmd: string, _args: string[]): Promise<CommandResult> => {
    return { stdout: '', stderr: '' };
  });

  /** Helper: get the args from the Nth call (0-indexed). */
  function callArgs(n: number): string[] {
    return executor.mock.calls[n]?.[1] as string[];
  }

  /** Helper: get {cmd, args} from the Nth call. */
  function call(n: number): { cmd: string; args: string[] } {
    const c = executor.mock.calls[n];
    return { cmd: c?.[0] as string, args: c?.[1] as string[] };
  }

  return { executor, callArgs, call };
}

/** Build a minimal ContainerConfig for testing. */
function minimalConfig(overrides?: Partial<ContainerConfig>): ContainerConfig {
  return {
    name: 'flowhelm-agent-stan-abc123',
    image: 'flowhelm-agent:latest',
    memoryLimit: '512m',
    cpuLimit: '1.0',
    pidsLimit: 256,
    readOnly: true,
    mounts: [],
    tmpfs: [],
    env: {},
    network: 'flowhelm-network-stan',
    securityOpts: [],
    ...overrides,
  };
}

// ─── Resource Limits ─────────────────────────────────────────────────────────

describe('Resource Limits', () => {
  describe('validateMemoryLimit', () => {
    it('accepts valid memory strings', () => {
      expect(validateMemoryLimit('512m')).toBe(true);
      expect(validateMemoryLimit('2g')).toBe(true);
      expect(validateMemoryLimit('1024k')).toBe(true);
      expect(validateMemoryLimit('1073741824')).toBe(true);
      expect(validateMemoryLimit('64M')).toBe(true);
    });

    it('rejects invalid memory strings', () => {
      expect(validateMemoryLimit('')).toBe(false);
      expect(validateMemoryLimit('abc')).toBe(false);
      expect(validateMemoryLimit('512mb')).toBe(false);
      expect(validateMemoryLimit('-512m')).toBe(false);
    });
  });

  describe('validateCpuLimit', () => {
    it('accepts valid CPU limits', () => {
      expect(validateCpuLimit('0.5')).toBe(true);
      expect(validateCpuLimit('1.0')).toBe(true);
      expect(validateCpuLimit('2')).toBe(true);
      expect(validateCpuLimit('0.25')).toBe(true);
    });

    it('rejects invalid CPU limits', () => {
      expect(validateCpuLimit('0')).toBe(false);
      expect(validateCpuLimit('-1')).toBe(false);
      expect(validateCpuLimit('abc')).toBe(false);
      expect(validateCpuLimit('200')).toBe(false);
    });
  });

  describe('validatePidsLimit', () => {
    it('accepts valid PID limits', () => {
      expect(validatePidsLimit(1)).toBe(true);
      expect(validatePidsLimit(256)).toBe(true);
      expect(validatePidsLimit(32768)).toBe(true);
    });

    it('rejects invalid PID limits', () => {
      expect(validatePidsLimit(0)).toBe(false);
      expect(validatePidsLimit(-1)).toBe(false);
      expect(validatePidsLimit(99999)).toBe(false);
      expect(validatePidsLimit(1.5)).toBe(false);
    });
  });

  describe('buildResourceLimitArgs', () => {
    it('builds correct flags', () => {
      const args = buildResourceLimitArgs({
        memoryLimit: '512m',
        cpuLimit: '1.0',
        pidsLimit: 256,
      });
      expect(args).toEqual(['--memory', '512m', '--cpus', '1.0', '--pids-limit', '256']);
    });

    it('throws on invalid memory', () => {
      expect(() =>
        buildResourceLimitArgs({ memoryLimit: 'bad', cpuLimit: '1.0', pidsLimit: 256 }),
      ).toThrow('Invalid memory limit');
    });

    it('throws on invalid CPU', () => {
      expect(() =>
        buildResourceLimitArgs({ memoryLimit: '512m', cpuLimit: '0', pidsLimit: 256 }),
      ).toThrow('Invalid CPU limit');
    });

    it('throws on invalid PIDs', () => {
      expect(() =>
        buildResourceLimitArgs({ memoryLimit: '512m', cpuLimit: '1.0', pidsLimit: -1 }),
      ).toThrow('Invalid PIDs limit');
    });
  });
});

// ─── PodmanRuntime: Command Building ─────────────────────────────────────────

describe('PodmanRuntime', () => {
  describe('buildCreateArgs', () => {
    it('builds minimal create command', () => {
      const runtime = new PodmanRuntime();
      const args = runtime.buildCreateArgs(minimalConfig());

      expect(args[0]).toBe('create');
      expect(args).toContain('--name');
      expect(args).toContain('flowhelm-agent-stan-abc123');
      expect(args).toContain('--memory');
      expect(args).toContain('512m');
      expect(args).toContain('--cpus');
      expect(args).toContain('1.0');
      expect(args).toContain('--pids-limit');
      expect(args).toContain('256');
      expect(args).toContain('--read-only');
      expect(args).toContain('--network');
      expect(args).toContain('flowhelm-network-stan');
      // Image is near the end
      expect(args).toContain('flowhelm-agent:latest');
    });

    it('includes volume mounts with correct format', () => {
      const runtime = new PodmanRuntime();
      const args = runtime.buildCreateArgs(
        minimalConfig({
          mounts: [
            {
              source: '/home/stan/.flowhelm/agent',
              target: '/workspace',
              readOnly: false,
              selinuxLabel: 'Z',
            },
            { source: '/home/stan/.flowhelm/memory', target: '/memory', readOnly: true },
          ],
        }),
      );

      expect(args).toContain('--volume');
      expect(args).toContain('/home/stan/.flowhelm/agent:/workspace:Z');
      expect(args).toContain('/home/stan/.flowhelm/memory:/memory:ro');
    });

    it('includes read-only mount with SELinux label', () => {
      const runtime = new PodmanRuntime();
      const args = runtime.buildCreateArgs(
        minimalConfig({
          mounts: [{ source: '/data', target: '/data', readOnly: true, selinuxLabel: 'Z' }],
        }),
      );

      expect(args).toContain('/data:/data:ro,Z');
    });

    it('includes tmpfs mounts', () => {
      const runtime = new PodmanRuntime();
      const args = runtime.buildCreateArgs(
        minimalConfig({
          tmpfs: [{ target: '/tmp', size: '500m' }],
        }),
      );

      expect(args).toContain('--tmpfs');
      expect(args).toContain('/tmp:size=500m');
    });

    it('includes environment variables', () => {
      const runtime = new PodmanRuntime();
      const args = runtime.buildCreateArgs(
        minimalConfig({
          env: { ANTHROPIC_API_KEY: 'sk-test', NODE_ENV: 'production' },
        }),
      );

      expect(args).toContain('--env');
      expect(args).toContain('ANTHROPIC_API_KEY=sk-test');
      expect(args).toContain('NODE_ENV=production');
    });

    it('includes security options', () => {
      const runtime = new PodmanRuntime();
      const args = runtime.buildCreateArgs(
        minimalConfig({
          securityOpts: ['no-new-privileges', 'label=type:container_runtime_t'],
        }),
      );

      expect(args).toContain('--security-opt');
      expect(args).toContain('no-new-privileges');
      expect(args).toContain('label=type:container_runtime_t');
    });

    it('includes user namespace mapping', () => {
      const runtime = new PodmanRuntime();
      const args = runtime.buildCreateArgs(minimalConfig({ userNamespace: 'auto' }));

      expect(args).toContain('--userns');
      expect(args).toContain('auto');
    });

    it('includes working directory', () => {
      const runtime = new PodmanRuntime();
      const args = runtime.buildCreateArgs(minimalConfig({ workDir: '/workspace' }));

      expect(args).toContain('--workdir');
      expect(args).toContain('/workspace');
    });

    it('includes command override', () => {
      const runtime = new PodmanRuntime();
      const args = runtime.buildCreateArgs(minimalConfig({ command: ['node', 'index.js'] }));

      // Command comes after the image
      const imageIdx = args.indexOf('flowhelm-agent:latest');
      expect(args[imageIdx + 1]).toBe('node');
      expect(args[imageIdx + 2]).toBe('index.js');
    });

    it('omits --read-only when readOnly is false', () => {
      const runtime = new PodmanRuntime();
      const args = runtime.buildCreateArgs(minimalConfig({ readOnly: false }));

      expect(args).not.toContain('--read-only');
    });

    it('builds a complete production-like config', () => {
      const runtime = new PodmanRuntime();
      const args = runtime.buildCreateArgs({
        name: 'flowhelm-agent-stan-task42',
        image: 'flowhelm-agent:latest',
        memoryLimit: '1g',
        cpuLimit: '2.0',
        pidsLimit: 256,
        readOnly: true,
        mounts: [
          {
            source: '/home/flowhelm-stan/.flowhelm/agent',
            target: '/workspace',
            readOnly: false,
            selinuxLabel: 'Z',
          },
        ],
        tmpfs: [{ target: '/tmp', size: '500m' }],
        env: { HTTPS_PROXY: 'http://flowhelm-proxy-stan:10255' },
        network: 'flowhelm-network-stan',
        securityOpts: ['no-new-privileges'],
        userNamespace: 'auto',
        workDir: '/workspace',
      });

      // Verify key flags are present
      expect(args).toContain('--userns');
      expect(args).toContain('--read-only');
      expect(args).toContain('--security-opt');
      expect(args).toContain('--tmpfs');
      expect(args).toContain('--network');
    });
  });

  // ── Container Lifecycle ──────────────────────────────────────────────────

  describe('create', () => {
    it('returns container ID from stdout', async () => {
      const { executor, callArgs } = createMockExecutor();
      executor.mockResolvedValueOnce({ stdout: 'abc123def456\n', stderr: '' });
      const runtime = new PodmanRuntime({ executor });

      const id = await runtime.create(minimalConfig());

      expect(id).toBe('abc123def456');
      expect(callArgs(0)[0]).toBe('create');
    });
  });

  describe('start', () => {
    it('calls podman start with container ID', async () => {
      const { executor, call } = createMockExecutor();
      const runtime = new PodmanRuntime({ executor });

      await runtime.start('abc123');

      expect(call(0)).toEqual({ cmd: 'podman', args: ['start', 'abc123'] });
    });
  });

  describe('stop', () => {
    it('calls podman stop with timeout', async () => {
      const { executor, call } = createMockExecutor();
      const runtime = new PodmanRuntime({ executor });

      await runtime.stop('abc123', 5);

      expect(call(0)).toEqual({ cmd: 'podman', args: ['stop', '-t', '5', 'abc123'] });
    });

    it('uses default timeout of 10', async () => {
      const { executor, callArgs } = createMockExecutor();
      const runtime = new PodmanRuntime({ executor });

      await runtime.stop('abc123');

      expect(callArgs(0)).toContain('10');
    });
  });

  describe('remove', () => {
    it('calls podman rm -f', async () => {
      const { executor, call } = createMockExecutor();
      const runtime = new PodmanRuntime({ executor });

      await runtime.remove('abc123');

      expect(call(0)).toEqual({ cmd: 'podman', args: ['rm', '-f', 'abc123'] });
    });
  });

  describe('exec', () => {
    it('returns stdout/stderr/exitCode on success', async () => {
      const { executor } = createMockExecutor();
      executor.mockResolvedValueOnce({ stdout: 'hello\n', stderr: '' });
      const runtime = new PodmanRuntime({ executor });

      const result = await runtime.exec('abc123', ['echo', 'hello']);

      expect(result).toEqual({ stdout: 'hello\n', stderr: '', exitCode: 0 });
    });

    it('returns error details on failure', async () => {
      const { executor } = createMockExecutor();
      const err = new Error('command not found') as Error & {
        stdout: string;
        stderr: string;
        code: number;
      };
      err.stdout = '';
      err.stderr = 'bash: bad: not found';
      err.code = 127;
      executor.mockRejectedValueOnce(err);
      const runtime = new PodmanRuntime({ executor });

      const result = await runtime.exec('abc123', ['bad']);

      expect(result.exitCode).toBe(127);
      expect(result.stderr).toContain('not found');
    });
  });

  describe('logs', () => {
    it('returns container logs', async () => {
      const { executor } = createMockExecutor();
      executor.mockResolvedValueOnce({ stdout: 'log line 1\nlog line 2\n', stderr: '' });
      const runtime = new PodmanRuntime({ executor });

      const output = await runtime.logs('abc123');

      expect(output).toBe('log line 1\nlog line 2\n');
    });

    it('passes --tail flag when specified', async () => {
      const { executor, callArgs } = createMockExecutor();
      const runtime = new PodmanRuntime({ executor });

      await runtime.logs('abc123', 50);

      expect(callArgs(0)).toContain('--tail');
      expect(callArgs(0)).toContain('50');
    });
  });

  describe('isHealthy', () => {
    it('returns true when container is running', async () => {
      const { executor } = createMockExecutor();
      executor.mockResolvedValueOnce({ stdout: 'true\n', stderr: '' });
      const runtime = new PodmanRuntime({ executor });

      expect(await runtime.isHealthy('abc123')).toBe(true);
    });

    it('returns false when container is not running', async () => {
      const { executor } = createMockExecutor();
      executor.mockResolvedValueOnce({ stdout: 'false\n', stderr: '' });
      const runtime = new PodmanRuntime({ executor });

      expect(await runtime.isHealthy('abc123')).toBe(false);
    });

    it('returns false when inspect fails', async () => {
      const { executor } = createMockExecutor();
      executor.mockRejectedValueOnce(new Error('no such container'));
      const runtime = new PodmanRuntime({ executor });

      expect(await runtime.isHealthy('nonexistent')).toBe(false);
    });
  });

  // ── Container Queries ────────────────────────────────────────────────────

  describe('exists', () => {
    it('returns true when container exists', async () => {
      const { executor } = createMockExecutor();
      executor.mockResolvedValueOnce({ stdout: '', stderr: '' });
      const runtime = new PodmanRuntime({ executor });

      expect(await runtime.exists('abc123')).toBe(true);
    });

    it('returns false when container does not exist', async () => {
      const { executor } = createMockExecutor();
      executor.mockRejectedValueOnce(new Error('no such container'));
      const runtime = new PodmanRuntime({ executor });

      expect(await runtime.exists('nonexistent')).toBe(false);
    });
  });

  describe('list', () => {
    it('parses Podman JSON output', async () => {
      const { executor } = createMockExecutor();
      executor.mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            Id: 'abc123',
            Names: ['flowhelm-agent-stan-task1'],
            Image: 'flowhelm-agent:latest',
            State: 'running',
            Created: '2026-04-04T10:00:00Z',
          },
        ]),
        stderr: '',
      });
      const runtime = new PodmanRuntime({ executor });

      const containers = await runtime.list();

      expect(containers).toHaveLength(1);
      expect(containers[0]).toEqual({
        id: 'abc123',
        name: 'flowhelm-agent-stan-task1',
        image: 'flowhelm-agent:latest',
        state: 'running',
        createdAt: expect.any(Number) as number,
      });
    });

    it('returns empty array on empty output', async () => {
      const { executor } = createMockExecutor();
      executor.mockResolvedValueOnce({ stdout: '', stderr: '' });
      const runtime = new PodmanRuntime({ executor });

      expect(await runtime.list()).toEqual([]);
    });

    it('applies name prefix filter', async () => {
      const { executor, callArgs } = createMockExecutor();
      executor.mockResolvedValueOnce({ stdout: '[]', stderr: '' });
      const runtime = new PodmanRuntime({ executor });

      await runtime.list({ namePrefix: 'flowhelm-agent-stan' });

      const filterArgs = callArgs(0).filter((a: string) => a.startsWith('name='));
      expect(filterArgs[0]).toBe('name=^flowhelm-agent-stan');
    });

    it('applies state filter', async () => {
      const { executor, callArgs } = createMockExecutor();
      executor.mockResolvedValueOnce({ stdout: '[]', stderr: '' });
      const runtime = new PodmanRuntime({ executor });

      await runtime.list({ state: 'running' });

      const filterArgs = callArgs(0).filter((a: string) => a.startsWith('status='));
      expect(filterArgs[0]).toBe('status=running');
    });
  });

  // ── Network Operations ───────────────────────────────────────────────────

  describe('network operations', () => {
    it('createNetwork calls podman network create', async () => {
      const { executor, call } = createMockExecutor();
      const runtime = new PodmanRuntime({ executor });

      await runtime.createNetwork('flowhelm-network-stan');

      expect(call(0)).toEqual({
        cmd: 'podman',
        args: ['network', 'create', 'flowhelm-network-stan'],
      });
    });

    it('removeNetwork calls podman network rm -f', async () => {
      const { executor, call } = createMockExecutor();
      const runtime = new PodmanRuntime({ executor });

      await runtime.removeNetwork('flowhelm-network-stan');

      expect(call(0)).toEqual({
        cmd: 'podman',
        args: ['network', 'rm', '-f', 'flowhelm-network-stan'],
      });
    });

    it('networkExists returns true when network exists', async () => {
      const { executor } = createMockExecutor();
      executor.mockResolvedValueOnce({ stdout: '', stderr: '' });
      const runtime = new PodmanRuntime({ executor });

      expect(await runtime.networkExists('flowhelm-network-stan')).toBe(true);
    });

    it('networkExists returns false when network does not exist', async () => {
      const { executor } = createMockExecutor();
      executor.mockRejectedValueOnce(new Error('no such network'));
      const runtime = new PodmanRuntime({ executor });

      expect(await runtime.networkExists('nonexistent')).toBe(false);
    });
  });

  // ── Image Operations ─────────────────────────────────────────────────────

  describe('image operations', () => {
    it('imageExists returns true when image exists', async () => {
      const { executor } = createMockExecutor();
      executor.mockResolvedValueOnce({ stdout: '', stderr: '' });
      const runtime = new PodmanRuntime({ executor });

      expect(await runtime.imageExists('flowhelm-agent:latest')).toBe(true);
    });

    it('imageExists returns false when image does not exist', async () => {
      const { executor } = createMockExecutor();
      executor.mockRejectedValueOnce(new Error('image not found'));
      const runtime = new PodmanRuntime({ executor });

      expect(await runtime.imageExists('nonexistent:latest')).toBe(false);
    });
  });
});

// ─── Naming Conventions ──────────────────────────────────────────────────────

describe('NAMING', () => {
  it('generates correct agent container name', () => {
    expect(NAMING.agentContainer('stan', 'task42')).toBe('flowhelm-agent-stan-task42');
  });

  it('generates correct proxy container name', () => {
    expect(NAMING.proxyContainer('stan')).toBe('flowhelm-proxy-stan');
  });

  it('generates correct network name', () => {
    expect(NAMING.network('stan')).toBe('flowhelm-network-stan');
  });
});

// ─── ContainerLifecycleManager ───────────────────────────────────────────────

describe('ContainerLifecycleManager', () => {
  let mockExecutor: ReturnType<typeof createMockExecutor>;
  let runtime: PodmanRuntime;
  let lifecycle: ContainerLifecycleManager;

  beforeEach(() => {
    mockExecutor = createMockExecutor();
    runtime = new PodmanRuntime({ executor: mockExecutor.executor });
    lifecycle = new ContainerLifecycleManager({
      runtime,
      username: 'stan',
      drainTimeout: 5,
    });
  });

  describe('ensureNetwork', () => {
    it('creates network if it does not exist', async () => {
      // networkExists returns false (rejects)
      mockExecutor.executor.mockRejectedValueOnce(new Error('no such network'));
      // createNetwork succeeds
      mockExecutor.executor.mockResolvedValueOnce({ stdout: '', stderr: '' });

      await lifecycle.ensureNetwork();

      expect(mockExecutor.executor).toHaveBeenCalledTimes(2);
      expect(mockExecutor.executor.mock.calls[1]?.[1]).toEqual([
        'network',
        'create',
        'flowhelm-network-stan',
      ]);
    });

    it('skips creation if network already exists', async () => {
      // networkExists returns true (resolves)
      mockExecutor.executor.mockResolvedValueOnce({ stdout: '', stderr: '' });

      await lifecycle.ensureNetwork();

      expect(mockExecutor.executor).toHaveBeenCalledTimes(1);
      expect(mockExecutor.executor.mock.calls[0]?.[1]).toEqual([
        'network',
        'exists',
        'flowhelm-network-stan',
      ]);
    });
  });

  describe('cleanupOrphans', () => {
    it('removes non-running containers matching the user prefix', async () => {
      mockExecutor.executor.mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            Id: 'orphan1',
            Names: ['flowhelm-agent-stan-old1'],
            Image: 'img',
            State: 'exited',
            Created: '2026-04-04T10:00:00Z',
          },
          {
            Id: 'orphan2',
            Names: ['flowhelm-agent-stan-old2'],
            Image: 'img',
            State: 'created',
            Created: '2026-04-04T10:00:00Z',
          },
          {
            Id: 'running1',
            Names: ['flowhelm-agent-stan-active'],
            Image: 'img',
            State: 'running',
            Created: '2026-04-04T10:00:00Z',
          },
        ]),
        stderr: '',
      });
      // rm calls for the non-running ones
      mockExecutor.executor.mockResolvedValue({ stdout: '', stderr: '' });

      await lifecycle.cleanupOrphans();

      // list call + 2 rm calls
      const allCalls = mockExecutor.executor.mock.calls;
      const rmCalls = allCalls.filter((c) => (c[1] as string[])[0] === 'rm');
      expect(rmCalls).toHaveLength(2);
      expect((rmCalls[0]?.[1] as string[])[2]).toBe('orphan1');
      expect((rmCalls[1]?.[1] as string[])[2]).toBe('orphan2');
    });

    it('does nothing when no orphans exist', async () => {
      mockExecutor.executor.mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            Id: 'r1',
            Names: ['flowhelm-agent-stan-active'],
            Image: 'img',
            State: 'running',
            Created: '2026-04-04T10:00:00Z',
          },
        ]),
        stderr: '',
      });

      await lifecycle.cleanupOrphans();

      // Only the list call, no rm calls
      expect(mockExecutor.executor).toHaveBeenCalledTimes(1);
    });
  });

  describe('isProxyHealthy', () => {
    it('returns true when proxy container is running', async () => {
      // exists check
      mockExecutor.executor.mockResolvedValueOnce({ stdout: '', stderr: '' });
      // isHealthy check
      mockExecutor.executor.mockResolvedValueOnce({ stdout: 'true\n', stderr: '' });

      expect(await lifecycle.isProxyHealthy()).toBe(true);
    });

    it('returns false when proxy container does not exist', async () => {
      mockExecutor.executor.mockRejectedValueOnce(new Error('no such container'));

      expect(await lifecycle.isProxyHealthy()).toBe(false);
    });
  });

  describe('stop (graceful shutdown)', () => {
    it('stops and removes all user containers', async () => {
      // list call
      mockExecutor.executor.mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            Id: 'agent1',
            Names: ['flowhelm-agent-stan-task1'],
            Image: 'img',
            State: 'running',
            Created: '2026-04-04T10:00:00Z',
          },
          {
            Id: 'proxy1',
            Names: ['flowhelm-proxy-stan'],
            Image: 'img',
            State: 'running',
            Created: '2026-04-04T10:00:00Z',
          },
        ]),
        stderr: '',
      });
      // stop + remove calls
      mockExecutor.executor.mockResolvedValue({ stdout: '', stderr: '' });

      await lifecycle.stop();

      const allCalls = mockExecutor.executor.mock.calls;
      const stopCalls = allCalls.filter((c) => (c[1] as string[])[0] === 'stop');
      const rmCalls = allCalls.filter((c) => (c[1] as string[])[0] === 'rm');

      expect(stopCalls).toHaveLength(2);
      expect(rmCalls).toHaveLength(2);
      // Drain timeout is 5
      expect(stopCalls[0]?.[1] as string[]).toContain('5');
    });
  });
});

// ─── AppleContainerRuntime ───────────────────────────────────────────────────
// Full AppleContainerRuntime tests are in tests/apple-container.test.ts (Phase 18).
// This section validates that the runtime implements ContainerRuntime correctly.

describe('AppleContainerRuntime', () => {
  it('implements ContainerRuntime interface (all methods exist)', () => {
    const runtime = new AppleContainerRuntime();

    // Verify all interface methods exist and are functions
    expect(typeof runtime.create).toBe('function');
    expect(typeof runtime.start).toBe('function');
    expect(typeof runtime.stop).toBe('function');
    expect(typeof runtime.remove).toBe('function');
    expect(typeof runtime.exec).toBe('function');
    expect(typeof runtime.logs).toBe('function');
    expect(typeof runtime.isHealthy).toBe('function');
    expect(typeof runtime.exists).toBe('function');
    expect(typeof runtime.list).toBe('function');
    expect(typeof runtime.createNetwork).toBe('function');
    expect(typeof runtime.removeNetwork).toBe('function');
    expect(typeof runtime.networkExists).toBe('function');
    expect(typeof runtime.imageExists).toBe('function');
  });

  it('network operations are no-ops (vmnet)', async () => {
    const runtime = new AppleContainerRuntime();

    // These should not throw
    await runtime.createNetwork('test-net');
    await runtime.removeNetwork('test-net');
    expect(await runtime.networkExists('test-net')).toBe(true);
  });
});
