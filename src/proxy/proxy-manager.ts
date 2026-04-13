/**
 * Proxy container lifecycle manager.
 *
 * Manages the flowhelm-proxy-{username} container: creation, startup,
 * health checking, and shutdown. The proxy container runs continuously
 * and is started before any agent containers.
 *
 * The manager reads the encryption key from the credential store and
 * passes it to the proxy container as an environment variable at launch.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ContainerRuntime, ContainerConfig, Startable } from '../orchestrator/types.js';
import { NAMING } from '../container/lifecycle.js';
import type { CredentialStore } from './credential-store.js';
import { caPaths } from './ca-manager.js';

export interface ProxyManagerOptions {
  /** Container runtime (Podman or Apple Container). */
  runtime: ContainerRuntime;
  /** FlowHelm username. */
  username: string;
  /** Credential store for reading the encryption key. */
  credentialStore: CredentialStore;
  /** Proxy container image (default: flowhelm-proxy:latest). */
  proxyImage?: string;
  /** Memory limit for the proxy container (default: 64m). */
  memoryLimit?: string;
  /** CPU limit for the proxy container (default: 0.25). */
  cpuLimit?: string;
  /** Port the proxy listens on inside the container (default: 10255). */
  proxyPort?: number;
  /** Health check interval in ms (default: 30000). */
  healthCheckInterval?: number;
  /** Active billing method — proxy only injects credentials matching this method. */
  credentialMethod?: 'oauth' | 'api_key';
}

/**
 * Manages the per-user credential proxy container.
 *
 * Lifecycle:
 *   start() → ensure container exists and is running → start health checks
 *   stop()  → stop health checks → stop and remove container
 *
 * The proxy container:
 *   - Runs on the user's isolated Podman network
 *   - Mounts ~/.flowhelm/secrets/ read-only for encrypted credentials
 *   - Receives the decryption key via PROXY_DECRYPTION_KEY env var
 *   - Listens on port 10255 for HTTP proxy requests
 *   - Read-only root filesystem, non-root user, no-new-privileges
 */
export class ProxyManager implements Startable {
  private readonly runtime: ContainerRuntime;
  private readonly username: string;
  private readonly credentialStore: CredentialStore;
  private readonly proxyImage: string;
  private readonly memoryLimit: string;
  private readonly cpuLimit: string;
  private readonly proxyPort: number;
  private readonly healthCheckInterval: number;
  private readonly credentialMethod: 'oauth' | 'api_key' | undefined;
  private healthCheckTimer?: ReturnType<typeof setInterval>;

  constructor(options: ProxyManagerOptions) {
    this.runtime = options.runtime;
    this.username = options.username;
    this.credentialStore = options.credentialStore;
    this.proxyImage = options.proxyImage ?? 'ghcr.io/flowhelm-ai/flowhelm-proxy:0.1.0';
    this.memoryLimit = options.memoryLimit ?? '128m';
    this.cpuLimit = options.cpuLimit ?? '0.25';
    this.proxyPort = options.proxyPort ?? 10255;
    this.healthCheckInterval = options.healthCheckInterval ?? 30_000;
    this.credentialMethod = options.credentialMethod;
  }

  /** Container name for this user's proxy. */
  get containerName(): string {
    return NAMING.proxyContainer(this.username);
  }

  /** Network name for this user. */
  get networkName(): string {
    return NAMING.network(this.username);
  }

  /** Host directory for proxy logs (audit, cost). Persists across container restarts. */
  get logsDir(): string {
    return join(this.credentialStore.secretsDir, '..', 'logs', 'proxy');
  }

