/**
 * Phase 18 tests: Apple Container Runtime.
 *
 * Tests AppleContainerRuntime command building, lifecycle operations,
 * network no-ops, mount syntax differences from Podman, and DNS
 * IPv4-first injection. Uses injectable command executor — no real
 * Apple Container binary needed.
 */

import { describe, it, expect, vi } from 'vitest';
import type { CommandResult, ContainerConfig } from '../src/orchestrator/types.js';
import { AppleContainerRuntime } from '../src/container/apple-runtime.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createMockExecutor() {
  const executor = vi.fn(async (_cmd: string, _args: string[]): Promise<CommandResult> => {
    return { stdout: '', stderr: '' };
  });

  function callArgs(n: number): string[] {
    return executor.mock.calls[n]?.[1] as string[];
  }

  function call(n: number): { cmd: string; args: string[] } {
    const c = executor.mock.calls[n];
    return { cmd: c?.[0] as string, args: c?.[1] as string[] };
  }

  return { executor, callArgs, call };
}

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

// ─── AppleContainerRuntime: Command Building ────────────────────────────────

describe('AppleContainerRuntime', () => {
  describe('buildCreateArgs', () => {
    it('builds create command with container binary', () => {
      const runtime = new AppleContainerRuntime();
      const args = runtime.buildCreateArgs(minimalConfig());

      expect(args[0]).toBe('create');
      expect(args).toContain('--name');
      expect(args).toContain('flowhelm-agent-stan-abc123');
      expect(args).toContain('--memory');
      expect(args).toContain('512m');
      expect(args).toContain('--cpus');
      expect(args).toContain('1.0');
      expect(args).toContain('flowhelm-agent:latest');
    });

    it('uses --mount syntax instead of --volume for bind mounts', () => {
      const runtime = new AppleContainerRuntime();
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

      // Should use --mount, not --volume
      expect(args).not.toContain('--volume');
      expect(args).toContain('--mount');
      expect(args).toContain('type=bind,source=/home/stan/.flowhelm/agent,target=/workspace');
      expect(args).toContain(
        'type=bind,source=/home/stan/.flowhelm/memory,target=/memory,readonly',
      );
    });

    it('ignores SELinux labels (not applicable on macOS)', () => {
      const runtime = new AppleContainerRuntime();
      const args = runtime.buildCreateArgs(
        minimalConfig({
          mounts: [{ source: '/data', target: '/data', readOnly: true, selinuxLabel: 'Z' }],
        }),
      );

      const mountArg = args[args.indexOf('--mount') + 1];
      expect(mountArg).not.toContain(':Z');
      expect(mountArg).not.toContain(',Z');
      expect(mountArg).toBe('type=bind,source=/data,target=/data,readonly');
    });

    it('ignores user namespace option (VM isolation instead)', () => {
      const runtime = new AppleContainerRuntime();
      const args = runtime.buildCreateArgs(minimalConfig({ userNamespace: 'auto' }));

      expect(args).not.toContain('--userns');
      expect(args).not.toContain('auto');
    });

    it('ignores security opts (not applicable on macOS)', () => {
      const runtime = new AppleContainerRuntime();
      const args = runtime.buildCreateArgs(
        minimalConfig({
          securityOpts: ['no-new-privileges', 'label=type:container_runtime_t'],
        }),
      );

      expect(args).not.toContain('--security-opt');
      expect(args).not.toContain('no-new-privileges');
    });

    it('does not include --read-only (VM filesystem isolation)', () => {
      const runtime = new AppleContainerRuntime();
      const args = runtime.buildCreateArgs(minimalConfig({ readOnly: true }));

      expect(args).not.toContain('--read-only');
    });

    it('injects NODE_OPTIONS=--dns-result-order=ipv4first', () => {
      const runtime = new AppleContainerRuntime();
      const args = runtime.buildCreateArgs(minimalConfig({ env: {} }));

      const envIdx = args.indexOf('NODE_OPTIONS=--dns-result-order=ipv4first');
      expect(envIdx).toBeGreaterThan(-1);
      // Preceded by --env
      expect(args[envIdx - 1]).toBe('--env');
    });

    it('appends dns-result-order to existing NODE_OPTIONS', () => {
      const runtime = new AppleContainerRuntime();
      const args = runtime.buildCreateArgs(
        minimalConfig({ env: { NODE_OPTIONS: '--max-old-space-size=4096' } }),
      );

      const nodeOptsArg = args.find((a: string) => a.startsWith('NODE_OPTIONS='));
      expect(nodeOptsArg).toContain('--max-old-space-size=4096');
      expect(nodeOptsArg).toContain('--dns-result-order=ipv4first');
    });

    it('does not duplicate dns-result-order if already present', () => {
      const runtime = new AppleContainerRuntime();
      const args = runtime.buildCreateArgs(
        minimalConfig({ env: { NODE_OPTIONS: '--dns-result-order=ipv4first' } }),
      );

      const nodeOptsArgs = args.filter((a: string) => a.includes('dns-result-order'));
      expect(nodeOptsArgs).toHaveLength(1);
    });

    it('includes tmpfs mounts with --mount syntax', () => {
      const runtime = new AppleContainerRuntime();
      const args = runtime.buildCreateArgs(
        minimalConfig({
          tmpfs: [{ target: '/tmp', size: '500m' }],
        }),
      );

      expect(args).toContain('--mount');
      expect(args).toContain('type=tmpfs,target=/tmp,tmpfs-size=500m');
    });

    it('includes environment variables', () => {
      const runtime = new AppleContainerRuntime();
      const args = runtime.buildCreateArgs(
        minimalConfig({
          env: { ANTHROPIC_API_KEY: 'sk-test', NODE_ENV: 'production' },
        }),
      );

      expect(args).toContain('--env');
      expect(args).toContain('ANTHROPIC_API_KEY=sk-test');
      expect(args).toContain('NODE_ENV=production');
    });

    it('includes working directory', () => {
      const runtime = new AppleContainerRuntime();
      const args = runtime.buildCreateArgs(minimalConfig({ workDir: '/workspace' }));

      expect(args).toContain('--workdir');
      expect(args).toContain('/workspace');
    });

    it('includes command override after image', () => {
      const runtime = new AppleContainerRuntime();
      const args = runtime.buildCreateArgs(minimalConfig({ command: ['node', 'index.js'] }));

      const imageIdx = args.indexOf('flowhelm-agent:latest');
      expect(args[imageIdx + 1]).toBe('node');
      expect(args[imageIdx + 2]).toBe('index.js');
    });

    it('includes published ports', () => {
      const runtime = new AppleContainerRuntime();
      const args = runtime.buildCreateArgs(minimalConfig({ ports: ['15432:5432', '10255:10255'] }));

      expect(args).toContain('--publish');
      expect(args).toContain('15432:5432');
      expect(args).toContain('10255:10255');
    });
  });

  // ── Container Lifecycle ──────────────────────────────────────────────────

  describe('create', () => {
    it('returns container ID from stdout', async () => {
      const { executor, callArgs } = createMockExecutor();
      executor.mockResolvedValueOnce({ stdout: 'abc123def456\n', stderr: '' });
      const runtime = new AppleContainerRuntime({ executor });

      const id = await runtime.create(minimalConfig());

      expect(id).toBe('abc123def456');
      expect(callArgs(0)[0]).toBe('create');
    });

    it('uses container binary', async () => {
      const { executor, call } = createMockExecutor();
      executor.mockResolvedValueOnce({ stdout: 'id123\n', stderr: '' });
      const runtime = new AppleContainerRuntime({ executor });

      await runtime.create(minimalConfig());

      expect(call(0).cmd).toBe('container');
    });
  });

  describe('start', () => {
    it('calls container start with container ID', async () => {
      const { executor, call } = createMockExecutor();
      const runtime = new AppleContainerRuntime({ executor });

      await runtime.start('abc123');

      expect(call(0)).toEqual({ cmd: 'container', args: ['start', 'abc123'] });
    });
  });

  describe('stop', () => {
    it('calls container stop with timeout', async () => {
      const { executor, call } = createMockExecutor();
      const runtime = new AppleContainerRuntime({ executor });

      await runtime.stop('abc123', 5);

      expect(call(0)).toEqual({ cmd: 'container', args: ['stop', '-t', '5', 'abc123'] });
    });

    it('uses default timeout of 10', async () => {
      const { executor, callArgs } = createMockExecutor();
      const runtime = new AppleContainerRuntime({ executor });

      await runtime.stop('abc123');

      expect(callArgs(0)).toContain('10');
    });
  });

  describe('remove', () => {
    it('calls container rm -f', async () => {
      const { executor, call } = createMockExecutor();
      const runtime = new AppleContainerRuntime({ executor });

      await runtime.remove('abc123');

      expect(call(0)).toEqual({ cmd: 'container', args: ['rm', '-f', 'abc123'] });
    });
  });

  describe('exec', () => {
    it('returns stdout/stderr/exitCode on success', async () => {
      const { executor } = createMockExecutor();
      executor.mockResolvedValueOnce({ stdout: 'hello\n', stderr: '' });
      const runtime = new AppleContainerRuntime({ executor });

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
      const runtime = new AppleContainerRuntime({ executor });

      const result = await runtime.exec('abc123', ['bad']);

      expect(result.exitCode).toBe(127);
      expect(result.stderr).toContain('not found');
    });
  });

  describe('logs', () => {
    it('returns container logs', async () => {
      const { executor } = createMockExecutor();
      executor.mockResolvedValueOnce({ stdout: 'log line 1\nlog line 2\n', stderr: '' });
      const runtime = new AppleContainerRuntime({ executor });

      const output = await runtime.logs('abc123');

      expect(output).toBe('log line 1\nlog line 2\n');
    });

    it('passes --tail flag when specified', async () => {
      const { executor, callArgs } = createMockExecutor();
      const runtime = new AppleContainerRuntime({ executor });

      await runtime.logs('abc123', 50);

      expect(callArgs(0)).toContain('--tail');
      expect(callArgs(0)).toContain('50');
    });
  });

  describe('isHealthy', () => {
    it('returns true when container is running', async () => {
      const { executor } = createMockExecutor();
      executor.mockResolvedValueOnce({ stdout: 'true\n', stderr: '' });
      const runtime = new AppleContainerRuntime({ executor });

      expect(await runtime.isHealthy('abc123')).toBe(true);
    });

    it('returns false when container is not running', async () => {
      const { executor } = createMockExecutor();
      executor.mockResolvedValueOnce({ stdout: 'false\n', stderr: '' });
      const runtime = new AppleContainerRuntime({ executor });

      expect(await runtime.isHealthy('abc123')).toBe(false);
    });

    it('returns false when inspect fails', async () => {
      const { executor } = createMockExecutor();
      executor.mockRejectedValueOnce(new Error('no such container'));
      const runtime = new AppleContainerRuntime({ executor });

      expect(await runtime.isHealthy('nonexistent')).toBe(false);
    });
  });

  // ── Container Queries ────────────────────────────────────────────────────

  describe('exists', () => {
    it('returns true when container exists', async () => {
      const { executor } = createMockExecutor();
      executor.mockResolvedValueOnce({ stdout: '{}', stderr: '' });
      const runtime = new AppleContainerRuntime({ executor });

      expect(await runtime.exists('abc123')).toBe(true);
    });

    it('returns false when container does not exist', async () => {
      const { executor } = createMockExecutor();
      executor.mockRejectedValueOnce(new Error('no such container'));
      const runtime = new AppleContainerRuntime({ executor });

      expect(await runtime.exists('nonexistent')).toBe(false);
    });

    it('uses inspect command (not container exists)', async () => {
      const { executor, call } = createMockExecutor();
      executor.mockResolvedValueOnce({ stdout: '{}', stderr: '' });
      const runtime = new AppleContainerRuntime({ executor });

      await runtime.exists('abc123');

      expect(call(0).args).toEqual(['inspect', 'abc123']);
    });
  });

  describe('list', () => {
    it('parses JSON array output', async () => {
      const { executor } = createMockExecutor();
      executor.mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            ID: 'abc123',
            Name: 'flowhelm-agent-stan-task1',
            Image: 'flowhelm-agent:latest',
            State: 'running',
            Created: '2026-04-04T10:00:00Z',
          },
        ]),
        stderr: '',
      });
      const runtime = new AppleContainerRuntime({ executor });

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

    it('parses newline-delimited JSON output', async () => {
      const { executor } = createMockExecutor();
      const line1 = JSON.stringify({
        ID: 'a1',
        Name: 'flowhelm-agent-stan-t1',
        Image: 'img',
        State: 'running',
        Created: '2026-04-04T10:00:00Z',
      });
      const line2 = JSON.stringify({
        ID: 'a2',
        Name: 'flowhelm-proxy-stan',
        Image: 'img',
        State: 'exited',
        Created: '2026-04-04T09:00:00Z',
      });
      executor.mockResolvedValueOnce({
        stdout: `${line1}\n${line2}\n`,
        stderr: '',
      });
      const runtime = new AppleContainerRuntime({ executor });

      const containers = await runtime.list();

      expect(containers).toHaveLength(2);
      expect(containers[0]!.state).toBe('running');
      expect(containers[1]!.state).toBe('exited');
    });

    it('returns empty array on empty output', async () => {
      const { executor } = createMockExecutor();
      executor.mockResolvedValueOnce({ stdout: '', stderr: '' });
      const runtime = new AppleContainerRuntime({ executor });

      expect(await runtime.list()).toEqual([]);
    });

    it('applies name prefix filter client-side', async () => {
      const { executor } = createMockExecutor();
      executor.mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            ID: 'a1',
            Name: 'flowhelm-agent-stan-t1',
            Image: 'img',
            State: 'running',
            Created: '2026-04-04T10:00:00Z',
          },
          {
            ID: 'a2',
            Name: 'flowhelm-proxy-stan',
            Image: 'img',
            State: 'running',
            Created: '2026-04-04T10:00:00Z',
          },
          {
            ID: 'a3',
            Name: 'other-container',
            Image: 'img',
            State: 'running',
            Created: '2026-04-04T10:00:00Z',
          },
        ]),
        stderr: '',
      });
      const runtime = new AppleContainerRuntime({ executor });

      const result = await runtime.list({ namePrefix: 'flowhelm-agent' });

      expect(result).toHaveLength(1);
      expect(result[0]!.name).toBe('flowhelm-agent-stan-t1');
    });

    it('applies state filter client-side', async () => {
      const { executor } = createMockExecutor();
      executor.mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            ID: 'a1',
            Name: 'flowhelm-agent-stan-t1',
            Image: 'img',
            State: 'running',
            Created: '2026-04-04T10:00:00Z',
          },
          {
            ID: 'a2',
            Name: 'flowhelm-proxy-stan',
            Image: 'img',
            State: 'exited',
            Created: '2026-04-04T10:00:00Z',
          },
        ]),
        stderr: '',
      });
      const runtime = new AppleContainerRuntime({ executor });

      const result = await runtime.list({ state: 'exited' });

      expect(result).toHaveLength(1);
      expect(result[0]!.name).toBe('flowhelm-proxy-stan');
    });

    it('uses ls -a --format json (not ps)', async () => {
      const { executor, callArgs } = createMockExecutor();
      executor.mockResolvedValueOnce({ stdout: '[]', stderr: '' });
      const runtime = new AppleContainerRuntime({ executor });

      await runtime.list();

      expect(callArgs(0)).toEqual(['ls', '-a', '--format', 'json']);
    });

    it('handles alternative JSON field names (Names array, Id)', async () => {
      const { executor } = createMockExecutor();
      executor.mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            Id: 'abc123',
            Names: ['flowhelm-agent-stan-task1'],
            Image: 'flowhelm-agent:latest',
            Status: 'Up 5 minutes',
            CreatedAt: '2026-04-04T10:00:00Z',
          },
        ]),
        stderr: '',
      });
      const runtime = new AppleContainerRuntime({ executor });

      const containers = await runtime.list();

      expect(containers[0]!.id).toBe('abc123');
      expect(containers[0]!.name).toBe('flowhelm-agent-stan-task1');
      expect(containers[0]!.state).toBe('running');
    });
  });

  // ── Network Operations (no-ops) ─────────────────────────────────────────

  describe('network operations (vmnet no-ops)', () => {
    it('createNetwork is a no-op', async () => {
      const { executor } = createMockExecutor();
      const runtime = new AppleContainerRuntime({ executor });

      await runtime.createNetwork('flowhelm-network-stan');

      // No CLI call should be made
      expect(executor).not.toHaveBeenCalled();
    });

    it('removeNetwork is a no-op', async () => {
      const { executor } = createMockExecutor();
      const runtime = new AppleContainerRuntime({ executor });

      await runtime.removeNetwork('flowhelm-network-stan');

      expect(executor).not.toHaveBeenCalled();
    });

    it('networkExists always returns true', async () => {
      const { executor } = createMockExecutor();
      const runtime = new AppleContainerRuntime({ executor });

      expect(await runtime.networkExists('flowhelm-network-stan')).toBe(true);
      expect(await runtime.networkExists('anything')).toBe(true);
      expect(executor).not.toHaveBeenCalled();
    });
  });

  // ── Image Operations ─────────────────────────────────────────────────────

  describe('image operations', () => {
    it('imageExists uses image inspect', async () => {
      const { executor, call } = createMockExecutor();
      executor.mockResolvedValueOnce({ stdout: '{}', stderr: '' });
      const runtime = new AppleContainerRuntime({ executor });

      expect(await runtime.imageExists('flowhelm-agent:latest')).toBe(true);
      expect(call(0).args).toEqual(['image', 'inspect', 'flowhelm-agent:latest']);
    });

    it('imageExists returns false when image does not exist', async () => {
      const { executor } = createMockExecutor();
      executor.mockRejectedValueOnce(new Error('image not found'));
      const runtime = new AppleContainerRuntime({ executor });

      expect(await runtime.imageExists('nonexistent:latest')).toBe(false);
    });
  });
});
