import { describe, it, expect } from 'vitest';
import { flowhelmConfigSchema } from '../src/config/schema.js';

describe('flowhelmConfigSchema', () => {
  it('validates a minimal config with just username', () => {
    const result = flowhelmConfigSchema.parse({ username: 'stan' });
    expect(result.username).toBe('stan');
    expect(result.logLevel).toBe('info');
    expect(result.agent.runtime).toBe('cli');
    expect(result.agent.maxConcurrentContainers).toBe(5);
    expect(result.agent.maxTurns).toBe(25);
    expect(result.container.runtime).toBe('podman');
    expect(result.service.enabled).toBe(false);
    expect(result.database.image).toBe('ghcr.io/flowhelm-ai/flowhelm-db:0.1.0');
    expect(result.memory.embeddingProvider).toBe('transformers');
    expect(result.pollInterval).toBe(2000);
  });

  it('rejects missing username', () => {
    expect(() => flowhelmConfigSchema.parse({})).toThrow();
  });

  it('rejects empty username', () => {
    expect(() => flowhelmConfigSchema.parse({ username: '' })).toThrow();
  });

  it('rejects invalid username format', () => {
    expect(() => flowhelmConfigSchema.parse({ username: 'Stan' })).toThrow(); // uppercase
    expect(() => flowhelmConfigSchema.parse({ username: '1stan' })).toThrow(); // starts with number
    expect(() => flowhelmConfigSchema.parse({ username: 'st an' })).toThrow(); // space
  });

  it('accepts valid username formats', () => {
    expect(flowhelmConfigSchema.parse({ username: 'stan' }).username).toBe('stan');
    expect(flowhelmConfigSchema.parse({ username: 'stan-dev' }).username).toBe('stan-dev');
    expect(flowhelmConfigSchema.parse({ username: 'user_1' }).username).toBe('user_1');
  });

  it('validates agent runtime modes', () => {
    const cli = flowhelmConfigSchema.parse({ username: 'stan', agent: { runtime: 'cli' } });
    expect(cli.agent.runtime).toBe('cli');

    const sdk = flowhelmConfigSchema.parse({ username: 'stan', agent: { runtime: 'sdk' } });
    expect(sdk.agent.runtime).toBe('sdk');

    expect(() =>
      flowhelmConfigSchema.parse({ username: 'stan', agent: { runtime: 'docker' } }),
    ).toThrow();
  });

  it('validates container runtime options', () => {
    const podman = flowhelmConfigSchema.parse({
      username: 'stan',
      container: { runtime: 'podman' },
    });
    expect(podman.container.runtime).toBe('podman');

    const apple = flowhelmConfigSchema.parse({
      username: 'stan',
      container: { runtime: 'apple_container' },
    });
    expect(apple.container.runtime).toBe('apple_container');
  });

  it('validates agent resource limits', () => {
    const result = flowhelmConfigSchema.parse({
      username: 'stan',
      agent: {
        maxConcurrentContainers: 3,
        memoryLimit: '1g',
        cpuLimit: '2.0',
        pidsLimit: 128,
      },
    });
    expect(result.agent.maxConcurrentContainers).toBe(3);
    expect(result.agent.memoryLimit).toBe('1g');
    expect(result.agent.cpuLimit).toBe('2.0');
    expect(result.agent.pidsLimit).toBe(128);
  });

  it('rejects invalid agent limits', () => {
    expect(() =>
      flowhelmConfigSchema.parse({
        username: 'stan',
        agent: { maxConcurrentContainers: 0 },
      }),
    ).toThrow();

    expect(() =>
      flowhelmConfigSchema.parse({
        username: 'stan',
        agent: { maxConcurrentContainers: 21 },
      }),
    ).toThrow();

    expect(() =>
      flowhelmConfigSchema.parse({
        username: 'stan',
        agent: { pidsLimit: 10 },
      }),
    ).toThrow();
  });

  it('validates log levels', () => {
    for (const level of ['trace', 'debug', 'info', 'warn', 'error']) {
      expect(flowhelmConfigSchema.parse({ username: 'stan', logLevel: level }).logLevel).toBe(
        level,
      );
    }
    expect(() => flowhelmConfigSchema.parse({ username: 'stan', logLevel: 'verbose' })).toThrow();
  });

  it('validates channel config', () => {
    const result = flowhelmConfigSchema.parse({
      username: 'stan',
      channels: {
        telegram: { botToken: 'abc123', allowedUsers: [12345] },
        whatsapp: { enabled: true },
      },
    });
    expect(result.channels.telegram?.botToken).toBe('abc123');
    expect(result.channels.telegram?.allowedUsers).toEqual([12345]);
    expect(result.channels.whatsapp?.enabled).toBe(true);
  });

  it('rejects empty telegram bot token', () => {
    expect(() =>
      flowhelmConfigSchema.parse({
        username: 'stan',
        channels: { telegram: { botToken: '' } },
      }),
    ).toThrow();
  });

  it('validates service config with custom STT settings', () => {
    const result = flowhelmConfigSchema.parse({
      username: 'stan',
      service: { enabled: true, stt: { language: 'de', threads: 4 } },
    });
    expect(result.service.enabled).toBe(true);
    expect(result.service.stt.language).toBe('de');
    expect(result.service.stt.threads).toBe(4);
    expect(result.service.stt.provider).toBe('whisper_cpp');
  });

  it('validates database config', () => {
    const result = flowhelmConfigSchema.parse({
      username: 'stan',
      database: { memoryLimit: '512m', poolSize: 10 },
    });
    expect(result.database.memoryLimit).toBe('512m');
    expect(result.database.poolSize).toBe(10);
    expect(result.database.image).toBe('ghcr.io/flowhelm-ai/flowhelm-db:0.1.0');
  });

  it('rejects invalid database config', () => {
    expect(() =>
      flowhelmConfigSchema.parse({ username: 'stan', database: { maxConnections: 0 } }),
    ).toThrow();
    expect(() =>
      flowhelmConfigSchema.parse({ username: 'stan', database: { poolSize: 0 } }),
    ).toThrow();
  });

  it('validates memory config', () => {
    const result = flowhelmConfigSchema.parse({
      username: 'stan',
      memory: { embeddingProvider: 'openai', embeddingDimensions: 1536 },
    });
    expect(result.memory.embeddingProvider).toBe('openai');
    expect(result.memory.embeddingDimensions).toBe(1536);
  });

  it('rejects invalid memory config', () => {
    expect(() =>
      flowhelmConfigSchema.parse({ username: 'stan', memory: { embeddingDimensions: 0 } }),
    ).toThrow();
    expect(() =>
      flowhelmConfigSchema.parse({ username: 'stan', memory: { embeddingProvider: 'invalid' } }),
    ).toThrow();
    expect(() =>
      flowhelmConfigSchema.parse({ username: 'stan', memory: { workingMemoryLimit: 0 } }),
    ).toThrow();
  });

  it('validates memory tier limits', () => {
    const result = flowhelmConfigSchema.parse({
      username: 'stan',
      memory: {
        workingMemoryLimit: 30,
        semanticMemoryLimit: 40,
        metaMemoryLimit: 10,
        externalMemoryLimit: 15,
        externalSimilarityThreshold: 0.6,
        contextTokenBudget: 8000,
      },
    });
    expect(result.memory.workingMemoryLimit).toBe(30);
    expect(result.memory.semanticMemoryLimit).toBe(40);
    expect(result.memory.metaMemoryLimit).toBe(10);
    expect(result.memory.externalMemoryLimit).toBe(15);
    expect(result.memory.externalSimilarityThreshold).toBe(0.6);
    expect(result.memory.contextTokenBudget).toBe(8000);
  });

  it('validates scoring config with defaults', () => {
    const result = flowhelmConfigSchema.parse({ username: 'stan' });
    expect(result.memory.scoring.alpha).toBe(0.5);
    expect(result.memory.scoring.beta).toBe(0.3);
    expect(result.memory.scoring.gamma).toBe(0.2);
    expect(result.memory.scoring.lambda).toBe(0.01);
    expect(result.memory.scoring.candidateMultiplier).toBe(3);
  });

  it('validates custom scoring weights', () => {
    const result = flowhelmConfigSchema.parse({
      username: 'stan',
      memory: {
        scoring: { alpha: 0.7, beta: 0.2, gamma: 0.1, lambda: 0.05, candidateMultiplier: 5 },
      },
    });
    expect(result.memory.scoring.alpha).toBe(0.7);
    expect(result.memory.scoring.candidateMultiplier).toBe(5);
  });

  it('rejects out-of-range scoring weights', () => {
    expect(() =>
      flowhelmConfigSchema.parse({ username: 'stan', memory: { scoring: { alpha: 1.5 } } }),
    ).toThrow();
    expect(() =>
      flowhelmConfigSchema.parse({ username: 'stan', memory: { scoring: { lambda: -0.1 } } }),
    ).toThrow();
    expect(() =>
      flowhelmConfigSchema.parse({
        username: 'stan',
        memory: { scoring: { candidateMultiplier: 0 } },
      }),
    ).toThrow();
  });

  it('validates consolidation config with defaults', () => {
    const result = flowhelmConfigSchema.parse({ username: 'stan' });
    expect(result.memory.consolidation.enabled).toBe(true);
    expect(result.memory.consolidation.schedule).toBe('0 */6 * * *');
    expect(result.memory.consolidation.consolidationModel).toBe('claude-haiku-4-5-20251001');
    expect(result.memory.consolidation.minUnconsolidatedMessages).toBe(20);
    expect(result.memory.consolidation.chunkSize).toBe(10);
    expect(result.memory.consolidation.consolidationThreshold).toBe(5);
    expect(result.memory.consolidation.d0MaxTokens).toBe(400);
    expect(result.memory.consolidation.d1MaxTokens).toBe(500);
  });

  it('validates custom consolidation config', () => {
    const result = flowhelmConfigSchema.parse({
      username: 'stan',
      memory: { consolidation: { enabled: false, chunkSize: 20, d0MaxTokens: 800 } },
    });
    expect(result.memory.consolidation.enabled).toBe(false);
    expect(result.memory.consolidation.chunkSize).toBe(20);
    expect(result.memory.consolidation.d0MaxTokens).toBe(800);
  });

  it('rejects invalid consolidation config', () => {
    expect(() =>
      flowhelmConfigSchema.parse({
        username: 'stan',
        memory: { consolidation: { chunkSize: 1 } },
      }),
    ).toThrow();
    expect(() =>
      flowhelmConfigSchema.parse({
        username: 'stan',
        memory: { consolidation: { d0MaxTokens: 50 } },
      }),
    ).toThrow();
  });

  it('validates reflection config with defaults', () => {
    const result = flowhelmConfigSchema.parse({ username: 'stan' });
    expect(result.memory.reflection.enabled).toBe(true);
    expect(result.memory.reflection.schedule).toBe('0 3 * * *');
    expect(result.memory.reflection.reflectionModel).toBe('claude-haiku-4-5-20251001');
    expect(result.memory.reflection.maxInputTokens).toBe(4000);
    expect(result.memory.reflection.minSemanticEntries).toBe(10);
    expect(result.memory.reflection.confidenceThreshold).toBe(0.3);
  });

  it('validates custom reflection config', () => {
    const result = flowhelmConfigSchema.parse({
      username: 'stan',
      memory: { reflection: { enabled: true, maxInputTokens: 8000, confidenceThreshold: 0.5 } },
    });
    expect(result.memory.reflection.enabled).toBe(true);
    expect(result.memory.reflection.maxInputTokens).toBe(8000);
    expect(result.memory.reflection.confidenceThreshold).toBe(0.5);
  });

  it('validates identity config with defaults', () => {
    const result = flowhelmConfigSchema.parse({ username: 'stan' });
    expect(result.memory.identity.personalityConfidenceThreshold).toBe(0.4);
    expect(result.memory.identity.userPersonalityConfidenceThreshold).toBe(0.4);
  });

  it('validates custom identity config', () => {
    const result = flowhelmConfigSchema.parse({
      username: 'stan',
      memory: {
        identity: { personalityConfidenceThreshold: 0.6, userPersonalityConfidenceThreshold: 0.8 },
      },
    });
    expect(result.memory.identity.personalityConfidenceThreshold).toBe(0.6);
    expect(result.memory.identity.userPersonalityConfidenceThreshold).toBe(0.8);
  });

  it('applies all defaults for a full config', () => {
    const result = flowhelmConfigSchema.parse({ username: 'stan' });
    expect(result).toEqual({
      username: 'stan',
      logLevel: 'info',
      dataDir: '~/.flowhelm',
      agent: {
        runtime: 'cli',
        credentialMethod: 'oauth',
        maxConcurrentContainers: 5,
        maxTurns: 25,
        containerTimeout: 3_600_000,
        idleTimeout: 3_600_000,
        sessionHardExpiry: 86_400_000,
        sessionCleanupInterval: 300_000,
        memoryLimit: '512m',
        cpuLimit: '1.0',
        pidsLimit: 256,
        image: 'ghcr.io/flowhelm-ai/flowhelm-agent:0.1.0',
        cliUseCustomSystemPrompt: true,
        cliDisableSlashCommands: false,
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
        metaMemoryLimit: 5,
        externalMemoryLimit: 10,
        externalSimilarityThreshold: 0.5,
        contextTokenBudget: 10000,
        scoring: {
          alpha: 0.5,
          beta: 0.3,
          gamma: 0.2,
          lambda: 0.01,
          candidateMultiplier: 3,
        },
        consolidation: {
          enabled: true,
          schedule: '0 */6 * * *',
          consolidationModel: 'claude-haiku-4-5-20251001',
          minUnconsolidatedMessages: 20,
          chunkSize: 10,
          consolidationThreshold: 5,
          d0MaxTokens: 400,
          d1MaxTokens: 500,
        },
        reflection: {
          enabled: true,
          schedule: '0 3 * * *',
          reflectionModel: 'claude-haiku-4-5-20251001',
          maxInputTokens: 4000,
          minSemanticEntries: 10,
          confidenceThreshold: 0.3,
          metaCondensationThreshold: 5,
          d1MetaMaxTokens: 400,
          d2MetaMaxTokens: 300,
          maxMetaDepth: 3,
          contradictionCascade: true,
        },
        identity: {
          personalityConfidenceThreshold: 0.4,
          userPersonalityConfidenceThreshold: 0.4,
        },
        metaInjection: {
          strategy: 'cascade',
          d2MinSimilarity: 0.3,
          d1MinSimilarity: 0.4,
          d0MinSimilarity: 0.5,
          d2Slots: 2,
          d1Slots: 2,
          d0Slots: 1,
        },
      },
      auth: {
        method: 'api_key',
        bridgeUrl: 'https://flowhelm.to',
      },
      channels: {},
      profiles: {
        autoAssignDefault: true,
        maxPerUser: 10,
      },
      service: {
        enabled: false,
        image: 'ghcr.io/flowhelm-ai/flowhelm-service:0.1.0',
        memoryLimit: '2g',
        cpuLimit: '2.0',
        port: 8787,
        stt: {
          enabled: true,
          provider: 'whisper_cpp',
          modelPath: '/models/ggml-small.bin',
          language: 'en',
          threads: 2,
        },
        vision: { enabled: true, provider: 'claude' },
        tts: { enabled: false, provider: 'none' },
      },
      channelContainer: {
        enabled: false,
        image: 'ghcr.io/flowhelm-ai/flowhelm-channel:0.1.0',
        memoryLimit: '256m',
        cpuLimit: '0.5',
        port: 9000,
      },
      pollInterval: 2000,
    });
  });
});
