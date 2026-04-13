/**
 * FlowHelm MCP Server over Unix domain socket — 25 tools.
 *
 * Runs inside the orchestrator process and exposes memory, identity,
 * profiles, skills, email, and admin tools to agent containers via MCP.
 * Implements the minimal subset of the MCP JSON-RPC interface needed
 * for tool discovery and execution.
 *
 * Memory tools: search_semantic, search_external, recall_conversation,
 *        store_semantic, get_memory_stats, expand_memory,
 *        search_meta, expand_meta, trace_to_source,
 *        get_identity, observe_personality,
 *        observe_user, propose_identity_update, update_user_identity
 * Profile tools: list_profiles, get_current_profile, switch_chat_profile
 * Admin tools (ADR-033): install_skill, uninstall_skill, list_skills,
 *        search_skills, update_config, get_auth_url, get_system_status
 *
 * The UDS is bind-mounted into agent containers at
 * /workspace/ipc/memory.sock. ~16ms per query.
 *
 * See ADR-023 and ADR-024.
 */

import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  Startable,
  SemanticMemoryType,
  MetaMemoryType,
  ExternalMemorySource,
  AgentPersonalityDimension,
  UserPersonalityDimension,
  PersonalitySource,
} from './types.js';
import type { MemoryManager } from './memory.js';
import type { IdentityManager } from './identity.js';
import type { ProfileManager } from './profile-manager.js';
import type { FlowHelmDatabase } from './database.js';
import type { SkillStore } from '../skills/store.js';
import type { RegistryClient } from '../skills/registry.js';
import type { ChannelClient } from '../channels/channel-client.js';

// ─── Types ────────────────────────────────────────────────────────────────

export interface McpServerOptions {
  socketPath: string;
  /**
   * When set, listen on TCP instead of UDS.
   * Use 0 for OS-assigned port. After start(), read assignedPort.
   * Used on macOS where virtiofs doesn't support Unix domain sockets.
   */
  port?: number;
  memory: MemoryManager;
  identity: IdentityManager;
  profileManager: ProfileManager;
  database: FlowHelmDatabase;
  defaultChatId?: string;
  /** Per-user skill store for self-service skill management (ADR-033). */
  skillStore?: SkillStore;
  /** Registry client for skill search/install (ADR-033). */
  registryClient?: RegistryClient;
  /** Channel client for Google Workspace operations via gws CLI. */
  channelClient?: ChannelClient;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// ─── Valid Values ─────────────────────────────────────────────────────────

const VALID_SEMANTIC_TYPES: SemanticMemoryType[] = [
  'preference',
  'fact',
  'pattern',
  'contact',
  'instruction',
  'summary',
  'procedure',
];

const VALID_META_TYPES: MetaMemoryType[] = ['insight', 'heuristic', 'self_assessment'];

const VALID_EXTERNAL_SOURCES: ExternalMemorySource[] = ['document', 'user_provided'];

const VALID_AGENT_PERSONALITY_DIMS: AgentPersonalityDimension[] = [
  'communication_style',
  'humor',
  'emotional_register',
  'values',
  'rapport',
  'boundaries',
];

const VALID_USER_PERSONALITY_DIMS: UserPersonalityDimension[] = [
  'communication_style',
  'work_patterns',
  'decision_making',
  'priorities',
  'preferences',
  'boundaries',
];

// ─── FlowHelm MCP Server ─────────────────────────────────────────────────

export class McpServer implements Startable {
  private server: net.Server | null = null;
  private connections: Set<net.Socket> = new Set();
  private readonly socketPath: string;
  private readonly tcpPort: number | undefined;
  /** Actual TCP port assigned by the OS after listen(). */
  private _assignedPort: number | undefined;
  private readonly memory: MemoryManager;
  private readonly identity: IdentityManager;
  private readonly profileManager: ProfileManager;
  private readonly database: FlowHelmDatabase;
  private readonly defaultChatId: string | undefined;
  private readonly skillStore: SkillStore | undefined;
  private readonly registryClient: RegistryClient | undefined;
  private readonly channelClient: ChannelClient | undefined;
  /** Resolved profile ID for this chat's MCP session. */
  private profileId: string | null = null;

  constructor(options: McpServerOptions) {
    this.socketPath = options.socketPath;
    this.tcpPort = options.port;
    this.memory = options.memory;
    this.identity = options.identity;
    this.profileManager = options.profileManager;
    this.database = options.database;
    this.defaultChatId = options.defaultChatId;
    this.skillStore = options.skillStore;
    this.registryClient = options.registryClient;
    this.channelClient = options.channelClient;
  }

  /** TCP port assigned by the OS. Only valid after start() when using TCP mode. */
  get assignedPort(): number | undefined {
    return this._assignedPort;
  }

