/**
 * Zod config schema with validation and defaults.
 *
 * All configuration is validated at startup. Invalid values produce
 * clear error messages with field paths rather than silent runtime failures.
 */

import { z } from 'zod';

// ─── Channel Schemas ────────────────────────────────────────────────────────

const telegramConfigSchema = z.object({
  botToken: z.string().min(1, 'Telegram bot token is required'),
  allowedUsers: z.array(z.number().int()).default([]),
});

const whatsappConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /**
   * Allowed phone numbers (without country code prefix +).
   * Empty = allow all. Example: ["14155551234", "442071234567"]
   */
  allowedNumbers: z.array(z.string()).default([]),
  /** Print QR code in terminal during pairing. Default: true. */
  printQrInTerminal: z.boolean().default(true),
});

const gmailFilterSchema = z.object({
  /** Only process starred emails. */
  starredOnly: z.boolean().default(false),
  /** Only process emails from these senders (exact match or glob pattern). */
  importantContacts: z.array(z.string()).default([]),
  /** Only process emails with these Gmail labels. Default: INBOX. */
  labels: z.array(z.string()).default(['INBOX']),
  /** Exclude emails matching these sender patterns (regex strings). */
  excludeSenders: z.array(z.string()).default([]),
  /** Minimum importance to forward (0.0–1.0). Emails below this are silently skipped. */
  minImportance: z.number().min(0).max(1).default(0),
});

const gmailConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** User's Gmail address (e.g., user@gmail.com). */
  emailAddress: z.string().email().optional(),

  /** Transport mode: 'pubsub' (GCP Pub/Sub REST pull) or 'imap' (IMAP IDLE). */
  transport: z.enum(['pubsub', 'imap']).default('pubsub'),

  // ── Pub/Sub transport settings ──
  /** GCP project ID (required for pubsub transport). */
  gcpProject: z.string().optional(),
  /** Pub/Sub topic name (short name, not full resource path). */
  pubsubTopic: z.string().default('flowhelm-gmail'),
  /** Pub/Sub subscription name. */
  pubsubSubscription: z.string().default('flowhelm-gmail-sub'),
  /** Path to GCP service account key JSON file (for Pub/Sub auth). */
  serviceAccountKeyPath: z.string().optional(),
  /** Pub/Sub pull interval in ms. Default: 5000 (5s). */
  pullInterval: z.number().int().min(1000).max(60_000).default(5000),

  // ── IMAP/SMTP transport settings ──
  /** IMAP server hostname. Default: imap.gmail.com. */
  imapHost: z.string().default('imap.gmail.com'),
  /** IMAP server port. Default: 993 (TLS). */
  imapPort: z.number().int().default(993),
  /** SMTP server hostname. Default: smtp.gmail.com. */
  smtpHost: z.string().default('smtp.gmail.com'),
  /** SMTP server port. Default: 465 (TLS). */
  smtpPort: z.number().int().default(465),

  // ── OAuth settings (shared by both transports for Gmail API / IMAP XOAUTH2) ──
  /** OAuth client ID. */
  oauthClientId: z.string().optional(),
  /** OAuth client secret. */
  oauthClientSecret: z.string().optional(),

  // ── Watch settings ──
  /** Watch renewal interval in ms. Default: 6 days (518400000). */
  watchRenewalInterval: z.number().int().min(60_000).default(518_400_000),

  // ── Notification routing ──
  /** Channel to forward email notifications to (e.g., 'telegram'). If unset, responses route back via Gmail. */
  notificationChannel: z.enum(['telegram', 'whatsapp']).optional(),

  /** Email filter rules. */
  filter: gmailFilterSchema.default({}),
});

const channelsConfigSchema = z.object({
  telegram: telegramConfigSchema.optional(),
  whatsapp: whatsappConfigSchema.optional(),
  gmail: gmailConfigSchema.optional(),
});

// ─── Service Schema ────────────────────────────────────────────────────

const serviceSttConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** STT inference backend. 'whisper_cpp' = local inference, 'openai_whisper' = OpenAI API ($0.006/min). */
  provider: z.enum(['whisper_cpp', 'openai_whisper']).default('whisper_cpp'),
  /** Path to GGML model file inside the service container (whisper_cpp only). */
  modelPath: z.string().default('/models/ggml-small.bin'),
  /** Default language code (ISO 639-1). */
  language: z.string().default('en'),
  /** CPU threads for inference (whisper_cpp only). */
  threads: z.number().int().min(1).max(16).default(2),
});

