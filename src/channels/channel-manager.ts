/**
 * Channel container lifecycle manager.
 *
 * Manages the always-on `flowhelm-channel-{username}` Podman container
 * that hosts all channel adapters (Telegram, Gmail, future WhatsApp/Slack).
 * Follows the same lifecycle pattern as ServiceManager:
 *   - Ensures container exists and is healthy on start
 *   - Periodic health checks with auto-restart
 *   - Graceful shutdown with container cleanup
 *
 * The channel container runs on the per-user Podman network, connects
 * to PostgreSQL for inbound message writes, and exposes an HTTP API
 * for outbound message delivery.
 */

import { mkdir } from 'node:fs/promises';
import { NAMING } from '../container/lifecycle.js';
import type { ContainerConfig, ContainerRuntime, Startable } from '../orchestrator/types.js';
import type { ChannelContainerConfig } from './channel-types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ChannelManagerOptions {
  runtime: ContainerRuntime;
  username: string;
  config: ChannelContainerConfig;
  /** Host directory for downloaded media (shared with service container). */
  downloadsDir: string;
  /** Host directory for channel logs. */
  logsDir: string;
  /** Path to credentials.enc on the host. */
  credentialsEncPath: string;
  /** Hex-encoded 32-byte AES key for credentials.enc. */
  credentialKeyHex: string;
  /** Database connection parameters (passed as env vars). */
  dbHost: string;
  dbPort: number;
  dbUser: string;
  dbPassword: string;
  dbName: string;
  /** Channel-specific env vars (TELEGRAM_ENABLED, GMAIL_ENABLED, etc.). */
  channelEnv: Record<string, string>;
  /** Host port to publish for host-to-container connectivity. */
  hostPort: number;
  /** Health check interval in ms (default: 30000). */
  healthCheckInterval?: number;
}

// ─── Manager ────────────────────────────────────────────────────────────────

export class ChannelManager implements Startable {
  private readonly runtime: ContainerRuntime;
  private readonly username: string;
  private readonly config: ChannelContainerConfig;
  private readonly downloadsDir: string;
  private readonly logsDir: string;
  private readonly credentialsEncPath: string;
  private readonly credentialKeyHex: string;
  private readonly dbHost: string;
  private readonly dbPort: number;
  private readonly dbUser: string;
  private readonly dbPassword: string;
  private readonly dbName: string;
  private readonly channelEnv: Record<string, string>;
  private readonly hostPort: number;
  private readonly healthCheckInterval: number;
  private healthCheckTimer?: ReturnType<typeof setInterval>;

  constructor(options: ChannelManagerOptions) {
    this.runtime = options.runtime;
    this.username = options.username;
    this.config = options.config;
    this.downloadsDir = options.downloadsDir;
    this.logsDir = options.logsDir;
    this.credentialsEncPath = options.credentialsEncPath;
    this.credentialKeyHex = options.credentialKeyHex;
    this.dbHost = options.dbHost;
    this.dbPort = options.dbPort;
    this.dbUser = options.dbUser;
    this.dbPassword = options.dbPassword;
    this.dbName = options.dbName;
    this.channelEnv = options.channelEnv;
    this.hostPort = options.hostPort;
    this.healthCheckInterval = options.healthCheckInterval ?? 30_000;
  }

  /** Container name for this user's channel container. */
  get containerName(): string {
    return NAMING.channelContainer(this.username);
  }

  /** Network name for this user. */
  get networkName(): string {
    return NAMING.network(this.username);
  }

  /**
   * Channel container HTTP URL on the per-user Podman network.
   * Format: http://flowhelm-channel-{username}:{port}
   */
  get channelUrl(): string {
    return `http://${this.containerName}:${String(this.config.port)}`;
  }

  /**
   * Channel container HTTP URL on the host.
   * Format: http://127.0.0.1:{hostPort}
   */
  get hostUrl(): string {
    return `http://127.0.0.1:${String(this.hostPort)}`;
  }

