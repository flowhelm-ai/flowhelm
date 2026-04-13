/**
 * Container lifecycle management.
 *
 * Higher-level operations built on top of ContainerRuntime:
 * - Orphan cleanup on startup (remove leftover flowhelm-* containers)
 * - Graceful shutdown with configurable drain timeout, then force-stop
 * - Per-user Podman network provisioning
 */

import type { ContainerRuntime, Startable } from '../orchestrator/types.js';

/** Naming conventions for FlowHelm containers and networks. */
export const NAMING = {
  /** Container name prefix for all FlowHelm containers. */
  containerPrefix: 'flowhelm-',
  /** Agent container name: flowhelm-agent-{username}-{taskId} */
  agentContainer: (username: string, taskId: string) => `flowhelm-agent-${username}-${taskId}`,
  /** Proxy container name: flowhelm-proxy-{username} */
  proxyContainer: (username: string) => `flowhelm-proxy-${username}`,
  /** Channel container name: flowhelm-channel-{username} */
  channelContainer: (username: string) => `flowhelm-channel-${username}`,
  /** Service container name: flowhelm-service-{username} */
  serviceContainer: (username: string) => `flowhelm-service-${username}`,
  /** Per-user network: flowhelm-network-{username} */
  network: (username: string) => `flowhelm-network-${username}`,
} as const;

export interface LifecycleManagerOptions {
  runtime: ContainerRuntime;
  username: string;
  /** Seconds to wait for containers to stop gracefully before force-killing. */
  drainTimeout?: number;
}

/**
 * Manages the lifecycle of a user's containers and network.
 * Implements Startable for integration with the orchestrator's shutdown sequence.
 */
export class ContainerLifecycleManager implements Startable {
  private readonly runtime: ContainerRuntime;
  private readonly username: string;
  private readonly drainTimeout: number;

  constructor(options: LifecycleManagerOptions) {
    this.runtime = options.runtime;
    this.username = options.username;
    this.drainTimeout = options.drainTimeout ?? 15;
  }

  /**
   * Startup: ensure network exists, clean up orphaned containers.
   */
  async start(): Promise<void> {
    await this.ensureNetwork();
    await this.cleanupOrphans();
  }

  /**
   * Shutdown: gracefully stop all user containers, then force-remove stragglers.
   */
  async stop(): Promise<void> {
    const containers = await this.runtime.list({
      namePrefix: `flowhelm-`,
    });

    // Filter to only this user's containers
    const userContainers = containers.filter(
      (c) =>
        c.name.startsWith(`flowhelm-agent-${this.username}-`) ||
        c.name === `flowhelm-proxy-${this.username}` ||
        c.name === `flowhelm-channel-${this.username}` ||
        c.name === `flowhelm-service-${this.username}`,
    );

    if (userContainers.length === 0) return;

    // Graceful stop with drain timeout
    const stopPromises = userContainers
      .filter((c) => c.state === 'running')
      .map((c) => this.runtime.stop(c.id, this.drainTimeout).catch(() => {}));
    await Promise.all(stopPromises);

    // Force remove all
    const removePromises = userContainers.map((c) => this.runtime.remove(c.id).catch(() => {}));
    await Promise.all(removePromises);
  }

  /**
   * Ensure the user's Podman network exists.
   */
  async ensureNetwork(): Promise<void> {
    const networkName = NAMING.network(this.username);
    const exists = await this.runtime.networkExists(networkName);
    if (!exists) {
      await this.runtime.createNetwork(networkName);
    }
  }

  /**
   * Remove orphaned containers from a previous crashed run.
   * Targets containers matching flowhelm-agent-{username}-* that are not running.
   */
  async cleanupOrphans(): Promise<void> {
    const containers = await this.runtime.list({
      namePrefix: `flowhelm-agent-${this.username}-`,
    });

    const orphans = containers.filter((c) => c.state !== 'running');
    const removePromises = orphans.map((c) => this.runtime.remove(c.id).catch(() => {}));
    await Promise.all(removePromises);

    if (orphans.length > 0) {
      console.log(`[flowhelm] Cleaned up ${String(orphans.length)} orphaned container(s).`);
    }
  }

  /**
   * Check if the user's proxy container is healthy.
   */
  async isProxyHealthy(): Promise<boolean> {
    const proxyName = NAMING.proxyContainer(this.username);
    const exists = await this.runtime.exists(proxyName);
    if (!exists) return false;
    return this.runtime.isHealthy(proxyName);
  }
}
