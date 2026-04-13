import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { MessageRouter } from '../src/orchestrator/message-router.js';
import { FlowHelmOrchestrator } from '../src/orchestrator/orchestrator.js';
import type {
  ChannelType,
  InboundMessage,
  AgentResult,
  AgentRuntime,
  AgentTask,
  Session,
} from '../src/orchestrator/types.js';
import type { FlowHelmDatabase } from '../src/orchestrator/database.js';
import type { MessageQueue, QueuedItem } from '../src/orchestrator/message-queue.js';
import type { MemoryManager } from '../src/orchestrator/memory.js';
import type { IdentityManager } from '../src/orchestrator/identity.js';
import type { ProfileManager } from '../src/orchestrator/profile-manager.js';
import type { MemoryConsolidationJob } from '../src/orchestrator/consolidation.js';
import type { MemoryReflectionJob } from '../src/orchestrator/reflection.js';
import type { FlowHelmConfig } from '../src/config/schema.js';
import { flowhelmConfigSchema } from '../src/config/schema.js';
import type { ChannelClient } from '../src/channels/channel-client.js';

// ─── Mock Factories ──────────────────────────────────────────────────────────

function createMockDatabase(overrides?: Partial<FlowHelmDatabase>): FlowHelmDatabase {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getSql: vi.fn(),
    isReady: vi.fn().mockReturnValue(true),
    upsertChat: vi.fn().mockResolvedValue('tg:123'),
    getChat: vi.fn().mockResolvedValue(null),
    storeMessage: vi.fn().mockResolvedValue(undefined),
    backfillSessionId: vi.fn().mockResolvedValue(undefined),
    getMessagesSince: vi.fn().mockResolvedValue([]),
    getRecentMessages: vi.fn().mockResolvedValue([]),
    getCursor: vi.fn().mockResolvedValue(null),
    setCursor: vi.fn().mockResolvedValue(undefined),
    getState: vi.fn().mockResolvedValue(null),
    setState: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as FlowHelmDatabase;
}

function createMockQueue(overrides?: Partial<MessageQueue>): MessageQueue {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue(undefined),
    enqueue: vi.fn().mockResolvedValue(1),
    dequeue: vi.fn().mockResolvedValue(null),
    dequeueForChat: vi.fn().mockResolvedValue(null),
    acknowledge: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue(undefined),
    counts: vi.fn().mockResolvedValue({
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      dead_letter: 0,
    }),
    getDeadLetters: vi.fn().mockResolvedValue([]),
    pendingCount: vi.fn().mockResolvedValue(0),
    pendingChatIds: vi.fn().mockResolvedValue([]),
    purgeCompleted: vi.fn().mockResolvedValue(0),
    retryDeadLetter: vi.fn().mockResolvedValue(false),
    ...overrides,
  } as unknown as MessageQueue;
}

function createMockMemory(overrides?: Partial<MemoryManager>): MemoryManager {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    storeSemanticMemory: vi.fn().mockResolvedValue('mem-1'),
    querySemanticMemory: vi.fn().mockResolvedValue([]),
    deleteSemanticMemory: vi.fn().mockResolvedValue(undefined),
    queryMetaMemory: vi.fn().mockResolvedValue([]),
    storeExternalMemory: vi.fn().mockResolvedValue('ext-1'),
    queryExternalMemory: vi.fn().mockResolvedValue([]),
    removeExternalBySource: vi.fn().mockResolvedValue(0),
    expandMemory: vi.fn().mockResolvedValue([]),
    getMemoryStats: vi.fn().mockResolvedValue({
      working: 0,
      semantic: {
        preference: 0,
        fact: 0,
        pattern: 0,
        contact: 0,
        instruction: 0,
        summary: 0,
        procedure: 0,
      },
      meta: { insight: 0, heuristic: 0, self_assessment: 0 },
      external: 0,
    }),
    startSession: vi.fn().mockResolvedValue('session-1'),
    endSession: vi.fn().mockResolvedValue(undefined),
    getActiveSession: vi.fn().mockResolvedValue(null),
    getSessionMessages: vi.fn().mockResolvedValue([]),
    buildAgentContext: vi.fn().mockResolvedValue('<context></context>'),
    ...overrides,
  } as unknown as MemoryManager;
}

