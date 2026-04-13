/**
 * Per-user resource limits via cgroups v2.
 *
 * On Linux with cgroups v2, systemd manages per-user resource slices.
 * This module reads and sets limits using systemctl and the systemd
 * cgroups hierarchy: /sys/fs/cgroup/user.slice/user-{uid}.slice/
 *
 * For non-Linux platforms (dev on macOS), operations are no-ops.
 */

import { readFile, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ResourceLimits {
  /** RAM limit (e.g., "4G", "2048M"). Undefined means no limit. */
  ramLimit?: string;
  /** CPU quota as a fraction (e.g., 2.0 means 200% = 2 cores). Undefined means no limit. */
  cpuLimit?: number;
  /** Max concurrent Podman containers. Enforced at application level. */
  maxContainers?: number;
}

export interface ResourceUsage {
  /** Current memory usage in bytes. */
  memoryBytes: number;
  /** Memory limit in bytes. 0 means no limit. */
  memoryLimitBytes: number;
  /** CPU usage period (microseconds of CPU time used). */
  cpuUsageMicros: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const CGROUPS_BASE = '/sys/fs/cgroup';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Check if cgroups v2 is available on this system.
 */
export async function isCgroupsV2Available(): Promise<boolean> {
  try {
    await access(`${CGROUPS_BASE}/cgroup.controllers`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the numeric UID for a Linux username.
 */
export async function getUid(username: string): Promise<number> {
  const { stdout } = await execFileAsync('id', ['-u', username]);
  return parseInt(stdout.trim(), 10);
}

/**
 * Get the cgroup path for a user's systemd slice.
 */
function userSlicePath(uid: number): string {
  return `${CGROUPS_BASE}/user.slice/user-${String(uid)}.slice`;
}

// ─── Read Limits ────────────────────────────────────────────────────────────

/**
 * Read current resource usage for a user.
 * Returns zero values if cgroups v2 is not available or the user has no slice.
 */
export async function readUsage(username: string): Promise<ResourceUsage> {
  try {
    const uid = await getUid(username);
    const slicePath = userSlicePath(uid);

    const [memCurrent, memMax, cpuStat] = await Promise.all([
      readCgroupFile(slicePath, 'memory.current'),
      readCgroupFile(slicePath, 'memory.max'),
      readCgroupFile(slicePath, 'cpu.stat'),
    ]);

    const memoryBytes = parseInt(memCurrent, 10) || 0;
    const memoryLimitBytes = memMax === 'max' ? 0 : parseInt(memMax, 10) || 0;

    // cpu.stat has lines like: usage_usec 12345678
    const usageLine = cpuStat.split('\n').find((l) => l.startsWith('usage_usec'));
    const cpuUsageMicros = usageLine ? parseInt(usageLine.split(' ')[1] ?? '0', 10) : 0;

    return { memoryBytes, memoryLimitBytes, cpuUsageMicros };
  } catch {
    return { memoryBytes: 0, memoryLimitBytes: 0, cpuUsageMicros: 0 };
  }
}

/**
 * Set resource limits for a user's systemd slice.
 *
 * Uses `systemctl set-property` to apply limits at runtime.
 * Changes persist across reboots (written to systemd override files).
 */
export async function setLimits(username: string, limits: ResourceLimits): Promise<void> {
  const uid = await getUid(username);
  const slice = `user-${String(uid)}.slice`;
  const args: string[] = ['set-property', slice];

  if (limits.ramLimit) {
    args.push(`MemoryMax=${limits.ramLimit}`);
  }

  if (limits.cpuLimit !== undefined) {
    // CPUQuota is expressed as percentage (200% = 2 cores)
    const quota = Math.round(limits.cpuLimit * 100);
    args.push(`CPUQuota=${String(quota)}%`);
  }

  if (args.length <= 2) return; // Nothing to set

  await execFileAsync('systemctl', args);
}

/**
 * Read current limits for a user's systemd slice.
 */
export async function readLimits(username: string): Promise<ResourceLimits> {
  try {
    const uid = await getUid(username);
    const slicePath = userSlicePath(uid);

    const [memMax, cpuMax] = await Promise.all([
      readCgroupFile(slicePath, 'memory.max'),
      readCgroupFile(slicePath, 'cpu.max'),
    ]);

    const result: ResourceLimits = {};

    if (memMax !== 'max') {
      const bytes = parseInt(memMax, 10);
      if (bytes > 0) {
        result.ramLimit = formatBytes(bytes);
      }
    }

    // cpu.max format: "quota period" (e.g., "200000 100000" = 2 cores)
    if (cpuMax !== 'max') {
      const parts = cpuMax.split(' ');
      const quota = parseInt(parts[0] ?? '0', 10);
      const period = parseInt(parts[1] ?? '100000', 10);
      if (quota > 0 && period > 0) {
        result.cpuLimit = quota / period;
      }
    }

    return result;
  } catch {
    return {};
  }
}

// ─── Utilities ──────────────────────────────────────────────────────────────

async function readCgroupFile(slicePath: string, file: string): Promise<string> {
  return (await readFile(`${slicePath}/${file}`, 'utf-8')).trim();
}

/**
 * Parse a human-readable size string (e.g., "4G", "2048M") to bytes.
 */
export function parseSize(size: string): number {
  const match = size.match(/^(\d+(?:\.\d+)?)\s*(B|K|M|G|T)?$/i);
  if (!match) throw new Error(`Invalid size: "${size}"`);

  const value = parseFloat(match[1] ?? '0');
  const unit = (match[2] ?? 'B').toUpperCase();

  const multipliers: Record<string, number> = {
    B: 1,
    K: 1024,
    M: 1024 ** 2,
    G: 1024 ** 3,
    T: 1024 ** 4,
  };

  return Math.round(value * (multipliers[unit] ?? 1));
}

/**
 * Format bytes to a human-readable string.
 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}G`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)}M`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}K`;
  return `${String(bytes)}B`;
}
