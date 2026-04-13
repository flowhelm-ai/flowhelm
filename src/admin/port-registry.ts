/**
 * Port registry for multi-tenant port allocation.
 *
 * Maintains a JSON file at /etc/flowhelm/ports.json that tracks which
 * ports are allocated to which users. Each user gets a block of ports
 * for their containers (proxy, channel, service, database, etc.).
 *
 * Port allocation is sequential from a configurable base port (default: 10000).
 * Each user gets PORTS_PER_USER (default: 10) consecutive ports.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PortAllocation {
  /** Username this block is allocated to. */
  username: string;
  /** First port in the block (inclusive). */
  basePort: number;
  /** Port assignments within the block. */
  ports: {
    proxy: number;
    channel: number;
    service: number;
    database: number;
  };
  /** When this allocation was created (ISO string). */
  allocatedAt: string;
}

export interface PortRegistryData {
  /** Lowest port to allocate from. */
  basePort: number;
  /** Number of ports per user. */
  portsPerUser: number;
  /** Current allocations. */
  allocations: PortAllocation[];
}

export interface PortRegistryOptions {
  /** Path to the registry JSON file. Default: /etc/flowhelm/ports.json */
  registryPath?: string;
  /** Base port for allocations. Default: 10000 */
  basePort?: number;
  /** Ports per user block. Default: 10 */
  portsPerUser?: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_REGISTRY_PATH = '/etc/flowhelm/ports.json';
const DEFAULT_BASE_PORT = 10000;
const DEFAULT_PORTS_PER_USER = 10;
const MAX_PORT = 65535;

// Port offsets within each user's block
const PORT_OFFSETS = {
  proxy: 0,
  channel: 1,
  service: 2,
  database: 3,
} as const;

// ─── Port Registry ─────────────────────────────────────────────────────────

export class PortRegistry {
  readonly registryPath: string;
  private readonly defaultBasePort: number;
  private readonly defaultPortsPerUser: number;

  constructor(options?: PortRegistryOptions) {
    this.registryPath = options?.registryPath ?? DEFAULT_REGISTRY_PATH;
    this.defaultBasePort = options?.basePort ?? DEFAULT_BASE_PORT;
    this.defaultPortsPerUser = options?.portsPerUser ?? DEFAULT_PORTS_PER_USER;
  }

  /**
   * Initialize the registry file. Creates it if it doesn't exist.
   * Safe to call multiple times (idempotent).
   */
  async init(): Promise<void> {
    try {
      await readFile(this.registryPath, 'utf-8');
      // File exists — don't overwrite
    } catch {
      const data: PortRegistryData = {
        basePort: this.defaultBasePort,
        portsPerUser: this.defaultPortsPerUser,
        allocations: [],
      };
      await mkdir(dirname(this.registryPath), { recursive: true });
      await writeFile(this.registryPath, JSON.stringify(data, null, 2), 'utf-8');
    }
  }

  /**
   * Read the current registry state.
   */
  async read(): Promise<PortRegistryData> {
    const raw = await readFile(this.registryPath, 'utf-8');
    return JSON.parse(raw) as PortRegistryData;
  }

  /**
   * Write the registry state back to disk.
   */
  private async write(data: PortRegistryData): Promise<void> {
    await writeFile(this.registryPath, JSON.stringify(data, null, 2), 'utf-8');
  }

  /**
   * Allocate a port block for a user.
   * Throws if the user already has an allocation or if ports are exhausted.
   */
  async allocate(username: string): Promise<PortAllocation> {
    const data = await this.read();

    // Check for existing allocation
    const existing = data.allocations.find((a) => a.username === username);
    if (existing) {
      throw new Error(`Port allocation already exists for user "${username}"`);
    }

    // Find next available base port
    const usedBases = data.allocations.map((a) => a.basePort).sort((a, b) => a - b);
    let nextBase = data.basePort;

    for (const used of usedBases) {
      if (nextBase === used) {
        nextBase = used + data.portsPerUser;
      }
    }

    // Check we don't exceed max port
    if (nextBase + data.portsPerUser - 1 > MAX_PORT) {
      throw new Error(
        `Port exhaustion: cannot allocate ${String(data.portsPerUser)} ports starting from ${String(nextBase)}`,
      );
    }

    const allocation: PortAllocation = {
      username,
      basePort: nextBase,
      ports: {
        proxy: nextBase + PORT_OFFSETS.proxy,
        channel: nextBase + PORT_OFFSETS.channel,
        service: nextBase + PORT_OFFSETS.service,
        database: nextBase + PORT_OFFSETS.database,
      },
      allocatedAt: new Date().toISOString(),
    };

    data.allocations.push(allocation);
    await this.write(data);
    return allocation;
  }

  /**
   * Free a user's port allocation.
   * Throws if the user has no allocation.
   */
  async free(username: string): Promise<PortAllocation> {
    const data = await this.read();
    const idx = data.allocations.findIndex((a) => a.username === username);
    if (idx === -1) {
      throw new Error(`No port allocation found for user "${username}"`);
    }

    const [removed] = data.allocations.splice(idx, 1);
    await this.write(data);
    // splice at a known-valid index always returns one element
    if (!removed) throw new Error(`Unexpected empty splice for user "${username}"`);
    return removed;
  }

  /**
   * Get a user's port allocation.
   * Returns undefined if not allocated.
   */
  async get(username: string): Promise<PortAllocation | undefined> {
    const data = await this.read();
    return data.allocations.find((a) => a.username === username);
  }

  /**
   * List all port allocations.
   */
  async list(): Promise<PortAllocation[]> {
    const data = await this.read();
    return data.allocations;
  }

  /**
   * Detect port conflicts — ports allocated to multiple users or
   * overlapping blocks. Returns an array of conflict descriptions.
   */
  async detectConflicts(): Promise<string[]> {
    const data = await this.read();
    const conflicts: string[] = [];

    for (let i = 0; i < data.allocations.length; i++) {
      const a = data.allocations[i];
      if (!a) continue;
      const aEnd = a.basePort + data.portsPerUser - 1;

      for (let j = i + 1; j < data.allocations.length; j++) {
        const b = data.allocations[j];
        if (!b) continue;
        const bEnd = b.basePort + data.portsPerUser - 1;

        // Check for overlap
        if (a.basePort <= bEnd && b.basePort <= aEnd) {
          conflicts.push(
            `Port overlap: ${a.username} (${String(a.basePort)}-${String(aEnd)}) ` +
              `and ${b.username} (${String(b.basePort)}-${String(bEnd)})`,
          );
        }
      }

      // Check duplicate usernames
      for (let j = i + 1; j < data.allocations.length; j++) {
        const b = data.allocations[j];
        if (!b) continue;
        if (a.username === b.username) {
          conflicts.push(`Duplicate allocation for user "${a.username}"`);
        }
      }
    }

    return conflicts;
  }
}
