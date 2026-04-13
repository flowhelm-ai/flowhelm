import { describe, it, expect } from 'vitest';
import { buildConnectionUrl } from '../src/orchestrator/connection.js';
import type { PostgresConnectionInfo } from '../src/container/postgres-manager.js';

// ─── Tests ────────────────────────────────────────────────────────────────

describe('buildConnectionUrl', () => {
  const baseInfo: PostgresConnectionInfo = {
    host: 'flowhelm-db-stan',
    port: 5432,
    database: 'flowhelm',
    username: 'flowhelm',
    password: 'secret123',
  };

  it('builds a standard postgres URL', () => {
    const url = buildConnectionUrl(baseInfo);
    expect(url).toBe('postgres://flowhelm:secret123@flowhelm-db-stan:5432/flowhelm');
  });

  it('URL-encodes special characters in password', () => {
    const info: PostgresConnectionInfo = {
      ...baseInfo,
      password: 'p@ss/word#123',
    };
    const url = buildConnectionUrl(info);
    expect(url).toBe(
      `postgres://flowhelm:${encodeURIComponent('p@ss/word#123')}@flowhelm-db-stan:5432/flowhelm`,
    );
    expect(url).toContain('p%40ss%2Fword%23123');
  });

  it('handles custom port', () => {
    const info: PostgresConnectionInfo = { ...baseInfo, port: 5433 };
    const url = buildConnectionUrl(info);
    expect(url).toContain(':5433/');
  });

  it('handles custom database name', () => {
    const info: PostgresConnectionInfo = { ...baseInfo, database: 'custom_db' };
    const url = buildConnectionUrl(info);
    expect(url.endsWith('/custom_db')).toBe(true);
  });

  it('handles empty password', () => {
    const info: PostgresConnectionInfo = { ...baseInfo, password: '' };
    const url = buildConnectionUrl(info);
    expect(url).toBe('postgres://flowhelm:@flowhelm-db-stan:5432/flowhelm');
  });

  it('handles password with spaces', () => {
    const info: PostgresConnectionInfo = { ...baseInfo, password: 'my password' };
    const url = buildConnectionUrl(info);
    expect(url).toContain('my%20password');
  });

  it('handles localhost connections', () => {
    const info: PostgresConnectionInfo = { ...baseInfo, host: 'localhost' };
    const url = buildConnectionUrl(info);
    expect(url).toBe('postgres://flowhelm:secret123@localhost:5432/flowhelm');
  });
});
