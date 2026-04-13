import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadConfigFile,
  loadConfigFromEnv,
  loadConfigFromArgs,
  deepMerge,
  expandHome,
  getConfigPathFromArgs,
} from '../src/config/loader.js';

describe('expandHome', () => {
  it('expands ~ to home directory', () => {
    const result = expandHome('~/foo/bar');
    expect(result).not.toContain('~');
    expect(result).toContain('foo/bar');
  });

  it('leaves absolute paths unchanged', () => {
    expect(expandHome('/usr/local')).toBe('/usr/local');
  });

  it('leaves relative paths unchanged', () => {
    expect(expandHome('foo/bar')).toBe('foo/bar');
  });
});

describe('loadConfigFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `flowhelm-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty object for missing file', () => {
    const result = loadConfigFile(join(tmpDir, 'nonexistent.yaml'));
    expect(result).toEqual({});
  });

  it('parses YAML config file', () => {
    const configPath = join(tmpDir, 'config.yaml');
    writeFileSync(
      configPath,
      `username: stan
logLevel: debug
agent:
  runtime: sdk
  maxTurns: 10
`,
    );
    const result = loadConfigFile(configPath);
    expect(result).toEqual({
      username: 'stan',
      logLevel: 'debug',
      agent: { runtime: 'sdk', maxTurns: 10 },
    });
  });

  it('returns empty object for empty file', () => {
    const configPath = join(tmpDir, 'empty.yaml');
    writeFileSync(configPath, '');
    const result = loadConfigFile(configPath);
    expect(result).toEqual({});
  });

  it('throws on non-object YAML', () => {
    const configPath = join(tmpDir, 'bad.yaml');
    writeFileSync(configPath, 'just a string');
    expect(() => loadConfigFile(configPath)).toThrow('must contain a YAML object');
  });
});

describe('loadConfigFromEnv', () => {
  it('extracts username from env', () => {
    const result = loadConfigFromEnv({ FLOWHELM_USERNAME: 'stan' });
    expect(result).toEqual({ username: 'stan' });
  });

  it('extracts multiple env vars', () => {
    const result = loadConfigFromEnv({
      FLOWHELM_USERNAME: 'alex',
      FLOWHELM_LOG_LEVEL: 'debug',
      FLOWHELM_DATA_DIR: '/data/flowhelm',
    });
    expect(result).toEqual({
      username: 'alex',
      logLevel: 'debug',
      dataDir: '/data/flowhelm',
    });
  });

  it('extracts agent runtime from env', () => {
    const result = loadConfigFromEnv({ FLOWHELM_AGENT_RUNTIME: 'sdk' });
    expect(result).toEqual({ agent: { runtime: 'sdk' } });
  });

  it('extracts container runtime from env', () => {
    const result = loadConfigFromEnv({ FLOWHELM_CONTAINER_RUNTIME: 'apple_container' });
    expect(result).toEqual({ container: { runtime: 'apple_container' } });
  });

  it('extracts telegram bot token from env', () => {
    const result = loadConfigFromEnv({ FLOWHELM_TELEGRAM_BOT_TOKEN: 'bot123' });
    expect(result).toEqual({ channels: { telegram: { botToken: 'bot123' } } });
  });

  it('converts poll interval to number', () => {
    const result = loadConfigFromEnv({ FLOWHELM_POLL_INTERVAL: '5000' });
    expect(result).toEqual({ pollInterval: 5000 });
  });

  it('ignores unrelated env vars', () => {
    const result = loadConfigFromEnv({ HOME: '/home/user', PATH: '/usr/bin' });
    expect(result).toEqual({});
  });
});

describe('loadConfigFromArgs', () => {
  it('extracts --username', () => {
    const result = loadConfigFromArgs(['--username', 'stan']);
    expect(result).toEqual({ username: 'stan' });
  });

  it('extracts --username=value format', () => {
    const result = loadConfigFromArgs(['--username=stan']);
    expect(result).toEqual({ username: 'stan' });
  });

  it('extracts --log-level', () => {
    const result = loadConfigFromArgs(['--log-level', 'debug']);
    expect(result).toEqual({ logLevel: 'debug' });
  });

  it('extracts --agent-runtime', () => {
    const result = loadConfigFromArgs(['--agent-runtime', 'sdk']);
    expect(result).toEqual({ agent: { runtime: 'sdk' } });
  });

  it('ignores non-flag arguments', () => {
    const result = loadConfigFromArgs(['start', '--username', 'stan', 'extra']);
    expect(result).toEqual({ username: 'stan' });
  });
});

describe('getConfigPathFromArgs', () => {
  it('extracts --config path', () => {
    expect(getConfigPathFromArgs(['--config', '/path/to/config.yaml'])).toBe(
      '/path/to/config.yaml',
    );
  });

  it('extracts --config=path format', () => {
    expect(getConfigPathFromArgs(['--config=/path/to/config.yaml'])).toBe('/path/to/config.yaml');
  });

  it('returns undefined when not present', () => {
    expect(getConfigPathFromArgs(['--username', 'stan'])).toBeUndefined();
  });
});

describe('deepMerge', () => {
  it('merges flat objects', () => {
    expect(deepMerge({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
  });

  it('later values win', () => {
    expect(deepMerge({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
  });

  it('merges nested objects', () => {
    expect(deepMerge({ a: { x: 1, y: 2 } }, { a: { y: 3, z: 4 } })).toEqual({
      a: { x: 1, y: 3, z: 4 },
    });
  });

  it('replaces arrays (no concatenation)', () => {
    expect(deepMerge({ a: [1, 2] }, { a: [3] })).toEqual({ a: [3] });
  });

  it('skips undefined values', () => {
    expect(deepMerge({ a: 1 }, { a: undefined })).toEqual({ a: 1 });
  });

  it('handles three-way merge', () => {
    expect(deepMerge({ a: 1 }, { b: 2 }, { c: 3 })).toEqual({ a: 1, b: 2, c: 3 });
  });

  it('respects precedence: file < env < CLI', () => {
    const file = { username: 'file-user', logLevel: 'info', agent: { runtime: 'cli' } };
    const env = { logLevel: 'debug' };
    const cli = { username: 'cli-user' };
    const result = deepMerge(file, env, cli);
    expect(result).toEqual({
      username: 'cli-user',
      logLevel: 'debug',
      agent: { runtime: 'cli' },
    });
  });
});