  /**
   * Start the channel container.
   * If already running, verifies health. If stopped, removes and recreates.
   */
  async start(): Promise<void> {
    const exists = await this.runtime.exists(this.containerName);

    if (exists) {
      const healthy = await this.runtime.isHealthy(this.containerName);
      if (healthy) {
        this.startHealthChecks();
        return;
      }
      // Unhealthy — remove and recreate
      await this.runtime.stop(this.containerName, 5).catch(() => {});
      await this.runtime.remove(this.containerName).catch(() => {});
    }

    // Ensure host directories exist
    await mkdir(this.downloadsDir, { recursive: true });
    await mkdir(this.logsDir, { recursive: true });

    // Build and create container
    const containerConfig = this.buildContainerConfig();
    await this.runtime.create(containerConfig);
    await this.runtime.start(this.containerName);

    // Wait for the HTTP server to be ready
    await this.waitForHealth(30_000);

    this.startHealthChecks();
  }

  /**
   * Stop and remove the channel container.
   */
  async stop(): Promise<void> {
    this.stopHealthChecks();

    const exists = await this.runtime.exists(this.containerName);
    if (!exists) return;

    await this.runtime.stop(this.containerName, 10).catch(() => {});
    await this.runtime.remove(this.containerName).catch(() => {});
  }

  /**
   * Check if the channel container is healthy (running).
   */
  async isHealthy(): Promise<boolean> {
    try {
      return await this.runtime.isHealthy(this.containerName);
    } catch {
      return false;
    }
  }

  /**
   * Send SIGHUP to the channel container to reload credentials.
   */
  async reloadCredentials(): Promise<void> {
    await this.runtime.exec(this.containerName, ['kill', '-HUP', '1']);
  }

  /**
   * Build the ContainerConfig for the channel container.
   */
  buildContainerConfig(): ContainerConfig {
    return {
      name: this.containerName,
      image: this.config.image,
      memoryLimit: this.config.memoryLimit,
      cpuLimit: this.config.cpuLimit,
      pidsLimit: 128,
      readOnly: true,
      ports: [`127.0.0.1:${String(this.hostPort)}:${String(this.config.port)}`],
      mounts: [
        // Encrypted credentials (RW: WhatsApp auth state writes back to vault)
        {
          source: this.credentialsEncPath,
          target: '/secrets/credentials.enc',
          readOnly: false,
          selinuxLabel: 'Z',
        },
        // Downloaded media files (shared with service container)
        {
          source: this.downloadsDir,
          target: '/downloads',
          readOnly: false,
          selinuxLabel: 'z',
        },
        // Channel logs
        {
          source: this.logsDir,
          target: '/var/log/flowhelm',
          readOnly: false,
          selinuxLabel: 'Z',
        },
      ],
      tmpfs: [{ target: '/tmp', size: '50m', mode: '1777' }],
      env: {
        CREDENTIAL_KEY: this.credentialKeyHex,
        CHANNEL_PORT: String(this.config.port),
        DB_HOST: this.dbHost,
        DB_PORT: String(this.dbPort),
        DB_USER: this.dbUser,
        DB_PASSWORD: this.dbPassword,
        DB_NAME: this.dbName,
        NODE_ENV: 'production',
        ...this.channelEnv,
      },
      network: this.networkName,
      securityOpts: ['no-new-privileges'],
      userNamespace: 'keep-id:uid=1000,gid=1000',
    };
  }

  // ── Health Checks ─────────────────────────────────────────────────────────

  private async waitForHealth(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const pollInterval = 500;

    while (Date.now() < deadline) {
      // Check HTTP health endpoint directly (not Podman health status,
      // which only checks State.Running and returns before the server is listening)
      try {
        const res = await fetch(`${this.hostUrl}/healthz`, {
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) return;
      } catch {
        // Server not ready yet — keep polling
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    throw new Error(
      `Channel container ${this.containerName} did not become healthy within ${String(timeoutMs)}ms`,
    );
  }

  private startHealthChecks(): void {
    this.stopHealthChecks();
    this.healthCheckTimer = setInterval(() => {
      void this.healthCheck();
    }, this.healthCheckInterval);
  }

  private stopHealthChecks(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }
  }

  private async healthCheck(): Promise<void> {
    const healthy = await this.isHealthy();
    if (!healthy) {
      console.warn(`[channel] Container ${this.containerName} unhealthy — attempting restart`);
      try {
        await this.runtime.stop(this.containerName, 5).catch(() => {});
        await this.runtime.remove(this.containerName).catch(() => {});
        const config = this.buildContainerConfig();
        await this.runtime.create(config);
        await this.runtime.start(this.containerName);
        console.log(`[channel] Container ${this.containerName} restarted`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[channel] Failed to restart container: ${msg}`);
      }
    }
  }
}
