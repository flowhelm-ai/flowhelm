#!/usr/bin/env node

/**
 * stdio-to-MCP bridge for FlowHelm MCP memory server.
 *
 * Pipes stdin/stdout to/from the orchestrator's MCP memory server
 * via either a Unix domain socket (Linux) or TCP (macOS).
 *
 * Transport selection:
 *   - If FLOWHELM_MCP_HOST and FLOWHELM_MCP_PORT are set → TCP
 *   - Otherwise → UDS via FLOWHELM_MCP_SOCKET
 *
 * TCP mode is used on macOS where Apple's virtiofs implementation
 * does not support Unix domain sockets through bind mounts.
 *
 * Protocol: JSON-RPC 2.0 over newline-delimited JSON (MCP spec).
 * Each line on stdin is forwarded to the socket, each line from
 * the socket is written to stdout.
 */

const net = require('node:net');

const mcpHost = process.env.FLOWHELM_MCP_HOST;
const mcpPort = process.env.FLOWHELM_MCP_PORT;
const socketPath = process.env.FLOWHELM_MCP_SOCKET || '/workspace/ipc/memory.sock';

// TCP mode: connect to host:port (macOS — virtiofs UDS limitation)
// UDS mode: connect to Unix domain socket (Linux — default)
const connectOptions = mcpHost && mcpPort
  ? { host: mcpHost, port: parseInt(mcpPort, 10) }
  : { path: socketPath };

const client = net.createConnection(connectOptions, () => {
  // Connected — pipe stdin to socket
  process.stdin.pipe(client);
});

// Pipe socket responses to stdout
client.pipe(process.stdout);

// Handle errors
client.on('error', (err) => {
  process.stderr.write(`Bridge error: ${err.message}\n`);
  process.exit(1);
});

client.on('close', () => {
  process.exit(0);
});

process.stdin.on('end', () => {
  client.end();
});

// Handle SIGTERM/SIGINT gracefully
process.on('SIGTERM', () => {
  client.end();
  process.exit(0);
});

process.on('SIGINT', () => {
  client.end();
  process.exit(0);
});