function createMockIdentity(): IdentityManager {
  return {
    getAgentIdentity: vi.fn().mockResolvedValue(null),
    setAgentIdentity: vi.fn().mockResolvedValue(undefined),
    getAgentPersonality: vi.fn().mockResolvedValue([]),
    observeAgentPersonality: vi.fn().mockResolvedValue(undefined),
    getUserIdentity: vi.fn().mockResolvedValue(null),
    updateUserIdentity: vi.fn().mockResolvedValue(undefined),
    getUserPersonality: vi.fn().mockResolvedValue([]),
    observeUserPersonality: vi.fn().mockResolvedValue(undefined),
    proposeIdentityUpdate: vi.fn().mockResolvedValue(undefined),
    confirmIdentityUpdate: vi.fn().mockResolvedValue(undefined),
    buildIdentityContext: vi.fn().mockResolvedValue(''),
  } as unknown as IdentityManager;
}

function createMockConsolidationJob(): MemoryConsolidationJob {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    run: vi.fn().mockResolvedValue(0),
  } as unknown as MemoryConsolidationJob;
}

function createMockReflectionJob(): MemoryReflectionJob {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    run: vi.fn().mockResolvedValue(0),
  } as unknown as MemoryReflectionJob;
}

function createMockProfileManager(): ProfileManager {
  return {
    createProfile: vi.fn().mockResolvedValue({
      id: 'profile-1',
      name: 'default',
      description: null,
      isDefault: true,
      createdAt: 0,
      updatedAt: 0,
    }),
    getProfile: vi.fn().mockResolvedValue({
      id: 'profile-1',
      name: 'default',
      description: null,
      isDefault: true,
      createdAt: 0,
      updatedAt: 0,
    }),
    getProfileByName: vi.fn().mockResolvedValue(null),
    getDefaultProfile: vi.fn().mockResolvedValue({
      id: 'profile-1',
      name: 'default',
      description: null,
      isDefault: true,
      createdAt: 0,
      updatedAt: 0,
    }),
    listProfiles: vi.fn().mockResolvedValue([]),
    setDefaultProfile: vi.fn().mockResolvedValue(undefined),
    deleteProfile: vi.fn().mockResolvedValue(undefined),
    cloneProfile: vi.fn().mockResolvedValue(undefined),
    assignChat: vi.fn().mockResolvedValue(null),
    getChatProfile: vi.fn().mockResolvedValue({
      id: 'profile-1',
      name: 'default',
      description: null,
      isDefault: true,
      createdAt: 0,
      updatedAt: 0,
    }),
  } as unknown as ProfileManager;
}

function createMockChannelClient(): ChannelClient {
  return {
    send: vi.fn().mockResolvedValue(undefined),
    sendEmail: vi.fn().mockResolvedValue({ id: 'email-1', threadId: 'thread-1' }),
    health: vi.fn().mockResolvedValue({ status: 'ok', channels: {}, uptimeMs: 0 }),
    status: vi.fn().mockResolvedValue({ channels: {}, uptimeMs: 0 }),
    isReachable: vi.fn().mockResolvedValue(true),
  } as unknown as ChannelClient;
}

