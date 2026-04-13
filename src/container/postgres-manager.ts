/**
 * Per-user PostgreSQL container lifecycle manager.
 *
 * Manages the PostgreSQL 18 + pgvector container for a single user:
 * create, start, stop, health check, connection string generation.
 * Uses the ContainerRuntime interface (Podman or Apple Container).
 *
 * The PG container lives on the user's isolated Podman network
 * alongside the credential proxy. No external internet access.
 */

import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { ContainerConfig, ContainerRuntime, Startable } from '../orchestrator/types.js';
import { NAMING } from './lifecycle.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PostgresManagerOptions {
  runtime: ContainerRuntime;
  username: string;
  /** Host directory for persistent PG data. */
  dataDir: string;
  /** Container image (default: flowhelm-db:latest). */
  image?: string;
  /** Memory limit for the PG container (default: 256m). */
  memoryLimit?: string;
  /** CPU limit (default: 0.5). */
  cpuLimit?: string;
  /** Database name (default: flowhelm). */
  dbName?: string;
  /** Database user (default: flowhelm). */
  dbUser?: string;
  /** Database password. Auto-generated if not provided. */
  dbPassword?: string;
  /** Port inside the container (default: 5432). */
  port?: number;
  /** Host port to publish for host-to-container connectivity. If set, PG is reachable at localhost:hostPort. */
  hostPort?: number;
}

export interface PostgresConnectionInfo {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
}

// ─── Naming ─────────────────────────────────────────────────────────────────

/** Database container name: flowhelm-db-{username} */
export function dbContainerName(username: string): string {
  return `flowhelm-db-${username}`;
}

// ─── Manager ────────────────────────────────────────────────────────────────

export class PostgresContainerManager implements Startable {
  private readonly runtime: ContainerRuntime;
  private readonly username: string;
  private readonly dataDir: string;
  private readonly image: string;
  private readonly memoryLimit: string;
  private readonly cpuLimit: string;
  private readonly dbName: string;
  private readonly dbUser: string;
  private readonly dbPassword: string;
  private readonly port: number;
  private readonly hostPort: number | undefined;
  private readonly containerName: string;

  constructor(options: PostgresManagerOptions) {
    this.runtime = options.runtime;
    this.username = options.username;
    this.dataDir = options.dataDir;
    this.image = options.image ?? 'ghcr.io/flowhelm-ai/flowhelm-db:0.1.0';
    this.memoryLimit = options.memoryLimit ?? '256m';
    this.cpuLimit = options.cpuLimit ?? '0.5';
    this.dbName = options.dbName ?? 'flowhelm';
    this.dbUser = options.dbUser ?? 'flowhelm';
    this.dbPassword = options.dbPassword ?? randomBytes(24).toString('base64url');
    this.port = options.port ?? 5432;
    this.hostPort = options.hostPort;
    this.containerName = dbContainerName(this.username);
  }

  /**
   * Ensure the PostgreSQL container is running.
   * Creates it if it doesn't exist, starts it if stopped.
   */
  async start(): Promise<void> {
    const exists = await this.runtime.exists(this.containerName);

    if (exists) {
      const healthy = await this.runtime.isHealthy(this.containerName);
      if (!healthy) {
        // Container exists but isn't running — start it
        await this.runtime.start(this.containerName);
      }
      return;
    }

    // Ensure host data directory exists before mounting
    await mkdir(this.dataDir, { recursive: true });

    // Create and start
    const config = this.buildContainerConfig();
    await this.runtime.create(config);
    await this.runtime.start(this.containerName);
  }

  /**
   * Stop the PostgreSQL container gracefully.
   * Uses a 30-second timeout to allow PG to flush WAL and checkpoint.
   */
  async stop(): Promise<void> {
    const exists = await this.runtime.exists(this.containerName);
    if (!exists) return;

    const healthy = await this.runtime.isHealthy(this.containerName);
    if (healthy) {
      await this.runtime.stop(this.containerName, 30);
    }
  }

  /** Check if PostgreSQL is running and accepting connections. */
  async isHealthy(): Promise<boolean> {
    const exists = await this.runtime.exists(this.containerName);
    if (!exists) return false;

    try {
      const result = await this.runtime.exec(this.containerName, [
        'pg_isready',
        '-U',
        this.dbUser,
        '-d',
        this.dbName,
      ]);
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  /** Get connection info for the orchestrator to connect. */
  getConnectionInfo(): PostgresConnectionInfo {
    return {
      host: this.containerName,
      port: this.port,
      database: this.dbName,
      username: this.dbUser,
      password: this.dbPassword,
    };
  }

  /**
   * Build a postgres.js connection URL.
   * Uses localhost:hostPort when a host port is published (for host-side orchestrator),
   * otherwise uses the container name (resolved via Podman network DNS).
   */
  getConnectionUrl(): string {
    const { database, username, password } = this.getConnectionInfo();
    const host = this.hostPort ? 'localhost' : this.containerName;
    const port = this.hostPort ?? this.port;
    return `postgres://${username}:${encodeURIComponent(password)}@${host}:${String(port)}/${database}`;
  }

  /** Get the container name. */
  getName(): string {
    return this.containerName;
  }

  /** Get the generated or provided password. */
  getPassword(): string {
    return this.dbPassword;
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /** Build the ContainerConfig for the PG container. */
  buildContainerConfig(): ContainerConfig {
    return {
      name: this.containerName,
      image: this.image,
      memoryLimit: this.memoryLimit,
      cpuLimit: this.cpuLimit,
      pidsLimit: 128,
      readOnly: false,
      ports: this.hostPort ? [`127.0.0.1:${String(this.hostPort)}:${String(this.port)}`] : [],
      mounts: [
        {
          source: this.dataDir,
          target: '/var/lib/postgresql/data',
          readOnly: false,
          selinuxLabel: 'Z',
        },
      ],
      tmpfs: [
        { target: '/tmp', size: '64m' },
        { target: '/run/postgresql', size: '8m' },
      ],
      env: {
        POSTGRES_USER: this.dbUser,
        POSTGRES_DB: this.dbName,
        POSTGRES_PASSWORD: this.dbPassword,
        PGDATA: '/var/lib/postgresql/data',
      },
      network: NAMING.network(this.username),
      securityOpts: ['no-new-privileges'],
    };
  }
}
