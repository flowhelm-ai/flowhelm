/**
 * Resource limit validation and Podman flag generation.
 *
 * Converts FlowHelm config values into Podman CLI flags for cgroups v2
 * enforcement. Validates limits at build time to catch misconfigurations
 * before container creation fails. All limits are enforced at the kernel
 * level via cgroups v2 controllers.
 */

/** Validate a memory limit string (e.g., "512m", "2g", "1073741824"). */
export function validateMemoryLimit(limit: string): boolean {
  return /^\d+[bkmg]?$/i.test(limit);
}

/** Validate a CPU limit string (e.g., "0.5", "1.0", "2"). */
export function validateCpuLimit(limit: string): boolean {
  const num = Number(limit);
  return !isNaN(num) && num > 0 && num <= 128;
}

/** Validate a PID limit. */
export function validatePidsLimit(limit: number): boolean {
  return Number.isInteger(limit) && limit >= 1 && limit <= 32768;
}

/**
 * Build Podman CLI flags for resource limits.
 * All limits map directly to cgroups v2 controllers.
 */
export function buildResourceLimitArgs(opts: {
  memoryLimit: string;
  cpuLimit: string;
  pidsLimit: number;
}): string[] {
  const args: string[] = [];

  if (!validateMemoryLimit(opts.memoryLimit)) {
    throw new Error(`Invalid memory limit: "${opts.memoryLimit}". Use format like "512m" or "2g".`);
  }
  args.push('--memory', opts.memoryLimit);

  if (!validateCpuLimit(opts.cpuLimit)) {
    throw new Error(
      `Invalid CPU limit: "${opts.cpuLimit}". Use a positive number like "0.5" or "2".`,
    );
  }
  args.push('--cpus', opts.cpuLimit);

  if (!validatePidsLimit(opts.pidsLimit)) {
    throw new Error(
      `Invalid PIDs limit: ${String(opts.pidsLimit)}. Must be an integer between 1 and 32768.`,
    );
  }
  args.push('--pids-limit', String(opts.pidsLimit));

  return args;
}
