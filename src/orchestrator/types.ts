/**
 * Core types for FlowHelm orchestrator.
 *
 * All identifiers are channel-agnostic with explicit channel prefixes
 * (e.g., tg:123, wa:+1234). Channel adapters include reconnection and
 * health check support for production reliability.
 */

// ─── Messages ───────────────────────────────────────────────────────────────

/** Normalized inbound message from any channel. */
export interface InboundMessage {
  /** Unique message ID (channel-specific). */
  id: string;
  /** Channel this message arrived from. */
  channel: ChannelType;
  /** Channel-specific user identifier (e.g., tg:123, wa:+1234@s.whatsapp.net). */
  userId: string;
  /** Display name of the sender. */
  senderName: string;
  /** Text content (may be transcribed from voice). */
  text?: string;
  /** Path to downloaded audio file (voice notes). */
  audioPath?: string;
  /** Path to downloaded image file. */
  imagePath?: string;
  /** ID of the message being replied to. */
  replyToMessageId?: string;
  /** Unix timestamp (milliseconds). */
  timestamp: number;
  /** Whether the bot sent this message. */
  isFromMe: boolean;
  /** Arbitrary channel-specific metadata. */
  metadata: Record<string, unknown>;
}

/** Outbound message to a channel. */
export interface OutboundMessage {
  /** Target channel. */
  channel: ChannelType;
  /** Channel-specific user/chat identifier. */
  userId: string;
  /** Text content to send. */
  text: string;
  /** Optional reply-to message ID. */
  replyToMessageId?: string;
}

export type ChannelType = 'telegram' | 'whatsapp' | 'gmail';

// ─── Channel Adapter ────────────────────────────────────────────────────────

/**
 * Channel adapter interface.
 *
 * Uses self-registration pattern with factory-with-null for unconfigured channels.
 * Includes reconnection and health check support for production reliability.
 */
export interface ChannelAdapter {
  readonly name: string;
  readonly type: ChannelType;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(message: OutboundMessage): Promise<void>;
  onMessage(handler: (msg: InboundMessage) => void): void;
  isConnected(): boolean;
}

/** Factory that returns null when credentials are missing. */
export type ChannelFactory = (onMessage: (msg: InboundMessage) => void) => ChannelAdapter | null;

// ─── Agent Runtime ──────────────────────────────────────────────────────────

/**
 * Agent runtime interface.
 *
 * Orthogonal to ContainerRuntime (Podman vs Apple Container).
 * CliRuntime spawns `claude -p`. SdkRuntime calls `query()`.
 */
export interface AgentRuntime {
  execute(task: AgentTask): Promise<AgentResult>;
  isHealthy(): Promise<boolean>;
}

export interface AgentTask {
  /** Unique task identifier. */
  id: string;
  /** Chat ID this task belongs to (for container reuse / warm pool). */
  chatId: string;
  /** The user prompt / message to process. */
  message: string;
  /** Username for container naming. */
  username: string;
  /** Working directory inside the container. */
  workDir: string;
  /** Max agent turns before forced stop. */
  maxTurns: number;
  /** Additional environment variables. */
  env: Record<string, string>;
  /** Pre-built context from buildAgentContext() for system prompt injection. */
  systemPrompt?: string;
  /** Path to MCP config inside the container for on-demand memory access. */
  mcpConfigPath?: string;
  /** TCP port for MCP server (macOS only — virtiofs doesn't support UDS). */
  mcpPort?: number;
}

export interface AgentResult {
  /** Text response to send back to the user. */
  text: string;
  /** Tool calls made by the agent. */
  toolCalls: ToolCallRecord[];
  /** Token usage for billing. */
  cost: { inputTokens: number; outputTokens: number };
  /** Whether the agent completed successfully. */
  success: boolean;
  /** Error message if failed. */
  error?: string;
}

export interface ToolCallRecord {
  tool: string;
  args: Record<string, unknown>;
  result?: string;
}

// ─── Container Runtime ──────────────────────────────────────────────────────

/**
 * Container runtime abstraction.
 *
 * Abstracts over Podman (Linux) and Apple Container (macOS) with full
 * security controls: resource limits, UID namespaces, network isolation,
 * and SELinux enforcement.
 */