const serviceVisionConfigSchema = z.object({
  /** When enabled with provider 'claude', images pass through to the Claude agent. */
  enabled: z.boolean().default(true),
  /** Vision inference provider. 'claude' = pass-through to agent, 'none' = skip. */
  provider: z.enum(['claude', 'none']).default('claude'),
});

const serviceTtsConfigSchema = z.object({
  /** TTS is a stub — not yet implemented. */
  enabled: z.boolean().default(false),
  provider: z.enum(['none']).default('none'),
});

const serviceConfigSchema = z.object({
  /** Enable the service container for local media processing. */
  enabled: z.boolean().default(false),
  /** Service container image. */
  image: z.string().default('ghcr.io/flowhelm-ai/flowhelm-service:0.1.0'),
  /** Memory limit for the service container. */
  memoryLimit: z.string().default('2g'),
  /** CPU limit for the service container. */
  cpuLimit: z.string().default('2.0'),
  /** HTTP API port inside the container network. */
  port: z.number().int().min(1024).max(65535).default(8787),
  /** Speech-to-text configuration. */
  stt: serviceSttConfigSchema.default({}),
  /** Vision/OCR configuration. */
  vision: serviceVisionConfigSchema.default({}),
  /** Text-to-speech configuration (stub). */
  tts: serviceTtsConfigSchema.default({}),
});

// ─── Channel Container Schema ─────────────────────────────────────────────

const channelContainerSchema = z.object({
  /** Enable the channel container. */
  enabled: z.boolean().default(false),
  /** Channel container image. */
  image: z.string().default('ghcr.io/flowhelm-ai/flowhelm-channel:0.1.0'),
  /** Memory limit for the channel container. */
  memoryLimit: z.string().default('256m'),
  /** CPU limit for the channel container. */
  cpuLimit: z.string().default('0.5'),
  /** HTTP API port inside the container network. */
  port: z.number().int().min(1024).max(65535).default(9000),
});

// ─── Agent Schema ───────────────────────────────────────────────────────────

const agentRuntimeModeSchema = z.enum(['cli', 'sdk']);

/**
 * Credential method for agent containers.
 *
 * Controls which placeholder env var the agent container receives,
 * which determines the auth header the CLI/SDK sends through the MITM proxy:
 *
 *   'oauth'   → CLAUDE_CODE_OAUTH_TOKEN placeholder → Authorization: Bearer header
 *              CLI runtime only. Requires OAuth token in secrets.
 *
 *   'api_key' → ANTHROPIC_API_KEY placeholder → x-api-key header
 *              Works with both CLI and SDK runtimes. Required for SDK.
 *
 * The MITM proxy's header-aware credential selection matches the agent's
 * outbound auth header to the corresponding credential rule.
 */
const credentialMethodSchema = z.enum(['oauth', 'api_key']);

const agentConfigSchema = z.object({
  runtime: agentRuntimeModeSchema.default('cli'),
  /** Which credential to present to agent containers. See credentialMethodSchema. */
  credentialMethod: credentialMethodSchema.default('oauth'),
  maxConcurrentContainers: z.number().int().min(1).max(20).default(5),
  maxTurns: z.number().int().min(1).max(100).default(25),
  containerTimeout: z.number().int().min(10_000).default(3_600_000), // 60 min
  idleTimeout: z.number().int().min(0).default(3_600_000), // 60 min (warm container idle timeout)
  /** Hard session expiry in ms. Containers are force-stopped after this
   *  regardless of activity. Default: 24 hours. */
  sessionHardExpiry: z.number().int().min(60_000).default(86_400_000), // 24h
  /** Session cleanup interval in ms. Periodic sweep for expired sessions.
   *  Default: 5 minutes. */
  sessionCleanupInterval: z.number().int().min(10_000).default(300_000), // 5 min
  memoryLimit: z.string().default('512m'),
  cpuLimit: z.string().default('1.0'),
  pidsLimit: z.number().int().min(32).default(256),
  image: z.string().default('ghcr.io/flowhelm-ai/flowhelm-agent:0.1.0'),

  /**
   * CLI token optimization (ADR-026). These options only apply to CLI runtime.
   */

  /** Replace the CLI's default coding-focused system prompt with a minimal,
   *  task-focused prompt. Set to false to keep the CLI's default prompt.
   *  Default: true (saves ~2-3K tokens per invocation). */
  cliUseCustomSystemPrompt: z.boolean().default(true),

  /** Disable Claude Code's built-in slash commands AND skills in CLI mode.
   *  Saves ~1-2K tokens per invocation but prevents skills from loading.
   *  Default: false (skills enabled). Set to true only if the user has no
   *  skills installed and wants maximum token savings. See ADR-026. */
  cliDisableSlashCommands: z.boolean().default(false),

  /** Restrict which built-in CLI tools are available to the agent.
   *  When unset (default), all tools are available. Set to a comma-separated
   *  list of tool names to restrict, e.g. "Bash,Read,Write,Edit".
   *  This is an advanced optimization — restricting tools may break skills
   *  that depend on excluded tools. */
  cliTools: z.string().optional(),
});

