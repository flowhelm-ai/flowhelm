/**
 * FlowHelm system status.
 *
 * `flowhelm status` shows current system state: version, orchestrator
 * health, running containers, and resource usage. Supports `--json`
 * for machine-readable output.
 *
 * Platform-aware: uses systemd on Linux, launchd on macOS.
 * Uses Podman on Linux, Apple Container CLI on macOS Tahoe+.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { platform } from 'node:os';
import { getVersion } from './version.js';
import { PortRegistry } from './port-registry.js';
import { checkAuthHealth, type AuthHealthResult } from '../auth/auth-monitor.js';
import { detectPlatform, type PlatformInfo } from '../container/platform.js';

const execFileAsync = promisify(execFileCb);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ContainerStatus {
  name: string;
  role: string;
  state: 'running' | 'stopped' | 'missing';
}

export interface UserStatus {
  name: string;
  linuxUser: string;
  serviceActive: boolean;
  containers: number;
}

export interface AuthStatus {
  type: string;
  status: string;
  message: string;
  daysRemaining?: number;
}

export interface StatusInfo {
  version: string;
  platform: string;
  runtime: string;
  orchestratorState: 'active' | 'inactive' | 'unknown';
  containers: ContainerStatus[];
  auth?: AuthStatus[];
  users?: UserStatus[];
}

export interface StatusOptions {
  json?: boolean;
  admin?: boolean;
  log?: (msg: string) => void;
  /** Custom exec function for testing. */
  execFn?: typeof execFileAsync;
  /** Custom port registry path for testing. */
  registryPath?: string;
  /** Override platform info for testing. */
  platformInfoOverride?: PlatformInfo;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function getOrchestratorStateLinux(
  exec: typeof execFileAsync,
): Promise<StatusInfo['orchestratorState']> {
  try {
    const { stdout } = await exec('systemctl', ['--user', 'is-active', 'flowhelm.service']);
    return stdout.trim() === 'active' ? 'active' : 'inactive';
  } catch {
    return 'unknown';
  }
}

async function getOrchestratorStateMacOS(
  exec: typeof execFileAsync,
): Promise<StatusInfo['orchestratorState']> {
  try {
    const { stdout } = await exec('launchctl', ['list']);
    return stdout.includes('ai.flowhelm') ? 'active' : 'inactive';
  } catch {
    return 'unknown';
  }
}

async function listContainersPodman(exec: typeof execFileAsync): Promise<ContainerStatus[]> {
  try {
    const { stdout } = await exec('podman', [
      'ps',
      '--all',
      '--filter',
      'name=flowhelm-',
      '--format',
      '{{.Names}}\t{{.Status}}',
    ]);

    if (!stdout.trim()) return [];
    return parseContainerList(stdout);
  } catch {
    return [];
  }
}

async function listContainersApple(exec: typeof execFileAsync): Promise<ContainerStatus[]> {
  try {
    const { stdout } = await exec('container', ['ls', '-a', '--format', 'json']);

    if (!stdout.trim()) return [];

    const trimmed = stdout.trim();
    let entries: Array<{ Name?: string; Names?: string[]; State?: string; Status?: string }>;
    if (trimmed.startsWith('[')) {
      entries = JSON.parse(trimmed) as typeof entries;
    } else {
      entries = trimmed
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as (typeof entries)[0]);
    }

    const containers: ContainerStatus[] = [];
    for (const entry of entries) {
      const name = entry.Name ?? (Array.isArray(entry.Names) ? (entry.Names[0] ?? '') : '');
      if (!name.startsWith('flowhelm-')) continue;

      const stateStr = (entry.State ?? entry.Status ?? '').toLowerCase();
      const state: ContainerStatus['state'] =
        stateStr === 'running' || stateStr.startsWith('up') ? 'running' : 'stopped';

      containers.push({ name, role: detectRole(name), state });
    }
    return containers;
  } catch {
    return [];
  }
}

function parseContainerList(stdout: string): ContainerStatus[] {
  const containers: ContainerStatus[] = [];
  for (const line of stdout.trim().split('\n')) {
    const [name, status] = line.split('\t');
    if (!name) continue;

    const state: ContainerStatus['state'] = status?.toLowerCase().startsWith('up')
      ? 'running'
      : 'stopped';

    containers.push({ name, role: detectRole(name), state });
  }
  return containers;
}

function detectRole(name: string): string {
  if (name.includes('-proxy-')) return 'proxy';
  if (name.includes('-db-')) return 'database';
  if (name.includes('-channel-')) return 'channel';
  if (name.includes('-service-')) return 'service';
  if (name.includes('-agent-')) return 'agent';
  if (name.includes('-memory-')) return 'memory';
  return 'unknown';
}

