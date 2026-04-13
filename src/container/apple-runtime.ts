/**
 * Apple Container runtime for macOS Tahoe (26+).
 *
 * Apple Container provides native VM-based isolation via the macOS
 * Virtualization framework — each container runs in its own lightweight VM
 * with vmnet networking (192.168.64.0/24 subnet).
 *
 * Wraps the `container` CLI binary with the same ContainerRuntime interface
 * as PodmanRuntime, so the orchestrator doesn't need to know which runtime
 * is active. An injectable CommandExecutor enables unit testing without a
 * real Apple Container binary.
 *
 * Key differences from Podman:
 * - Mount syntax: --mount type=bind,source=...,target=...,readonly
 *   (Podman uses --volume /host:/container:ro,Z)
 * - No cgroups v2 (VM isolation instead) — resource limits are advisory
 * - No SELinux labels or user namespace mapping (not applicable on macOS)
 * - No named user networks — vmnet bridge is shared, containers resolve
 *   each other by name via Apple Container's built-in DNS
 * - DNS: IPv6 resolution must be forced to IPv4-first via
 *   NODE_OPTIONS=--dns-result-order=ipv4first
 * - Host gateway: bridge100 (192.168.64.1), created when containers start
 */

import { execFile } from 'node:child_process';
import type {
  CommandExecutor,
  CommandResult,
  ContainerConfig,
  ContainerFilter,
  ContainerInfo,
  ContainerRuntime,
  ContainerState,
  ExecResult,
} from '../orchestrator/types.js';

/** Default command executor wrapping child_process.execFile. */
function defaultExecutor(
  cmd: string,
  args: string[],
  options?: { timeout?: number },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: options?.timeout ?? 30_000, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const err = new Error(
            `Command failed: ${cmd} ${args.join(' ')}\n${stderr || error.message}`,
          );
          (err as NodeJS.ErrnoException & { stdout: string; stderr: string }).stdout = stdout;
          (err as NodeJS.ErrnoException & { stdout: string; stderr: string }).stderr = stderr;
          reject(err);
        } else {
          resolve({ stdout, stderr });
        }
      },
    );
  });
}

export class AppleContainerRuntime implements ContainerRuntime {
  private readonly execute: CommandExecutor;
  private readonly binary = 'container';

  constructor(options?: { executor?: CommandExecutor }) {
    this.execute = options?.executor ?? defaultExecutor;
  }

  // ── Container lifecycle ──────────────────────────────────────────────────

  async create(config: ContainerConfig): Promise<string> {
    const args = this.buildCreateArgs(config);
    const { stdout } = await this.execute(this.binary, args);
    return stdout.trim(); // Container ID
  }

  async start(id: string): Promise<void> {
    await this.execute(this.binary, ['start', id]);
  }

  async stop(id: string, timeout = 10): Promise<void> {
    await this.execute(this.binary, ['stop', '-t', String(timeout), id]);
  }

  async remove(id: string): Promise<void> {
    await this.execute(this.binary, ['rm', '-f', id]);
  }

  // ── Container operations ─────────────────────────────────────────────────