// ─── Container Schema ───────────────────────────────────────────────────────

const containerConfigSchema = z.object({
  runtime: z.enum(['podman', 'apple_container']).default('podman'),
  proxyImage: z.string().default('ghcr.io/flowhelm-ai/flowhelm-proxy:0.1.0'),
  proxyMemoryLimit: z.string().default('64m'),
  proxyCpuLimit: z.string().default('0.25'),
});

// ─── Database Schema ───────────────────────────────────────────────────────

const databaseConfigSchema = z.object({
  /** PostgreSQL container image. */
  image: z.string().default('ghcr.io/flowhelm-ai/flowhelm-db:0.1.0'),
  /** Memory limit for the PG container. */
  memoryLimit: z.string().default('256m'),
  /** CPU limit for the PG container. */
  cpuLimit: z.string().default('0.5'),
  /** PG max connections (per-user orchestrator needs few). */
  maxConnections: z.number().int().min(2).max(50).default(10),
  /** Connection pool size for the orchestrator. */
  poolSize: z.number().int().min(1).max(20).default(5),
});

// ─── Memory Schema ─────────────────────────────────────────────────────────

const embeddingProviderSchema = z.enum(['transformers', 'openai']);

const scoringConfigSchema = z.object({
  /** Similarity weight (dominant factor). */
  alpha: z.number().min(0).max(1).default(0.5),
  /** Recency weight (time decay). */
  beta: z.number().min(0).max(1).default(0.3),
  /** Importance/confidence weight. */
  gamma: z.number().min(0).max(1).default(0.2),
  /** Decay rate per day. */
  lambda: z.number().min(0).max(1).default(0.01),
  /** HNSW oversampling factor for Phase 1 candidate fetch. */
  candidateMultiplier: z.number().int().min(1).max(10).default(3),
});

const consolidationConfigSchema = z.object({
  /** Enable scheduled consolidation (Tier 1 → Tier 2). */
  enabled: z.boolean().default(true),
  /** Cron schedule for consolidation job. */
  schedule: z.string().default('0 */6 * * *'),
  /** Model for summarization. */
  consolidationModel: z.string().default('claude-haiku-4-5-20251001'),
  /** Minimum unconsolidated messages before running. */
  minUnconsolidatedMessages: z.number().int().min(1).default(20),
  /** Messages per chunk for d0 summarization. */
  chunkSize: z.number().int().min(2).max(50).default(10),
  /** Number of d0 summaries before triggering d1 condensation. */
  consolidationThreshold: z.number().int().min(2).max(20).default(5),
  /** Max tokens for d0 summary output. */
  d0MaxTokens: z.number().int().min(100).max(2000).default(400),
  /** Max tokens for d1+ condensation output. */
  d1MaxTokens: z.number().int().min(100).max(2000).default(500),
});

