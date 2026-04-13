/**
 * Container runtime barrel exports and factory.
 */

export { PodmanRuntime } from './podman-runtime.js';
export { AppleContainerRuntime } from './apple-runtime.js';
export {
  detectPlatform,
  isPodmanRootless,
  getPodmanMachineState,
  isAppleSilicon,
  isAppleContainerInstalled,
  getMacOSMajorVersion,
  isIPForwardingEnabled,
  getAppleContainerHostGateway,
  type PlatformInfo,
  type ContainerRuntimeType,
  type ServiceManagerType,
} from './platform.js';
export {
  buildResourceLimitArgs,
  validateMemoryLimit,
  validateCpuLimit,
  validatePidsLimit,
} from './resource-limits.js';
export { ContainerLifecycleManager, NAMING, type LifecycleManagerOptions } from './lifecycle.js';
export {
  PostgresContainerManager,
  dbContainerName,
  type PostgresManagerOptions,
  type PostgresConnectionInfo,
} from './postgres-manager.js';

export {
  checkAppleContainerNetwork,
  generateNetworkSetupCommands,
  generateFirewallBlockCommand,
  VMNET_SUBNET,
  VMNET_BRIDGE,
  VMNET_HOST_GATEWAY,
  type NetworkCheckResult,
} from './apple-network.js';

import type { ContainerRuntime } from '../orchestrator/types.js';
import { PodmanRuntime } from './podman-runtime.js';
import { AppleContainerRuntime } from './apple-runtime.js';
import { detectPlatform } from './platform.js';

/**
 * Create the appropriate ContainerRuntime for the current platform.
 * Auto-detects Podman (Linux/macOS) or Apple Container (macOS 26+).
 *
 * @param runtimeOverride - Force a specific runtime (from config). If omitted, auto-detect.
 */
export function createRuntime(runtimeOverride?: 'podman' | 'apple_container'): ContainerRuntime {
  const runtimeType = runtimeOverride ?? detectPlatform().runtime;

  switch (runtimeType) {
    case 'podman':
      return new PodmanRuntime();
    case 'apple_container':
      return new AppleContainerRuntime();
    default:
      throw new Error(`Unknown container runtime: ${String(runtimeType)}`);
  }
}
