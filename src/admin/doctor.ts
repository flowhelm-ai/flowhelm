/**
 * FlowHelm diagnostic health checks.
 *
 * `flowhelm doctor` runs a series of independent checks to verify
 * the system is correctly set up. Each check produces a pass/warn/fail
 * result with an actionable fix suggestion on failure.
 *
 * Platform-aware: runs Linux-specific checks (Podman, systemd, cgroups)
 * on Linux, and macOS-specific checks (Apple Container, IP forwarding,
 * NAT rules, launchd) on macOS.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir, platform } from 'node:os';
import { getVersion } from './version.js';
import { isCgroupsV2Available } from './resource-limits.js';
import { checkAuthHealth, type AuthHealthResult } from '../auth/auth-monitor.js';
import {
  detectPlatform,
  getMacOSMajorVersion,
  isAppleSilicon,
  isAppleContainerInstalled,
  isIPForwardingEnabled,
  type ContainerRuntimeType,
} from '../container/platform.js';

const execFileAsync = promisify(execFileCb);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
  fix?: string;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  overallStatus: 'ok' | 'warn' | 'fail';
}

export interface DoctorOptions {
  log?: (msg: string) => void;
  verbose?: boolean;
  /** Override home dir for testing. */
  homeDir?: string;
  /** Custom exec function for testing. */
  execFn?: typeof execFileAsync;
  /** Skip system-level checks (for unit testing). */
  skipSystemChecks?: boolean;
  /** Force a platform for testing ('linux' | 'darwin'). */
  platformOverride?: 'linux' | 'darwin';
  /** Force a runtime for testing ('podman' | 'apple_container'). */
  runtimeOverride?: ContainerRuntimeType;
}

// ─── Shared checks ─────────────────────────────────────────────────────────

async function checkNodeVersion(): Promise<DoctorCheck> {
  const version = process.version;
  const major = parseInt(version.slice(1), 10);
  if (major >= 22) {
    return { name: 'Node.js', status: 'ok', message: `Node.js ${version}` };
  }
  if (major >= 20) {
    return {
      name: 'Node.js',
      status: 'warn',
      message: `Node.js ${version} (22+ recommended)`,
      fix: 'Install Node.js 22+ via NodeSource: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs',
    };
  }
  return {
    name: 'Node.js',
    status: 'fail',
    message: `Node.js ${version} (22+ required)`,
    fix: 'Install Node.js 22+: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs',
  };
}

// ─── Linux checks ───────────────────────────────────────────────────────────

async function checkPodman(exec: typeof execFileAsync): Promise<DoctorCheck> {
  try {
    const { stdout } = await exec('podman', ['--version']);
    const version = stdout.trim().replace('podman version ', '');
    return { name: 'Podman', status: 'ok', message: `Podman ${version}` };
  } catch {
    return {
      name: 'Podman',
      status: 'fail',
      message: 'Podman not found',
      fix: 'Install Podman: sudo apt-get install -y podman',
    };
  }
}

async function checkPodmanRootless(exec: typeof execFileAsync): Promise<DoctorCheck> {
  try {
    const { stdout } = await exec('podman', ['info', '--format', '{{.Host.Security.Rootless}}']);
    if (stdout.trim() === 'true') {
      return { name: 'Podman rootless', status: 'ok', message: 'Rootless mode active' };
    }
    return {
      name: 'Podman rootless',
      status: 'warn',
      message: 'Podman running as root',
      fix: 'Run as a non-root user with sub-UIDs configured',
    };
  } catch {
    return {
      name: 'Podman rootless',
      status: 'warn',
      message: 'Could not verify rootless mode',
      fix: 'Ensure Podman is installed and sub-UIDs are configured',
    };
  }
}

async function checkSystemd(): Promise<DoctorCheck> {
  if (existsSync('/run/systemd/system')) {
    return { name: 'systemd', status: 'ok', message: 'systemd (PID 1)' };
  }
  return {
    name: 'systemd',
    status: 'fail',
    message: 'systemd not detected',
    fix: 'FlowHelm requires systemd for service management. Use Ubuntu 24.04 LTS.',
  };
}

async function checkCgroupsV2(): Promise<DoctorCheck> {
  const available = await isCgroupsV2Available();
  if (available) {
    return { name: 'cgroups v2', status: 'ok', message: 'cgroups v2 active' };
  }
  return {
    name: 'cgroups v2',
    status: 'warn',
    message: 'cgroups v2 not detected',
    fix: 'Resource limits require cgroups v2. Boot with systemd.unified_cgroup_hierarchy=1',
  };
}

async function checkEtcFlowhelm(): Promise<DoctorCheck> {
  if (existsSync('/etc/flowhelm')) {
    return { name: '/etc/flowhelm', status: 'ok', message: 'System config directory exists' };
  }
  return {
    name: '/etc/flowhelm',
    status: 'warn',
    message: '/etc/flowhelm not found',
    fix: 'Run "sudo flowhelm admin init" to initialize the system',
  };
}