function createMockAgentRuntime(overrides?: Partial<AgentRuntime>): AgentRuntime {
  return {
    execute: vi.fn<(task: AgentTask) => Promise<AgentResult>>().mockResolvedValue({
      text: 'Agent response',
      toolCalls: [],
      cost: { inputTokens: 100, outputTokens: 50 },
      success: true,
    }),
    isHealthy: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as AgentRuntime;
}

function sampleInbound(overrides?: Partial<InboundMessage>): InboundMessage {
  return {
    id: 'msg-1',
    channel: 'telegram' as ChannelType,
    userId: 'tg:123',
    senderName: 'Stan',
    text: 'Reply to John about the budget',
    timestamp: Date.now(),
    isFromMe: false,
    metadata: {},
    ...overrides,
  };
}

function sampleQueuedItem(overrides?: Partial<QueuedItem>): QueuedItem {
  return {
    id: 1,
    message: sampleInbound(),
    status: 'processing',
    attempts: 1,
    maxAttempts: 3,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    error: null,
    ...overrides,
  };
}

function createTestConfig(): FlowHelmConfig {
  return flowhelmConfigSchema.parse({ username: 'stan' });
}

// ─── MessageRouter Tests ─────────────────────────────────────────────────────

describe('MessageRouter', () => {
  let database: FlowHelmDatabase;
  let memory: MemoryManager;
  let profileManager: ProfileManager;
  let channelClient: ChannelClient;
  let router: MessageRouter;

  beforeEach(() => {
    database = createMockDatabase();
    memory = createMockMemory();
    profileManager = createMockProfileManager();
    channelClient = createMockChannelClient();
    router = new MessageRouter({ database, memory, profileManager, channelClient });
  });

  // ── Outbound Handling ───────────────────────────────────────────────────

  describe('sendResponse', () => {
    it('sends via channel client and stores bot message', async () => {
      await router.start();

      await router.sendResponse('tg:123', 'telegram', 'Hello from bot', 'msg-1');

      expect(channelClient.send).toHaveBeenCalledWith(
        'telegram',
        'tg:123',
        'Hello from bot',
        'msg-1',
      );
      expect(database.storeMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 'tg:123',
          senderId: 'flowhelm',
          senderName: 'FlowHelm',
          content: 'Hello from bot',
          isBotMessage: true,
          isFromMe: true,
        }),
      );
    });

    it('still stores message even if channel client fails', async () => {
      (channelClient.send as Mock).mockRejectedValueOnce(new Error('Channel down'));
      await router.start();

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await router.sendResponse('tg:123', 'telegram', 'Hello from bot');

      // Message should still be stored despite channel client failure
      expect(database.storeMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 'tg:123',
          content: 'Hello from bot',
          isBotMessage: true,
        }),
      );
      consoleSpy.mockRestore();
    });

    it('stores message without channel client (no channels enabled)', async () => {
      const routerNoClient = new MessageRouter({ database, memory, profileManager });
      await routerNoClient.start();

      await routerNoClient.sendResponse('tg:123', 'telegram', 'Hello from bot');

      // Only database store — no channel client call
      expect(database.storeMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 'tg:123',
          content: 'Hello from bot',
          isBotMessage: true,
        }),
      );
    });
  });

  describe('handleAgentResult', () => {
    it('sends response and extracts memories', async () => {
      await router.start();

      const result: AgentResult = {
        text: 'Done, email sent',
        toolCalls: [],
        cost: { inputTokens: 100, outputTokens: 50 },
        success: true,
      };

      await router.handleAgentResult('tg:123', 'telegram', result, 'msg-1');

      expect(channelClient.send).toHaveBeenCalledWith(
        'telegram',
        'tg:123',
        'Done, email sent',
        'msg-1',
      );
    });

    it('extracts gmail send facts from tool calls', async () => {
      const session: Session = {
        id: 'session-xyz',
        chatId: 'tg:123',
        startedAt: Date.now(),
        metadata: {},
      };
      (memory.getActiveSession as Mock).mockResolvedValue(session);
      await router.start();

      const result: AgentResult = {
        text: 'Email sent to John',
        toolCalls: [
          {
            tool: 'gmail_send',
            args: { to: 'john@example.com', subject: 'Budget Review' },
            result: 'Message sent successfully',
          },
        ],
        cost: { inputTokens: 200, outputTokens: 100 },
        success: true,
      };

      await router.handleAgentResult('tg:123', 'telegram', result);

      expect(memory.storeSemanticMemory).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'Sent email to john@example.com: Budget Review',
          memoryType: 'fact',
          importance: 0.6,
          sourceSession: 'session-xyz',
        }),
      );
    });

    it('extracts calendar insert facts from tool calls', async () => {
      (memory.getActiveSession as Mock).mockResolvedValue({
        id: 'session-cal',
        chatId: 'tg:123',
        startedAt: Date.now(),
        metadata: {},
      });
      await router.start();

      const result: AgentResult = {
        text: 'Calendar event created',
        toolCalls: [
          {
            tool: 'calendar_events_insert',
            args: { summary: 'Q3 Budget Meeting' },
            result: 'Event created',
          },
        ],
        cost: { inputTokens: 100, outputTokens: 50 },
        success: true,
      };

      await router.handleAgentResult('tg:123', 'telegram', result);

      expect(memory.storeSemanticMemory).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'Created calendar event: Q3 Budget Meeting',
          memoryType: 'fact',
        }),
      );
    });
  });

  // ── Lifecycle ───────────────────────────────────────────────────────────

  describe('stop', () => {
    it('sets started to false', async () => {
      await router.start();
      await router.stop();
      await expect(router.sendResponse('tg:123', 'telegram', 'test')).rejects.toThrow(
        'MessageRouter not started',
      );
    });
  });
});