const reflectionConfigSchema = z.object({
  /** Enable scheduled reflection (Tier 2 → Tier 3). Enabled by default; opt out to disable. */
  enabled: z.boolean().default(true),
  /** Cron schedule for reflection job. */
  schedule: z.string().default('0 3 * * *'),
  /** Model for reflection. */
  reflectionModel: z.string().default('claude-haiku-4-5-20251001'),
  /** Max input tokens for reflection prompt. */
  maxInputTokens: z.number().int().min(1000).max(16000).default(4000),
  /** Minimum Tier 2 entries since last run before reflecting. */
  minSemanticEntries: z.number().int().min(1).default(10),
  /** Initial confidence threshold for new reflections (clamped). */
  confidenceThreshold: z.number().min(0).max(1).default(0.3),
  /** Min uncondensed entries at depth N before condensing to depth N+1. */
  metaCondensationThreshold: z.number().int().min(2).default(5),
  /** Max tokens for d1 meta synthesis prompt. */
  d1MetaMaxTokens: z.number().int().min(100).max(2000).default(400),
  /** Max tokens for d2+ meta synthesis prompt. */
  d2MetaMaxTokens: z.number().int().min(100).max(2000).default(300),
  /** Max depth level for meta DAG (0-indexed). */
  maxMetaDepth: z.number().int().min(1).max(10).default(3),
  /** Enable contradiction cascade: decay parent entries when children are contradicted. */
  contradictionCascade: z.boolean().default(true),
});

const identityConfigSchema = z.object({
  /** Minimum confidence for agent personality dimensions in context injection. */
  personalityConfidenceThreshold: z.number().min(0).max(1).default(0.4),
  /** Minimum confidence for user personality dimensions in context injection. */
  userPersonalityConfidenceThreshold: z.number().min(0).max(1).default(0.4),
});

const metaInjectionConfigSchema = z.object({
  /**
   * Injection strategy for T3 meta memory into agent context.
   * 'cascade': top-down hierarchical — highest depth first, fill remaining budget
   *            with progressively lower depths, each gated by similarity threshold.
   * 'flat': all depths compete in a single pool by composite score (legacy).
   */
  strategy: z.enum(['cascade', 'flat']).default('cascade'),
  /** Similarity threshold for d2+ strategic entries (lower = more permissive). */
  d2MinSimilarity: z.number().min(0).max(1).default(0.3),
  /** Similarity threshold for d1 evaluated patterns. */
  d1MinSimilarity: z.number().min(0).max(1).default(0.4),
  /** Similarity threshold for d0 direct observations (higher = stricter). */
  d0MinSimilarity: z.number().min(0).max(1).default(0.5),
  /** Max d2+ entries to inject. */
  d2Slots: z.number().int().min(0).max(20).default(2),
  /** Max d1 entries to inject. */
  d1Slots: z.number().int().min(0).max(20).default(2),
  /** Max d0 entries to inject (fills remaining budget). */
  d0Slots: z.number().int().min(0).max(20).default(1),
});

const memoryConfigSchema = z.object({
  /** Embedding provider. Default: local transformers (free, offline). */
  embeddingProvider: embeddingProviderSchema.default('transformers'),
  /** Embedding model name. */
  embeddingModel: z.string().default('Xenova/all-MiniLM-L6-v2'),
  /** Embedding vector dimensions. Must match the model output. */
  embeddingDimensions: z.number().int().min(64).max(4096).default(384),

  /** Max working memory messages per context build (Tier 1). */
  workingMemoryLimit: z.number().int().min(1).max(100).default(20),
  /** Max semantic memory entries per context build (Tier 2). */
  semanticMemoryLimit: z.number().int().min(1).max(100).default(20),
  /** Max meta memory entries per context build (Tier 3). */
  metaMemoryLimit: z.number().int().min(1).max(50).default(5),
  /** Max external memory entries per context build. */
  externalMemoryLimit: z.number().int().min(1).max(50).default(10),
  /** Minimum similarity for external memory injection (below this, block is omitted). */
  externalSimilarityThreshold: z.number().min(0).max(1).default(0.5),
  /** Total token budget for buildAgentContext() output. */
  contextTokenBudget: z.number().int().min(1000).max(50000).default(10000),

  /** Composite scoring weights and parameters. */
  scoring: scoringConfigSchema.default({}),
  /** Scheduled consolidation (Tier 1 → Tier 2). */
  consolidation: consolidationConfigSchema.default({}),
  /** Scheduled reflection (Tier 2 → Tier 3). Opt-in. */
  reflection: reflectionConfigSchema.default({}),
  /** Identity layer thresholds. */
  identity: identityConfigSchema.default({}),
  /** Meta memory injection strategy (how T3 entries are selected for agent context). */
  metaInjection: metaInjectionConfigSchema.default({}),
});

// ─── Profiles Schema ──────────────────────────────────────────────────────

const profilesConfigSchema = z.object({
  /** Auto-assign new chats to the default profile. */
  autoAssignDefault: z.boolean().default(true),
  /** Maximum number of profiles per user. */
  maxPerUser: z.number().int().min(1).max(50).default(10),
});

