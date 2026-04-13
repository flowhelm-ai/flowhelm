export {
  FlowHelmDatabase,
  type DatabaseOptions,
  type ChatRow,
  type MessageRow,
  type QueueRow,
  type CursorRow,
} from './database.js';

export {
  MessageQueue,
  type MessageQueueOptions,
  type QueuedItem,
  type QueueStatus,
  type QueueNotifyHandler,
} from './message-queue.js';

export {
  createConnection,
  buildConnectionUrl,
  type ConnectionOptions,
  type Sql,
} from './connection.js';

export {
  TransformersEmbeddingProvider,
  OpenAIEmbeddingProvider,
  createEmbeddingProvider,
  type EmbeddingProviderConfig,
} from './embeddings.js';

export {
  MemoryManager,
  type MemoryManagerOptions,
  type StoreSemanticOptions,
  type QuerySemanticOptions,
  type StoreExternalOptions,
} from './memory.js';

export { MessageRouter, type MessageRouterOptions } from './message-router.js';

export { McpServer, cleanupStaleSockets, type McpServerOptions } from './mcp-server.js';

export { FlowHelmOrchestrator, type OrchestratorOptions } from './orchestrator.js';

export {
  IdentityManager,
  confirmConfidence,
  contradictConfidence,
  type IdentityManagerOptions,
  type IdentityThresholds,
  type IdentityProposal,
} from './identity.js';

export {
  compositeScore,
  rankByCompositeScore,
  DEFAULT_SCORING_WEIGHTS,
  DEFAULT_CANDIDATE_MULTIPLIER,
} from './scoring.js';

export {
  MemoryProvider,
  createMemoryProvider,
  type MemoryProviderOptions,
  type CreateMemoryProviderOptions,
} from './memory-provider.js';

export {
  MemoryConsolidationJob,
  type ConsolidationConfig,
  type ConsolidationJobOptions,
} from './consolidation.js';

export {
  MemoryReflectionJob,
  type ReflectionConfig,
  type ReflectionJobOptions,
} from './reflection.js';

export { ProfileManager, type ProfileManagerOptions } from './profile-manager.js';
