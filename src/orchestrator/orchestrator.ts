/**
 * Core orchestrator — the event-driven heart of FlowHelm.
 *
 * Subscribes to PostgreSQL LISTEN/NOTIFY for instant message processing
 * (no polling). On each notification:
 *   dequeue → build context → execute agent → route response → acknowledge
 *
 * Keeps the coordinator focused and delegates to specialized components:
 * MessageRouter (channel I/O),
 * MemoryManager (three-tier context), MessageQueue (persistence),
 * and AgentRuntime (container execution).
 *
 * Each user runs their own orchestrator instance in their own Podman
 * UID namespace — there is no shared state between users.
 */

import * as path from 'node:path';
import { unlink } from 'node:fs/promises';
import type { AgentRuntime, AgentTask, ChannelType, Startable } from './types.js';
import type { FlowHelmDatabase } from './database.js';
import type { MessageQueue, QueuedItem } from './message-queue.js';
import type { MemoryManager } from './memory.js';
import type { MessageRouter } from './message-router.js';
import type { IdentityManager } from './identity.js';
import type { ProfileManager } from './profile-manager.js';
import type { MemoryConsolidationJob } from './consolidation.js';
import type { MemoryReflectionJob } from './reflection.js';
import { McpServer, cleanupStaleSockets } from './mcp-server.js';
import type { FlowHelmConfig } from '../config/schema.js';
import type { ServiceClient } from '../service/service-client.js';
import type { ChannelClient } from '../channels/channel-client.js';
import { ChannelCommandHandler } from './channel-commands.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OrchestratorOptions {
  config: FlowHelmConfig;
  database: FlowHelmDatabase;
  queue: MessageQueue;
  memory: MemoryManager;
  router: MessageRouter;
  identity: IdentityManager;
  profileManager: ProfileManager;
  consolidationJob?: MemoryConsolidationJob;
  reflectionJob?: MemoryReflectionJob;
  /** Agent runtime for executing tasks. Optional — Phase 5 provides the real implementation. */
  agentRuntime?: AgentRuntime;
  /** Service container client for STT/vision processing. */
  serviceClient?: ServiceClient;
  /** Container-internal path prefix for downloaded media files (e.g., "/downloads"). */
  serviceDownloadsPrefix?: string;
  /** Channel container client for outbound message delivery and email. */
  channelClient?: ChannelClient;
}

/** Active task being processed by the orchestrator. */
interface ActiveTask {
  queueId: number;
  chatId: string;
  channel: ChannelType;
  startedAt: number;
}

// ─── Orchestrator ───────────────────────────────────────────────────────────

export class FlowHelmOrchestrator implements Startable {
  private readonly config: FlowHelmConfig;
  private readonly database: FlowHelmDatabase;
  private readonly queue: MessageQueue;
  private readonly memory: MemoryManager;
  private readonly router: MessageRouter;
  private readonly identity: IdentityManager;
  private readonly profileManager: ProfileManager;
  private readonly agentRuntime: AgentRuntime | undefined;
  private readonly serviceClient: ServiceClient | undefined;
  private readonly serviceDownloadsPrefix: string;
  private readonly channelClient: ChannelClient | undefined;
  private readonly consolidationJob: MemoryConsolidationJob | undefined;
  private readonly reflectionJob: MemoryReflectionJob | undefined;
  private readonly commandHandler: ChannelCommandHandler;

  /** Track in-flight tasks to prevent duplicate processing. */
  private readonly activeTasks = new Map<string, ActiveTask>();

  /** Active MCP memory servers keyed by chat ID. */
  private readonly mcpServers = new Map<string, McpServer>();

  /** IPC directory for MCP sockets. */
  private readonly ipcDir: string;