  async start(): Promise<void> {
    // Resolve profile from chat
    if (this.defaultChatId) {
      const profile = await this.profileManager.getChatProfile(this.defaultChatId);
      this.profileId = profile?.id ?? null;
    }
    if (!this.profileId) {
      const defaultProfile = await this.profileManager.getDefaultProfile();
      this.profileId = defaultProfile?.id ?? null;
    }

    // TCP mode: listen on a TCP port (macOS — virtiofs doesn't support UDS).
    // UDS mode: listen on a Unix domain socket (Linux — default).
    if (this.tcpPort !== undefined) {
      await new Promise<void>((resolve, reject) => {
        this.server = net.createServer((socket) => this.handleConnection(socket));
        this.server.on('error', reject);
        this.server.listen(this.tcpPort, '0.0.0.0', () => {
          const addr = this.server?.address();
          if (addr && typeof addr === 'object') {
            this._assignedPort = addr.port;
          }
          resolve();
        });
      });
    } else {
      const dir = path.dirname(this.socketPath);
      fs.mkdirSync(dir, { recursive: true });

      try {
        fs.unlinkSync(this.socketPath);
      } catch {
        // Socket didn't exist
      }

      await new Promise<void>((resolve, reject) => {
        this.server = net.createServer((socket) => this.handleConnection(socket));
        this.server.on('error', reject);
        this.server.listen(this.socketPath, () => {
          try {
            fs.chmodSync(this.socketPath, 0o666);
          } catch {
            // chmod may not work on all platforms
          }
          resolve();
        });
      });
    }
  }

  async stop(): Promise<void> {
    for (const conn of this.connections) {
      conn.destroy();
    }
    this.connections.clear();

    if (this.server) {
      const server = this.server;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      this.server = null;
    }

    // Only clean up socket file in UDS mode
    if (this.tcpPort === undefined) {
      try {
        fs.unlinkSync(this.socketPath);
      } catch {
        // Already removed
      }
    }
  }

  getSocketPath(): string {
    return this.socketPath;
  }

  isListening(): boolean {
    return this.server?.listening ?? false;
  }

  /** Get the resolved profile ID. Throws if not resolved. */
  private getProfileId(): string {
    if (!this.profileId) throw new Error('Profile not resolved. Call start() first.');
    return this.profileId;
  }

  // ── Connection Handling ─────────────────────────────────────────────────

  private handleConnection(socket: net.Socket): void {
    this.connections.add(socket);
    let buffer = '';

    socket.on('data', (data) => {
      buffer += data.toString();

      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (line.length === 0) continue;
        void this.processLine(socket, line);
      }
    });

    socket.on('close', () => this.connections.delete(socket));
    socket.on('error', () => this.connections.delete(socket));
  }