async function checkServiceActive(exec: typeof execFileAsync): Promise<DoctorCheck> {
  try {
    const { stdout } = await exec('systemctl', ['--user', 'is-active', 'flowhelm.service']);
    if (stdout.trim() === 'active') {
      return { name: 'Service status', status: 'ok', message: 'flowhelm.service active' };
    }
    return {
      name: 'Service status',
      status: 'warn',
      message: `flowhelm.service: ${stdout.trim()}`,
      fix: 'Start with: systemctl --user start flowhelm.service',
    };
  } catch {
    return {
      name: 'Service status',
      status: 'warn',
      message: 'Could not check service status',
      fix: 'Start with: systemctl --user start flowhelm.service',
    };
  }
}

async function checkPodmanMachine(exec: typeof execFileAsync): Promise<DoctorCheck> {
  try {
    const { stdout } = await exec('podman', ['machine', 'list', '--format', '{{.Running}}']);
    const lines = stdout.trim().split('\n').filter(Boolean);
    if (lines.length === 0) {
      return {
        name: 'Podman machine',
        status: 'fail',
        message: 'No Podman machine initialized',
        fix: 'Initialize with: podman machine init && podman machine start',
      };
    }
    if (lines.some((line) => line.trim() === 'true')) {
      return { name: 'Podman machine', status: 'ok', message: 'Podman machine running' };
    }
    return {
      name: 'Podman machine',
      status: 'fail',
      message: 'Podman machine stopped',
      fix: 'Start with: podman machine start',
    };
  } catch {
    return {
      name: 'Podman machine',
      status: 'fail',
      message: 'Could not check Podman machine status',
      fix: 'Initialize with: podman machine init && podman machine start',
    };
  }
}

// ─── macOS checks ───────────────────────────────────────────────────────────

async function checkAppleContainerCLI(): Promise<DoctorCheck> {
  if (isAppleContainerInstalled()) {
    return { name: 'Apple Container', status: 'ok', message: 'container CLI installed' };
  }
  return {
    name: 'Apple Container',
    status: 'fail',
    message: 'Apple Container CLI not found',
    fix: 'Install from: https://github.com/apple/container/releases',
  };
}

async function checkMacOSVersion(): Promise<DoctorCheck> {
  const major = getMacOSMajorVersion();
  if (major >= 26) {
    return { name: 'macOS version', status: 'ok', message: `macOS ${String(major)} (Tahoe+)` };
  }
  if (major > 0) {
    return {
      name: 'macOS version',
      status: 'warn',
      message: `macOS ${String(major)} (Tahoe 26+ required for Apple Container)`,
      fix: 'Upgrade to macOS Tahoe (26+) or use Podman: brew install podman',
    };
  }
  return {
    name: 'macOS version',
    status: 'warn',
    message: 'Could not detect macOS version',
    fix: 'Run: sw_vers -productVersion',
  };
}

async function checkAppleSilicon(): Promise<DoctorCheck> {
  if (isAppleSilicon()) {
    return { name: 'Apple Silicon', status: 'ok', message: 'ARM64 (Apple Silicon)' };
  }
  return {
    name: 'Apple Silicon',
    status: 'warn',
    message: 'Intel Mac detected',
    fix: 'Apple Container requires Apple Silicon (M1+). Use Podman on Intel Macs.',
  };
}

async function checkMacIPForwarding(): Promise<DoctorCheck> {
  if (isIPForwardingEnabled()) {
    return { name: 'IP forwarding', status: 'ok', message: 'net.inet.ip.forwarding=1' };
  }
  return {
    name: 'IP forwarding',
    status: 'warn',
    message: 'IP forwarding disabled',
    fix: 'Enable with: sudo sysctl -w net.inet.ip.forwarding=1',
  };
}

async function checkLaunchdActive(exec: typeof execFileAsync): Promise<DoctorCheck> {
  try {
    const { stdout } = await exec('launchctl', ['list']);
    if (stdout.includes('ai.flowhelm')) {
      return { name: 'Service status', status: 'ok', message: 'ai.flowhelm loaded' };
    }
    return {
      name: 'Service status',
      status: 'warn',
      message: 'ai.flowhelm not loaded',
      fix: 'Load with: launchctl load ~/Library/LaunchAgents/ai.flowhelm.plist',
    };
  } catch {
    return {
      name: 'Service status',
      status: 'warn',
      message: 'Could not check launchd status',
      fix: 'Load with: launchctl load ~/Library/LaunchAgents/ai.flowhelm.plist',
    };
  }
}

// ─── Platform-agnostic checks ───────────────────────────────────────────────

async function checkConfigFile(homeDir: string): Promise<DoctorCheck> {
  const configPath = resolve(homeDir, '.flowhelm', 'config.yaml');
  if (existsSync(configPath)) {
    return { name: 'Config file', status: 'ok', message: configPath };
  }
  return {
    name: 'Config file',
    status: 'warn',
    message: 'No config.yaml found',
    fix: 'Run "flowhelm setup" to create your configuration',
  };
}

