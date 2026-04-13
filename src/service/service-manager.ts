/**
 * Service container lifecycle manager.
 *
 * Manages the always-on `flowhelm-service-{username}` Podman container
 * that runs local media inference (STT, future vision/TTS). Follows
 * the same lifecycle pattern as ProxyManager:
 *   - Ensures container exists and is healthy on start
 *   - Periodic health checks with auto-restart
 *   - Graceful shutdown with container cleanup
 *
 * The service container runs on the per-user Podman network and routes
 * all external API calls (e.g., OpenAI Whisper) through the credential
 * proxy for auditing, rate limiting, and centralized key management.
 */

import { mkdir } from 'node:fs/promises';
import { NAMING } from '../container/lifecycle.js';
import { PLACEHOLDER_OPENAI_API_KEY } from '../proxy/placeholders.js';
import type { ContainerConfig, ContainerRuntime, Startable } from '../orchestrator/types.js';
import type { ServiceConfig } from './types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ServiceManagerOptions {
  runtime: ContainerRuntime;
  username: string;
  config: ServiceConfig;
  /** Host directory for downloaded media (shared with channel adapters). */
  downloadsDir: string;
  /** Host directory for GGML models (persisted across container restarts). */
  modelsDir: string;
  /** Host port to publish for host-to-container connectivity. */
  hostPort: number;
  /** Credential proxy URL (e.g., http://flowhelm-proxy-{username}:10255). */
  proxyUrl?: string;
  /** Path to the FlowHelm CA certificate on the host (for MITM TLS trust). */
  caCertPath?: string;
  /** Health check interval in ms (default: 30000). */
  healthCheckInterval?: number;
}

// ─── Manager ────────────────────────────────────────────────────────────────

export class ServiceManager implements Startable {
  private readonly runtime: ContainerRuntime;
  private readonly username: string;
  private readonly config: ServiceConfig;
  private readonly downloadsDir: string;
  private readonly modelsDir: string;
  private readonly hostPort: number;
  private readonly proxyUrl: string | undefined;
  private readonly caCertPath: string | undefined;
  private readonly healthCheckInterval: number;
  private healthCheckTimer?: ReturnType<typeof setInterval>;

  constructor(options: ServiceManagerOptions) {
    this.runtime = options.runtime;
    this.username = options.username;
    this.config = options.config;
    this.downloadsDir = options.downloadsDir;
    this.modelsDir = options.modelsDir;
    this.hostPort = options.hostPort;
    this.proxyUrl = options.proxyUrl;
    this.caCertPath = options.caCertPath;
    this.healthCheckInterval = options.healthCheckInterval ?? 30_000;
  }

  /** Container name for this user's service container. */
  get containerName(): string {
    return NAMING.serviceContainer(this.username);
  }

  /** Network name for this user. */
  get networkName(): string {
    return NAMING.network(this.username);
  }

  /**
   * Service container HTTP URL on the per-user Podman network (container-to-container).
   * Format: http://flowhelm-service-{username}:{port}
   */
  get serviceUrl(): string {
    return `http://${this.containerName}:${String(this.config.port)}`;
  }

  /**
   * Service container HTTP URL on the host (for orchestrator → service calls).
   * Format: http://127.0.0.1:{hostPort}
   */
  get hostUrl(): string {
    return `http://127.0.0.1:${String(this.hostPort)}`;
  }

  /**
   * Start the service container.
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
    await mkdir(this.modelsDir, { recursive: true });

    // Build and create container
    const containerConfig = this.buildContainerConfig();
    await this.runtime.create(containerConfig);
    await this.runtime.start(this.containerName);

    // Wait for the HTTP server to be ready
    await this.waitForHealth(30_000);

    this.startHealthChecks();
  }

  /**
   * Stop and remove the service container.
   */
  async stop(): Promise<void> {
    this.stopHealthChecks();

    const exists = await this.runtime.exists(this.containerName);
    if (!exists) return;

    await this.runtime.stop(this.containerName, 10).catch(() => {});
    await this.runtime.remove(this.containerName).catch(() => {});
  }

  /**
   * Check if the service container is healthy (running).
   */
  async isHealthy(): Promise<boolean> {
    try {
      return await this.runtime.isHealthy(this.containerName);
    } catch {
      return false;
    }
  }

  /**
   * Build the ContainerConfig for the service container.
   *
   * When proxyUrl and caCertPath are set (MITM TLS active), the service container
   * routes all HTTPS traffic through the credential proxy. OpenAI API calls
   * use a placeholder key that the proxy replaces with the real key.
   */
  buildContainerConfig(): ContainerConfig {
    const proxyUrl = this.proxyUrl;
    const caCertPath = this.caCertPath;
    const useProxy = !!(proxyUrl && caCertPath);
    const isOpenAi = this.config.stt.provider === 'openai_whisper';

    return {
      name: this.containerName,
      image: this.config.image,
      memoryLimit: this.config.memoryLimit,
      cpuLimit: this.config.cpuLimit,
      pidsLimit: 128,
      readOnly: false,
      ports: [`127.0.0.1:${String(this.hostPort)}:${String(this.config.port)}`],
      mounts: [
        // Model files (persisted across container restarts)
        {
          source: this.modelsDir,
          target: '/models',
          readOnly: true,
          selinuxLabel: 'Z',
        },
        // Downloaded media files (shared with channel adapters)
        {
          source: this.downloadsDir,
          target: '/downloads',
          readOnly: true,
          selinuxLabel: 'Z',
        },
        // CA certificate for MITM TLS trust (same mount as agent containers)
        ...(useProxy
          ? [
              {
                source: caCertPath,
                target: '/usr/local/share/ca-certificates/flowhelm-proxy-ca.crt',
                readOnly: true as const,
                selinuxLabel: 'Z' as const,
              },
            ]
          : []),
      ],
      tmpfs: [{ target: '/tmp', size: '100m', mode: '1777' }],
      env: {
        SERVICE_PORT: String(this.config.port),
        SERVICE_STT_ENABLED: String(this.config.stt.enabled),
        SERVICE_STT_PROVIDER: this.config.stt.provider,
        SERVICE_STT_MODEL: this.config.stt.modelPath,
        SERVICE_STT_LANGUAGE: this.config.stt.language,
        SERVICE_STT_THREADS: String(this.config.stt.threads),
        // Proxy routing: all HTTPS traffic goes through credential proxy
        ...(useProxy
          ? {
              HTTPS_PROXY: proxyUrl,
              HTTP_PROXY: proxyUrl,
              NO_PROXY: 'localhost,127.0.0.1',
              NODE_EXTRA_CA_CERTS: '/usr/local/share/ca-certificates/flowhelm-proxy-ca.crt',
            }
          : {}),
        // OpenAI Whisper: placeholder key (proxy injects real key via MITM)
        ...(isOpenAi ? { SERVICE_OPENAI_API_KEY: useProxy ? PLACEHOLDER_OPENAI_API_KEY : '' } : {}),
        NODE_ENV: 'production',
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
      `Service container ${this.containerName} did not become healthy within ${String(timeoutMs)}ms`,
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
      console.warn(`[service] Container ${this.containerName} unhealthy — attempting restart`);
      try {
        await this.runtime.stop(this.containerName, 5).catch(() => {});
        await this.runtime.remove(this.containerName).catch(() => {});
        const config = this.buildContainerConfig();
        await this.runtime.create(config);
        await this.runtime.start(this.containerName);
        console.log(`[service] Container ${this.containerName} restarted`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[service] Failed to restart container: ${msg}`);
      }
    }
  }
}
