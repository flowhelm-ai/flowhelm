/**
 * PostgreSQL connection factory and pool management.
 *
 * Creates and manages the postgres.js `sql` connection for a per-user
 * orchestrator. Handles connection URL construction, pool sizing,
 * and graceful shutdown (drain pool).
 *
 * Uses postgres.js tagged template literals for SQL injection prevention
 * by construction — ${variable} is always parameterized, never interpolated.
 */

import postgres from 'postgres';
import type { PostgresConnectionInfo } from '../container/postgres-manager.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ConnectionOptions {
  /** Connection info from PostgresContainerManager. */
  connection: PostgresConnectionInfo | string;
  /** Max connections in the pool (default: 5). */
  maxConnections?: number;
  /** Idle timeout in seconds before closing a connection (default: 20). */
  idleTimeout?: number;
  /** Connection timeout in seconds (default: 10). */
  connectTimeout?: number;
}

export type Sql = postgres.Sql;

// ─── Connection Factory ─────────────────────────────────────────────────────

/**
 * Build a postgres.js connection URL from connection info.
 */
export function buildConnectionUrl(info: PostgresConnectionInfo): string {
  const { host, port, database, username, password } = info;
  return `postgres://${username}:${encodeURIComponent(password)}@${host}:${String(port)}/${database}`;
}

/**
 * Create a postgres.js connection pool.
 *
 * The returned `sql` object is both a tagged template function
 * and a connection manager. Call `sql.end()` for graceful shutdown.
 */
export function createConnection(options: ConnectionOptions): Sql {
  const url =
    typeof options.connection === 'string'
      ? options.connection
      : buildConnectionUrl(options.connection);

  return postgres(url, {
    max: options.maxConnections ?? 5,
    idle_timeout: options.idleTimeout ?? 20,
    connect_timeout: options.connectTimeout ?? 10,
    // No SSL for local Podman network
    ssl: false,
    // Return notices as part of the query result instead of logging them
    onnotice: () => {},
  });
}