async function listUsers(exec: typeof execFileAsync, registryPath?: string): Promise<UserStatus[]> {
  try {
    const registry = new PortRegistry({ registryPath });
    const data = await registry.read();
    const allocations = data.allocations;
    const users: UserStatus[] = [];

    for (const alloc of allocations) {
      const linuxUser = `flowhelm-${alloc.username}`;
      let serviceActive = false;

      try {
        const { stdout } = await exec('systemctl', [
          '--user',
          `--machine=${linuxUser}@.host`,
          'is-active',
          'flowhelm.service',
        ]);
        serviceActive = stdout.trim() === 'active';
      } catch {
        // Service not active or can't check
      }

      // Count containers for this user
      let containers = 0;
      try {
        const { stdout } = await exec('podman', [
          'ps',
          '--filter',
          `name=flowhelm-.*-${alloc.username}`,
          '--format',
          '{{.Names}}',
        ]);
        containers = stdout.trim() ? stdout.trim().split('\n').length : 0;
      } catch {
        // Can't count containers
      }

      users.push({
        name: alloc.username,
        linuxUser,
        serviceActive,
        containers,
      });
    }

    return users;
  } catch {
    return [];
  }
}

// ─── Main status function ───────────────────────────────────────────────────

export async function getStatus(options: StatusOptions = {}): Promise<StatusInfo> {
  const log = options.log ?? console.log;
  const exec = options.execFn ?? execFileAsync;
  const version = getVersion();
  const os = platform();

  // Detect platform info
  let platformInfo: PlatformInfo;
  try {
    platformInfo = options.platformInfoOverride ?? detectPlatform();
  } catch {
    platformInfo = {
      os: os === 'darwin' ? 'darwin' : 'linux',
      runtime: 'podman',
      serviceManager: os === 'darwin' ? 'launchd' : 'systemd',
      binaryPath: 'podman',
      version: 'unknown',
    };
  }

  const isMacOS = platformInfo.os === 'darwin';

  // Get orchestrator state based on platform
  const orchestratorState = isMacOS
    ? await getOrchestratorStateMacOS(exec)
    : await getOrchestratorStateLinux(exec);

  // List containers based on runtime
  const containers =
    platformInfo.runtime === 'apple_container'
      ? await listContainersApple(exec)
      : await listContainersPodman(exec);

  // Auth health
  const authResults = await checkAuthHealth();
  const authStatuses: AuthStatus[] = authResults.map((r: AuthHealthResult) => ({
    type: r.type,
    status: r.status,
    message: r.message,
    ...(r.daysRemaining !== undefined ? { daysRemaining: r.daysRemaining } : {}),
  }));

  const status: StatusInfo = {
    version,
    platform: isMacOS ? 'macOS' : 'Linux',
    runtime: platformInfo.runtime === 'apple_container' ? 'Apple Container' : 'Podman',
    orchestratorState,
    containers,
    auth: authStatuses,
  };

  // Admin mode: list all users (Linux multi-tenant only)
  if (options.admin && !isMacOS && existsSync('/etc/flowhelm/ports.json')) {
    status.users = await listUsers(exec, options.registryPath);
  }

  if (options.json) {
    log(JSON.stringify(status, null, 2));
    return status;
  }

  // Human-readable output
  log('');
  log(`FlowHelm v${version}`);
  log(`Platform: ${status.platform} (${status.runtime} ${platformInfo.version})`);
  log('');
  log(`Orchestrator: ${orchestratorState}`);

  if (status.auth && status.auth.length > 0) {
    log('');
    log('Auth:');
    for (const a of status.auth) {
      const icon = a.status === 'ok' ? '+' : a.status === 'expired' ? '!' : '~';
      log(`  [${icon}] ${a.message}`);
    }
  }

  if (containers.length > 0) {
    log('');
    log('Containers:');
    for (const c of containers) {
      const icon = c.state === 'running' ? '+' : '-';
      log(`  [${icon}] ${c.name} (${c.role})`);
    }
  } else {
    log('Containers:   none');
  }

  if (status.users && status.users.length > 0) {
    log('');
    log('Users:');
    for (const u of status.users) {
      const svc = u.serviceActive ? 'active' : 'inactive';
      log(
        `  ${u.name.padEnd(16)} ${u.linuxUser.padEnd(24)} service: ${svc}  containers: ${String(u.containers)}`,
      );
    }
  }

  log('');
  return status;
}
