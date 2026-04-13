/**
 * Message routing — outbound delivery and memory extraction.
 *
 * After Phase 11, inbound handling is done by the channel container
 * (ChannelDbWriter writes directly to PG). The router now only handles:
 * - Outbound: agent result → send via ChannelClient → store bot response
 * - Memory extraction from agent tool calls
 *
 * The router delegates outbound delivery to the ChannelClient, which
 * sends HTTP POST to the channel container. The channel container
 * routes to the appropriate adapter.
 */

import type { ChannelType, AgentResult, SemanticMemoryType, Startable } from './types.js';
import type { FlowHelmDatabase } from './database.js';
import type { MemoryManager } from './memory.js';
import type { ProfileManager } from './profile-manager.js';
import type { ChannelClient } from '../channels/channel-client.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MessageRouterOptions {
  database: FlowHelmDatabase;
  memory: MemoryManager;
  profileManager: ProfileManager;
  /** Channel container client for outbound message delivery. */
  channelClient?: ChannelClient;
}

// ─── Message Router ─────────────────────────────────────────────────────────

export class MessageRouter implements Startable {
  private readonly database: FlowHelmDatabase;
  private readonly memory: MemoryManager;
  private readonly profileManager: ProfileManager;
  private readonly channelClient: ChannelClient | undefined;
  private started = false;

  constructor(options: MessageRouterOptions) {
    this.database = options.database;
    this.memory = options.memory;
    this.profileManager = options.profileManager;
    this.channelClient = options.channelClient;
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  // ── Outbound Handling ───────────────────────────────────────────────────

  /**
   * Send an agent's response to the user via the channel container.
   *
   * Delivers via ChannelClient HTTP POST to the channel container,
   * then stores the bot's response as a message in the database
   * with the active session ID.
   */
  async sendResponse(
    chatId: string,
    channel: ChannelType,
    text: string,
    replyToId?: string,
  ): Promise<void> {
    if (!this.started) throw new Error('MessageRouter not started');

    // Send via channel container
    if (this.channelClient) {
      try {
        await this.channelClient.send(channel, chatId, text, replyToId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[router] Failed to send via channel container: ${msg}`);
      }
    }

    // Store bot response in database
    const session = await this.memory.getActiveSession(chatId);
    const profile = await this.profileManager.getChatProfile(chatId);
    const profileId = profile?.id ?? '';
    await this.database.storeMessage({
      id: `bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      chatId,
      channel,
      externalChatId: chatId,
      senderId: 'flowhelm',
      senderName: 'FlowHelm',
      content: text,
      timestamp: Date.now(),
      isFromMe: true,
      isBotMessage: true,
      sessionId: session?.id,
      profileId,
    });
  }

  /**
   * Process an agent result: send response and extract memories.
   *
   * This is the post-agent-execution pipeline:
   * 1. Send the agent's text response to the user
   * 2. Extract and store any new memories from the result
   */
  async handleAgentResult(
    chatId: string,
    channel: ChannelType,
    result: AgentResult,
    replyToId?: string,
  ): Promise<void> {
    // 1. Send response to user
    if (result.text) {
      await this.sendResponse(chatId, channel, result.text, replyToId);
    }

    // 2. Extract memories from agent tool calls
    // The agent may have called store_memory via MCP, which stores directly.
    // Here we look for additional signals in the result to extract facts.
    if (result.success && result.text) {
      await this.extractMemories(chatId, result);
    }
  }

  /**
   * Extract facts and patterns from agent results for long-term memory.
   *
   * Looks at tool calls for actionable facts (emails sent, events created)
   * and stores them as long-term memories. This complements the agent's
   * own store_memory calls via MCP.
   */
  private async extractMemories(chatId: string, result: AgentResult): Promise<void> {
    const session = await this.memory.getActiveSession(chatId);
    const chatProfile = await this.profileManager.getChatProfile(chatId);
    const profileId = chatProfile?.id ?? '';

    for (const call of result.toolCalls) {
      // Extract facts from specific tool patterns
      const fact = extractFactFromToolCall(call.tool, call.args, call.result);
      if (fact) {
        await this.memory.storeSemanticMemory({
          content: fact.content,
          memoryType: fact.type,
          importance: fact.importance,
          sourceSession: session?.id,
          profileId,
        });
      }
    }
  }
}

// ─── Memory Extraction Helpers ──────────────────────────────────────────────

interface ExtractedFact {
  content: string;
  type: SemanticMemoryType;
  importance: number;
}

/**
 * Extract a storable fact from an agent tool call.
 * Returns null if the tool call doesn't contain extractable information.
 */
function extractFactFromToolCall(
  tool: string,
  args: Record<string, unknown>,
  result?: string,
): ExtractedFact | null {
  // Email sent → store as fact
  if (tool.includes('gmail') && tool.includes('send') && result) {
    const to = typeof args['to'] === 'string' ? args['to'] : 'unknown';
    const subject = typeof args['subject'] === 'string' ? args['subject'] : '';
    return {
      content: `Sent email to ${to}${subject ? `: ${subject}` : ''}`,
      type: 'fact',
      importance: 0.6,
    };
  }

  // Calendar event created → store as fact
  if (tool.includes('calendar') && tool.includes('insert') && result) {
    const summary = typeof args['summary'] === 'string' ? args['summary'] : 'event';
    return {
      content: `Created calendar event: ${summary}`,
      type: 'fact',
      importance: 0.6,
    };
  }

  return null;
}
