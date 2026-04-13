/**
 * Test helper: manages a real PostgreSQL container via Podman for tests.
 *
 * Starts a pgvector/pgvector:0.8.2-pg18 container on a random port,
 * waits for it to accept connections, and provides postgres.js connections
 * to isolated test databases (one per test suite).
 *
 * Usage in vitest globalSetup:
 *   - startTestPg() in setup
 *   - stopTestPg() in teardown
 *
 * Usage in test files:
 *   - createTestDatabase() returns an isolated sql connection
 */

import { execSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import type { Sql } from '../../src/orchestrator/connection.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const CONTAINER_NAME = 'flowhelm-test-pg';
const IMAGE = 'docker.io/pgvector/pgvector:0.8.2-pg18';
const PG_USER = 'flowhelm';
const PG_PASSWORD = 'testpw';
const PG_DB = 'flowhelm';
const HOST_PORT = 5433; // Avoid conflict with any local PG on 5432

// ─── Container Lifecycle ────────────────────────────────────────────────────

/** Detect whether to use podman or docker. */
function getRuntime(): string {
  try {
    execSync('podman --version', { stdio: 'pipe' });
    return 'podman';
  } catch {
    try {
      execSync('docker --version', { stdio: 'pipe' });
      return 'docker';
    } catch {
      throw new Error('Neither podman nor docker found. Install podman to run tests.');
    }
  }
}

function run(runtime: string, args: string[]): string {
  const result = spawnSync(runtime, args, {
    encoding: 'utf-8',
    timeout: 30_000,
  });
  if (result.status !== 0) {
    throw new Error(`${runtime} ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

/** Start the test PostgreSQL container. Idempotent — skips if already running. */
export async function startTestPg(): Promise<void> {
  const runtime = getRuntime();

  // Check if container already exists and is running
  try {
    const state = run(runtime, ['inspect', '--format', '{{.State.Status}}', CONTAINER_NAME]);
    if (state === 'running') {
      // Already running — wait for ready
      await waitForReady(runtime);
      return;
    }
    // Exists but not running — remove and recreate
    run(runtime, ['rm', '-f', CONTAINER_NAME]);
  } catch {
    // Container doesn't exist — create it
  }

  run(runtime, [
    'run',
    '-d',
    '--name',
    CONTAINER_NAME,
    '-p',
    `${String(HOST_PORT)}:5432`,
    '-e',
    `POSTGRES_USER=${PG_USER}`,
    '-e',
    `POSTGRES_DB=${PG_DB}`,
    '-e',
    `POSTGRES_PASSWORD=${PG_PASSWORD}`,
    IMAGE,
  ]);

  await waitForReady(runtime);
}

/** Stop and remove the test PostgreSQL container. */
export async function stopTestPg(): Promise<void> {
  const runtime = getRuntime();
  try {
    run(runtime, ['stop', '-t', '5', CONTAINER_NAME]);
  } catch {
    // Already stopped
  }
  try {
    run(runtime, ['rm', '-f', CONTAINER_NAME]);
  } catch {
    // Already removed
  }
}

/** Wait for PostgreSQL to accept connections. */
async function waitForReady(runtime: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      run(runtime, ['exec', CONTAINER_NAME, 'pg_isready', '-U', PG_USER, '-d', PG_DB]);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`PostgreSQL did not become ready within ${String(timeoutMs)}ms`);
}

// ─── Database Helpers ───────────────────────────────────────────────────────

let dbCounter = 0;

/**
 * Create a fresh, isolated test database and return a postgres.js connection to it.
 * Each call creates a new database (flowhelm_test_1, flowhelm_test_2, etc.)
 * to isolate test suites from each other.
 */
export async function createTestDatabase(): Promise<{
  sql: Sql;
  dbName: string;
  cleanup: () => Promise<void>;
}> {
  const dbName = `flowhelm_test_${String(++dbCounter)}_${String(Date.now())}_${randomBytes(4).toString('hex')}`;

  // Connect to the default database to create our test database
  const adminSql = postgres({
    host: 'localhost',
    port: HOST_PORT,
    user: PG_USER,
    password: PG_PASSWORD,
    database: PG_DB,
    max: 1,
  });

  await adminSql.unsafe(`CREATE DATABASE "${dbName}"`);
  await adminSql.end();

  // Connect to the new test database
  const sql = postgres({
    host: 'localhost',
    port: HOST_PORT,
    user: PG_USER,
    password: PG_PASSWORD,
    database: dbName,
    max: 5,
  });

  // Enable pgvector
  await sql`CREATE EXTENSION IF NOT EXISTS vector`;

  return {
    sql,
    dbName,
    cleanup: async () => {
      await sql.end();
      // Drop the test database
      const dropSql = postgres({
        host: 'localhost',
        port: HOST_PORT,
        user: PG_USER,
        password: PG_PASSWORD,
        database: PG_DB,
        max: 1,
      });
      await dropSql.unsafe(`DROP DATABASE IF EXISTS "${dbName}"`);
      await dropSql.end();
    },
  };
}

/**
 * Get a postgres.js connection to the default test database.
 * Useful for simple tests that don't need full isolation.
 */
export function getTestConnectionUrl(): string {
  return `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${String(HOST_PORT)}/${PG_DB}`;
}

/**
 * Apply the FlowHelm schema.sql directly to a test database.
 * Executes schema.sql which creates all tables, indexes, and seed data.
 */
export async function applySchema(sql: Sql): Promise<void> {
  const schemaPath = join(
    dirname(fileURLToPath(import.meta.url)),
    '../../src/orchestrator/schema.sql',
  );
  const schemaSql = readFileSync(schemaPath, 'utf-8');
  await sql.unsafe(schemaSql);
}

export { HOST_PORT, PG_USER, PG_PASSWORD, PG_DB, CONTAINER_NAME };
