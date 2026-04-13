/**
 * Apple Container network setup and validation.
 *
 * Apple Container uses vmnet networking (192.168.64.0/24 subnet).
 * Containers get their own VM with a bridge100 interface. For containers
 * to reach the internet, the host needs:
 *
 * 1. IP forwarding: sysctl net.inet.ip.forwarding=1
 * 2. NAT rule: pfctl rule to masquerade 192.168.64.0/24 → en0
 *
 * This module checks for and helps configure these prerequisites.
 * All changes require sudo — the actual `sudo` calls are left to
 * `flowhelm setup` (interactive) or install.sh (automated).
 */

import { execFileSync } from 'node:child_process';
import { platform } from 'node:os';

/** Result of a network readiness check. */
export interface NetworkCheckResult {
  ipForwarding: boolean;
  natRuleActive: boolean;
  bridgeInterface: string | null;
  hostGateway: string | null;
}

/** The vmnet subnet used by Apple Container. */
export const VMNET_SUBNET = '192.168.64.0/24';

/** The default bridge interface created by Apple Container. */
export const VMNET_BRIDGE = 'bridge100';

/** Default host gateway IP on the vmnet bridge. */
export const VMNET_HOST_GATEWAY = '192.168.64.1';

/**
 * Run all Apple Container network checks.
 * Returns the status of each prerequisite.
 */
export function checkAppleContainerNetwork(): NetworkCheckResult {
  return {
    ipForwarding: checkIPForwarding(),
    natRuleActive: checkNATRule(),
    bridgeInterface: detectBridgeInterface(),
    hostGateway: detectHostGateway(),
  };
}

/** Check if IP forwarding is enabled via sysctl. */
function checkIPForwarding(): boolean {
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
 * Check if a NAT rule for the vmnet subnet exists in pfctl.
 * Looks for a nat rule covering 192.168.64.0/24.
 */
function checkNATRule(): boolean {
  if (platform() !== 'darwin') return false;
  try {
    const stdout = execFileSync('pfctl', ['-s', 'nat'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return stdout.includes('192.168.64.0/24');
  } catch {
    // pfctl requires root to show NAT rules; absence doesn't mean no rule
    return false;
  }
}

/** Detect the bridge100 interface if it exists (only while containers are running). */
function detectBridgeInterface(): string | null {
  if (platform() !== 'darwin') return null;
  try {
    execFileSync('ifconfig', [VMNET_BRIDGE], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return VMNET_BRIDGE;
  } catch {
    return null;
  }
}

/** Get the host gateway IP from bridge100. */
function detectHostGateway(): string | null {
  if (platform() !== 'darwin') return null;
  try {
    const stdout = execFileSync('ifconfig', [VMNET_BRIDGE], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    const match = stdout.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Generate the shell commands needed to set up Apple Container networking.
 * These commands require sudo — they're returned as strings for display
 * or execution by the setup wizard / install script.
 */
export function generateNetworkSetupCommands(): string[] {
  return [
    '# Enable IP forwarding (required for container internet access)',
    'sudo sysctl -w net.inet.ip.forwarding=1',
    '',
    '# Make IP forwarding persistent across reboots',
    'echo "net.inet.ip.forwarding=1" | sudo tee -a /etc/sysctl.conf',
    '',
    '# Add NAT rule for vmnet subnet (192.168.64.0/24)',
    'echo "nat on en0 from 192.168.64.0/24 to any -> (en0)" | sudo pfctl -ef -',
    '',
    '# Make NAT rule persistent (add to /etc/pf.conf)',
    'echo "# FlowHelm Apple Container NAT" | sudo tee -a /etc/pf.conf',
    'echo "nat on en0 from 192.168.64.0/24 to any -> (en0)" | sudo tee -a /etc/pf.conf',
  ];
}

/**
 * Generate a pfctl firewall rule to block external LAN access to a port.
 * Use this for the credential proxy when on a shared/public network.
 */
export function generateFirewallBlockCommand(port: number): string[] {
  return [
    `# Block external LAN access to port ${String(port)} (credential proxy)`,
    `echo "block in on en0 proto tcp to any port ${String(port)}" | sudo pfctl -ef -`,
    '',
    '# Make persistent',
    `echo "# FlowHelm proxy — block LAN access" | sudo tee -a /etc/pf.conf`,
    `echo "block in on en0 proto tcp to any port ${String(port)}" | sudo tee -a /etc/pf.conf`,
  ];
}
