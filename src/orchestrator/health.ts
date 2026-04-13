/**
 * Health monitor with exponential backoff.
 *
 * Periodically checks the health of registered components (proxy, DB,
 * channels, service). On failure, applies exponential backoff before
 * retrying. On recovery, resets to the base interval.
 *
 * The orchestrator queries `isHealthy(name)` before dispatching agent
 * tasks — if the proxy is unhealthy, messages stay queued until recovery.
 */

import type { Startable } from './types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface HealthCheckTarget {
  /** Unique name for this component (e.g., 'proxy', 'database'). */
  name: string;
  /** Returns true if the component is healthy. Should not throw. */
  check: () => Promise<boolean>;
  /** Optional: attempt to restart the component on failure. */
  restart?: () => Promise<void>;
}

export interface HealthMonitorOptions {
  targets: HealthCheckTarget[];
  /** Base health check interval in ms. Default: 30000 (30s). */
  baseInterval?: number;
  /** Maximum backoff interval in ms. Default: 300000 (5 min). */
  maxBackoff?: number;
  /** Backoff multiplier. Default: 2. */
  backoffMultiplier?: number;
  /** Log function. */
  log?: (msg: string) => void;
}

export interface ComponentHealth {
  name: string;
  healthy: boolean;
  lastCheck: Date;
  lastHealthy: Date | null;
  consecutiveFailures: number;
  currentInterval: number;
}

// ─── Health Monitor ─────────────────────────────────────────────────────────

export class HealthMonitor implements Startable {
  private readonly targets: HealthCheckTarget[];
  private readonly baseInterval: number;
  private readonly maxBackoff: number;
  private readonly backoffMultiplier: number;
  private readonly log: (msg: string) => void;

  private readonly state = new Map<string, ComponentHealth>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private running = false;

  constructor(options: HealthMonitorOptions) {
    this.targets = options.targets;
    this.baseInterval = options.baseInterval ?? 30_000;
    this.maxBackoff = options.maxBackoff ?? 300_000;
    this.backoffMultiplier = options.backoffMultiplier ?? 2;
    this.log = options.log ?? console.log;

    // Initialize state for each target
    for (const target of this.targets) {
      this.state.set(target.name, {
        name: target.name,
        healthy: true, // Assume healthy until first check
        lastCheck: new Date(),
        lastHealthy: null,
        consecutiveFailures: 0,
        currentInterval: this.baseInterval,
      });
    }
  }

  async start(): Promise<void> {
    this.running = true;

    // Run initial health check for all targets, then schedule recurring checks
    for (const target of this.targets) {
      await this.checkTarget(target);
      this.scheduleNext(target);
    }

    this.log('[health] Health monitor started');
  }

  async stop(): Promise<void> {
    this.running = false;

    // Clear all timers
    for (const [name, timer] of this.timers) {
      clearTimeout(timer);
      this.timers.delete(name);
    }

    this.log('[health] Health monitor stopped');
  }

  /**
   * Check if a component is currently healthy.
   * Returns true if the component has not failed its last health check.
   */
  isHealthy(name: string): boolean {
    const health = this.state.get(name);
    return health?.healthy ?? false;
  }

  /**
   * Get health status for all components.
   */
  getAllHealth(): ComponentHealth[] {
    return Array.from(this.state.values());
  }

  /**
   * Calculate the next check interval using exponential backoff.
   */
  calculateBackoff(consecutiveFailures: number): number {
    if (consecutiveFailures === 0) return this.baseInterval;
    const backoff = this.baseInterval * Math.pow(this.backoffMultiplier, consecutiveFailures);
    return Math.min(backoff, this.maxBackoff);
  }

  // ─── Internal ───────────────────────────────────────────────────────────

  private async checkTarget(target: HealthCheckTarget): Promise<void> {
    const health = this.state.get(target.name);
    if (!health) return;

    try {
      const isHealthy = await target.check();
      health.lastCheck = new Date();

      if (isHealthy) {
        if (!health.healthy) {
          this.log(
            `[health] ${target.name} recovered after ${String(health.consecutiveFailures)} failure(s)`,
          );
        }
        health.healthy = true;
        health.lastHealthy = new Date();
        health.consecutiveFailures = 0;
        health.currentInterval = this.baseInterval;
      } else {
        health.healthy = false;
        health.consecutiveFailures++;
        health.currentInterval = this.calculateBackoff(health.consecutiveFailures);

        this.log(
          `[health] ${target.name} unhealthy (failure #${String(health.consecutiveFailures)}, next check in ${String(Math.round(health.currentInterval / 1000))}s)`,
        );

        // Attempt restart if available
        if (target.restart && health.consecutiveFailures <= 3) {
          try {
            await target.restart();
            this.log(`[health] ${target.name} restart attempted`);
          } catch (err) {
            this.log(
              `[health] ${target.name} restart failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    } catch (err) {
      // The check itself threw — treat as unhealthy
      health.healthy = false;
      health.lastCheck = new Date();
      health.consecutiveFailures++;
      health.currentInterval = this.calculateBackoff(health.consecutiveFailures);

      this.log(
        `[health] ${target.name} check error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private scheduleNext(target: HealthCheckTarget): void {
    if (!this.running) return;

    const health = this.state.get(target.name);
    const interval = health?.currentInterval ?? this.baseInterval;

    const timer = setTimeout(async () => {
      if (!this.running) return;
      await this.checkTarget(target);
      this.scheduleNext(target);
    }, interval);

    // Unref timer so it doesn't keep the process alive during shutdown
    timer.unref();
    this.timers.set(target.name, timer);
  }
}