  /**
   * Start the proxy container.
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

    // Read the encryption key
    const key = await this.credentialStore.readKey();

    // Ensure CA for MITM TLS interception
    await this.credentialStore.ensureCA(this.username);

    // Ensure proxy logs directory exists on host (persists across restarts)
    await mkdir(this.logsDir, { recursive: true });

    // Build container config
    const config = this.buildContainerConfig(key);

    // Create and start
    await this.runtime.create(config);
    await this.runtime.start(this.containerName);

    // Wait for health
    await this.waitForHealth(10_000);

    this.startHealthChecks();
  }

  /**
   * Stop and remove the proxy container.
   */
  async stop(): Promise<void> {
    this.stopHealthChecks();

    const exists = await this.runtime.exists(this.containerName);
    if (!exists) return;

    await this.runtime.stop(this.containerName, 10).catch(() => {});
    await this.runtime.remove(this.containerName).catch(() => {});
  }

  /**
   * Check if the proxy is healthy (running and responding).
   */
  async isHealthy(): Promise<boolean> {
    try {
      return await this.runtime.isHealthy(this.containerName);
    } catch {
      return false;
    }
  }

  /**
   * Build the ContainerConfig for the proxy container.
   */
  buildContainerConfig(key: Buffer): ContainerConfig {
    const ca = caPaths(this.credentialStore.secretsDir);

    return {
      name: this.containerName,
      image: this.proxyImage,
      memoryLimit: this.memoryLimit,
      cpuLimit: this.cpuLimit,
      pidsLimit: 64,
      readOnly: true,
      mounts: [
        {
          source: this.credentialStore.encPath,
          target: '/secrets/credentials.enc',
          readOnly: true,
          selinuxLabel: 'Z',
        },
        {
          source: ca.keyPath,
          target: '/secrets/ca.key',
          readOnly: true,
          selinuxLabel: 'Z',
        },
        {
          source: ca.certPath,
          target: '/secrets/ca.crt',
          readOnly: true,
          selinuxLabel: 'Z',
        },
        {
          source: this.logsDir,
          target: '/var/log/flowhelm',
          readOnly: false,
          selinuxLabel: 'Z',
        },
      ],
      tmpfs: [{ target: '/tmp', size: '10m', mode: '1777' }],
      env: {
        PROXY_DECRYPTION_KEY: key.toString('hex'),
        PROXY_PORT: String(this.proxyPort),
        NODE_ENV: 'production',
        ...(this.credentialMethod ? { CREDENTIAL_METHOD: this.credentialMethod } : {}),
      },
      network: this.networkName,
      securityOpts: ['no-new-privileges'],
      userNamespace: 'keep-id:uid=1000,gid=1000',
      command: ['node', '/app/main.js'],
    };
  }

  /**
   * Wait for the proxy to become healthy, with timeout.
   */
  private async waitForHealth(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const pollInterval = 500;

    while (Date.now() < deadline) {
      const healthy = await this.isHealthy();
      if (healthy) return;
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    throw new Error(
      `Proxy container ${this.containerName} did not become healthy within ${String(timeoutMs)}ms`,
    );
  }

  /**
   * Start periodic health checks. If the proxy dies, attempt restart.
   */
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
      console.warn(
        `[flowhelm] Proxy container ${this.containerName} unhealthy, attempting restart...`,
      );
      try {
        await this.start();
        console.log(`[flowhelm] Proxy container ${this.containerName} restarted successfully.`);
      } catch (err) {
        console.error(`[flowhelm] Failed to restart proxy container:`, err);
      }
    }
  }

  /**
   * Reload credentials by sending SIGHUP to the proxy container process.
   * The proxy's SIGHUP handler re-reads credentials.enc and rebuilds state.
   */
  async reloadCredentials(): Promise<void> {
    const exists = await this.runtime.exists(this.containerName);
    if (!exists) {
      throw new Error(`Proxy container ${this.containerName} is not running`);
    }

    // Send SIGHUP to PID 1 (the Node.js process) inside the proxy container
    await this.runtime.exec(this.containerName, ['kill', '-HUP', '1']);
    console.log(`[flowhelm] Sent SIGHUP to proxy container ${this.containerName}`);
  }

  /**
   * Get the proxy URL for agent containers to use.
   * Format: http://flowhelm-proxy-{username}:10255
   */
  get proxyUrl(): string {
    return `http://${this.containerName}:${String(this.proxyPort)}`;
  }
}