async function checkCredentialVault(homeDir: string): Promise<DoctorCheck> {
  const vaultPath = resolve(homeDir, '.flowhelm', 'secrets', 'credentials.enc');
  if (existsSync(vaultPath)) {
    try {
      const stat = statSync(vaultPath);
      if (stat.size > 0) {
        return { name: 'Credential vault', status: 'ok', message: `${String(stat.size)} bytes` };
      }
    } catch {
      // Fall through
    }
  }
  return {
    name: 'Credential vault',
    status: 'warn',
    message: 'No credentials stored',
    fix: 'Run "flowhelm setup" to configure authentication and channel credentials',
  };
}

async function checkServiceFile(homeDir: string, os: string): Promise<DoctorCheck> {
  if (os === 'darwin') {
    const plistPath = resolve(homeDir, 'Library', 'LaunchAgents', 'ai.flowhelm.plist');
    if (existsSync(plistPath)) {
      return { name: 'Service file', status: 'ok', message: 'ai.flowhelm.plist installed' };
    }
    return {
      name: 'Service file',
      status: 'warn',
      message: 'No launchd plist file',
      fix: 'Run "flowhelm setup" to generate the launchd service',
    };
  }

  const unitPath = resolve(homeDir, '.config', 'systemd', 'user', 'flowhelm.service');
  if (existsSync(unitPath)) {
    return { name: 'Service file', status: 'ok', message: 'flowhelm.service installed' };
  }
  return {
    name: 'Service file',
    status: 'warn',
    message: 'No systemd service file',
    fix: 'The service file is created by "flowhelm admin add-user"',
  };
}

async function checkAuthTokens(homeDir: string): Promise<DoctorCheck[]> {
  const results = await checkAuthHealth({ homeDir });
  const checks: DoctorCheck[] = [];

  for (const r of results) {
    const statusMap: Record<AuthHealthResult['status'], DoctorCheck['status']> = {
      ok: 'ok',
      warn: 'warn',
      expiring: 'warn',
      expired: 'fail',
      missing: 'warn',
    };

    checks.push({
      name: r.type === 'oauth' ? 'OAuth token' : r.type === 'api_key' ? 'API key' : 'Auth',
      status: statusMap[r.status],
      message: r.message,
      fix: r.fix,
    });
  }

  return checks;
}

// ─── Main doctor function ───────────────────────────────────────────────────

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorResult> {
  const log = options.log ?? console.log;
  const exec = options.execFn ?? execFileAsync;
  const home = options.homeDir ?? homedir();
  const os = options.platformOverride ?? platform();
  const checks: DoctorCheck[] = [];

  log('');
  log(`FlowHelm Doctor v${getVersion()}`);
  log('');

  // Determine runtime: explicit override, or detect from platform
  let runtime: ContainerRuntimeType;
  if (options.runtimeOverride) {
    runtime = options.runtimeOverride;
  } else if (os === 'linux') {
    runtime = 'podman';
  } else {
    // macOS: auto-detect (Apple Container if Tahoe+, otherwise Podman)
    try {
      const info = detectPlatform();
      runtime = info.runtime;
    } catch {
      runtime = 'podman';
    }
  }

  // Run all checks
  checks.push(await checkNodeVersion());

  if (!options.skipSystemChecks) {
    // Runtime-specific checks
    if (runtime === 'apple_container') {
      checks.push(await checkAppleContainerCLI());
      checks.push(await checkMacIPForwarding());
    } else {
      // Podman checks (work on both Linux and macOS via podman machine)
      checks.push(await checkPodman(exec));
      checks.push(await checkPodmanRootless(exec));
      // macOS Podman requires a running VM
      if (os === 'darwin') {
        checks.push(await checkPodmanMachine(exec));
      }
    }

    // OS-specific checks
    if (os === 'darwin') {
      checks.push(await checkMacOSVersion());
      checks.push(await checkAppleSilicon());
      checks.push(await checkLaunchdActive(exec));
    } else {
      checks.push(await checkSystemd());
      checks.push(await checkCgroupsV2());
      checks.push(await checkEtcFlowhelm());
      checks.push(await checkServiceActive(exec));
    }
  }

  checks.push(await checkConfigFile(home));
  checks.push(await checkCredentialVault(home));
  checks.push(...(await checkAuthTokens(home)));
  checks.push(await checkServiceFile(home, os));

  // Print results
  for (const check of checks) {
    const icon =
      check.status === 'ok' ? '  [OK]  ' : check.status === 'warn' ? '  [WARN]' : '  [FAIL]';
    log(`${icon} ${check.message}`);
    if (check.fix && check.status !== 'ok') {
      log(`         Fix: ${check.fix}`);
    }
  }

  // Summary
  const ok = checks.filter((c) => c.status === 'ok').length;
  const warn = checks.filter((c) => c.status === 'warn').length;
  const fail = checks.filter((c) => c.status === 'fail').length;

  log('');
  log(`Result: ${String(ok)} passed, ${String(warn)} warning(s), ${String(fail)} failure(s)`);
  log('');

  const overallStatus: DoctorResult['overallStatus'] = fail > 0 ? 'fail' : warn > 0 ? 'warn' : 'ok';
  return { checks, overallStatus };
}