  async exec(id: string, command: string[], options?: { timeout?: number }): Promise<ExecResult> {
    try {
      const { stdout, stderr } = await this.execute(this.binary, ['exec', id, ...command], {
        timeout: options?.timeout,
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (err: unknown) {
      const error = err as Error & { stdout?: string; stderr?: string; code?: number };
      return {
        stdout: error.stdout ?? '',
        stderr: error.stderr ?? error.message,
        exitCode: error.code ?? 1,
      };
    }
  }

  async logs(id: string, tail?: number): Promise<string> {
    const args = ['logs'];
    if (tail !== undefined) {
      args.push('--tail', String(tail));
    }
    args.push(id);
    const { stdout } = await this.execute(this.binary, args);
    return stdout;
  }

  async isHealthy(id: string): Promise<boolean> {
    try {
      const { stdout } = await this.execute(this.binary, [
        'inspect',
        '--format',
        '{{.State.Running}}',
        id,
      ]);
      return stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  // ── Container queries ────────────────────────────────────────────────────

  async exists(nameOrId: string): Promise<boolean> {
    try {
      await this.execute(this.binary, ['inspect', nameOrId]);
      return true;
    } catch {
      return false;
    }
  }

  async list(filter?: ContainerFilter): Promise<ContainerInfo[]> {
    const args = ['ls', '-a', '--format', 'json'];

    const { stdout } = await this.execute(this.binary, args);
    if (!stdout.trim()) return [];

    // Apple Container may output JSON array or newline-delimited JSON objects
    let containers: AppleContainerLsEntry[];
    const trimmed = stdout.trim();
    if (trimmed.startsWith('[')) {
      containers = JSON.parse(trimmed) as AppleContainerLsEntry[];
    } else {
      // Newline-delimited JSON
      containers = trimmed
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as AppleContainerLsEntry);
    }

    // Apply filters client-side (Apple Container CLI filtering is limited)
    let result = containers.map(parseContainerInfo);

    if (filter?.namePrefix) {
      const prefix = filter.namePrefix;
      result = result.filter((c) => c.name.startsWith(prefix));
    }
    if (filter?.state) {
      result = result.filter((c) => c.state === filter.state);
    }

    return result;
  }

  // ── Network operations ───────────────────────────────────────────────────
  //
  // Apple Container uses vmnet networking — all containers share the same
  // bridge (bridge100, 192.168.64.0/24). There are no user-defined networks.
  // These methods are no-ops to satisfy the ContainerRuntime interface.

  async createNetwork(_name: string): Promise<void> {
    // vmnet bridge is created automatically when a container starts.
    // No explicit network creation needed.
  }

  async removeNetwork(_name: string): Promise<void> {
    // vmnet bridge is managed by the OS. No explicit removal.
  }

  async networkExists(_name: string): Promise<boolean> {
    // vmnet is always available on macOS Tahoe with Apple Container.
    return true;
  }

  // ── Image operations ─────────────────────────────────────────────────────

  async imageExists(image: string): Promise<boolean> {
    try {
      await this.execute(this.binary, ['image', 'inspect', image]);
      return true;
    } catch {
      return false;
    }
  }

  // ── Argument building (public for testing) ───────────────────────────────

  /**
   * Build the full `container create` argument list from a ContainerConfig.
   * Exposed as public for unit testing argument construction.
   *
   * Adapts Podman-style config to Apple Container CLI syntax:
   * - Bind mounts use --mount instead of --volume
   * - SELinux labels and user namespaces are ignored (not applicable on macOS)
   * - Resource limits use --memory/--cpus (advisory for Apple Container VMs)
   * - IPv4-first DNS is injected via NODE_OPTIONS
   */
  buildCreateArgs(config: ContainerConfig): string[] {
    const args: string[] = ['create', '--name', config.name];

    // Resource limits (advisory — Apple Container VMs don't enforce cgroups)
    args.push('--memory', config.memoryLimit);
    args.push('--cpus', config.cpuLimit);

    // Published ports
    if (config.ports) {
      for (const port of config.ports) {
        args.push('--publish', port);
      }
    }

    // Working directory
    if (config.workDir) {
      args.push('--workdir', config.workDir);
    }

    // Bind mounts — use --mount syntax (Apple Container doesn't support -v :ro,Z)
    for (const mount of config.mounts) {
      let mountStr = `type=bind,source=${mount.source},target=${mount.target}`;
      if (mount.readOnly) mountStr += ',readonly';
      // SELinux labels (Z) and chownToUser (U) are Podman-only — skip on macOS
      args.push('--mount', mountStr);
    }

    // Tmpfs mounts
    for (const tmpfs of config.tmpfs) {
      args.push('--mount', `type=tmpfs,target=${tmpfs.target},tmpfs-size=${tmpfs.size}`);
    }

    // Environment variables — inject IPv4-first DNS workaround
    const env = { ...config.env };
    const nodeOpts = env['NODE_OPTIONS'] ?? '';
    if (!nodeOpts.includes('dns-result-order')) {
      env['NODE_OPTIONS'] = nodeOpts
        ? `${nodeOpts} --dns-result-order=ipv4first`
        : '--dns-result-order=ipv4first';
    }
    for (const [key, value] of Object.entries(env)) {
      args.push('--env', `${key}=${value}`);
    }

    // Image (must be last positional before command)
    args.push(config.image);

    // Command override
    if (config.command && config.command.length > 0) {
      args.push(...config.command);
    }

    return args;
  }
}

// ── Apple Container JSON output types ──────────────────────────────────────

interface AppleContainerLsEntry {
  ID?: string;
  Id?: string;
  Name?: string;
  Names?: string[];
  Image?: string;
  State?: string;
  Status?: string;
  Created?: string;
  CreatedAt?: string;
}

function parseContainerInfo(entry: AppleContainerLsEntry): ContainerInfo {
  const id = entry.ID ?? entry.Id ?? '';
  const name = entry.Name ?? (Array.isArray(entry.Names) ? (entry.Names[0] ?? '') : '') ?? '';
  const image = entry.Image ?? '';
  const stateStr = entry.State ?? entry.Status ?? 'unknown';
  const createdStr = entry.Created ?? entry.CreatedAt ?? '';

  return {
    id,
    name,
    image,
    state: mapStatusToState(stateStr),
    createdAt: createdStr ? new Date(createdStr).getTime() : 0,
  };
}

function mapStatusToState(status: string): ContainerState {
  const normalized = status.toLowerCase();
  if (normalized === 'running' || normalized.startsWith('up')) return 'running';
  if (normalized === 'created') return 'created';
  if (normalized === 'paused') return 'paused';
  if (normalized === 'exited' || normalized === 'stopped') return 'exited';
  return 'unknown';
}
