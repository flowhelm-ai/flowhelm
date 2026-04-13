/**
 * MCP config generator for agent containers.
 *
 * Generates the MCP server configuration that allows the agent to
 * access the orchestrator's MCP server via Unix domain socket.
 *
 * CLI runtime: writes a JSON file, passed via `--mcp-config <path>`.
 * SDK runtime: returns a config object for the `mcpServers` option.
 *
 * The agent container has a stdio-to-UDS bridge script that pipes
 * stdin/stdout to the MCP server's Unix domain socket.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import * as path from 'node:path';

// ─── Types ──────────────────────────────────────────────────────────────────

/** MCP server entry in the CLI config file. */
export interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** Full MCP config file structure for `--mcp-config`. */
export interface McpConfigFile {
  mcpServers: Record<string, McpServerConfig>;
}

export interface McpConfigOptions {
  /** Path to the UDS socket inside the container. */
  socketPath: string;
  /** Path to the stdio-to-UDS bridge script inside the container. */
  bridgeScriptPath?: string;
  /** TCP host for MCP server (macOS — virtiofs doesn't support UDS). */
  tcpHost?: string;
  /** TCP port for MCP server (macOS — virtiofs doesn't support UDS). */
  tcpPort?: number;
}

// ─── Default Paths (Inside Container) ───────────────────────────────────────

/** Default path to the stdio-to-UDS bridge script inside the container. */
const DEFAULT_BRIDGE_SCRIPT = '/workspace/stdio-to-uds-bridge.cjs';

/** Default path to the MCP socket inside the container. */
const DEFAULT_SOCKET_PATH = '/workspace/ipc/memory.sock';

// ─── MCP Config Generator ───────────────────────────────────────────────────

/**
 * Generate the MCP config object for the flowhelm MCP server.
 *
 * The config references the stdio-to-UDS bridge script which pipes
 * stdin/stdout to the MCP server's Unix domain socket.
 */
export function generateMcpConfig(options?: McpConfigOptions): McpConfigFile {
  const bridgeScript = options?.bridgeScriptPath ?? DEFAULT_BRIDGE_SCRIPT;

  // TCP mode: macOS where virtiofs doesn't support UDS through bind mounts.
  // Agent connects to host.containers.internal:<port> via TCP.
  if (options?.tcpHost && options?.tcpPort) {
    return {
      mcpServers: {
        flowhelm: {
          command: 'node',
          args: [bridgeScript],
          env: {
            FLOWHELM_MCP_HOST: options.tcpHost,
            FLOWHELM_MCP_PORT: String(options.tcpPort),
          },
        },
      },
    };
  }

  // UDS mode: Linux default. Agent connects via bind-mounted Unix domain socket.
  const socketPath = options?.socketPath ?? DEFAULT_SOCKET_PATH;
  return {
    mcpServers: {
      flowhelm: {
        command: 'node',
        args: [bridgeScript],
        env: {
          FLOWHELM_MCP_SOCKET: socketPath,
        },
      },
    },
  };
}

/**
 * Write the MCP config file to a host directory.
 *
 * The file is written to the host and bind-mounted into the container.
 * Returns the container-side path for `--mcp-config`.
 */
export async function writeMcpConfigFile(
  hostDir: string,
  options?: McpConfigOptions,
): Promise<string> {
  const config = generateMcpConfig(options);
  const hostPath = path.join(hostDir, 'mcp-config.json');

  await mkdir(hostDir, { recursive: true });
  await writeFile(hostPath, JSON.stringify(config, null, 2), 'utf-8');

  return hostPath;
}

/**
 * Build CLI flags for MCP config.
 *
 * Returns the `--mcp-config` flag pointing to the config file
 * path inside the container.
 */
export function buildMcpCliFlags(containerConfigPath: string): string[] {
  return ['--mcp-config', containerConfigPath];
}

/**
 * Get the container-side path where the MCP config will be mounted.
 */
export function getContainerMcpConfigPath(): string {
  return '/workspace/mcp-config.json';
}