export interface ContainerRuntime {
  /** Create a container (does not start it). Returns container ID. */
  create(config: ContainerConfig): Promise<string>;
  /** Start a created container. */
  start(id: string): Promise<void>;
  /** Stop a running container. */
  stop(id: string, timeout?: number): Promise<void>;
  /** Remove a container (must be stopped). */
  remove(id: string): Promise<void>;
  /** Execute a command inside a running container. Optional timeout in ms (default: 30s). */
  exec(id: string, command: string[], options?: { timeout?: number }): Promise<ExecResult>;
  /** Retrieve container logs. */
  logs(id: string, tail?: number): Promise<string>;
  /** Check if a container is running and healthy. */
  isHealthy(id: string): Promise<boolean>;
  /** Check if a container exists by name or ID. */
  exists(nameOrId: string): Promise<boolean>;
  /** List containers matching a filter. */
  list(filter?: ContainerFilter): Promise<ContainerInfo[]>;

  // ── Network operations ──
  /** Create an isolated network for a user. */
  createNetwork(name: string): Promise<void>;
  /** Remove a user's network. */
  removeNetwork(name: string): Promise<void>;
  /** Check if a network exists. */
  networkExists(name: string): Promise<boolean>;

  // ── Image operations ──
  /** Check if a container image is available locally. */
  imageExists(image: string): Promise<boolean>;
}

export type ContainerState = 'created' | 'running' | 'paused' | 'stopped' | 'exited' | 'unknown';

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  state: ContainerState;
  createdAt: number;
}

export interface ContainerFilter {
  /** Filter by name prefix (e.g., "flowhelm-agent-stan"). */
  namePrefix?: string;
  /** Filter by container state. */
  state?: ContainerState;
}

export interface ContainerConfig {
  /** Container name (e.g., flowhelm-agent-stan-abc123). */
  name: string;
  /** Image to run. */
  image: string;
  /** Memory limit (e.g., "512m"). */
  memoryLimit: string;
  /** CPU limit (e.g., "1.0"). */
  cpuLimit: string;
  /** Max PIDs inside container. */
  pidsLimit: number;
  /** Read-only root filesystem. */
  readOnly: boolean;
  /** Volume mounts. */
  mounts: MountConfig[];
  /** Tmpfs mounts for writable scratch space. */
  tmpfs: TmpfsConfig[];
  /** Environment variables. */
  env: Record<string, string>;
  /** Published ports (host:container format, e.g., "15432:5432"). */
  ports?: string[];
  /** Network name. */
  network: string;
  /** Security options (e.g., "no-new-privileges", "label=type:container_runtime_t"). */
  securityOpts: string[];
  /** User namespace mode (e.g., "auto" for rootless UID mapping). */
  userNamespace?: string;
  /** Working directory inside the container. */
  workDir?: string;
  /** Command to run (overrides image CMD). */
  command?: string[];
}

export interface MountConfig {
  /** Host path. */
  source: string;
  /** Container path. */
  target: string;
  /** Read-only mount. */
  readOnly: boolean;
  /** SELinux label (e.g., "Z" for private relabeling). */
  selinuxLabel?: string;
  /** Podman :U flag — chown mount to match container user UID/GID. */
  chownToUser?: boolean;
}