  private stopping = false;
  private processingCount = 0;
  private consolidationTimer: ReturnType<typeof setInterval> | null = null;
  private reflectionTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: OrchestratorOptions) {
    this.config = options.config;
    this.database = options.database;
    this.queue = options.queue;
    this.memory = options.memory;
    this.router = options.router;
    this.identity = options.identity;
    this.profileManager = options.profileManager;
    this.agentRuntime = options.agentRuntime;
    this.serviceClient = options.serviceClient;
    this.serviceDownloadsPrefix = options.serviceDownloadsPrefix ?? '/downloads';
    this.channelClient = options.channelClient;
    this.consolidationJob = options.consolidationJob;
    this.reflectionJob = options.reflectionJob;
    this.commandHandler = new ChannelCommandHandler(this.identity, this.profileManager);

    const dataDir = this.config.dataDir.replace('~', process.env['HOME'] ?? '~');
    this.ipcDir = path.join(dataDir, 'ipc');
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.stopping = false;

    // Clean up stale MCP sockets from a previous crash
    cleanupStaleSockets(this.ipcDir);

    // Subscribe to queue notifications (event-driven, no polling)
    await this.queue.subscribe((chatId) => {
      if (!this.stopping) {
        void this.onNewMessage(chatId);
      }
    });

    // Drain any pending messages from a previous crash or orchestrator downtime.
    // NOTIFY events fired while the orchestrator was down are lost, so we scan
    // for pending messages after subscribing and trigger processing for each.
    await this.drainPendingMessages();

    // Start scheduled consolidation and reflection jobs
    this.startScheduledJobs();

    console.log('[orchestrator] Started — listening for messages');
  }

  async stop(): Promise<void> {
    this.stopping = true;

    // Stop scheduled job timers
    if (this.consolidationTimer) {
      clearInterval(this.consolidationTimer);
      this.consolidationTimer = null;
    }
    if (this.reflectionTimer) {
      clearInterval(this.reflectionTimer);
      this.reflectionTimer = null;
    }

    // Stop scheduled jobs
    if (this.consolidationJob) await this.consolidationJob.stop();
    if (this.reflectionJob) await this.reflectionJob.stop();

    // Wait for in-flight processing to complete (drain)
    const drainTimeout = 15_000;
    const drainStart = Date.now();
    while (this.processingCount > 0 && Date.now() - drainStart < drainTimeout) {
      await sleep(100);
    }
    if (this.processingCount > 0) {
      console.warn(
        `[orchestrator] Drain timeout — ${String(this.processingCount)} tasks still in-flight`,
      );
    }

    // Stop all MCP servers
    for (const [chatId, server] of this.mcpServers) {
      try {
        await server.stop();
      } catch (err) {
        console.error(`[orchestrator] Error stopping MCP server for ${chatId}:`, err);
      }
    }
    this.mcpServers.clear();

    console.log('[orchestrator] Stopped');
  }

  /** Number of tasks currently being processed. */
  getProcessingCount(): number {
    return this.processingCount;
  }

  /** Check if a chat has an active task being processed. */
  isProcessing(chatId: string): boolean {
    return this.activeTasks.has(chatId);
  }

  // ── Event-Driven Message Handling ───────────────────────────────────────

  /**
   * Called when NOTIFY fires for a new message.
   *
   * Checks concurrency limits, dequeues the message, and processes it.
   * If the chat already has an active task, the message stays in the
   * queue and will be processed when the current task completes.
   */
  private async onNewMessage(chatId: string): Promise<void> {
    // Skip if already processing this chat (one task per chat at a time)
    if (this.activeTasks.has(chatId)) return;

    // Check global concurrency limit
    if (this.activeTasks.size >= this.config.agent.maxConcurrentContainers) return;

    // Dequeue the next pending message for this chat
    const item = await this.queue.dequeueForChat(chatId);
    if (!item) return;

    // Process the message
    await this.processQueueItem(item);
  }

  /**
   * Main message processing pipeline.
   *
   * 1. Register as active task
   * 2. Build memory context
   * 3. Start MCP server for on-demand memory access
   * 4. Execute the agent
   * 5. Handle the result (send response, extract memories)
   * 6. Acknowledge the queue item
   * 7. Check for more pending messages
   */
  private async processQueueItem(item: QueuedItem): Promise<void> {
    const { message } = item;
    const chatId = message.userId;
    const channel = message.channel;

    // Track active task
    this.activeTasks.set(chatId, {
      queueId: item.id,
      chatId,
      channel,
      startedAt: Date.now(),
    });
    this.processingCount++;

    try {
      // 0. Transcribe voice messages before anything else
      if (message.audioPath) {
        if (this.serviceClient) {
          try {
            const containerPath = this.toServicePath(message.audioPath);
            const result = await this.serviceClient.transcribe(
              containerPath,
              this.config.service.stt.language,
            );
            const caption = message.text ? `${message.text}\n\n` : '';
            message.text = `${caption}[Voice message transcription]: ${result.text}`;
            console.log(
              `[orchestrator] Transcribed voice message for ${chatId} via service/${result.provider} (${String(result.durationMs)}ms)`,
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[orchestrator] Service STT failed for ${chatId}: ${msg}`);
            message.text = message.text || '[Voice message could not be transcribed]';
          }
        } else {
          console.warn(
            `[orchestrator] Voice message received but service container is not enabled`,
          );
          message.text =
            message.text || '[Voice message received but service container is not configured]';
        }
        // Clean up audio file after transcription (don't accumulate on disk).
        // Note: audio file is on a shared bind mount — service container reads it,
        // then orchestrator deletes it from the host side.
        await unlink(message.audioPath).catch(() => {});
      }

      // 0.25. Image handling — tell the agent where to find the image file.
      // The channel container downloads photos to /downloads/{uuid}.jpg (host bind mount).
      // The agent container has /workspace/downloads/ mounted read-only.
      if (message.imagePath) {
        const filename = path.basename(message.imagePath);
        const agentPath = `/workspace/downloads/${filename}`;
        const caption = message.text ? `${message.text}\n\n` : '';
        message.text = `${caption}[The user sent an image. View it at: ${agentPath}]`;
        console.log(`[orchestrator] Image for ${chatId}: ${agentPath}`);
      }

      // 0.5. Channel command interception — handle /identity, /personality, /profile, /help
      // These never reach the agent: zero API token cost, instant response.
      if (message.text?.trim().startsWith('/')) {
        const cmdResult = await this.commandHandler.handle(message.text, chatId);
        if (cmdResult.handled) {
          console.log(
            `[orchestrator] Channel command handled for ${chatId}: ${message.text.trim().split(/\s+/)[0]}`,
          );
          if (cmdResult.response) {
            await this.router.sendResponse(chatId, channel, cmdResult.response, message.id);
          }
          await this.queue.acknowledge(item.id);
          return;
        }
      }

      // 1. Build memory context (~5K tokens of relevant context)
      let systemPrompt = await this.memory.buildAgentContext(chatId, message.text ?? '', {
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });

      // 1.1. Welcome hint — if agent identity is not configured, append a setup hint
      // so the agent's response includes guidance for the user.
      const chatProfile = await this.profileManager.getChatProfile(chatId);
      if (chatProfile) {
        const agentId = await this.identity.getAgentIdentity(chatProfile.id);
        if (!agentId) {
          systemPrompt +=
            '\n\n<system_notice>Agent identity is not yet configured. ' +
            'In your response, briefly mention that the user can personalize you with: ' +
            '/identity set agent role=... or via CLI: flowhelm identity agent set --role "..."' +
            '</system_notice>';
        }
      }

      // 1.5. Session backfill — channel container writes messages with session_id = NULL.
      // Orchestrator backfills after dequeue so session logic stays in the orchestrator.
      let session = await this.memory.getActiveSession(chatId);
      if (!session) {
        await this.memory.startSession(chatId);
        session = await this.memory.getActiveSession(chatId);
      }
      if (session) {
        await this.database.backfillSessionId(message.id, chatId, session.id);
      }

      // 2. Start MCP server for this chat (on-demand memory access)
      // macOS: use TCP (virtiofs doesn't support UDS through bind mounts)
      // Linux: use UDS (default, bind-mounted into agent containers)
      const isMacOS = process.platform === 'darwin';
      const mcpSocketPath = path.join(this.ipcDir, `${sanitizeForPath(chatId)}-memory.sock`);
      let mcpServer = this.mcpServers.get(chatId);
      if (!mcpServer) {
        mcpServer = new McpServer({
          socketPath: mcpSocketPath,
          ...(isMacOS ? { port: 0 } : {}),
          memory: this.memory,
          identity: this.identity,
          profileManager: this.profileManager,
          database: this.database,
          defaultChatId: chatId,
          channelClient: this.channelClient,
        });
        await mcpServer.start();
        this.mcpServers.set(chatId, mcpServer);
      }

      // 3. Execute the agent (or skip if no runtime configured)
      if (this.agentRuntime) {
        const task: AgentTask = {
          id: `task-${item.id}-${Date.now()}`,
          chatId,
          message: message.text ?? '',
          username: this.config.username,
          workDir: '/workspace',
          maxTurns: this.config.agent.maxTurns,
          env: {},
          systemPrompt,
          mcpConfigPath: mcpSocketPath,
          ...(isMacOS && mcpServer.assignedPort ? { mcpPort: mcpServer.assignedPort } : {}),
        };

        const result = await this.agentRuntime.execute(task);
        console.log(
          `[orchestrator] Agent result for ${chatId}: success=${String(result.success)}, text=${result.text?.slice(0, 100) ?? '(empty)'}, error=${result.error ?? 'none'}`,
        );

        // 4. Handle result: send response, store memories
        await this.router.handleAgentResult(chatId, channel, result, message.id);

        // 5. Acknowledge successful processing
        await this.queue.acknowledge(item.id);
      } else {
        // No agent runtime — just acknowledge (useful for testing the pipeline)
        console.log(`[orchestrator] No agent runtime — skipping execution for ${chatId}`);
        await this.queue.acknowledge(item.id);
      }
    } catch (err) {
      // Handle failure: retry or dead-letter
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[orchestrator] Task failed for ${chatId}:`, errorMsg);

      await this.handleTaskFailure(item, chatId, channel, errorMsg);
    } finally {
      this.activeTasks.delete(chatId);
      this.processingCount--;

      // Check for more pending messages for this chat
      if (!this.stopping) {
        void this.drainChat(chatId);
      }
    }
  }

  /**
   * After a task completes, check if there are more pending messages
   * for this chat and process them.
   */
  private async drainChat(chatId: string): Promise<void> {
    const pending = await this.queue.dequeueForChat(chatId);
    if (pending) {
      void this.processQueueItem(pending);
    }
  }

  /**
   * Drain all pending messages on startup.
   *
   * When the orchestrator crashes or restarts, NOTIFY events fired while
   * it was down are lost. This method queries for distinct chat IDs with
   * pending messages and triggers onNewMessage for each, ensuring no
   * messages are orphaned in the queue.
   */
  private async drainPendingMessages(): Promise<void> {
    const chatIds = await this.queue.pendingChatIds();
    if (chatIds.length > 0) {
      console.log(
        `[orchestrator] Draining ${String(chatIds.length)} chat(s) with pending messages`,
      );
      for (const chatId of chatIds) {
        void this.onNewMessage(chatId);
      }
    }
  }

  // ── Error Handling ──────────────────────────────────────────────────────

  /**
   * Handle a failed task: log error, update queue status, notify user.
   */
  private async handleTaskFailure(
    item: QueuedItem,
    chatId: string,
    channel: ChannelType,
    error: string,
  ): Promise<void> {
    try {
      await this.queue.fail(item.id, error);

      // If the message was dead-lettered (max attempts reached), notify the user
      if (item.attempts >= item.maxAttempts) {
        await this.router.sendResponse(
          chatId,
          channel,
          `Task failed after ${String(item.maxAttempts)} attempts. The message has been saved for admin review.`,
        );
      }
    } catch (failErr) {
      console.error('[orchestrator] Error handling task failure:', failErr);
    }
  }

  // ── Scheduled Jobs ──────────────────────────────────────────────────────

  /**
   * Start scheduled consolidation (Tier 1 → Tier 2) and reflection (Tier 2 → Tier 3) jobs.
   * Uses simple setInterval for now; cron parsing deferred to a later phase.
   */
  private startScheduledJobs(): void {
    // Consolidation: default every 6 hours
    if (this.consolidationJob && this.config.memory.consolidation.enabled) {
      const CONSOLIDATION_INTERVAL = 6 * 60 * 60 * 1000;
      this.consolidationTimer = setInterval(() => {
        void this.runConsolidation();
      }, CONSOLIDATION_INTERVAL);
    }

    // Reflection: default daily (disabled by default)
    if (this.reflectionJob && this.config.memory.reflection.enabled) {
      const REFLECTION_INTERVAL = 24 * 60 * 60 * 1000;
      this.reflectionTimer = setInterval(() => {
        void this.runReflection();
      }, REFLECTION_INTERVAL);
    }
  }

  private async runConsolidation(): Promise<void> {
    if (!this.consolidationJob) return;
    try {
      const count = await this.consolidationJob.run();
      if (count > 0) {
        console.log(`[orchestrator] Consolidated ${String(count)} sessions`);
      }
    } catch (err) {
      console.error('[orchestrator] Consolidation error:', err);
    }
  }

  private async runReflection(): Promise<void> {
    if (!this.reflectionJob) return;
    try {
      const count = await this.reflectionJob.run();
      if (count > 0) {
        console.log(`[orchestrator] Generated ${String(count)} meta-memory entries`);
      }
    } catch (err) {
      console.error('[orchestrator] Reflection error:', err);
    }
  }

  // ── Path Translation ──────────────────────────────────────────────────────

  /**
   * Convert a host-side audio path to the service container's internal path.
   *
   * The downloads directory is bind-mounted into the service container at
   * the serviceDownloadsPrefix (default: /downloads). This translates:
   *   /home/flowhelm-stan/.flowhelm/downloads/voice-123.ogg
   *   → /downloads/voice-123.ogg
   */
  private toServicePath(hostPath: string): string {
    const filename = path.basename(hostPath);
    return `${this.serviceDownloadsPrefix}/${filename}`;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Sanitize a chat ID for use in a file path (socket name). */
function sanitizeForPath(chatId: string): string {
  return chatId.replace(/[^a-zA-Z0-9_-]/g, '_');
}
