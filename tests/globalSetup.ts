/**
 * Vitest global setup: starts a real PostgreSQL container before all tests,
 * stops it after all tests complete.
 */

import { startTestPg, stopTestPg } from './helpers/pg-container.js';

export async function setup(): Promise<void> {
  console.log('\n[test] Starting PostgreSQL container...');
  await startTestPg();
  console.log('[test] PostgreSQL ready.\n');
}

export async function teardown(): Promise<void> {
  console.log('\n[test] Stopping PostgreSQL container...');
  await stopTestPg();
  console.log('[test] PostgreSQL stopped.\n');
}