export interface TmpfsConfig {
  /** Mount point inside the container. */
  target: string;
  /** Size limit (e.g., "500m"). */
  size: string;
  /** Permission mode (e.g., "1777" for world-writable with sticky bit). */
  mode?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// ─── Command Executor (for testability) ────────────────────────────────────

/** Result from executing a shell command. */
export interface CommandResult {
  stdout: string;
  stderr: string;
}

/**
 * Function that executes a CLI command. Injected into runtimes for testability.
 * Rejects on non-zero exit code with an error containing stdout/stderr.
 */
export type CommandExecutor = (
  cmd: string,
  args: string[],
  options?: { timeout?: number },
) => Promise<CommandResult>;

// ─── User Config ────────────────────────────────────────────────────────────

export type AgentRuntimeMode = 'cli' | 'sdk';

export interface UserConfig {
  /** Username (maps to Linux user flowhelm-{username}). */
  username: string;
  /** Agent runtime mode. */
  agentRuntime: AgentRuntimeMode;
  /** Max concurrent agent containers. */
  maxConcurrentAgents: number;
  /** Container memory limit. */
  agentMemoryLimit: string;
  /** Container CPU limit. */
  agentCpuLimit: string;
  /** Max agent turns per task. */
  maxTurns: number;
  /** Enabled channels. */
  channels: {
    telegram?: { botToken: string; allowedUsers: number[] };
    whatsapp?: { enabled: boolean };
    gmail?: { enabled: boolean };
  };
  /** Service container config. */
  service: {
    enabled: boolean;
  };
}

// ─── Queue ──────────────────────────────────────────────────────────────────

export type MessageStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'dead_letter';

export interface QueuedMessage {
  id: number;
  message: InboundMessage;
  status: MessageStatus;
  attempts: number;
  createdAt: number;
  updatedAt: number;
}

// ─── Sessions ──────────────────────────────────────────────────────────────

export interface Session {
  id: string;
  chatId: string;
  startedAt: number;
  endedAt?: number;
  summary?: string;
  metadata: Record<string, unknown>;
}

// ─── Tier 2: Semantic Memory ───────────────────────────────────────────────

export type SemanticMemoryType =
  | 'preference'
  | 'fact'
  | 'pattern'
  | 'contact'
  | 'instruction'
  | 'summary'
  | 'procedure';

export interface SemanticMemoryEntry {
  id: string;
  content: string;
  memoryType: SemanticMemoryType;
  importance: number;
  depth: number;
  tokenCount: number;
  sourceSession?: string;
  earliestAt?: number;
  latestAt?: number;
  createdAt: number;
  updatedAt: number;
  lastAccessed: number;
  accessCount: number;
}

// ─── Tier 3: Meta Memory ──────────────────────────────────────────────────

export type MetaMemoryType = 'insight' | 'heuristic' | 'self_assessment';

export interface MetaMemoryEntry {
  id: string;
  content: string;
  reflectionType: MetaMemoryType;
  confidence: number;
  /** DAG depth: 0 = direct observation, 1 = evaluated pattern, 2+ = strategic synthesis. */
  depth: number;
  createdAt: number;
  updatedAt: number;
  lastAccessed: number;
}

// ─── External Memory ──────────────────────────────────────────────────────

export type ExternalMemorySource = 'document' | 'user_provided';

export interface ExternalMemoryEntry {
  id: string;
  content: string;
  sourceType: ExternalMemorySource;
  sourceRef: string;
  createdAt: number;
}

// ─── Identity Layer ───────────────────────────────────────────────────────

export interface AgentIdentity {
  role: string;
  expertise: string[];
  tone: string;
  instructions?: string;
  createdAt: number;
  updatedAt: number;
}

export type AgentPersonalityDimension =
  | 'communication_style'
  | 'humor'
  | 'emotional_register'
  | 'values'
  | 'rapport'
  | 'boundaries';

export interface AgentPersonalityEntry {
  id: string;
  dimension: AgentPersonalityDimension;
  content: string;
  confidence: number;
  evidenceCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface UserIdentity {
  name?: string;
  role?: string;
  organization?: string;
  timezone?: string;
  language: string;
  contact: Record<string, unknown>;
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

export type UserPersonalityDimension =
  | 'communication_style'
  | 'work_patterns'
  | 'decision_making'
  | 'priorities'
  | 'preferences'
  | 'boundaries';

export type PersonalitySource = 'inferred' | 'declared' | 'onboarding';

export interface UserPersonalityEntry {
  id: string;
  dimension: UserPersonalityDimension;
  content: string;
  confidence: number;
  evidenceCount: number;
  source: PersonalitySource;
  createdAt: number;
  updatedAt: number;
}

// ─── Agent Profiles ──────────────────────────────────────────────────────

export interface AgentProfile {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AgentProfileWithStats extends AgentProfile {
  chatCount: number;
  semanticMemoryCount: number;
  metaMemoryCount: number;
}

// ─── Scoring ──────────────────────────────────────────────────────────────

export interface ScoringWeights {
  alpha: number;
  beta: number;
  gamma: number;
  lambda: number;
}

export interface ScoredResult<T> {
  entry: T;
  similarity: number;
  compositeScore: number;
}

export type SemanticQueryResult = ScoredResult<SemanticMemoryEntry>;
export type MetaQueryResult = ScoredResult<MetaMemoryEntry>;

export interface ExternalQueryResult {
  entry: ExternalMemoryEntry;
  similarity: number;
}

// ─── Summarization Provider ───────────────────────────────────────────────

export interface SummarizationOptions {
  model: string;
  maxTokens: number;
  systemPrompt: string;
}

export interface MemorySummarizationProvider {
  summarize(content: string, options: SummarizationOptions): Promise<string>;
}

// ─── Embedding Provider ─────────────────────────────────────────────────────

export interface EmbeddingProvider {
  /** Generate an embedding vector for a single text. */
  embed(text: string): Promise<number[]>;
  /** Generate embedding vectors for multiple texts. */
  embedBatch(texts: string[]): Promise<number[][]>;
  /** The number of dimensions in the output vectors. */
  readonly dimensions: number;
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

export interface Startable {
  start(): Promise<void>;
  stop(): Promise<void>;
}
