/**
 * Tests for the CLI dispatcher (src/cli.ts) and version utility.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Version utility ───────────────────────────────────────────────────────

describe('getVersion', () => {
  it('returns a semver-like version string', async () => {
    const { getVersion } = await import('../src/admin/version.js');
    const version = getVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('caches the version across calls', async () => {
    const { getVersion } = await import('../src/admin/version.js');
    const v1 = getVersion();
    const v2 = getVersion();
    expect(v1).toBe(v2);
  });
});

// ─── CLI dispatcher routing ────────────────────────────────────────────────

describe('CLI dispatcher', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('--version prints version', async () => {
    const { cli } = await import('../src/cli.js');
    await cli(['node', 'flowhelm', '--version']);

    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/^flowhelm v\d+\.\d+\.\d+/));
  });

  it('-v prints version', async () => {
    const { cli } = await import('../src/cli.js');
    await cli(['node', 'flowhelm', '-v']);

    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/^flowhelm v/));
  });

  it('version prints version', async () => {
    const { cli } = await import('../src/cli.js');
    await cli(['node', 'flowhelm', 'version']);

    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/^flowhelm v/));
  });

  it('--help prints usage information', async () => {
    const { cli } = await import('../src/cli.js');
    await cli(['node', 'flowhelm', '--help']);

    const output = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('FlowHelm');
    expect(output).toContain('Usage:');
    expect(output).toContain('start');
    expect(output).toContain('setup');
    expect(output).toContain('doctor');
    expect(output).toContain('admin');
    expect(output).toContain('install');
  });

  it('help prints usage information', async () => {
    const { cli } = await import('../src/cli.js');
    await cli(['node', 'flowhelm', 'help']);

    const output = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('FlowHelm');
  });

  it('unknown command prints error and exits with code 1', async () => {
    const { cli } = await import('../src/cli.js');

    await expect(cli(['node', 'flowhelm', 'nonexistent'])).rejects.toThrow('process.exit called');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown command'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('identity without args prints guidance and exits', async () => {
    const { cli } = await import('../src/cli.js');

    await expect(cli(['node', 'flowhelm', 'identity'])).rejects.toThrow('process.exit called');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
  });

  it('personality without args prints guidance and exits', async () => {
    const { cli } = await import('../src/cli.js');

    await expect(cli(['node', 'flowhelm', 'personality'])).rejects.toThrow('process.exit called');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
  });
});

// ─── parseNonInteractiveFlags ──────────────────────────────────────────────

describe('extractFlag', () => {
  it('extracts --flag value pairs', async () => {
    const { extractFlag } = await import('../src/admin/cli.js');
    expect(extractFlag(['--bot-token', '123:ABC'], 'bot-token')).toBe('123:ABC');
  });

  it('extracts --flag=value pairs', async () => {
    const { extractFlag } = await import('../src/admin/cli.js');
    expect(extractFlag(['--bot-token=123:ABC'], 'bot-token')).toBe('123:ABC');
  });

  it('returns undefined for missing flags', async () => {
    const { extractFlag } = await import('../src/admin/cli.js');
    expect(extractFlag(['--other', 'val'], 'bot-token')).toBeUndefined();
  });
});
