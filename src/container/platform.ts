/**
 * Platform detection for container runtime selection.
 *
 * Linux → Podman rootless (daemonless, per-user UID namespaces)
 * macOS Tahoe (26+) + Apple Silicon → Apple Container (Virtualization.framework VMs)
 * macOS pre-Tahoe or Intel → Podman (development fallback)
 *
 * Auto-detects the OS, macOS version, CPU architecture, and verifies
 * the container runtime binary is installed before the runtime is constructed.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { platform, arch } from 'node:os';

export type ContainerRuntimeType = 'podman' | 'apple_container';
export type ServiceManagerType = 'systemd' | 'launchd' | 'none';

export interface PlatformInfo {
  os: 'linux' | 'darwin';
  runtime: ContainerRuntimeType;
  serviceManager: ServiceManagerType;
  binaryPath: string;
  version: string;
}

/**
 * Detect the platform and verify the container runtime is available.
 * Throws if the runtime binary is not found or returns an error.
 */
export function detectPlatform(): PlatformInfo {
  const os = platform();

  if (os === 'linux') {
    return { ...detectPodman(), serviceManager: detectServiceManager() };
  }

  if (os === 'darwin') {
    // Apple Container requires macOS Tahoe (26+) and Apple Silicon (arm64).
    if (isAppleSilicon() && getMacOSMajorVersion() >= 26 && isAppleContainerInstalled()) {
      return detectAppleContainer();
    }
    // Fallback to Podman on older macOS or Intel.
    return { ...detectPodman(), serviceManager: 'launchd' };
  }

  throw new Error(
    `Unsupported platform: ${os}. FlowHelm requires Linux (Podman) or macOS (Apple Container).`,
  );
}

/**
 * Get the macOS major version number.
 * Returns 0 on non-macOS or if detection fails.
 *
 * macOS version mapping:
 *   15 = Sequoia, 26 = Tahoe (first with Apple Container)
 */
export function getMacOSMajorVersion(): number {
  if (platform() !== 'darwin') return 0;
  try {
    const stdout = execFileSync('sw_vers', ['-productVersion'], {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    // Format: "26.0" or "15.4.1"
    const major = parseInt(stdout.split('.')[0] ?? '0', 10);
    return isNaN(major) ? 0 : major;
  } catch {
    return 0;
  }
}

/** Check if running on Apple Silicon (arm64). */
export function isAppleSilicon(): boolean {
  return platform() === 'darwin' && arch() === 'arm64';
}

/** Check if the Apple Container CLI (`container`) is installed. */
export function isAppleContainerInstalled(): boolean {
  try {
    execFileSync('container', ['--version'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

/** Detect and verify Apple Container runtime. */
function detectAppleContainer(): PlatformInfo {
  const binary = 'container';

  try {
    const stdout = execFileSync(binary, ['--version'], {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();

    // Output format varies: "container version X.Y.Z" or just "X.Y.Z"
    const match = stdout.match(/(\d+\.\d+(?:\.\d+)?)/);
    const version = match?.[1] ?? 'unknown';

    return {
      os: 'darwin',
      runtime: 'apple_container',
      serviceManager: 'launchd',
      binaryPath: binary,
      version,
    };
  } catch {
    throw new Error(
      `Apple Container CLI not found. Install it:\n` +
        `  Download from: https://github.com/apple/container/releases\n` +
        `  Or fall back to Podman: brew install podman`,
    );
  }
}

/** Verify Podman is installed and return its version. */
function detectPodman(): Omit<PlatformInfo, 'serviceManager'> {
  const os = platform() as 'linux' | 'darwin';
  const binary = 'podman';

  try {
    const stdout = execFileSync(binary, ['--version'], {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();

    // Output format: "podman version X.Y.Z"
    const match = stdout.match(/(\d+\.\d+\.\d+)/);
    const version = match?.[1] ?? 'unknown';

    return { os, runtime: 'podman', binaryPath: binary, version };
  } catch {
    throw new Error(
      `Podman not found. Install it:\n` +
        `  Linux:  sudo apt install -y podman slirp4netns fuse-overlayfs\n` +
        `  macOS:  brew install podman`,
    );
  }
}

/** Detect the service manager for the current platform. */
function detectServiceManager(): ServiceManagerType {
  const os = platform();
  if (os === 'darwin') return 'launchd';
  if (os === 'linux') {
    try {
      const init = readFileSync('/proc/1/comm', 'utf-8').trim();
      if (init === 'systemd') return 'systemd';
    } catch {
      // /proc/1/comm not readable — not systemd
    }
    return 'none';
  }
  return 'none';
}

/**
 * Check if podman machine is initialized and running (macOS only).
 * On macOS, Podman runs inside a VM managed by `podman machine`.
 * Returns 'running', 'stopped', or 'none' (not initialized).
 */
export function getPodmanMachineState(): 'running' | 'stopped' | 'none' {
  if (platform() !== 'darwin') return 'none';
  try {
    const stdout = execFileSync('podman', ['machine', 'list', '--format', '{{.Running}}'], {
      encoding: 'utf-8',
      timeout: 10_000,
    }).trim();
    // Output: one line per machine, "true" or "false"
    const lines = stdout.split('\n').filter(Boolean);
    if (lines.length === 0) return 'none';
    return lines.some((line) => line.trim() === 'true') ? 'running' : 'stopped';
  } catch {
    return 'none';
  }
}

/**
 * Verify that Podman is running in rootless mode.
 * Returns true if rootless, false if running as root (which we reject).
 */
export function isPodmanRootless(): boolean {
  try {
    const stdout = execFileSync('podman', ['info', '--format', '{{.Host.Security.Rootless}}'], {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    return stdout === 'true';
  } catch {
    return false;
  }
}

/**
 * Check if IP forwarding is enabled (required for Apple Container NAT).
 * Returns true if net.inet.ip.forwarding is 1.
 */
export function isIPForwardingEnabled(): boolean {
  if (platform() !== 'darwin') return false;
  try {
    const stdout = execFileSync('sysctl', ['-n', 'net.inet.ip.forwarding'], {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    return stdout === '1';
  } catch {
    return false;
  }
}

/**
 * Discover the host gateway IP for Apple Container's vmnet bridge.
 * Returns the IP of bridge100 (typically 192.168.64.1) or null if unavailable.
 * bridge100 only exists while an Apple Container is running.
 */
export function getAppleContainerHostGateway(): string | null {
  if (platform() !== 'darwin') return null;
  try {
    const stdout = execFileSync('ifconfig', ['bridge100'], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    // Look for "inet 192.168.64.1 netmask ..."
    const match = stdout.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}
