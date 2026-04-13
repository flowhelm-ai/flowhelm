#!/usr/bin/env node

/**
 * FlowHelm entry point.
 *
 * Sequential startup with graceful shutdown via SIGTERM/SIGINT.
 * Components are stopped in reverse registration order (LIFO)
 * with a configurable drain timeout before force-stop.
 */

import * as path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { loadConfig } from './config/index.js';
import type { Startable } from './orchestrator/types.js';
import { createConnection } from './orchestrator/connection.js';
import { FlowHelmDatabase } from './orchestrator/database.js';
import { MessageQueue } from './orchestrator/message-queue.js';
import { createEmbeddingProvider } from './orchestrator/embeddings.js';
import { MemoryManager } from './orchestrator/memory.js';
import { IdentityManager } from './orchestrator/identity.js';
import { MemoryConsolidationJob } from './orchestrator/consolidation.js';
import { MemoryReflectionJob } from './orchestrator/reflection.js';
import { ProfileManager } from './orchestrator/profile-manager.js';
import { MessageRouter } from './orchestrator/message-router.js';
import { FlowHelmOrchestrator } from './orchestrator/orchestrator.js';
import { CredentialStore } from './proxy/credential-store.js';
import { ProxyManager } from './proxy/proxy-manager.js';
import { createRuntime } from './container/index.js';
import { ContainerLifecycleManager } from './container/lifecycle.js';
import { PostgresContainerManager } from './container/postgres-manager.js';
import { createAgentRuntime } from './agent/index.js';
import { MemoryProvider } from './orchestrator/memory-provider.js';
import { SkillStore } from './skills/store.js';
import { ChannelManager, ChannelClient } from './channels/index.js';
import { ServiceManager, ServiceClient } from './service/index.js';

/** Components registered for graceful lifecycle management. */
const components: Startable[] = [];

/** Register a component for graceful shutdown. */
export function registerComponent(component: Startable): void {
  components.push(component);
}

/** Graceful shutdown: stop all components in reverse order. */
async function shutdown(signal: string): Promise<void> {
  console.log(`\n[flowhelm] Received ${signal}, shutting down gracefully...`);

  // Stop components in reverse registration order (LIFO)
  const toStop = [...components].reverse();
  for (const component of toStop) {
    try {
      await component.stop();
    } catch (err) {
      console.error(`[flowhelm] Error stopping component:`, err);
    }
  }

  console.log('[flowhelm] Shutdown complete.');
  process.exit(0);
}

