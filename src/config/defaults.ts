/**
 * Default configuration values.
 * These are also declared in the Zod schema — this file provides
 * a convenient typed object for reference and documentation.
 */

import type { FlowHelmConfigInput } from './schema.js';

export const CONFIG_FILE_NAME = 'config.yaml';
export const CONFIG_DIR = '~/.flowhelm';

export const defaults: Partial<FlowHelmConfigInput> = {
  logLevel: 'info',
  dataDir: CONFIG_DIR,
  agent: {
    runtime: 'cli',
    maxConcurrentContainers: 5,
    maxTurns: 25,
    containerTimeout: 1_800_000,
    idleTimeout: 1_800_000,
    memoryLimit: '512m',
    cpuLimit: '1.0',
    pidsLimit: 256,
    image: 'ghcr.io/flowhelm-ai/flowhelm-agent:0.1.0',
    cliUseCustomSystemPrompt: true,
    cliDisableSlashCommands: false, // false: skills enabled; true: saves ~1-2K but breaks skills
    // cliTools: undefined — all tools available by default (ADR-026)
  },
  container: {
    runtime: 'podman',
    proxyImage: 'ghcr.io/flowhelm-ai/flowhelm-proxy:0.1.0',
    proxyMemoryLimit: '64m',
    proxyCpuLimit: '0.25',
  },
  database: {
    image: 'ghcr.io/flowhelm-ai/flowhelm-db:0.1.0',
    memoryLimit: '256m',
    cpuLimit: '0.5',
    maxConnections: 10,
    poolSize: 5,
  },
  memory: {
    embeddingProvider: 'transformers',
    embeddingModel: 'Xenova/all-MiniLM-L6-v2',
    embeddingDimensions: 384,
    workingMemoryLimit: 20,
    semanticMemoryLimit: 20,
    externalMemoryLimit: 10,
  },
  channels: {},
  service: {
    enabled: false,
  },
  channelContainer: {
    enabled: false,
  },
  pollInterval: 2000,
};
