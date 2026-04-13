/**
 * Podman rootless container runtime.
 *
 * Invokes the `podman` CLI binary via child_process.execFile. This preserves
 * Podman's daemonless architecture — no `podman system service` required.
 * An injectable CommandExecutor enables unit testing without a real Podman binary.
 *
 * Why Podman over Docker:
 * - Daemonless: each command is an independent process (no root daemon)
 * - Rootless by default: containers run in the invoking user's UID namespace
 * - Separate UID ranges per user: kernel-enforced multi-tenant isolation
 * - SELinux automatic enforcement via :Z mount labels
 * - Zero idle resource consumption
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
import { buildResourceLimitArgs } from './resource-limits.js';

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

export class PodmanRuntime implements ContainerRuntime {
  private readonly execute: CommandExecutor;
  private readonly binary = 'podman';

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
      await this.execute(this.binary, ['container', 'exists', nameOrId]);
      return true;
    } catch {
      return false;
    }
  }

  async list(filter?: ContainerFilter): Promise<ContainerInfo[]> {
    const args = ['ps', '-a', '--format', 'json', '--no-trunc'];

    if (filter?.namePrefix) {
      args.push('--filter', `name=^${filter.namePrefix}`);
    }
    if (filter?.state) {
      args.push('--filter', `status=${mapStateToStatus(filter.state)}`);
    }

    const { stdout } = await this.execute(this.binary, args);
    if (!stdout.trim()) return [];

    const containers = JSON.parse(stdout) as PodmanPsEntry[];
    return containers.map(parseContainerInfo);
  }

  // ── Network operations ───────────────────────────────────────────────────

  async createNetwork(name: string): Promise<void> {
    await this.execute(this.binary, ['network', 'create', name]);
  }

  async removeNetwork(name: string): Promise<void> {
    await this.execute(this.binary, ['network', 'rm', '-f', name]);
  }

  async networkExists(name: string): Promise<boolean> {
    try {
      await this.execute(this.binary, ['network', 'exists', name]);
      return true;
    } catch {
      return false;
    }
  }

  // ── Image operations ─────────────────────────────────────────────────────

  async imageExists(image: string): Promise<boolean> {
    try {
      await this.execute(this.binary, ['image', 'exists', image]);
      return true;
    } catch {
      return false;
    }
  }

  // ── Argument building (public for testing) ───────────────────────────────

  /**
   * Build the full `podman create` argument list from a ContainerConfig.
   * Exposed as public for unit testing argument construction.
   */
  buildCreateArgs(config: ContainerConfig): string[] {
    const args: string[] = ['create', '--name', config.name];

    // Resource limits (cgroups v2)
    args.push(
      ...buildResourceLimitArgs({
        memoryLimit: config.memoryLimit,
        cpuLimit: config.cpuLimit,
        pidsLimit: config.pidsLimit,
      }),
    );

    // Read-only root filesystem
    if (config.readOnly) {
      args.push('--read-only');
    }

    // User namespace (rootless UID mapping)
    if (config.userNamespace) {
      args.push('--userns', config.userNamespace);
    }

    // Published ports
    if (config.ports) {
      for (const port of config.ports) {
        args.push('--publish', port);
      }
    }

    // Network
    if (config.network) {
      args.push('--network', config.network);
    }

    // Working directory
    if (config.workDir) {
      args.push('--workdir', config.workDir);
    }

    // Volume mounts
    for (const mount of config.mounts) {
      let mountStr = `${mount.source}:${mount.target}`;
      const opts: string[] = [];
      if (mount.readOnly) opts.push('ro');
      if (mount.selinuxLabel) opts.push(mount.selinuxLabel);
      if (mount.chownToUser) opts.push('U');
      if (opts.length > 0) mountStr += `:${opts.join(',')}`;
      args.push('--volume', mountStr);
    }

    // Tmpfs mounts
    for (const tmpfs of config.tmpfs) {
      let tmpfsOpts = `${tmpfs.target}:size=${tmpfs.size}`;
      if (tmpfs.mode) tmpfsOpts += `,mode=${tmpfs.mode}`;
      args.push('--tmpfs', tmpfsOpts);
    }

    // Environment variables
    for (const [key, value] of Object.entries(config.env)) {
      args.push('--env', `${key}=${value}`);
    }

    // Security options
    for (const opt of config.securityOpts) {
      args.push('--security-opt', opt);
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

// ── Podman JSON output types ─────────────────────────────────────────────────

interface PodmanPsEntry {
  Id: string;
  Names: string[];
  Image: string;
  State: string;
  Created: string;
}

function parseContainerInfo(entry: PodmanPsEntry): ContainerInfo {
  return {
    id: entry.Id,
    name: Array.isArray(entry.Names) ? (entry.Names[0] ?? '') : '',
    image: entry.Image,
    state: mapStatusToState(entry.State),
    createdAt: new Date(entry.Created).getTime(),
  };
}

function mapStatusToState(status: string): ContainerState {
  const normalized = status.toLowerCase();
  if (normalized === 'running') return 'running';
  if (normalized === 'created') return 'created';
  if (normalized === 'paused') return 'paused';
  if (normalized === 'exited' || normalized === 'stopped') return 'exited';
  return 'unknown';
}

function mapStateToStatus(state: ContainerState): string {
  switch (state) {
    case 'running':
      return 'running';
    case 'created':
      return 'created';
    case 'paused':
      return 'paused';
    case 'exited':
    case 'stopped':
      return 'exited';
    default:
      return state;
  }
}