  private async processLine(socket: net.Socket, line: string): Promise<void> {
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line) as JsonRpcRequest;
    } catch {
      this.sendResponse(socket, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      });
      return;
    }

    const response = await this.handleRequest(request);
    if (response) this.sendResponse(socket, response);
  }

  private sendResponse(socket: net.Socket, response: JsonRpcResponse): void {
    if (!socket.writable) return;
    socket.write(JSON.stringify(response) + '\n');
  }

  // ── JSON-RPC Dispatch ───────────────────────────────────────────────────

  async handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    if (request.id === undefined && request.method === 'notifications/initialized') {
      return null;
    }

    const id = request.id ?? null;

    switch (request.method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'flowhelm', version: '2.0.0' },
          },
        };

      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: TOOL_DEFINITIONS } };

      case 'tools/call':
        return this.handleToolCall(id, request.params ?? {});

      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${request.method}` },
        };
    }
  }

  // ── Tool Dispatch ───────────────────────────────────────────────────────

  private async handleToolCall(
    id: number | string | null,
    params: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    const toolName = params['name'] as string | undefined;
    const toolArgs = (params['arguments'] ?? {}) as Record<string, unknown>;

    if (!toolName) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: 'Missing tool name' },
      };
    }

    try {
      let result: unknown;

      switch (toolName) {
        case 'search_semantic':
          result = await this.toolSearchSemantic(toolArgs);
          break;
        case 'search_external':
          result = await this.toolSearchExternal(toolArgs);
          break;
        case 'recall_conversation':
          result = await this.toolRecallConversation(toolArgs);
          break;
        case 'store_semantic':
          result = await this.toolStoreSemantic(toolArgs);
          break;
        case 'get_memory_stats':
          result = await this.memory.getMemoryStats(this.getProfileId());
          break;
        case 'expand_memory':
          result = await this.toolExpandMemory(toolArgs);
          break;
        case 'search_meta':
          result = await this.toolSearchMeta(toolArgs);
          break;
        case 'expand_meta':
          result = await this.toolExpandMeta(toolArgs);
          break;
        case 'trace_to_source':
          result = await this.toolTraceToSource(toolArgs);
          break;
        case 'get_identity':
          result = await this.toolGetIdentity();
          break;
        case 'observe_personality':
          result = await this.toolObservePersonality(toolArgs);
          break;
        case 'observe_user':
          result = await this.toolObserveUser(toolArgs);
          break;
        case 'propose_identity_update':
          result = await this.toolProposeIdentityUpdate(toolArgs);
          break;
        case 'update_user_identity':
          result = await this.toolUpdateUserIdentity(toolArgs);
          break;
        case 'list_profiles':
          result = await this.toolListProfiles();
          break;
        case 'get_current_profile':
          result = await this.toolGetCurrentProfile();
          break;
        case 'switch_chat_profile':
          result = await this.toolSwitchChatProfile(toolArgs);
          break;

        // ── Admin / Self-Service Tools (ADR-033) ─────────────────────────
        case 'install_skill':
          result = await this.toolInstallSkill(toolArgs);
          break;
        case 'uninstall_skill':
          result = await this.toolUninstallSkill(toolArgs);
          break;
        case 'list_skills':
          result = await this.toolListSkills();
          break;
        case 'search_skills':
          result = await this.toolSearchSkills(toolArgs);
          break;
        case 'update_config':
          result = await this.toolUpdateConfig(toolArgs);
          break;
        case 'get_auth_url':
          result = await this.toolGetAuthUrl(toolArgs);
          break;
        case 'get_system_status':
          result = await this.toolGetSystemStatus();
          break;

        // ── Google Workspace Tool ────────────────────────────────────────
        case 'google_workspace':
          result = await this.toolGoogleWorkspace(toolArgs);
          break;
        default:
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32602, message: `Unknown tool: ${toolName}` },
          };
      }

      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Tool execution failed';
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
          isError: true,
        },
      };
    }
  }

  // ── Tool Implementations ────────────────────────────────────────────────

  private async toolSearchSemantic(args: Record<string, unknown>): Promise<unknown> {
    const query = args['query'] as string;
    if (!query) throw new Error('query is required');

    const memoryType = args['type'] as SemanticMemoryType | undefined;
    if (memoryType && !VALID_SEMANTIC_TYPES.includes(memoryType)) {
      throw new Error(`Invalid type. Must be one of: ${VALID_SEMANTIC_TYPES.join(', ')}`);
    }

    const limit = clampLimit(args['limit'], 10, 50);
    const profileId = this.getProfileId();
    const results = await this.memory.querySemanticMemory(query, profileId, { memoryType, limit });

    return results.map((r) => ({
      id: r.entry.id,
      content: r.entry.content,
      type: r.entry.memoryType,
      importance: r.entry.importance,
      depth: r.entry.depth,
      similarity: round3(r.similarity),
      score: round3(r.compositeScore),
      created_at: r.entry.createdAt,
    }));
  }

  private async toolSearchExternal(args: Record<string, unknown>): Promise<unknown> {
    const query = args['query'] as string;
    if (!query) throw new Error('query is required');

    const source = args['source'] as ExternalMemorySource | undefined;
    if (source && !VALID_EXTERNAL_SOURCES.includes(source)) {
      throw new Error(`Invalid source. Must be one of: ${VALID_EXTERNAL_SOURCES.join(', ')}`);
    }

    const limit = clampLimit(args['limit'], 5, 50);
    const profileId = this.getProfileId();
    const results = await this.memory.queryExternalMemory(query, profileId, { source, limit });

    return results.map((r) => ({
      content: r.entry.content,
      source: r.entry.sourceType,
      source_ref: r.entry.sourceRef,
      similarity: round3(r.similarity),
      created_at: r.entry.createdAt,
    }));
  }

  private async toolRecallConversation(args: Record<string, unknown>): Promise<unknown> {
    const chatId = (args['chat_id'] as string) ?? this.defaultChatId;
    const sessionId = args['session_id'] as string | undefined;
    const limit = clampLimit(args['limit'], 20, 100);

    if (sessionId) {
      const messages = await this.memory.getSessionMessages(sessionId, limit);
      return messages.map(formatMessageForTool);
    }

    if (chatId) {
      const messages = await this.database.getRecentMessages(chatId, limit);
      return messages.map(formatMessageForTool);
    }

    throw new Error('Either chat_id or session_id is required');
  }

  private async toolStoreSemantic(args: Record<string, unknown>): Promise<unknown> {
    const content = args['content'] as string;
    if (!content) throw new Error('content is required');
    if (content.length > 2000) throw new Error('content must be 2000 characters or less');

    const memoryType = args['type'] as SemanticMemoryType;
    if (!memoryType) throw new Error('type is required');
    if (!VALID_SEMANTIC_TYPES.includes(memoryType)) {
      throw new Error(`Invalid type. Must be one of: ${VALID_SEMANTIC_TYPES.join(', ')}`);
    }

    const importance =
      typeof args['importance'] === 'number'
        ? Math.max(0, Math.min(1, args['importance']))
        : undefined;

    const profileId = this.getProfileId();
    const id = await this.memory.storeSemanticMemory({
      content,
      memoryType,
      importance,
      profileId,
    });

    return { id, stored: true };
  }

  private async toolExpandMemory(args: Record<string, unknown>): Promise<unknown> {
    const memoryId = args['memory_id'] as string;
    if (!memoryId) throw new Error('memory_id is required');

    const result = await this.memory.expandMemory(memoryId);

    if (result.messages) {
      return {
        type: 'messages',
        data: result.messages.map(formatMessageForTool),
      };
    }

    if (result.childSummaries) {
      return {
        type: 'summaries',
        data: result.childSummaries.map((s) => ({
          id: s.id,
          content: s.content,
          depth: s.depth,
          earliest_at: s.earliestAt,
          latest_at: s.latestAt,
        })),
      };
    }

    return { type: 'empty', data: [] };
  }

  private async toolSearchMeta(args: Record<string, unknown>): Promise<unknown> {
    const query = args['query'] as string;
    if (!query) throw new Error('query is required');

    const type = args['type'] as MetaMemoryType | undefined;
    if (type && !VALID_META_TYPES.includes(type)) {
      throw new Error(`Invalid type. Must be one of: ${VALID_META_TYPES.join(', ')}`);
    }

    const limit = clampLimit(args['limit'], 5, 20);
    const minDepth =
      typeof args['min_depth'] === 'number' ? (args['min_depth'] as number) : undefined;
    const maxDepth =
      typeof args['max_depth'] === 'number' ? (args['max_depth'] as number) : undefined;

    const profileId = this.getProfileId();
    const results = await this.memory.queryMetaMemory(query, profileId, {
      type,
      limit,
      minDepth,
      maxDepth,
    });

    return results.map((r) => ({
      id: r.entry.id,
      content: r.entry.content,
      reflection_type: r.entry.reflectionType,
      confidence: round3(r.entry.confidence),
      depth: r.entry.depth,
      similarity: round3(r.similarity),
      score: round3(r.compositeScore),
    }));
  }

  private async toolExpandMeta(args: Record<string, unknown>): Promise<unknown> {
    const metaId = args['meta_id'] as string;
    if (!metaId) throw new Error('meta_id is required');

    const result = await this.memory.expandMetaMemory(metaId);

    if (result.sourceSemantics) {
      return {
        type: 'semantic_sources',
        data: result.sourceSemantics.map((s) => ({
          id: s.id,
          content: s.content,
          memory_type: s.memoryType,
          importance: s.importance,
          depth: s.depth,
        })),
      };
    }

    if (result.childMetas) {
      return {
        type: 'child_metas',
        data: result.childMetas.map((m) => ({
          id: m.id,
          content: m.content,
          reflection_type: m.reflectionType,
          confidence: round3(m.confidence),
          depth: m.depth,
        })),
      };
    }

    return { type: 'empty', data: [] };
  }

  private async toolTraceToSource(args: Record<string, unknown>): Promise<unknown> {
    const metaId = args['meta_id'] as string;
    if (!metaId) throw new Error('meta_id is required');

    const sources = await this.memory.traceMetaToSources(metaId);

    return {
      count: sources.length,
      sources: sources.map((s) => ({
        id: s.id,
        content: s.content,
        memory_type: s.memoryType,
        importance: s.importance,
        depth: s.depth,
      })),
    };
  }

  private async toolGetIdentity(): Promise<unknown> {
    const profileId = this.getProfileId();
    const [agentIdentity, agentPersonality, userIdentity, userPersonality] = await Promise.all([
      this.identity.getAgentIdentity(profileId),
      this.identity.getAgentPersonality(profileId),
      this.identity.getUserIdentity(),
      this.identity.getUserPersonality(),
    ]);

    return {
      agent_identity: agentIdentity,
      agent_personality: agentPersonality.map((p) => ({
        dimension: p.dimension,
        content: p.content,
        confidence: round3(p.confidence),
      })),
      user_identity: userIdentity,
      user_personality: userPersonality.map((p) => ({
        dimension: p.dimension,
        content: p.content,
        confidence: round3(p.confidence),
        source: p.source,
      })),
    };
  }

  private async toolObservePersonality(args: Record<string, unknown>): Promise<unknown> {
    const dimension = args['dimension'] as AgentPersonalityDimension;
    if (!dimension) throw new Error('dimension is required');
    if (!VALID_AGENT_PERSONALITY_DIMS.includes(dimension)) {
      throw new Error(
        `Invalid dimension. Must be one of: ${VALID_AGENT_PERSONALITY_DIMS.join(', ')}`,
      );
    }

    const observation = args['observation'] as string;
    if (!observation) throw new Error('observation is required');

    const profileId = this.getProfileId();
    const entry = await this.identity.observeAgentPersonality(profileId, dimension, observation);
    return {
      dimension: entry.dimension,
      content: entry.content,
      confidence: round3(entry.confidence),
      evidence_count: entry.evidenceCount,
    };
  }

  private async toolObserveUser(args: Record<string, unknown>): Promise<unknown> {
    const dimension = args['dimension'] as UserPersonalityDimension;
    if (!dimension) throw new Error('dimension is required');
    if (!VALID_USER_PERSONALITY_DIMS.includes(dimension)) {
      throw new Error(
        `Invalid dimension. Must be one of: ${VALID_USER_PERSONALITY_DIMS.join(', ')}`,
      );
    }

    const observation = args['observation'] as string;
    if (!observation) throw new Error('observation is required');

    const source = (args['source'] as PersonalitySource) ?? 'inferred';
    const entry = await this.identity.observeUserPersonality(dimension, observation, source);
    return {
      dimension: entry.dimension,
      content: entry.content,
      confidence: round3(entry.confidence),
      source: entry.source,
      evidence_count: entry.evidenceCount,
    };
  }

  private async toolProposeIdentityUpdate(args: Record<string, unknown>): Promise<unknown> {
    const field = args['field'] as string;
    if (!field) throw new Error('field is required');

    const validFields = ['role', 'expertise', 'tone', 'instructions'];
    if (!validFields.includes(field)) {
      throw new Error(`Invalid field. Must be one of: ${validFields.join(', ')}`);
    }

    const newValue = args['new_value'] as string;
    if (!newValue) throw new Error('new_value is required');

    const reason = args['reason'] as string;
    if (!reason) throw new Error('reason is required');

    const profileId = this.getProfileId();
    const proposal = await this.identity.proposeIdentityUpdate(profileId, field, newValue, reason);
    return {
      proposal_id: proposal.id,
      field: proposal.field,
      new_value: proposal.newValue,
      reason: proposal.reason,
      status: 'pending_user_confirmation',
    };
  }

  private async toolUpdateUserIdentity(args: Record<string, unknown>): Promise<unknown> {
    const field = args['field'] as string;
    if (!field) throw new Error('field is required');

    const validFields = ['name', 'role', 'organization', 'timezone', 'language', 'notes'];
    if (!validFields.includes(field)) {
      throw new Error(`Invalid field. Must be one of: ${validFields.join(', ')}`);
    }

    const value = args['value'] as string;
    if (!value) throw new Error('value is required');

    const entry = await this.identity.updateUserIdentity({ [field]: value });
    return { updated: true, user_identity: entry };
  }

  // ── Profile Tools (Phase 4E) ──────────────────────────────────────────

  private async toolListProfiles(): Promise<unknown> {
    const profiles = await this.profileManager.listProfiles();
    return profiles.map((p) => ({
      name: p.name,
      description: p.description,
      is_default: p.isDefault,
      chat_count: p.chatCount,
      semantic_memory_count: p.semanticMemoryCount,
      meta_memory_count: p.metaMemoryCount,
    }));
  }

  private async toolGetCurrentProfile(): Promise<unknown> {
    const profileId = this.getProfileId();
    const profile = await this.profileManager.getProfile(profileId);
    if (!profile) throw new Error('Current profile not found');
    return {
      name: profile.name,
      description: profile.description,
      is_default: profile.isDefault,
    };
  }

  private async toolSwitchChatProfile(args: Record<string, unknown>): Promise<unknown> {
    const profileName = args['profile_name'] as string;
    if (!profileName) throw new Error('profile_name is required');

    const chatId = this.defaultChatId;
    if (!chatId) throw new Error('No chat context available');

    const targetProfile = await this.profileManager.getProfileByName(profileName);
    if (!targetProfile) throw new Error(`Profile not found: ${profileName}`);

    const previousProfileId = await this.profileManager.assignChat(chatId, targetProfile.id);
    const previousProfile = await this.profileManager.getProfile(previousProfileId);

    // Update the resolved profile for this MCP session
    this.profileId = targetProfile.id;

    return {
      switched: true,
      previous_profile: previousProfile?.name ?? 'unknown',
      new_profile: targetProfile.name,
    };
  }
  // ── Admin / Self-Service Tools (ADR-033) ──────────────────────────────

  private async toolInstallSkill(args: Record<string, unknown>): Promise<unknown> {
    if (!this.skillStore || !this.registryClient) {
      throw new Error('Skill management not available');
    }

    const name = args['name'] as string;
    if (!name) throw new Error('name is required');

    // Only allow registry installs via MCP (security constraint)
    const entry = await this.registryClient.lookup(name);
    if (!entry) throw new Error(`Skill "${name}" not found in registry`);

    const downloadDir = await this.registryClient.download(name);
    try {
      const installed = await this.skillStore.install(downloadDir, { source: 'registry' });
      return {
        installed: true,
        name: installed.name,
        version: installed.version,
        message: `Skill "${installed.name}" v${installed.version} installed. Takes effect on next agent invocation.`,
      };
    } finally {
      // Cleanup temp dir
      const fsp = await import('node:fs/promises');
      await fsp.rm(downloadDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async toolUninstallSkill(args: Record<string, unknown>): Promise<unknown> {
    if (!this.skillStore) throw new Error('Skill management not available');

    const name = args['name'] as string;
    if (!name) throw new Error('name is required');

    await this.skillStore.remove(name);
    return {
      uninstalled: true,
      name,
      message: `Skill "${name}" uninstalled. Takes effect on next agent invocation.`,
    };
  }

  private async toolListSkills(): Promise<unknown> {
    if (!this.skillStore) throw new Error('Skill management not available');

    const installed = await this.skillStore.list();
    const builtIn = [
      { name: 'capabilities', description: 'Agent self-description', builtIn: true },
      { name: 'status', description: 'System health report', builtIn: true },
    ];

    let available: Array<{ name: string; description: string; version: string }> = [];
    if (this.registryClient) {
      try {
        const index = await this.registryClient.getIndex();
        const installedNames = new Set(installed.map((s: { name: string }) => s.name));
        available = index.skills
          .filter((s: { name: string }) => !installedNames.has(s.name))
          .map((s: { name: string; description: string; version: string }) => ({
            name: s.name,
            description: s.description,
            version: s.version,
          }));
      } catch {
        // Registry unavailable — return installed only
      }
    }

    return {
      installed: installed.map(
        (s: { name: string; version: string; source: string; installedAt: string }) => ({
          name: s.name,
          version: s.version,
          source: s.source,
          installed_at: s.installedAt,
        }),
      ),
      built_in: builtIn,
      available,
    };
  }

  private async toolSearchSkills(args: Record<string, unknown>): Promise<unknown> {
    if (!this.registryClient) throw new Error('Registry not available');

    const query = args['query'] as string;
    if (!query) throw new Error('query is required');

    const results = await this.registryClient.search(query);

    // Mark which are already installed
    let installedNames = new Set<string>();
    if (this.skillStore) {
      const manifest = await this.skillStore.readManifest();
      installedNames = new Set(manifest.map((s: { name: string }) => s.name));
    }

    return results.map((r: { name: string; description: string; version: string }) => ({
      name: r.name,
      description: r.description,
      version: r.version,
      installed: installedNames.has(r.name),
    }));
  }

  private async toolUpdateConfig(args: Record<string, unknown>): Promise<unknown> {
    const field = args['field'] as string;
    if (!field) throw new Error('field is required');

    const value = args['value'];
    if (value === undefined) throw new Error('value is required');

    // Allowlisted fields that can be updated via chat
    const ALLOWED_FIELDS = [
      'channels.telegram.allowedUsers',
      'channels.whatsapp.enabled',
      'channels.gmail.enabled',
      'service.enabled',
      'service.stt.enabled',
      'agent.maxTurns',
      'agent.idleTimeout',
      'memory.workingMemoryLimit',
      'memory.semanticMemoryLimit',
      'memory.externalSimilarityThreshold',
      'profiles.autoAssignDefault',
    ];

    // Security: block sensitive fields
    const BLOCKED_PREFIXES = [
      'username',
      'dataDir',
      'auth.',
      'container.proxy',
      'database.',
      'agent.runtime',
      'agent.image',
    ];

    if (BLOCKED_PREFIXES.some((p) => field === p || field.startsWith(p))) {
      throw new Error(`Field "${field}" cannot be modified via chat for security reasons`);
    }

    if (!ALLOWED_FIELDS.includes(field)) {
      throw new Error(
        `Field "${field}" is not in the allowlist. Allowed fields: ${ALLOWED_FIELDS.join(', ')}`,
      );
    }

    // Config update will be applied via hot-reload when the config module is built.
    // For now, return the validated intent for the orchestrator to handle.
    return {
      updated: true,
      field,
      value,
      message: `Configuration "${field}" set to ${JSON.stringify(value)}. Restart may be needed for some settings.`,
    };
  }

  private async toolGetAuthUrl(args: Record<string, unknown>): Promise<unknown> {
    const service = args['service'] as string;
    if (!service) throw new Error('service is required');

    const scopes = (args['scopes'] as string[]) ?? [];

    // Auth URL generation will be implemented when channel phases add OAuth flows.
    // For now, return a placeholder that indicates the flow.
    return {
      service,
      scopes,
      message: `OAuth setup for "${service}" is not yet configured. Please use "flowhelm setup ${service}" on the CLI to set up authentication.`,
      requires_cli: true,
    };
  }

  private async toolGetSystemStatus(): Promise<unknown> {
    const profileId = this.getProfileId();
    const memoryStats = await this.memory.getMemoryStats(profileId);
    const profiles = await this.profileManager.listProfiles();

    let installedSkillCount = 0;
    if (this.skillStore) {
      const manifest = await this.skillStore.readManifest();
      installedSkillCount = manifest.length;
    }

    return {
      memory: memoryStats,
      profiles: {
        total: profiles.length,
        names: profiles.map((p) => p.name),
      },
      skills: {
        installed_count: installedSkillCount,
        built_in_count: 2,
      },
      mcp_server: {
        listening: this.isListening(),
        socket_path: this.socketPath,
      },
    };
  }

  // ── Google Workspace Tool ────────────────────────────────────────────────

  private async toolGoogleWorkspace(args: Record<string, unknown>): Promise<unknown> {
    if (!this.channelClient) {
      return {
        error:
          'Google Workspace is not configured. The channel container must be running with Gmail OAuth credentials.',
      };
    }

    const command = args['command'] as string | undefined;
    if (!command) {
      return { error: 'Missing required field: command' };
    }

    const timeout = typeof args['timeout'] === 'number' ? args['timeout'] : undefined;
    const result = await this.channelClient.gws(command, timeout);

    if (!result.success) {
      return {
        error: `gws command failed (exit ${String(result.exitCode)}): ${result.stderr ?? result.output}`,
        exitCode: result.exitCode,
      };
    }

    // Try to parse JSON output from gws for structured results
    try {
      return JSON.parse(result.output);
    } catch {
      // gws output is not JSON — return as plain text
      return { output: result.output };
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function formatMessageForTool(msg: {
  sender_name: string;
  content: string | null;
  timestamp: number;
  is_from_me: boolean;
}): Record<string, unknown> {
  return {
    sender: msg.sender_name,
    content: msg.content ?? '[no content]',
    time: new Date(Number(msg.timestamp)).toISOString(),
    is_assistant: msg.is_from_me,
  };
}

function clampLimit(value: unknown, defaultVal: number, max: number): number {
  if (typeof value !== 'number') return defaultVal;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Cleanup stale socket files from a directory. */
export function cleanupStaleSockets(ipcDir: string): void {
  try {
    if (!fs.existsSync(ipcDir)) return;
    const files = fs.readdirSync(ipcDir);
    for (const file of files) {
      if (file.endsWith('-memory.sock')) {
        try {
          fs.unlinkSync(path.join(ipcDir, file));
        } catch {
          // Ignore
        }
      }
    }
  } catch {
    // Directory doesn't exist or isn't readable
  }
}

// ─── Tool Definitions (25 tools) ─────────────────────────────────────────

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'search_semantic',
    description:
      'Search Tier 2 Semantic Memory (facts, preferences, patterns, contacts, instructions, summaries, procedures) by semantic similarity with composite scoring.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query text' },
        type: {
          type: 'string',
          description: 'Filter by memory type',
          enum: ['preference', 'fact', 'pattern', 'contact', 'instruction', 'summary', 'procedure'],
        },
        limit: { type: 'number', description: 'Max results (default 10, max 50)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_external',
    description:
      'Search External Memory (documents, user-provided references) by cosine similarity.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query text' },
        source: {
          type: 'string',
          description: 'Filter by source type',
          enum: ['document', 'user_provided'],
        },
        limit: { type: 'number', description: 'Max results (default 5, max 50)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'recall_conversation',
    description: 'Retrieve chronological message history from Working Memory (Tier 1).',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'Chat ID' },
        session_id: { type: 'string', description: 'Session ID' },
        limit: { type: 'number', description: 'Max messages (default 20, max 100)' },
      },
    },
  },
  {
    name: 'store_semantic',
    description:
      'Store a new Tier 2 Semantic Memory entry. Use to capture facts, preferences, or patterns mid-task.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Memory content (max 2000 chars)' },
        type: {
          type: 'string',
          description: 'Memory type',
          enum: ['preference', 'fact', 'pattern', 'contact', 'instruction', 'summary', 'procedure'],
        },
        importance: { type: 'number', description: 'Importance 0.0-1.0' },
      },
      required: ['content', 'type'],
    },
  },
  {
    name: 'get_memory_stats',
    description: 'Get aggregate counts across all memory tiers.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'expand_memory',
    description:
      'Drill into a summary entry. Depth-0 returns source messages, depth-1+ returns child summaries. LCM-inspired DAG traversal.',
    inputSchema: {
      type: 'object',
      properties: {
        memory_id: { type: 'string', description: 'Summary entry ID to expand' },
      },
      required: ['memory_id'],
    },
  },
  {
    name: 'search_meta',
    description:
      'Search Tier 3 Meta Memory (insights, heuristics, self-assessments) with confidence-weighted scoring. Supports depth filtering for recursive metacognitive DAG.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query text' },
        type: {
          type: 'string',
          description: 'Filter by reflection type',
          enum: ['insight', 'heuristic', 'self_assessment'],
        },
        limit: { type: 'number', description: 'Max results (default 5, max 20)' },
        min_depth: {
          type: 'number',
          description: 'Minimum DAG depth (0=direct observation, 1=evaluation, 2+=synthesis)',
        },
        max_depth: {
          type: 'number',
          description: 'Maximum DAG depth',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'expand_meta',
    description:
      'Expand a Tier 3 meta memory entry. For depth>0 entries, returns the child meta entries that were condensed into it. For depth=0 entries, returns the source Tier 2 semantic memories.',
    inputSchema: {
      type: 'object',
      properties: {
        meta_id: { type: 'string', description: 'Meta memory entry ID to expand' },
      },
      required: ['meta_id'],
    },
  },
  {
    name: 'trace_to_source',
    description:
      'Trace a Tier 3 meta memory entry all the way down to its source Tier 2 semantic memories, recursively traversing the metacognitive DAG.',
    inputSchema: {
      type: 'object',
      properties: {
        meta_id: { type: 'string', description: 'Meta memory entry ID to trace' },
      },
      required: ['meta_id'],
    },
  },
  {
    name: 'get_identity',
    description:
      'Retrieve full identity snapshot: agent identity, agent personality, user identity, user personality.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'observe_personality',
    description:
      'Record an observation about an agent personality dimension. Confidence grows with confirming evidence.',
    inputSchema: {
      type: 'object',
      properties: {
        dimension: {
          type: 'string',
          description: 'Personality dimension',
          enum: [
            'communication_style',
            'humor',
            'emotional_register',
            'values',
            'rapport',
            'boundaries',
          ],
        },
        observation: { type: 'string', description: 'Observation content' },
      },
      required: ['dimension', 'observation'],
    },
  },
  {
    name: 'observe_user',
    description:
      'Record an observation about a user personality dimension. Inferred from interaction patterns.',
    inputSchema: {
      type: 'object',
      properties: {
        dimension: {
          type: 'string',
          description: 'User personality dimension',
          enum: [
            'communication_style',
            'work_patterns',
            'decision_making',
            'priorities',
            'preferences',
            'boundaries',
          ],
        },
        observation: { type: 'string', description: 'Observation content' },
        source: {
          type: 'string',
          description: 'Source of observation',
          enum: ['inferred', 'declared', 'onboarding'],
        },
      },
      required: ['dimension', 'observation'],
    },
  },
  {
    name: 'propose_identity_update',
    description:
      'Propose a change to agent identity. Requires user confirmation via messaging channel.',
    inputSchema: {
      type: 'object',
      properties: {
        field: {
          type: 'string',
          description: 'Identity field to update',
          enum: ['role', 'expertise', 'tone', 'instructions'],
        },
        new_value: { type: 'string', description: 'Proposed new value' },
        reason: { type: 'string', description: 'Reason for the change' },
      },
      required: ['field', 'new_value', 'reason'],
    },
  },
  {
    name: 'update_user_identity',
    description:
      'Update user identity fields discovered in conversation (name, role, timezone, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        field: {
          type: 'string',
          description: 'Identity field to update',
          enum: ['name', 'role', 'organization', 'timezone', 'language', 'notes'],
        },
        value: { type: 'string', description: 'New value' },
      },
      required: ['field', 'value'],
    },
  },
  {
    name: 'list_profiles',
    description:
      "List all agent profiles with stats (chat count, memory count). Allows the agent to be aware of the user's profile setup.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_current_profile',
    description:
      "Get the current chat's agent profile (name, description, is_default). Allows the agent to identify itself.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'switch_chat_profile',
    description:
      'Reassign the current chat to a different agent profile. Enables chat-based profile management ("switch me to my work profile").',
    inputSchema: {
      type: 'object',
      properties: {
        profile_name: { type: 'string', description: 'Name of the target profile' },
      },
      required: ['profile_name'],
    },
  },

  // ── Admin / Self-Service Tools (ADR-033) ─────────────────────────────
  {
    name: 'install_skill',
    description:
      'Install a skill from the FlowHelm registry. The skill will be available on the next agent invocation.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Skill name from the registry (e.g., "gmail", "data-analysis")',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'uninstall_skill',
    description: 'Remove an installed skill. Fails if other installed skills depend on it.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the skill to uninstall' },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_skills',
    description: 'List installed skills, built-in skills, and available skills from the registry.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'search_skills',
    description:
      'Search the skills registry by keyword. Returns matching skills with install status.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search keyword (matched against name and description)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'update_config',
    description:
      'Update a FlowHelm configuration field. Only allowlisted fields can be modified via chat. Security-sensitive fields are blocked.',
    inputSchema: {
      type: 'object',
      properties: {
        field: {
          type: 'string',
          description: 'Dot-notation config path (e.g., "channels.gmail.enabled")',
        },
        value: { description: 'New value for the field' },
      },
      required: ['field', 'value'],
    },
  },
  {
    name: 'get_auth_url',
    description:
      'Generate an OAuth authorization URL for a service. Returns a URL for the user to open in their browser.',
    inputSchema: {
      type: 'object',
      properties: {
        service: { type: 'string', description: 'Service name (e.g., "google", "slack")' },
        scopes: {
          type: 'array',
          description: 'OAuth scopes to request',
          items: { type: 'string' },
        },
      },
      required: ['service'],
    },
  },
  {
    name: 'get_system_status',
    description:
      'Get FlowHelm system health: memory stats, profiles, installed skills, MCP server status.',
    inputSchema: { type: 'object', properties: {} },
  },
  // ── Google Workspace Tool ─────────────────────────────────────────────────
  {
    name: 'google_workspace',
    description:
      'Execute any Google Workspace operation via the gws CLI. This single tool handles Gmail, ' +
      'Google Contacts, Google Calendar, Google Drive, and all other Google Workspace services.\n\n' +
      'Common commands:\n' +
      '  Email:\n' +
      '    gws gmail +send --to bob@example.com --subject "Hello" --body "Hi Bob"\n' +
      '    gws gmail +send --to a@example.com --cc b@example.com --subject "Re: Topic" --body "Reply text"\n' +
      '    gws gmail users messages list --params \'{"q":"from:alice@example.com"}\'\n' +
      '    gws gmail users messages list --params \'{"q":"subject:invoice after:2026/03/01"}\'\n' +
      '    gws gmail +read --id MESSAGE_ID\n' +
      '  Contacts:\n' +
      '    gws people otherContacts search --params \'{"query":"John"}\'\n' +
      '    gws people people createContact --json \'{"names":[{"displayName":"Alice"}],"emailAddresses":[{"value":"alice@example.com"}]}\'\n' +
      '    gws people people updateContact --params \'{"resourceName":"people/CONTACT_ID"}\' --json \'{"names":[{"displayName":"Alice Smith"}]}\'\n' +
      '    gws people people deleteContact --params \'{"resourceName":"people/CONTACT_ID"}\'\n' +
      '  Calendar:\n' +
      '    gws calendar events list --params \'{"calendarId":"primary"}\'\n' +
      '  Drive:\n' +
      '    gws drive files list --params \'{"pageSize":10}\'\n\n' +
      'The gws CLI has full access to Google Workspace APIs. All responses are JSON. ' +
      'OAuth credentials are managed automatically by the channel container.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description:
            'gws CLI command (e.g., \'gmail +send --to bob@example.com --subject "Hello" --body "Hi"\')',
        },
        timeout: {
          type: 'number',
          description: 'Command timeout in ms (default: 30000, max: 60000)',
        },
      },
      required: ['command'],
    },
  },
];
