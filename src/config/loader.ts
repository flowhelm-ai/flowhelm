/**
 * Config loader with file → env → CLI precedence.
 *
 * Loads YAML config, overlays environment variables, overlays CLI flags,
 * then validates through Zod. Fails fast at startup with clear errors.
 *
 * Precedence (later wins):
 * 1. Zod defaults
 * 2. Config file (~/.flowhelm/config.yaml)
 * 3. Environment variables (FLOWHELM_*)
 * 4. CLI flags (--username, --log-level, etc.)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { flowhelmConfigSchema, type FlowHelmConfig, type FlowHelmConfigInput } from './schema.js';
import { CONFIG_DIR, CONFIG_FILE_NAME } from './defaults.js';

/** Resolve ~ to the user's home directory. */
export function expandHome(path: string): string {
  if (path.startsWith('~/')) {
    return resolve(homedir(), path.slice(2));
  }
  return path;
}

/** Load config from YAML file. Returns empty object if file doesn't exist. */
export function loadConfigFile(configPath?: string): Partial<FlowHelmConfigInput> {
  const filePath = configPath ?? resolve(expandHome(CONFIG_DIR), CONFIG_FILE_NAME);

  if (!existsSync(filePath)) {
    return {};
  }

  const raw = readFileSync(filePath, 'utf-8');
  const parsed: unknown = parseYaml(raw);

  if (parsed === null || parsed === undefined) {
    return {};
  }

  if (typeof parsed !== 'object') {
    throw new Error(`Config file ${filePath} must contain a YAML object, got ${typeof parsed}`);
  }

  return parsed as Partial<FlowHelmConfigInput>;
}

/**
 * Extract config from environment variables.
 * Convention: FLOWHELM_USERNAME, FLOWHELM_LOG_LEVEL, FLOWHELM_AGENT_RUNTIME, etc.
 */
export function loadConfigFromEnv(
  env: Record<string, string | undefined>,
): Partial<FlowHelmConfigInput> {
  const config: Record<string, unknown> = {};

  const simple: Record<string, string> = {
    FLOWHELM_USERNAME: 'username',
    FLOWHELM_LOG_LEVEL: 'logLevel',
    FLOWHELM_DATA_DIR: 'dataDir',
    FLOWHELM_DB_PATH: 'dbPath',
    FLOWHELM_POLL_INTERVAL: 'pollInterval',
  };

  for (const [envKey, configKey] of Object.entries(simple)) {
    if (env[envKey] !== undefined) {
      const val = env[envKey];
      // Attempt numeric conversion for known numeric fields
      if (configKey === 'pollInterval') {
        config[configKey] = Number(val);
      } else {
        config[configKey] = val;
      }
    }
  }

  // Agent runtime
  if (env['FLOWHELM_AGENT_RUNTIME'] !== undefined) {
    config['agent'] = {
      ...(config['agent'] as Record<string, unknown> | undefined),
      runtime: env['FLOWHELM_AGENT_RUNTIME'],
    };
  }

  // Container runtime
  if (env['FLOWHELM_CONTAINER_RUNTIME'] !== undefined) {
    config['container'] = {
      ...(config['container'] as Record<string, unknown> | undefined),
      runtime: env['FLOWHELM_CONTAINER_RUNTIME'],
    };
  }

  // Telegram bot token
  if (env['FLOWHELM_TELEGRAM_BOT_TOKEN'] !== undefined) {
    config['channels'] = {
      ...(config['channels'] as Record<string, unknown> | undefined),
      telegram: { botToken: env['FLOWHELM_TELEGRAM_BOT_TOKEN'] },
    };
  }

  return config as Partial<FlowHelmConfigInput>;
}

/** Parse simple CLI flags (--key=value or --key value style). */
export function loadConfigFromArgs(args: string[]): Partial<FlowHelmConfigInput> {
  const config: Record<string, unknown> = {};
  let i = 0;

  while (i < args.length) {
    const arg = args[i];
    if (arg === undefined) {
      i++;
      continue;
    }

    if (!arg.startsWith('--')) {
      i++;
      continue;
    }

    let key: string;
    let value: string | undefined;

    if (arg.includes('=')) {
      const eqIndex = arg.indexOf('=');
      key = arg.slice(2, eqIndex);
      value = arg.slice(eqIndex + 1);
    } else {
      key = arg.slice(2);
      value = args[i + 1];
      i++;
    }

    switch (key) {
      case 'username':
        config['username'] = value;
        break;
      case 'log-level':
        config['logLevel'] = value;
        break;
      case 'data-dir':
        config['dataDir'] = value;
        break;
      case 'agent-runtime':
        config['agent'] = {
          ...(config['agent'] as Record<string, unknown> | undefined),
          runtime: value,
        };
        break;
      case 'config':
        // Handled separately — the config file path itself
        break;
    }

    i++;
  }

  return config as Partial<FlowHelmConfigInput>;
}

/** Extract --config path from CLI args. */
export function getConfigPathFromArgs(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--config' && args[i + 1]) {
      return args[i + 1];
    }
    if (arg?.startsWith('--config=')) {
      return arg.slice('--config='.length);
    }
  }
  return undefined;
}

/**
 * Deep merge objects. Later values win. Arrays are replaced, not concatenated.
 */
export function deepMerge<T extends Record<string, unknown>>(...objects: Partial<T>[]): Partial<T> {
  const result: Record<string, unknown> = {};

  for (const obj of objects) {
    for (const [key, value] of Object.entries(obj)) {
      if (
        value !== undefined &&
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        typeof result[key] === 'object' &&
        result[key] !== null &&
        !Array.isArray(result[key])
      ) {
        result[key] = deepMerge(
          result[key] as Record<string, unknown>,
          value as Record<string, unknown>,
        );
      } else if (value !== undefined) {
        result[key] = value;
      }
    }
  }

  return result as Partial<T>;
}

/**
 * Load, merge, and validate config from all sources.
 * Throws ZodError with detailed messages on invalid config.
 */
export function loadConfig(
  args: string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
): FlowHelmConfig {
  const configPath = getConfigPathFromArgs(args);
  const fileConfig = loadConfigFile(configPath);
  const envConfig = loadConfigFromEnv(env);
  const cliConfig = loadConfigFromArgs(args);

  const merged = deepMerge(fileConfig, envConfig, cliConfig);
  return flowhelmConfigSchema.parse(merged);
}

/**
 * Save config to YAML file.
 * Only writes fields that differ from defaults to keep the file clean.
 * Creates parent directory if needed.
 */
export function saveConfig(config: FlowHelmConfig, configDir?: string): void {
  const dir = expandHome(configDir ?? CONFIG_DIR);
  mkdirSync(dir, { recursive: true });
  const filePath = resolve(dir, CONFIG_FILE_NAME);
  const yaml = stringifyYaml(config, { indent: 2 });
  writeFileSync(filePath, yaml, { mode: 0o600 });
}