export async function main(): Promise<void> {
  // 1. Load and validate config (fails fast on invalid config)
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error('[flowhelm] Configuration error:');
    if (err instanceof Error && 'issues' in err) {
      // Zod validation error — print each issue
      const zodErr = err as Error & {
        issues: Array<{ path: (string | number)[]; message: string }>;
      };
      for (const issue of zodErr.issues) {
        console.error(`  ${issue.path.join('.')}: ${issue.message}`);
      }
    } else {
      console.error(err);
    }
    process.exit(1);
  }

  // Validate credential method for SDK runtime (SDK requires API key)
  if (config.agent.runtime === 'sdk' && config.agent.credentialMethod === 'oauth') {
    console.error(
      '[flowhelm] Fatal: SDK runtime requires credentialMethod: api_key (OAuth not supported)',
    );
    process.exit(1);
  }

  console.log(`[flowhelm] Starting as user: ${config.username}`);
  console.log(`[flowhelm] Agent runtime: ${config.agent.runtime}`);
  console.log(`[flowhelm] Credential method: ${config.agent.credentialMethod}`);
  console.log(`[flowhelm] Container runtime: ${config.container.runtime}`);
  console.log(`[flowhelm] Log level: ${config.logLevel}`);

  const containerRuntime = createRuntime(config.container.runtime);
  const dataDir = config.dataDir.replace('~', process.env['HOME'] ?? '~');

  // 2. Container lifecycle: ensure network, cleanup orphans
  const lifecycle = new ContainerLifecycleManager({
    runtime: containerRuntime,
    username: config.username,
  });
  await lifecycle.start();
  registerComponent(lifecycle);
  console.log(`[flowhelm] Container lifecycle initialized`);

  // 3. Initialize credential store and migrate legacy plaintext secrets
  const credentialStore = new CredentialStore({
    secretsDir: `${dataDir}/secrets`,
  });
  await credentialStore.ensureSecretsDir();
  await credentialStore.migrateAuthTokens();

  // 4. Start credential proxy container (before any other containers)
  const proxyManager = new ProxyManager({
    runtime: containerRuntime,
    username: config.username,
    credentialStore,
    proxyImage: config.container.proxyImage,
    memoryLimit: config.container.proxyMemoryLimit,
    cpuLimit: config.container.proxyCpuLimit,
    credentialMethod: config.agent.credentialMethod,
  });
  await proxyManager.start();
  registerComponent(proxyManager);
  console.log(`[flowhelm] Credential proxy started: ${proxyManager.containerName}`);

  // 5. Start per-user PostgreSQL container
  // DB password is stored in the encrypted credential vault (credentials.enc).
  // dbPassword() generates on first boot, migrates from legacy plaintext, or reads existing.
  const dbPassword = await credentialStore.dbPassword();
  let connectionUrl = process.env['FLOWHELM_DATABASE_URL'];

  if (!connectionUrl) {
    const pgDataDir = `${dataDir}/data/pg`;
    const pgHostPort = 15432 + (hashCode(config.username) % 1000);

    const secretsDir = `${dataDir}/secrets`;
    await mkdir(secretsDir, { recursive: true });
    await loadPersistedAuthTokens(secretsDir);

    const pgManager = new PostgresContainerManager({
      runtime: containerRuntime,
      username: config.username,
      dataDir: pgDataDir,
      image: config.database.image,
      memoryLimit: config.database.memoryLimit,
      cpuLimit: config.database.cpuLimit,
      hostPort: pgHostPort,
      dbPassword,
    });
    await pgManager.start();
    registerComponent(pgManager);
    connectionUrl = pgManager.getConnectionUrl();
    console.log(
      `[flowhelm] PostgreSQL started: ${pgManager.getName()} (localhost:${String(pgHostPort)})`,
    );

    // Wait for PG to be fully ready (first-time init takes 10-15s)
    console.log('[flowhelm] Waiting for PostgreSQL to be ready...');
    const pgDeadline = Date.now() + 60_000;
    while (Date.now() < pgDeadline) {
      if (await pgManager.isHealthy()) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    // Extra wait for first-time init (PG starts, inits, stops, restarts)
    await new Promise((r) => setTimeout(r, 5000));
  }

  // Connect to PG with retry (first-time init may cause transient failures)
  let sql: ReturnType<typeof createConnection> | undefined;
  const connDeadline = Date.now() + 30_000;
  while (Date.now() < connDeadline) {
    try {
      sql = createConnection({
        connection: connectionUrl,
        maxConnections: config.database.poolSize,
      });
      // Test the connection
      await sql`SELECT 1`;
      break;
    } catch {
      sql = undefined;
      console.log('[flowhelm] Waiting for PostgreSQL connection...');
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  if (!sql) {
    throw new Error(`Failed to connect to PostgreSQL at ${connectionUrl}`);
  }

  // 6. Initialize database layer (applies schema.sql on start)
  const database = new FlowHelmDatabase({ sql });
  await database.start();
  registerComponent(database);
  console.log('[flowhelm] Database schema applied');

  // 7. Initialize message queue (subscribes to LISTEN/NOTIFY)
  const queue = new MessageQueue({ database });
  await queue.start();
  registerComponent(queue);

  // 8. Initialize embedding provider and memory manager
  const embeddingProvider = createEmbeddingProvider({
    provider: config.memory.embeddingProvider,
    model: config.memory.embeddingModel,
    dimensions: config.memory.embeddingDimensions,
  });

  // 8b. Initialize identity manager and profile manager
  const identityManager = new IdentityManager({ sql });
  const profileManager = new ProfileManager({
    sql,
    maxProfilesPerUser: config.profiles.maxPerUser,
  });

  const memory = new MemoryManager({
    sql,
    embeddingProvider,
    identityManager,
    profileManager,
    workingMemoryLimit: config.memory.workingMemoryLimit,
    semanticMemoryLimit: config.memory.semanticMemoryLimit,
    metaMemoryLimit: config.memory.metaMemoryLimit,
    externalMemoryLimit: config.memory.externalMemoryLimit,
    externalSimilarityThreshold: config.memory.externalSimilarityThreshold,
    scoringWeights: config.memory.scoring,
    candidateMultiplier: config.memory.scoring.candidateMultiplier,
    identityThresholds: config.memory.identity,
    metaInjection: config.memory.metaInjection,
  });

  await memory.start();
  registerComponent(memory);

  // 8c. Initialize summarization provider for consolidation/reflection jobs
  const summarizationProvider = new MemoryProvider({
    containerRuntime,
    agentImage: config.agent.image,
    proxyUrl: proxyManager.proxyUrl,
    username: config.username,
    network: `flowhelm-network-${config.username}`,
    caCertPath: credentialStore.caCertPath,
    credentialMethod: config.agent.credentialMethod,
  });

  const consolidationJob = new MemoryConsolidationJob({
    sql,
    summarizationProvider,
    embeddingProvider,
    config: config.memory.consolidation,
  });

  const reflectionJob = new MemoryReflectionJob({
    sql,
    summarizationProvider,
    embeddingProvider,
    config: config.memory.reflection,
  });

  // 9. Start channel container (hosts Telegram, Gmail adapters)
  const downloadsDir = `${dataDir}/downloads`;
  let channelClient: ChannelClient | undefined;
  if (config.channelContainer.enabled) {
    const channelHostPort = 19000 + (hashCode(config.username) % 1000);
    const channelEnv: Record<string, string> = {};

    // Telegram env vars
    if (config.channels.telegram?.botToken) {
      channelEnv['TELEGRAM_ENABLED'] = 'true';
      const allowedUsers = config.channels.telegram.allowedUsers ?? [];
      if (allowedUsers.length > 0) {
        channelEnv['TELEGRAM_ALLOWED_USERS'] = allowedUsers.join(',');
      }
    }

    // Gmail env vars
    if (config.channels.gmail?.enabled) {
      channelEnv['GMAIL_ENABLED'] = 'true';
      channelEnv['GMAIL_TRANSPORT'] = config.channels.gmail.transport ?? 'pubsub';
      if (config.channels.gmail.emailAddress) {
        channelEnv['GMAIL_EMAIL_ADDRESS'] = config.channels.gmail.emailAddress;
      }
      if (config.channels.gmail.gcpProject) {
        channelEnv['GMAIL_GCP_PROJECT'] = config.channels.gmail.gcpProject;
      }
      if (config.channels.gmail.pubsubTopic) {
        channelEnv['GMAIL_PUBSUB_TOPIC'] = config.channels.gmail.pubsubTopic;
      }
      if (config.channels.gmail.pubsubSubscription) {
        channelEnv['GMAIL_PUBSUB_SUBSCRIPTION'] = config.channels.gmail.pubsubSubscription;
      }
      // Note: serviceAccountKeyPath from config is no longer passed as env var.
      // The SA key JSON is stored in the encrypted vault (secrets["gmail-sa-key"])
      // and written to tmpfs at runtime inside the channel container.
      if (config.channels.gmail.pullInterval) {
        channelEnv['GMAIL_PULL_INTERVAL'] = String(config.channels.gmail.pullInterval);
      }
      if (config.channels.gmail.imapHost) {
        channelEnv['GMAIL_IMAP_HOST'] = config.channels.gmail.imapHost;
      }
      if (config.channels.gmail.imapPort) {
        channelEnv['GMAIL_IMAP_PORT'] = String(config.channels.gmail.imapPort);
      }
      if (config.channels.gmail.notificationChannel) {
        channelEnv['GMAIL_NOTIFICATION_CHANNEL'] = config.channels.gmail.notificationChannel;
        // Resolve the notification target user ID on the notification channel
        if (config.channels.gmail.notificationChannel === 'telegram') {
          const firstUser = config.channels.telegram?.allowedUsers?.[0];
          if (firstUser) channelEnv['GMAIL_NOTIFICATION_USER_ID'] = `tg:${String(firstUser)}`;
        }
      }
    }

    // Load encryption key for channel container credential decryption
    const channelCredKey = await credentialStore.ensureKey();

    const channelManager = new ChannelManager({
      runtime: containerRuntime,
      username: config.username,
      config: config.channelContainer,
      downloadsDir,
      logsDir: `${dataDir}/logs/channels`,
      credentialsEncPath: credentialStore.encPath,
      credentialKeyHex: channelCredKey.toString('hex'),
      dbHost: `flowhelm-db-${config.username}`,
      dbPort: 5432,
      dbUser: 'flowhelm',
      dbPassword: dbPassword,
      dbName: 'flowhelm',
      channelEnv,
      hostPort: channelHostPort,
    });
    await channelManager.start();
    registerComponent(channelManager);
    channelClient = new ChannelClient({ baseUrl: channelManager.hostUrl });
    console.log(`[flowhelm] Channel container started: ${channelManager.containerName}`);
  }

  // 10. Initialize message router (outbound delivery via channel container)
  const router = new MessageRouter({ database, memory, profileManager, channelClient });
  await router.start();
  registerComponent(router);

  // 11. Initialize skill store
  const skillStore = new SkillStore({ skillsDir: `${dataDir}/skills` });
  await skillStore.init();

  // 12. Initialize agent runtime (CLI or SDK based on config)
  const { runtime: agentRuntime, sessionManager } = createAgentRuntime({
    config,
    containerRuntime,
    sql,
    proxyUrl: proxyManager.proxyUrl,
    skillStore,
    builtinSkillsDir: path.join(import.meta.dirname ?? '.', '..', 'container-image', 'skills'),
    caCertPath: credentialStore.caCertPath,
  });
  sessionManager.start();

  // 13. Start service container for local media processing (STT, vision, TTS)
  let serviceClient: ServiceClient | undefined;
  if (config.service.enabled) {
    // Deterministic host port from username hash (same pattern as PG)
    const serviceHostPort = 18787 + (hashCode(config.username) % 1000);
    const serviceManager = new ServiceManager({
      runtime: containerRuntime,
      username: config.username,
      config: config.service,
      downloadsDir,
      modelsDir: `${dataDir}/models`,
      hostPort: serviceHostPort,
      proxyUrl: proxyManager.proxyUrl,
      caCertPath: credentialStore.caCertPath,
    });
    await serviceManager.start();
    registerComponent(serviceManager);
    serviceClient = new ServiceClient({ baseUrl: serviceManager.hostUrl });
    console.log(`[flowhelm] Service container started: ${serviceManager.containerName}`);
  }

  // 14. Initialize orchestrator (event-driven main loop)
  const orchestrator = new FlowHelmOrchestrator({
    config,
    database,
    queue,
    memory,
    router,
    identity: identityManager,
    profileManager,
    consolidationJob,
    reflectionJob,
    agentRuntime,
    serviceClient,
    channelClient,
  });
  await orchestrator.start();
  registerComponent(orchestrator);

  console.log('[flowhelm] Ready. Waiting for messages...');

  // Keep the process alive until signal
  await new Promise<void>(() => {
    // Intentionally never resolves — the process runs until signaled
  });
}

// Signal handlers
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// Unhandled rejection handler
process.on('unhandledRejection', (reason) => {
  console.error('[flowhelm] Unhandled rejection:', reason);
  void shutdown('unhandledRejection');
});

/**
 * Load persisted auth tokens from the secrets directory into process.env.
 *
 * Supports two auth methods:
 *   - CLAUDE_CODE_OAUTH_TOKEN: subscription auth (Pro/Max plans)
 *   - ANTHROPIC_API_KEY: direct API key auth
 *
 * Tokens are saved during `flowhelm setup` or the first run with the env var set.
 * On subsequent restarts, they're loaded automatically — users never re-paste.
 */
async function loadPersistedAuthTokens(secretsDir: string): Promise<void> {
  const tokenFiles: Array<{ file: string; envVar: string }> = [
    { file: 'oauth-token', envVar: 'CLAUDE_CODE_OAUTH_TOKEN' },
    { file: 'api-key', envVar: 'ANTHROPIC_API_KEY' },
  ];

  for (const { file, envVar } of tokenFiles) {
    // If already set in environment, persist it for future restarts
    const envValue = process.env[envVar];
    if (envValue) {
      const filePath = path.join(secretsDir, file);
      try {
        const existing = (await readFile(filePath, 'utf-8')).trim();
        if (existing !== envValue) {
          await writeFile(filePath, envValue, { mode: 0o600 });
          console.log(`[flowhelm] Updated persisted ${envVar}`);
        }
      } catch {
        // File doesn't exist yet — save for first time
        await writeFile(filePath, envValue, { mode: 0o600 });
        console.log(`[flowhelm] Persisted ${envVar} to ${file}`);
      }
      continue;
    }

    // Not in environment — try loading from file
    try {
      const token = (await readFile(path.join(secretsDir, file), 'utf-8')).trim();
      if (token) {
        process.env[envVar] = token;
        console.log(`[flowhelm] Loaded ${envVar} from persisted secrets`);
      }
    } catch {
      // File doesn't exist — no token available for this method
    }
  }
}

/** Simple string hash for deterministic port assignment. */
function hashCode(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = (Math.imul(31, hash) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

// Auto-invoke only when run directly (not when imported by cli.ts)
const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith('/index.js') || process.argv[1].endsWith('/index.ts'));

if (isDirectRun) {
  main().catch((err) => {
    console.error('[flowhelm] Fatal error:', err);
    process.exit(1);
  });
}