// ─── FlowHelmOrchestrator Tests ──────────────────────────────────────────────

describe('FlowHelmOrchestrator', () => {
  let config: FlowHelmConfig;
  let database: FlowHelmDatabase;
  let queue: MessageQueue;
  let memory: MemoryManager;
  let identity: IdentityManager;
  let profileManager: ProfileManager;
  let router: MessageRouter;
  let mockRouter: {
    sendResponse: Mock;
    handleAgentResult: Mock;
  };
  let orchestrator: FlowHelmOrchestrator;

  beforeEach(() => {
    config = createTestConfig();
    database = createMockDatabase();
    queue = createMockQueue();
    memory = createMockMemory();
    identity = createMockIdentity();
    profileManager = createMockProfileManager();

    // We need a real MessageRouter instance but mock its methods for orchestrator tests
    router = new MessageRouter({ database, memory, profileManager });
    mockRouter = {
      sendResponse: vi.fn().mockResolvedValue(undefined),
      handleAgentResult: vi.fn().mockResolvedValue(undefined),
    };
    // Patch the methods the orchestrator calls
    router.sendResponse = mockRouter.sendResponse;
    router.handleAgentResult = mockRouter.handleAgentResult;
  });

  // ── Lifecycle ───────────────────────────────────────────────────────────

  describe('start', () => {
    it('subscribes to queue and starts consolidation', async () => {
      orchestrator = new FlowHelmOrchestrator({
        config,
        database,
        queue,
        memory,
        router,
        identity,
        profileManager,
      });

      vi.spyOn(console, 'log').mockImplementation(() => {});
      await orchestrator.start();

      expect(queue.subscribe).toHaveBeenCalledOnce();
      expect(queue.subscribe).toHaveBeenCalledWith(expect.any(Function));

      await orchestrator.stop();
      vi.restoreAllMocks();
    });
  });

  describe('stop', () => {
    it('drains in-flight tasks and stops MCP servers', async () => {
      orchestrator = new FlowHelmOrchestrator({
        config,
        database,
        queue,
        memory,
        router,
        identity,
        profileManager,
      });

      vi.spyOn(console, 'log').mockImplementation(() => {});
      await orchestrator.start();

      // No active tasks, so stop should complete quickly
      await orchestrator.stop();

      expect(orchestrator.getProcessingCount()).toBe(0);
      vi.restoreAllMocks();
    });
  });

  // ── Event-Driven Message Handling ───────────────────────────────────────

  describe('onNewMessage (via subscribe callback)', () => {
    it('skips if already processing chat', async () => {
      // Set up a long-running task so the chat is "active"
      const item = sampleQueuedItem();
      let resolveExec: (() => void) | undefined;
      const execPromise = new Promise<AgentResult>((resolve) => {
        resolveExec = () =>
          resolve({
            text: 'Done',
            toolCalls: [],
            cost: { inputTokens: 10, outputTokens: 5 },
            success: true,
          });
      });

      const agentRuntime = createMockAgentRuntime({
        execute: vi.fn().mockReturnValue(execPromise),
      });
      (queue.dequeueForChat as Mock)
        .mockResolvedValueOnce(item) // First call returns item
        .mockResolvedValue(null); // Subsequent calls return null

      orchestrator = new FlowHelmOrchestrator({
        config,
        database,
        queue,
        memory,
        router,
        identity,
        profileManager,
        agentRuntime,
      });

      vi.spyOn(console, 'log').mockImplementation(() => {});
      await orchestrator.start();

      // Capture the subscribe callback
      const subscribeHandler = (queue.subscribe as Mock).mock.calls[0][0] as (
        chatId: string,
      ) => void;

      // Trigger first message — this starts processing
      subscribeHandler('tg:123');
      // Wait for the dequeue to resolve
      await new Promise((r) => setTimeout(r, 10));

      expect(orchestrator.isProcessing('tg:123')).toBe(true);

      // Trigger another message for the same chat — should be skipped
      subscribeHandler('tg:123');
      await new Promise((r) => setTimeout(r, 10));

      // dequeueForChat should have been called only once (the first time)
      expect(queue.dequeueForChat).toHaveBeenCalledTimes(1);

      // Clean up: finish the task
      resolveExec!();
      await new Promise((r) => setTimeout(r, 50));
      await orchestrator.stop();
      vi.restoreAllMocks();
    });

    it('respects global concurrency limit', async () => {
      // Config has default maxConcurrentContainers = 5, set to 1 for this test
      const limitedConfig = flowhelmConfigSchema.parse({
        username: 'stan',
        agent: { maxConcurrentContainers: 1 },
      });

      let resolveExec: (() => void) | undefined;
      const execPromise = new Promise<AgentResult>((resolve) => {
        resolveExec = () =>
          resolve({
            text: 'Done',
            toolCalls: [],
            cost: { inputTokens: 10, outputTokens: 5 },
            success: true,
          });
      });

      const agentRuntime = createMockAgentRuntime({
        execute: vi.fn().mockReturnValue(execPromise),
      });
      (queue.dequeueForChat as Mock)
        .mockResolvedValueOnce(sampleQueuedItem())
        .mockResolvedValue(null);

      orchestrator = new FlowHelmOrchestrator({
        config: limitedConfig,
        database,
        queue,
        memory,
        router,
        identity,
        profileManager,
        agentRuntime,
      });

      vi.spyOn(console, 'log').mockImplementation(() => {});
      await orchestrator.start();

      const subscribeHandler = (queue.subscribe as Mock).mock.calls[0][0] as (
        chatId: string,
      ) => void;

      // First chat starts processing
      subscribeHandler('tg:123');
      await new Promise((r) => setTimeout(r, 10));
      expect(orchestrator.isProcessing('tg:123')).toBe(true);

      // Second chat for a DIFFERENT chat ID should be blocked by concurrency limit
      subscribeHandler('tg:456');
      await new Promise((r) => setTimeout(r, 10));

      // dequeueForChat should only have been called once (for tg:123)
      expect(queue.dequeueForChat).toHaveBeenCalledTimes(1);

      resolveExec!();
      await new Promise((r) => setTimeout(r, 50));
      await orchestrator.stop();
      vi.restoreAllMocks();
    });

    it('dequeues and processes when available', async () => {
      const item = sampleQueuedItem();
      (queue.dequeueForChat as Mock).mockResolvedValueOnce(item).mockResolvedValue(null);

      orchestrator = new FlowHelmOrchestrator({
        config,
        database,
        queue,
        memory,
        router,
        identity,
        profileManager,
      });

      vi.spyOn(console, 'log').mockImplementation(() => {});
      await orchestrator.start();

      const subscribeHandler = (queue.subscribe as Mock).mock.calls[0][0] as (
        chatId: string,
      ) => void;

      subscribeHandler('tg:123');
      await new Promise((r) => setTimeout(r, 50));

      // Without agent runtime, it just acknowledges
      expect(queue.acknowledge).toHaveBeenCalledWith(item.id);

      await orchestrator.stop();
      vi.restoreAllMocks();
    });
  });

  // ── Processing Pipeline ─────────────────────────────────────────────────

  describe('processQueueItem (via onNewMessage)', () => {
    it('without agent runtime, logs and acknowledges', async () => {
      const item = sampleQueuedItem();
      (queue.dequeueForChat as Mock).mockResolvedValueOnce(item).mockResolvedValue(null);

      orchestrator = new FlowHelmOrchestrator({
        config,
        database,
        queue,
        memory,
        router,
        identity,
        profileManager,
        // No agentRuntime
      });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await orchestrator.start();

      const subscribeHandler = (queue.subscribe as Mock).mock.calls[0][0] as (
        chatId: string,
      ) => void;

      subscribeHandler('tg:123');
      await new Promise((r) => setTimeout(r, 50));

      expect(memory.buildAgentContext).toHaveBeenCalledWith(
        'tg:123',
        'Reply to John about the budget',
        expect.objectContaining({ timezone: expect.any(String) }),
      );
      expect(queue.acknowledge).toHaveBeenCalledWith(item.id);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No agent runtime'));

      await orchestrator.stop();
      logSpy.mockRestore();
    });

    it('with agent runtime, executes full pipeline', async () => {
      const item = sampleQueuedItem();
      (queue.dequeueForChat as Mock).mockResolvedValueOnce(item).mockResolvedValue(null);

      const agentRuntime = createMockAgentRuntime();
      orchestrator = new FlowHelmOrchestrator({
        config,
        database,
        queue,
        memory,
        router,
        identity,
        profileManager,
        agentRuntime,
      });

      vi.spyOn(console, 'log').mockImplementation(() => {});
      await orchestrator.start();

      const subscribeHandler = (queue.subscribe as Mock).mock.calls[0][0] as (
        chatId: string,
      ) => void;

      subscribeHandler('tg:123');
      await new Promise((r) => setTimeout(r, 50));

      // Should have built context
      expect(memory.buildAgentContext).toHaveBeenCalled();

      // Should have executed the agent
      expect(agentRuntime.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 'tg:123',
          message: 'Reply to John about the budget',
          username: 'stan',
        }),
      );

      // Should have handled the agent result
      expect(mockRouter.handleAgentResult).toHaveBeenCalledWith(
        'tg:123',
        'telegram',
        expect.objectContaining({ text: 'Agent response', success: true }),
        'msg-1',
      );

      // Should have acknowledged
      expect(queue.acknowledge).toHaveBeenCalledWith(item.id);

      await orchestrator.stop();
      vi.restoreAllMocks();
    });

    it('on failure, calls queue.fail and notifies user if dead-lettered', async () => {
      const item = sampleQueuedItem({ attempts: 3, maxAttempts: 3 });
      (queue.dequeueForChat as Mock).mockResolvedValueOnce(item).mockResolvedValue(null);

      const agentRuntime = createMockAgentRuntime({
        execute: vi.fn().mockRejectedValue(new Error('API timeout')),
      });

      orchestrator = new FlowHelmOrchestrator({
        config,
        database,
        queue,
        memory,
        router,
        identity,
        profileManager,
        agentRuntime,
      });

      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});
      await orchestrator.start();

      const subscribeHandler = (queue.subscribe as Mock).mock.calls[0][0] as (
        chatId: string,
      ) => void;

      subscribeHandler('tg:123');
      await new Promise((r) => setTimeout(r, 50));

      // Should have called queue.fail with the error
      expect(queue.fail).toHaveBeenCalledWith(item.id, 'API timeout');

      // Should have notified user because attempts >= maxAttempts (dead-lettered)
      expect(mockRouter.sendResponse).toHaveBeenCalledWith(
        'tg:123',
        'telegram',
        expect.stringContaining('failed after 3 attempts'),
      );

      await orchestrator.stop();
      vi.restoreAllMocks();
    });
  });

  // ── Drain ───────────────────────────────────────────────────────────────

  describe('drainChat', () => {
    it('processes next pending message after task completes', async () => {
      const item1 = sampleQueuedItem({ id: 1 });
      const item2 = sampleQueuedItem({
        id: 2,
        message: sampleInbound({ id: 'msg-2', text: 'Follow up message' }),
      });

      // First dequeue returns item1, drain dequeue returns item2, then null
      (queue.dequeueForChat as Mock)
        .mockResolvedValueOnce(item1)
        .mockResolvedValueOnce(item2)
        .mockResolvedValue(null);

      orchestrator = new FlowHelmOrchestrator({
        config,
        database,
        queue,
        memory,
        router,
        identity,
        profileManager,
        // No agent runtime — just acknowledge
      });

      vi.spyOn(console, 'log').mockImplementation(() => {});
      await orchestrator.start();

      const subscribeHandler = (queue.subscribe as Mock).mock.calls[0][0] as (
        chatId: string,
      ) => void;

      subscribeHandler('tg:123');
      // Wait for both items to be processed (item1 + drain processes item2)
      await new Promise((r) => setTimeout(r, 150));

      // Both items should have been acknowledged
      expect(queue.acknowledge).toHaveBeenCalledWith(1);
      expect(queue.acknowledge).toHaveBeenCalledWith(2);

      await orchestrator.stop();
      vi.restoreAllMocks();
    });
  });

  // ── State Queries ───────────────────────────────────────────────────────

  describe('getProcessingCount', () => {
    it('returns current processing count', () => {
      orchestrator = new FlowHelmOrchestrator({
        config,
        database,
        queue,
        memory,
        router,
        identity,
        profileManager,
      });

      expect(orchestrator.getProcessingCount()).toBe(0);
    });
  });

  describe('isProcessing', () => {
    it('returns true when chat has active task', async () => {
      let resolveExec: (() => void) | undefined;
      const execPromise = new Promise<AgentResult>((resolve) => {
        resolveExec = () =>
          resolve({
            text: 'Done',
            toolCalls: [],
            cost: { inputTokens: 10, outputTokens: 5 },
            success: true,
          });
      });

      const agentRuntime = createMockAgentRuntime({
        execute: vi.fn().mockReturnValue(execPromise),
      });
      (queue.dequeueForChat as Mock)
        .mockResolvedValueOnce(sampleQueuedItem())
        .mockResolvedValue(null);

      orchestrator = new FlowHelmOrchestrator({
        config,
        database,
        queue,
        memory,
        router,
        identity,
        profileManager,
        agentRuntime,
      });

      vi.spyOn(console, 'log').mockImplementation(() => {});
      await orchestrator.start();

      const subscribeHandler = (queue.subscribe as Mock).mock.calls[0][0] as (
        chatId: string,
      ) => void;

      // Before any message
      expect(orchestrator.isProcessing('tg:123')).toBe(false);

      // Start processing
      subscribeHandler('tg:123');
      await new Promise((r) => setTimeout(r, 10));

      expect(orchestrator.isProcessing('tg:123')).toBe(true);
      expect(orchestrator.getProcessingCount()).toBe(1);

      // Complete
      resolveExec!();
      await new Promise((r) => setTimeout(r, 50));

      expect(orchestrator.isProcessing('tg:123')).toBe(false);
      expect(orchestrator.getProcessingCount()).toBe(0);

      await orchestrator.stop();
      vi.restoreAllMocks();
    });
  });

  // ── Consolidation ───────────────────────────────────────────────────────

  describe('consolidation', () => {
    it('runs consolidationJob on timer interval', async () => {
      vi.useFakeTimers();

      const consolidationJob = createMockConsolidationJob();

      orchestrator = new FlowHelmOrchestrator({
        config,
        database,
        queue,
        memory,
        router,
        identity,
        profileManager,
        consolidationJob,
      });

      // Mock subscribe to not use real LISTEN (which needs real PG)
      (queue.subscribe as Mock).mockResolvedValue(undefined);

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await orchestrator.start();

      // Consolidation runs every 6 hours
      expect(consolidationJob.run).not.toHaveBeenCalled();

      // Advance time by 6 hours
      await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);

      expect(consolidationJob.run).toHaveBeenCalledTimes(1);

      // Advance another 6 hours
      await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);

      expect(consolidationJob.run).toHaveBeenCalledTimes(2);

      await orchestrator.stop();
      logSpy.mockRestore();
      vi.useRealTimers();
    });
  });
});
