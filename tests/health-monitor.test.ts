/**
 * Tests for the health monitor with exponential backoff.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HealthMonitor, type HealthCheckTarget } from '../src/orchestrator/health.js';

describe('HealthMonitor', () => {
  let logs: string[];
  let log: (msg: string) => void;

  beforeEach(() => {
    logs = [];
    log = (msg: string) => logs.push(msg);
  });

  function createTarget(name: string, healthy: boolean): HealthCheckTarget {
    return {
      name,
      check: vi.fn(async () => healthy),
    };
  }

  it('initializes all targets as healthy', () => {
    const monitor = new HealthMonitor({
      targets: [createTarget('proxy', true), createTarget('db', true)],
      log,
    });

    expect(monitor.isHealthy('proxy')).toBe(true);
    expect(monitor.isHealthy('db')).toBe(true);
  });

  it('returns false for unknown components', () => {
    const monitor = new HealthMonitor({ targets: [], log });
    expect(monitor.isHealthy('nonexistent')).toBe(false);
  });

  it('detects healthy components after start', async () => {
    const monitor = new HealthMonitor({
      targets: [createTarget('proxy', true)],
      baseInterval: 100_000, // Long interval so scheduled check doesn't fire
      log,
    });

    await monitor.start();
    expect(monitor.isHealthy('proxy')).toBe(true);

    const health = monitor.getAllHealth();
    expect(health).toHaveLength(1);
    expect(health[0]!.healthy).toBe(true);
    expect(health[0]!.consecutiveFailures).toBe(0);

    await monitor.stop();
  });

  it('detects unhealthy components after start', async () => {
    const monitor = new HealthMonitor({
      targets: [createTarget('proxy', false)],
      baseInterval: 100_000,
      log,
    });

    await monitor.start();
    expect(monitor.isHealthy('proxy')).toBe(false);

    const health = monitor.getAllHealth();
    expect(health[0]!.consecutiveFailures).toBe(1);

    await monitor.stop();
  });

  it('calculates exponential backoff correctly', () => {
    const monitor = new HealthMonitor({
      targets: [],
      baseInterval: 1000,
      maxBackoff: 60000,
      backoffMultiplier: 2,
      log,
    });

    expect(monitor.calculateBackoff(0)).toBe(1000); // base
    expect(monitor.calculateBackoff(1)).toBe(2000); // 1000 * 2^1
    expect(monitor.calculateBackoff(2)).toBe(4000); // 1000 * 2^2
    expect(monitor.calculateBackoff(3)).toBe(8000); // 1000 * 2^3
    expect(monitor.calculateBackoff(4)).toBe(16000); // 1000 * 2^4
    expect(monitor.calculateBackoff(5)).toBe(32000); // 1000 * 2^5
    expect(monitor.calculateBackoff(6)).toBe(60000); // capped at maxBackoff
    expect(monitor.calculateBackoff(10)).toBe(60000); // still capped
  });

  it('resets backoff on recovery', async () => {
    let isHealthy = false;
    const target: HealthCheckTarget = {
      name: 'proxy',
      check: vi.fn(async () => isHealthy),
    };

    const monitor = new HealthMonitor({
      targets: [target],
      baseInterval: 100_000,
      log,
    });

    // Start unhealthy
    await monitor.start();
    expect(monitor.isHealthy('proxy')).toBe(false);
    expect(monitor.getAllHealth()[0]!.consecutiveFailures).toBe(1);

    // Recover
    isHealthy = true;
    // Manually trigger another check by stopping and restarting
    await monitor.stop();
    await monitor.start();

    expect(monitor.isHealthy('proxy')).toBe(true);
    expect(monitor.getAllHealth()[0]!.consecutiveFailures).toBe(0);

    await monitor.stop();
  });

  it('attempts restart on failure', async () => {
    const restartFn = vi.fn(async () => {});
    const target: HealthCheckTarget = {
      name: 'proxy',
      check: vi.fn(async () => false),
      restart: restartFn,
    };

    const monitor = new HealthMonitor({
      targets: [target],
      baseInterval: 100_000,
      log,
    });

    await monitor.start();
    expect(restartFn).toHaveBeenCalledTimes(1);
    await monitor.stop();
  });

  it('handles restart failure gracefully', async () => {
    const restartFn = vi.fn(async () => {
      throw new Error('restart failed');
    });
    const target: HealthCheckTarget = {
      name: 'proxy',
      check: vi.fn(async () => false),
      restart: restartFn,
    };

    const monitor = new HealthMonitor({
      targets: [target],
      baseInterval: 100_000,
      log,
    });

    await monitor.start();
    expect(restartFn).toHaveBeenCalled();
    expect(logs.some((l) => l.includes('restart failed'))).toBe(true);
    await monitor.stop();
  });

  it('handles check throwing an error', async () => {
    const target: HealthCheckTarget = {
      name: 'proxy',
      check: vi.fn(async () => {
        throw new Error('connection refused');
      }),
    };

    const monitor = new HealthMonitor({
      targets: [target],
      baseInterval: 100_000,
      log,
    });

    await monitor.start();
    expect(monitor.isHealthy('proxy')).toBe(false);
    expect(monitor.getAllHealth()[0]!.consecutiveFailures).toBe(1);
    expect(logs.some((l) => l.includes('connection refused'))).toBe(true);
    await monitor.stop();
  });

  it('stop clears all timers', async () => {
    const monitor = new HealthMonitor({
      targets: [createTarget('proxy', true), createTarget('db', true)],
      baseInterval: 100, // Short interval
      log,
    });

    await monitor.start();
    await monitor.stop();

    // No further checks should run after stop
    const checksAfterStop = logs.length;
    await new Promise((r) => setTimeout(r, 300));
    expect(logs.length).toBe(checksAfterStop);
  });

  it('logs recovery message', async () => {
    let healthy = false;
    const target: HealthCheckTarget = {
      name: 'proxy',
      check: vi.fn(async () => healthy),
    };

    const monitor = new HealthMonitor({
      targets: [target],
      baseInterval: 100_000,
      log,
    });

    // Start unhealthy
    await monitor.start();
    await monitor.stop();

    // Recover
    healthy = true;
    await monitor.start();
    expect(logs.some((l) => l.includes('recovered'))).toBe(true);
    await monitor.stop();
  });
});