// ─── Auth Schema ──────────────────────────────────────────────────────────

const authMethodSchema = z.enum(['api_key', 'subscription_bridge', 'subscription_tunnel']);

const authConfigSchema = z.object({
  /** Authentication method. Default: api_key. */
  method: authMethodSchema.default('api_key'),
  /** Token Bridge relay URL for subscription auth. Default: 'https://flowhelm.to'. */
  bridgeUrl: z.string().url().default('https://flowhelm.to'),
  /** Anthropic API key (for api_key method). Loaded from secrets file if not set. */
  apiKey: z.string().optional(),
});

// ─── Skills Schema ──────────────────────────────────────────────────────────

/** SKILL.md frontmatter `requires` block. */
export const skillRequiresSchema = z.object({
  channels: z.array(z.string()).default([]),
  bins: z.array(z.string()).default([]),
  env: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  os: z.array(z.enum(['linux', 'macos'])).default([]),
});

/** Zod schema for SKILL.md YAML frontmatter. */
export const skillFrontmatterSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9-]*$/, 'Skill name must be lowercase alphanumeric with hyphens'),
  description: z.string().min(1).max(256),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'Version must be semver (e.g., 1.0.0)'),
  requires: skillRequiresSchema.default({}),
});

export type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>;
export type SkillRequires = z.infer<typeof skillRequiresSchema>;

/** Single entry in ~/.flowhelm/skills/installed.json. */
export const installedSkillEntrySchema = z.object({
  name: z.string(),
  version: z.string(),
  source: z.enum(['registry', 'local', 'git']),
  installedAt: z.string(),
  requires: skillRequiresSchema,
});

export type InstalledSkillEntry = z.infer<typeof installedSkillEntrySchema>;

/** The full installed.json manifest. */
export const installedManifestSchema = z.array(installedSkillEntrySchema);

export type InstalledManifest = z.infer<typeof installedManifestSchema>;

/** Registry skill entry from registry.json. */
export const registrySkillEntrySchema = z.object({
  name: z.string(),
  description: z.string(),
  version: z.string(),
  path: z.string(),
  /** SHA-256 hash of the SKILL.md file for integrity verification. Optional in Stage 1. */
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/, 'SHA-256 must be a 64-character hex string')
    .optional(),
});

export type RegistrySkillEntry = z.infer<typeof registrySkillEntrySchema>;

/** Registry index file (registry.json). */
export const registryIndexSchema = z.object({
  version: z.number(),
  skills: z.array(registrySkillEntrySchema),
});

export type RegistryIndex = z.infer<typeof registryIndexSchema>;

// ─── Top-Level Schema ───────────────────────────────────────────────────────

export const flowhelmConfigSchema = z.object({
  /** Username for this FlowHelm instance. */
  username: z
    .string()
    .min(1)
    .max(32)
    .regex(
      /^[a-z][a-z0-9_-]*$/,
      'Username must be lowercase alphanumeric with hyphens/underscores',
    ),

  /** Log level. */
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),

  /** Data directory. */
  dataDir: z.string().default('~/.flowhelm'),

  /** Agent runtime configuration. */
  agent: agentConfigSchema.default({}),

  /** Container runtime configuration. */
  container: containerConfigSchema.default({}),

  /** Channel configurations (only enabled channels will connect). */
  channels: channelsConfigSchema.default({}),

  /** Service container for local media processing (STT, vision, TTS). */
  service: serviceConfigSchema.default({}),

  /** Channel container for unified channel adapter hosting. */
  channelContainer: channelContainerSchema.default({}),

  /** PostgreSQL database container configuration. */
  database: databaseConfigSchema.default({}),

  /** Three-tier memory system configuration. */
  memory: memoryConfigSchema.default({}),

  /** Authentication configuration. */
  auth: authConfigSchema.default({}),

  /** Agent profile configuration. */
  profiles: profilesConfigSchema.default({}),

  /** Message queue polling interval in ms. Kept as fallback; event-driven LISTEN/NOTIFY is primary. */
  pollInterval: z.number().int().min(500).default(2000),
});

export type FlowHelmConfig = z.infer<typeof flowhelmConfigSchema>;

/** Partial config for merging from file/env/CLI sources. */
export type FlowHelmConfigInput = z.input<typeof flowhelmConfigSchema>;
