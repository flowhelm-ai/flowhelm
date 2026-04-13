/**
 * Multi-tenant user lifecycle manager.
 *
 * Provides add-user and remove-user operations for the admin CLI.
 * Each user gets:
 *   - Linux user: flowhelm-{username}
 *   - Sub-UID/GID range: 65536 IDs (for Podman rootless)
 *   - Podman rootless initialization
 *   - Per-user Podman network: flowhelm-network-{username}
 *   - Systemd user service: flowhelm.service
 *   - Port allocation from port registry
 *   - SSH public key for remote access
 *
 * All operations are non-interactive and require root privileges.
 */

import { readFile, writeFile, mkdir, access, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import type { PortRegistry } from './port-registry.js';
import { type PortAllocation } from './port-registry.js';
import { installService, removeService } from './service-generator.js';

const execFileAsync = promisify(execFile);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AddUserOptions {
  /** Short username (e.g., "stan"). Linux user will be flowhelm-{name}. */
  name: string;
  /** Path to the user's SSH public key file. */
  sshKeyPath: string;
  /** Per-user RAM limit (e.g., "4G"). */
  ramLimit?: string;
  /** Per-user CPU limit (number of cores). */
  cpuLimit?: number;
  /** Max concurrent agent containers. */
  maxAgents?: number;
  /** Agent runtime mode. */
  agentRuntime?: 'cli' | 'sdk';
}

export interface RemoveUserOptions {
  /** Short username (e.g., "stan"). */
  name: string;
  /** Archive user data before removal. */
  archive?: boolean;
  /** Force removal without archiving. */
  force?: boolean;
}

export interface UserInfo {
  /** Short username. */
  name: string;
  /** Linux username (flowhelm-{name}). */
  linuxUser: string;
  /** Home directory. */
  homeDir: string;
  /** Port allocation. */
  ports?: PortAllocation;
  /** Whether the systemd service exists. */
  hasService: boolean;
}

export interface UserManagerResult {
  success: boolean;
  message: string;
}

export interface UserManagerOptions {
  /** Port registry instance. */
  portRegistry: PortRegistry;
  /** Archive directory for removed user data. Default: /var/backup/flowhelm */
  archiveDir?: string;
  /** FlowHelm binary path. Default: /usr/local/bin/flowhelm */
  binaryPath?: string;
  /** Log function. */
  log?: (msg: string) => void;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const LINUX_USER_PREFIX = 'flowhelm-';
const SUB_ID_RANGE = 65536;
const DEFAULT_ARCHIVE_DIR = '/var/backup/flowhelm';
const DEFAULT_BINARY_PATH = '/usr/bin/flowhelm';
const DEFAULT_RAM_LIMIT = '4G';
const DEFAULT_CPU_LIMIT = 2;
const DEFAULT_MAX_AGENTS = 5;

// ─── User Manager ───────────────────────────────────────────────────────────

export class UserManager {
  private readonly portRegistry: PortRegistry;
  private readonly archiveDir: string;
  private readonly binaryPath: string;
  private readonly log: (msg: string) => void;

  constructor(options: UserManagerOptions) {
    this.portRegistry = options.portRegistry;
    this.archiveDir = options.archiveDir ?? DEFAULT_ARCHIVE_DIR;
    this.binaryPath = options.binaryPath ?? DEFAULT_BINARY_PATH;
    this.log = options.log ?? console.log;
  }

  /**
   * Linux username for a given short name.
   */
  linuxUser(name: string): string {
    return `${LINUX_USER_PREFIX}${name}`;
  }

  /**
   * Home directory for a given short name.
   */
  homeDir(name: string): string {
    return `/home/${this.linuxUser(name)}`;
  }

  /**
   * Validate a username.
   */
  validateName(name: string): string | null {
    if (!name) return 'Username cannot be empty';
    if (name.length > 24) return 'Username must be 24 characters or fewer';
    if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
      return 'Username must start with a lowercase letter and contain only a-z, 0-9, _, -';
    }
    if (name === 'admin' || name === 'root') return `Reserved username: ${name}`;
    return null;
  }

  /**
   * Check if a user already exists.
   */
  async userExists(name: string): Promise<boolean> {
    try {
      await execFileAsync('id', [this.linuxUser(name)]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Add a new user with full isolation setup.
   */
  async addUser(options: AddUserOptions): Promise<UserManagerResult> {
    const { name, sshKeyPath } = options;
    const ramLimit = options.ramLimit ?? DEFAULT_RAM_LIMIT;
    const cpuLimit = options.cpuLimit ?? DEFAULT_CPU_LIMIT;
    const maxAgents = options.maxAgents ?? DEFAULT_MAX_AGENTS;

    // Validate name
    const nameError = this.validateName(name);
    if (nameError) return { success: false, message: nameError };

    // Check if user already exists
    if (await this.userExists(name)) {
      return { success: false, message: `User "${name}" already exists` };
    }

    // Read SSH key
    let sshKey: string;
    try {
      sshKey = (await readFile(sshKeyPath, 'utf-8')).trim();
    } catch {
      return { success: false, message: `Cannot read SSH key: ${sshKeyPath}` };
    }

    const linuxUser = this.linuxUser(name);
    const homeDir = this.homeDir(name);

    try {
      // 1. Create Linux user
      this.log(`Creating user ${linuxUser}...`);
      await execFileAsync('useradd', [
        '--create-home',
        '--shell',
        '/bin/bash',
        '--home-dir',
        homeDir,
        linuxUser,
      ]);

      // 2. Allocate sub-UID/GID ranges
      this.log('Allocating sub-UID/GID ranges...');
      await this.allocateSubIds(linuxUser);

      // 3. Enable systemd lingering (user services run without login)
      this.log('Enabling systemd lingering...');
      await execFileAsync('loginctl', ['enable-linger', linuxUser]);

      // 4. Set up SSH access
      this.log('Setting up SSH access...');
      const sshDir = join(homeDir, '.ssh');
      await mkdir(sshDir, { recursive: true });
      await writeFile(join(sshDir, 'authorized_keys'), sshKey + '\n', { mode: 0o600 });
      await this.chown(sshDir, linuxUser);
      await this.chown(join(sshDir, 'authorized_keys'), linuxUser);

      // 5. Create FlowHelm config directory
      this.log('Creating FlowHelm directories...');
      const configDir = join(homeDir, '.flowhelm');
      const secretsDir = join(configDir, 'secrets');
      await mkdir(secretsDir, { recursive: true });
      await this.chown(configDir, linuxUser);
      await this.chown(secretsDir, linuxUser);

      // 6. Write initial config
      const initialConfig = {
        agent: {
          runtime: options.agentRuntime ?? 'cli',
          maxConcurrent: maxAgents,
        },
      };
      const configPath = join(configDir, 'config.yaml');
      const { stringify: stringifyYaml } = await import('yaml');
      await writeFile(configPath, stringifyYaml(initialConfig), { mode: 0o600 });
      await this.chown(configPath, linuxUser);

      // 7. Initialize Podman for the user
      this.log('Initializing Podman rootless...');
      await this.runAsUser(linuxUser, 'podman', ['system', 'migrate']);

      // 8. Create per-user Podman network
      this.log('Creating Podman network...');
      const networkName = `flowhelm-network-${name}`;
      await this.runAsUser(linuxUser, 'podman', ['network', 'create', networkName]);

      // 9. Allocate ports
      this.log('Allocating ports...');
      const ports = await this.portRegistry.allocate(name);

      // 10. Generate and install systemd service
      this.log('Installing systemd service...');
      const unit = await installService({
        username: linuxUser,
        homeDir,
        binaryPath: this.binaryPath,
        ramLimit,
        cpuLimit,
        agentRuntime: options.agentRuntime,
      });
      await this.chown(join(homeDir, '.config'), linuxUser);

      this.log('');
      this.log(`User "${name}" created successfully.`);
      this.log('');
      this.log('Details:');
      this.log(`  Linux user:    ${linuxUser}`);
      this.log(`  Home:          ${homeDir}`);
      this.log(`  Config:        ${configDir}`);
      this.log(`  Service:       ${unit.serviceName}`);
      this.log(
        `  Ports:         proxy=${String(ports.ports.proxy)}, channel=${String(ports.ports.channel)}, service=${String(ports.ports.service)}, db=${String(ports.ports.database)}`,
      );
      this.log(`  RAM limit:     ${ramLimit}`);
      this.log(`  CPU limit:     ${String(cpuLimit)} core(s)`);
      this.log(`  Max agents:    ${String(maxAgents)}`);
      this.log('');
      this.log('Next steps:');
      this.log(`  1. User logs in:  ssh ${linuxUser}@<this-vm>`);
      this.log('  2. User runs:     flowhelm setup');
      this.log('  3. User starts:   systemctl --user enable --now flowhelm.service');

      return { success: true, message: `User "${name}" created` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, message: `Failed to create user "${name}": ${msg}` };
    }
  }

  /**
   * Remove a user and their resources.
   */
  async removeUser(options: RemoveUserOptions): Promise<UserManagerResult> {
    const { name, archive, force } = options;
    const linuxUser = this.linuxUser(name);
    const homeDir = this.homeDir(name);

    if (!archive && !force) {
      return {
        success: false,
        message: 'Specify --archive to back up data or --force to remove without backup',
      };
    }

    if (!(await this.userExists(name))) {
      return { success: false, message: `User "${name}" does not exist` };
    }

    try {
      // 1. Stop containers
      this.log('Stopping containers...');
      try {
        await this.runAsUser(linuxUser, 'podman', ['stop', '--all', '--time', '10']);
      } catch {
        // Containers may not be running
      }

      // 2. Stop systemd service
      this.log('Stopping systemd service...');
      try {
        await execFileAsync('systemctl', [
          '--user',
          '--machine',
          `${linuxUser}@.host`,
          'stop',
          'flowhelm.service',
        ]);
      } catch {
        // Service may not be running
      }
      try {
        await execFileAsync('systemctl', [
          '--user',
          '--machine',
          `${linuxUser}@.host`,
          'disable',
          'flowhelm.service',
        ]);
      } catch {
        // Service may not be enabled
      }

      // 3. Archive if requested
      if (archive) {
        this.log('Archiving user data...');
        await mkdir(this.archiveDir, { recursive: true });
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const archivePath = join(this.archiveDir, `${name}-${timestamp}.tar.gz`);
        await execFileAsync('tar', ['czf', archivePath, '-C', '/home', this.linuxUser(name)]);
        this.log(`  Archived to: ${archivePath}`);
      }

      // 4. Remove Podman network + containers
      this.log('Removing Podman resources...');
      try {
        await this.runAsUser(linuxUser, 'podman', ['rm', '--all', '--force']);
      } catch {
        // May have no containers
      }
      try {
        await this.runAsUser(linuxUser, 'podman', ['network', 'rm', `flowhelm-network-${name}`]);
      } catch {
        // Network may not exist
      }

      // 5. Remove systemd service file
      this.log('Removing systemd service...');
      await removeService(homeDir);

      // 6. Free ports
      this.log('Freeing ports...');
      try {
        await this.portRegistry.free(name);
      } catch {
        // May not have an allocation
      }

      // 7. Disable lingering
      try {
        await execFileAsync('loginctl', ['disable-linger', linuxUser]);
      } catch {
        // May not be lingering
      }

      // 8. Remove Linux user
      this.log('Removing Linux user...');
      await execFileAsync('userdel', ['--remove', linuxUser]);

      this.log(`User "${name}" removed.`);
      return { success: true, message: `User "${name}" removed` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, message: `Failed to remove user "${name}": ${msg}` };
    }
  }

  /**
   * List all FlowHelm users on the system.
   */
  async listUsers(): Promise<UserInfo[]> {
    const allocations = await this.portRegistry.list();
    const users: UserInfo[] = [];

    for (const alloc of allocations) {
      const linuxUser = this.linuxUser(alloc.username);
      const homeDir = this.homeDir(alloc.username);

      let hasService = false;
      try {
        await access(join(homeDir, '.config', 'systemd', 'user', 'flowhelm.service'));
        hasService = true;
      } catch {
        // No service
      }

      users.push({
        name: alloc.username,
        linuxUser,
        homeDir,
        ports: alloc,
        hasService,
      });
    }

    return users;
  }

  /**
   * Get info about a specific user.
   */
  async getUserInfo(name: string): Promise<UserInfo | null> {
    const exists = await this.userExists(name);
    if (!exists) return null;

    const linuxUser = this.linuxUser(name);
    const homeDir = this.homeDir(name);
    const ports = await this.portRegistry.get(name);

    let hasService = false;
    try {
      await access(join(homeDir, '.config', 'systemd', 'user', 'flowhelm.service'));
      hasService = true;
    } catch {
      // No service
    }

    return { name, linuxUser, homeDir, ports, hasService };
  }

  // ─── Internal ───────────────────────────────────────────────────────────

  /**
   * Allocate sub-UID and sub-GID ranges for rootless Podman.
   * Appends to /etc/subuid and /etc/subgid.
   */
  private async allocateSubIds(linuxUser: string): Promise<void> {
    // Find the next available sub-ID range
    const nextStart = await this.findNextSubIdStart();

    const subuidLine = `${linuxUser}:${String(nextStart)}:${String(SUB_ID_RANGE)}\n`;
    const subgidLine = `${linuxUser}:${String(nextStart)}:${String(SUB_ID_RANGE)}\n`;

    await appendFile('/etc/subuid', subuidLine);
    await appendFile('/etc/subgid', subgidLine);
  }

  /**
   * Find the next available sub-ID start by scanning /etc/subuid.
   */
  private async findNextSubIdStart(): Promise<number> {
    let maxEnd = 100000; // Default start above system UIDs

    try {
      const content = await readFile('/etc/subuid', 'utf-8');
      for (const line of content.split('\n')) {
        const parts = line.split(':');
        if (parts.length >= 3) {
          const start = parseInt(parts[1] ?? '', 10);
          const count = parseInt(parts[2] ?? '', 10);
          if (!isNaN(start) && !isNaN(count)) {
            maxEnd = Math.max(maxEnd, start + count);
          }
        }
      }
    } catch {
      // File may not exist yet
    }

    return maxEnd;
  }

  /**
   * Run a command as a specific user via sudo.
   */
  private async runAsUser(
    linuxUser: string,
    command: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync('sudo', ['-u', linuxUser, command, ...args], {
      cwd: `/home/${linuxUser}`,
    });
  }

  /**
   * Recursively chown a path to a user.
   */
  private async chown(filePath: string, linuxUser: string): Promise<void> {
    const s = await stat(filePath);
    if (s.isDirectory()) {
      await execFileAsync('chown', ['-R', `${linuxUser}:${linuxUser}`, filePath]);
    } else {
      await execFileAsync('chown', [`${linuxUser}:${linuxUser}`, filePath]);
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function appendFile(filePath: string, content: string): Promise<void> {
  let existing = '';
  try {
    existing = await readFile(filePath, 'utf-8');
  } catch {
    // File doesn't exist
  }
  await writeFile(filePath, existing + content);
}
