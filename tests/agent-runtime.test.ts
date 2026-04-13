import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  parseCliResponse,
  extractLastAssistantUuid,
  extractSessionIdFromJsonl,
} from '../src/agent/cli-response.js';
import { buildSystemPrompt, estimatePromptTokens } from '../src/agent/system-prompt.js';
import {
  generateMcpConfig,
  buildMcpCliFlags,
  getContainerMcpConfigPath,
} from '../src/agent/mcp-config.js';
import { CliRuntime } from '../src/agent/cli-runtime.js';
import { SdkRuntime } from '../src/agent/sdk-runtime.js';
import { createAgentRuntime } from '../src/agent/index.js';
import type {
  ContainerRuntime,
  ExecResult,
  ContainerConfig,
  ContainerInfo,
} from '../src/orchestrator/types.js';
import type { SessionManager } from '../src/agent/session-manager.js';
import { flowhelmConfigSchema } from '../src/config/schema.js';

// ─── Mock Factories ────────────────────────────────────────────────────────

function createMockContainerRuntime(overrides?: Record<string, unknown>): ContainerRuntime {
  return {
    create: vi.fn().mockResolvedValue('container-abc123'),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
    logs: vi.fn().mockResolvedValue(''),
    isHealthy: vi.fn().mockResolvedValue(true),
    exists: vi.fn().mockResolvedValue(false),
    list: vi.fn().mockResolvedValue([]),
    createNetwork: vi.fn().mockResolvedValue(undefined),
    removeNetwork: vi.fn().mockResolvedValue(undefined),
    networkExists: vi.fn().mockResolvedValue(true),
    imageExists: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as unknown as ContainerRuntime;
}

function createMockSessionManager(overrides?: Record<string, unknown>): SessionManager {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    getActiveSession: vi.fn().mockResolvedValue(null),
    saveSession: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    restoreToFilesystem: vi.fn().mockResolvedValue(null),
    saveFromFilesystem: vi.fn().mockResolvedValue(undefined),
    cleanupExpired: vi.fn().mockResolvedValue(0),
    touchSession: vi.fn().mockResolvedValue(undefined),
    listActiveSessions: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as SessionManager;
}

function createDefaultConfig() {
  return flowhelmConfigSchema.parse({ username: 'testuser' });
}

// ═══════════════════════════════════════════════════════════════════════════
// CLI Response Parser
// ═══════════════════════════════════════════════════════════════════════════

describe('parseCliResponse', () => {
  it('parses a valid JSON response', () => {
    const stdout = JSON.stringify({
      result: 'Hello! How can I help?',
      is_error: false,
      session_id: 'sess-123',
      num_turns: 1,
      total_input_tokens: 500,
      total_output_tokens: 50,
    });
    const result = parseCliResponse(stdout, '');
    expect(result.text).toBe('Hello! How can I help?');
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.sessionId).toBe('sess-123');
    expect(result.numTurns).toBe(1);
    expect(result.cost.inputTokens).toBe(500);
    expect(result.cost.outputTokens).toBe(50);
  });

  it('parses an error response', () => {
    const stdout = JSON.stringify({
      result: 'Context limit exceeded',
      is_error: true,
      session_id: 'sess-456',
      num_turns: 5,
    });
    const result = parseCliResponse(stdout, '');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Context limit exceeded');
    expect(result.sessionId).toBe('sess-456');
  });

  it('handles empty stdout', () => {
    const result = parseCliResponse('', '');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Empty response from agent');
    expect(result.text).toBe('');
  });

  it('handles empty stdout with stderr', () => {
    const result = parseCliResponse('', 'Connection refused');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Connection refused');
  });

  it('handles malformed JSON', () => {
    const result = parseCliResponse('not json at all', '');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Failed to parse agent response as JSON');
    expect(result.text).toBe('not json at all');
  });

  it('extracts JSON from mixed output', () => {
    const stdout =
      'Some warning\n' +
      JSON.stringify({
        result: 'Got it!',
        is_error: false,
        session_id: 'sess-789',
        num_turns: 2,
      });
    const result = parseCliResponse(stdout, '');
    expect(result.text).toBe('Got it!');
    expect(result.success).toBe(true);
  });

  it('handles missing optional fields', () => {
    const stdout = JSON.stringify({
      result: 'Ok',
      is_error: false,
      session_id: 'sess-000',
      num_turns: 1,
    });
    const result = parseCliResponse(stdout, '');
    expect(result.cost.inputTokens).toBe(0);
    expect(result.cost.outputTokens).toBe(0);
  });

  it('handles whitespace-only stdout', () => {
    const result = parseCliResponse('   \n\n  ', '');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Empty response from agent');
  });
});

describe('extractLastAssistantUuid', () => {
  it('extracts UUID from JSONL with assistant messages', () => {
    const jsonl = [
      JSON.stringify({ type: 'system', session_id: 'sess-1' }),
      JSON.stringify({ type: 'user', content: 'Hello' }),
      JSON.stringify({ type: 'assistant', uuid: 'uuid-aaa' }),
      JSON.stringify({ type: 'user', content: 'More' }),
      JSON.stringify({ type: 'assistant', uuid: 'uuid-bbb' }),
    ].join('\n');
    expect(extractLastAssistantUuid(jsonl)).toBe('uuid-bbb');
  });

  it('returns null when no assistant messages', () => {
    const jsonl = [
      JSON.stringify({ type: 'system', session_id: 'sess-1' }),
      JSON.stringify({ type: 'user', content: 'Hello' }),
    ].join('\n');
    expect(extractLastAssistantUuid(jsonl)).toBeNull();
  });

  it('handles empty input', () => {
    expect(extractLastAssistantUuid('')).toBeNull();
  });

  it('handles malformed lines', () => {
    const jsonl = 'not json\n' + JSON.stringify({ type: 'assistant', uuid: 'uuid-ccc' });
    expect(extractLastAssistantUuid(jsonl)).toBe('uuid-ccc');
  });
});

describe('extractSessionIdFromJsonl', () => {
  it('extracts session_id from system init message', () => {
    const jsonl = [
      JSON.stringify({ type: 'system', session_id: 'sess-init-123' }),
      JSON.stringify({ type: 'user', content: 'Hi' }),
    ].join('\n');
    expect(extractSessionIdFromJsonl(jsonl)).toBe('sess-init-123');
  });

  it('returns null when no system message', () => {
    const jsonl = JSON.stringify({ type: 'user', content: 'Hi' });
    expect(extractSessionIdFromJsonl(jsonl)).toBeNull();
  });

  it('returns null on empty input', () => {
    expect(extractSessionIdFromJsonl('')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// System Prompt Builder
// ═══════════════════════════════════════════════════════════════════════════

describe('buildSystemPrompt', () => {
  it('returns a custom prompt when useCustom is true', () => {
    const prompt = buildSystemPrompt({ useCustom: true });
    expect(prompt).toBeDefined();
    expect(prompt).toContain('FlowHelm Agent');
    expect(prompt).toContain('Memory Tools');
    expect(prompt).toContain('search_semantic');
  });

  it('returns undefined when useCustom is false', () => {
    const prompt = buildSystemPrompt({ useCustom: false });
    expect(prompt).toBeUndefined();
  });

  it('includes agent name when provided', () => {
    const prompt = buildSystemPrompt({ useCustom: true, agentName: 'TaskBot' });
    expect(prompt).toContain('TaskBot');
  });

  it('includes username when provided', () => {
    const prompt = buildSystemPrompt({ useCustom: true, username: 'Alice' });
    expect(prompt).toContain('for Alice');
  });

  it('generates a prompt under 1000 tokens', () => {
    const prompt = buildSystemPrompt({ useCustom: true })!;
    const tokens = estimatePromptTokens(prompt);
    expect(tokens).toBeLessThan(1000);
    expect(tokens).toBeGreaterThan(200);
  });
});

describe('estimatePromptTokens', () => {
  it('estimates roughly 4 chars per token', () => {
    expect(estimatePromptTokens('hello world')).toBe(3); // 11/4 = 2.75 → ceil = 3
  });

  it('returns 0 for empty string', () => {
    expect(estimatePromptTokens('')).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MCP Config Generator
// ═══════════════════════════════════════════════════════════════════════════

describe('generateMcpConfig', () => {
  it('generates config with default paths', () => {
    const config = generateMcpConfig();
    expect(config.mcpServers).toHaveProperty('flowhelm');
    const server = config.mcpServers['flowhelm'];
    expect(server.command).toBe('node');
    expect(server.args[0]).toContain('stdio-to-uds-bridge.cjs');
    expect(server.env?.FLOWHELM_MCP_SOCKET).toContain('memory.sock');
  });

  it('generates config with custom socket path', () => {
    const config = generateMcpConfig({ socketPath: '/custom/socket.sock' });
    const server = config.mcpServers['flowhelm'];
    expect(server.env?.FLOWHELM_MCP_SOCKET).toBe('/custom/socket.sock');
  });

  it('generates config with custom bridge script path', () => {
    const config = generateMcpConfig({ bridgeScriptPath: '/custom/bridge.js' });
    const server = config.mcpServers['flowhelm'];
    expect(server.args[0]).toBe('/custom/bridge.js');
  });
});

describe('buildMcpCliFlags', () => {
  it('returns --mcp-config with the path', () => {
    const flags = buildMcpCliFlags('/workspace/config/mcp-config.json');
    expect(flags).toEqual(['--mcp-config', '/workspace/config/mcp-config.json']);
  });
});

describe('getContainerMcpConfigPath', () => {
  it('returns the container-side path', () => {
    expect(getContainerMcpConfigPath()).toBe('/workspace/mcp-config.json');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CliRuntime
// ═══════════════════════════════════════════════════════════════════════════

describe('CliRuntime', () => {
  let runtime: CliRuntime;
  let mockContainerRuntime: ContainerRuntime;
  let mockSessionManager: SessionManager;
  let config: ReturnType<typeof createDefaultConfig>;

  beforeEach(() => {
    vi.useFakeTimers();
    config = createDefaultConfig();
    mockContainerRuntime = createMockContainerRuntime();
    mockSessionManager = createMockSessionManager();
    runtime = new CliRuntime({
      config,
      containerRuntime: mockContainerRuntime,
      sessionManager: mockSessionManager,
      proxyUrl: 'http://flowhelm-proxy-testuser:10255',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates a warm container on first execution', async () => {
    const successResponse = JSON.stringify({
      result: 'Done!',
      is_error: false,
      session_id: 'sess-new',
      num_turns: 1,
      total_input_tokens: 100,
      total_output_tokens: 20,
    });

    (mockContainerRuntime.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      stdout: successResponse,
      stderr: '',
      exitCode: 0,
    });

    const result = await runtime.execute({
      id: 'task-1',
      chatId: 'tg:123',
      message: 'Hello',
      username: 'testuser',
      workDir: '/workspace',
      maxTurns: 25,
      env: {},
      systemPrompt: '<context>test</context>',
      mcpConfigPath: '/workspace/ipc/memory.sock',
    });

    expect(result.text).toBe('Done!');
    expect(result.success).toBe(true);
    expect(result.cost.inputTokens).toBe(100);
    expect(result.cost.outputTokens).toBe(20);

    // Container was created with sleep infinity
    expect(mockContainerRuntime.create).toHaveBeenCalledOnce();
    const createCall = (mockContainerRuntime.create as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as ContainerConfig;
    expect(createCall.command).toEqual(['sleep', 'infinity']);
    expect(createCall.env).toHaveProperty('HTTPS_PROXY', 'http://flowhelm-proxy-testuser:10255');

    // Container was started
    expect(mockContainerRuntime.start).toHaveBeenCalledOnce();
  });

  it('reuses warm container for same chat', async () => {
    const response = JSON.stringify({
      result: 'Response',
      is_error: false,
      session_id: 'sess-1',
      num_turns: 1,
    });

    (mockContainerRuntime.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      stdout: response,
      stderr: '',
      exitCode: 0,
    });

    const task = {
      id: 'task-1',
      chatId: 'tg:123',
      message: 'Hello',
      username: 'testuser',
      workDir: '/workspace',
      maxTurns: 25,
      env: {},
    };

    // First execution — creates container
    await runtime.execute(task);
    expect(mockContainerRuntime.create).toHaveBeenCalledTimes(1);

    // Second execution — reuses warm container
    await runtime.execute({ ...task, id: 'task-2', message: 'Again' });
    expect(mockContainerRuntime.create).toHaveBeenCalledTimes(1); // Not called again
    // exec is called multiple times per execute (post-start copy, command, backup reads)
    // but the key assertion is that create was NOT called again (container reuse)
    expect(mockContainerRuntime.exec).toHaveBeenCalled();
  });

  it('recreates container if warm container died', async () => {
    const response = JSON.stringify({
      result: 'Ok',
      is_error: false,
      session_id: 'sess-2',
      num_turns: 1,
    });

    (mockContainerRuntime.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      stdout: response,
      stderr: '',
      exitCode: 0,
    });

    const task = {
      id: 'task-1',
      chatId: 'tg:456',
      message: 'Hi',
      username: 'testuser',
      workDir: '/workspace',
      maxTurns: 25,
      env: {},
    };

    // First execution
    await runtime.execute(task);
    expect(mockContainerRuntime.create).toHaveBeenCalledTimes(1);

    // Simulate container death
    (mockContainerRuntime.isHealthy as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    // Third execution — recreates container
    await runtime.execute({ ...task, id: 'task-3' });
    expect(mockContainerRuntime.create).toHaveBeenCalledTimes(2);
  });

  it('handles agent error response', async () => {
    const errorResponse = JSON.stringify({
      result: 'Max turns exceeded',
      is_error: true,
      session_id: 'sess-err',
      num_turns: 25,
    });

    (mockContainerRuntime.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      stdout: errorResponse,
      stderr: '',
      exitCode: 0,
    });

    const result = await runtime.execute({
      id: 'task-err',
      chatId: 'tg:789',
      message: 'Complex task',
      username: 'testuser',
      workDir: '/workspace',
      maxTurns: 25,
      env: {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Max turns exceeded');
  });

  it('builds CLI command with all flags', () => {
    const command = runtime.buildCliCommand({
      message: 'What is the weather?',
      systemPrompt: '<context>memory</context>',
      mcpConfigPath: '/workspace/config/mcp-config.json',
      maxTurns: 10,
      resumeSessionId: 'sess-resume',
      useCustomSystemPrompt: true,
      disableSlashCommands: false,
    });

    expect(command).toContain('claude');
    expect(command).toContain('-p');
    expect(command).toContain('--output-format');
    expect(command).toContain('json');
    expect(command).toContain('--dangerously-skip-permissions');
    expect(command).toContain('--max-turns');
    expect(command).toContain('10');
    expect(command).toContain('--system-prompt');
    expect(command).toContain('--append-system-prompt');
    expect(command).toContain('<context>memory</context>');
    expect(command).toContain('--mcp-config');
    expect(command).toContain('--strict-mcp-config');
    expect(command).toContain('--resume');
    expect(command).toContain('sess-resume');
    expect(command).not.toContain('--disable-slash-commands');
    expect(command[command.length - 1]).toBe('What is the weather?');
  });

  it('builds CLI command without resume for fresh session', () => {
    const command = runtime.buildCliCommand({
      message: 'Hello',
      systemPrompt: '',
      mcpConfigPath: '/workspace/config/mcp-config.json',
      maxTurns: 25,
      useCustomSystemPrompt: false,
      disableSlashCommands: true,
    });

    expect(command).not.toContain('--resume');
    expect(command).not.toContain('--system-prompt');
    expect(command).toContain('--disable-slash-commands');
  });

  it('builds CLI command with tools restriction', () => {
    const command = runtime.buildCliCommand({
      message: 'Do something',
      systemPrompt: '',
      mcpConfigPath: '/workspace/config/mcp-config.json',
      maxTurns: 25,
      useCustomSystemPrompt: false,
      disableSlashCommands: false,
      tools: 'Bash,Read,Write',
    });

    expect(command).toContain('--allowedTools');
    expect(command).toContain('Bash,Read,Write');
  });

  it('isHealthy returns true when image exists', async () => {
    (mockContainerRuntime.imageExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    expect(await runtime.isHealthy()).toBe(true);
  });

  it('isHealthy returns false when image missing', async () => {
    (mockContainerRuntime.imageExists as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    expect(await runtime.isHealthy()).toBe(false);
  });

  it('getWarmContainerCount starts at zero', () => {
    expect(runtime.getWarmContainerCount()).toBe(0);
  });

  it('tracks warm container count', async () => {
    const response = JSON.stringify({
      result: 'Ok',
      is_error: false,
      session_id: 'sess-track',
      num_turns: 1,
    });

    (mockContainerRuntime.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      stdout: response,
      stderr: '',
      exitCode: 0,
    });

    await runtime.execute({
      id: 'task-track',
      chatId: 'tg:track1',
      message: 'Hi',
      username: 'testuser',
      workDir: '/workspace',
      maxTurns: 25,
      env: {},
    });

    expect(runtime.getWarmContainerCount()).toBe(1);

    await runtime.execute({
      id: 'task-track2',
      chatId: 'tg:track2',
      message: 'Hi',
      username: 'testuser',
      workDir: '/workspace',
      maxTurns: 25,
      env: {},
    });

    expect(runtime.getWarmContainerCount()).toBe(2);
  });

  it('performs async PG backup after execution', async () => {
    const response = JSON.stringify({
      result: 'Ok',
      is_error: false,
      session_id: 'sess-backup',
      num_turns: 1,
    });

    (mockContainerRuntime.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      stdout: response,
      stderr: '',
      exitCode: 0,
    });

    await runtime.execute({
      id: 'task-backup',
      chatId: 'tg:backup',
      message: 'Hello',
      username: 'testuser',
      workDir: '/workspace',
      maxTurns: 25,
      env: {},
    });

    // Allow async backup to complete
    await vi.advanceTimersByTimeAsync(100);

    // Backup now reads session files from container via exec, then calls saveSession
    expect(mockSessionManager.saveSession).toHaveBeenCalled();
  });

  it('restores session on cold start from PG', async () => {
    const response = JSON.stringify({
      result: 'Resumed!',
      is_error: false,
      session_id: 'sess-restored',
      num_turns: 1,
    });

    (mockContainerRuntime.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      stdout: response,
      stderr: '',
      exitCode: 0,
    });

    (mockSessionManager.restoreToFilesystem as ReturnType<typeof vi.fn>).mockResolvedValue({
      chatId: 'tg:cold',
      sessionId: 'sess-old',
      sessionFiles: { 'main.jsonl': '{}' },
      lastAssistantUuid: 'uuid-old',
      messageCount: 5,
      createdAt: Date.now() - 60000,
      updatedAt: Date.now() - 60000,
      expiresAt: Date.now() + 3600000,
    });

    await runtime.execute({
      id: 'task-cold',
      chatId: 'tg:cold',
      message: 'Continue',
      username: 'testuser',
      workDir: '/workspace',
      maxTurns: 25,
      env: {},
    });

    expect(mockSessionManager.restoreToFilesystem).toHaveBeenCalledWith(
      'tg:cold',
      expect.stringContaining('sessions'),
    );

    // Find the exec call that runs the claude CLI command (not the post-start copy)
    const allExecCalls = (mockContainerRuntime.exec as ReturnType<typeof vi.fn>).mock.calls;
    const claudeExecCall = allExecCalls.find(
      (call: unknown[]) => Array.isArray(call[1]) && (call[1] as string[]).includes('claude'),
    );
    expect(claudeExecCall).toBeDefined();
    const command = claudeExecCall![1] as string[];
    const resumeIdx = command.indexOf('--resume');
    expect(resumeIdx).toBeGreaterThan(-1);
    expect(command[resumeIdx + 1]).toBe('sess-old');
  });

  it('shuts down all warm containers', async () => {
    const response = JSON.stringify({
      result: 'Ok',
      is_error: false,
      session_id: 'sess-shutdown',
      num_turns: 1,
    });

    (mockContainerRuntime.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      stdout: response,
      stderr: '',
      exitCode: 0,
    });

    await runtime.execute({
      id: 'task-sd1',
      chatId: 'tg:sd1',
      message: 'Hi',
      username: 'testuser',
      workDir: '/workspace',
      maxTurns: 25,
      env: {},
    });

    await runtime.execute({
      id: 'task-sd2',
      chatId: 'tg:sd2',
      message: 'Hi',
      username: 'testuser',
      workDir: '/workspace',
      maxTurns: 25,
      env: {},
    });

    expect(runtime.getWarmContainerCount()).toBe(2);

    await runtime.shutdown();

    expect(runtime.getWarmContainerCount()).toBe(0);
    // Stop and remove called for each container
    expect(mockContainerRuntime.stop).toHaveBeenCalledTimes(2);
    expect(mockContainerRuntime.remove).toHaveBeenCalledTimes(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SdkRuntime
// ═══════════════════════════════════════════════════════════════════════════

describe('SdkRuntime', () => {
  let runtime: SdkRuntime;
  let mockContainerRuntime: ContainerRuntime;
  let mockSessionManager: SessionManager;
  let config: ReturnType<typeof createDefaultConfig>;

  beforeEach(() => {
    vi.useFakeTimers();
    config = createDefaultConfig();
    mockContainerRuntime = createMockContainerRuntime();
    mockSessionManager = createMockSessionManager();
    runtime = new SdkRuntime({
      config,
      containerRuntime: mockContainerRuntime,
      sessionManager: mockSessionManager,
      proxyUrl: 'http://flowhelm-proxy-testuser:10255',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates a warm container and executes sdk-runner.js', async () => {
    const sdkResponse = JSON.stringify({
      result: 'SDK response!',
      is_error: false,
      session_id: 'sdk-sess-1',
      num_turns: 2,
      input_tokens: 300,
      output_tokens: 80,
    });

    (mockContainerRuntime.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      stdout: sdkResponse,
      stderr: '',
      exitCode: 0,
    });

    const result = await runtime.execute({
      id: 'task-sdk',
      chatId: 'tg:sdk',
      message: 'Hello SDK',
      username: 'testuser',
      workDir: '/workspace',
      maxTurns: 25,
      env: {},
      systemPrompt: '<context>memory</context>',
    });

    expect(result.text).toBe('SDK response!');
    expect(result.success).toBe(true);
    expect(result.cost.inputTokens).toBe(300);
    expect(result.cost.outputTokens).toBe(80);

    // Container was created with sleep infinity
    expect(mockContainerRuntime.create).toHaveBeenCalledOnce();
    const createCall = (mockContainerRuntime.create as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as ContainerConfig;
    expect(createCall.command).toEqual(['sleep', 'infinity']);

    // Find the exec call that runs sdk-runner.js (not the post-start copy)
    const allExecCalls = (mockContainerRuntime.exec as ReturnType<typeof vi.fn>).mock.calls;
    const sdkExecCall = allExecCalls.find(
      (call: unknown[]) => Array.isArray(call[1]) && (call[1] as string[])[0] === 'node',
    );
    expect(sdkExecCall).toBeDefined();
    const execArgs = sdkExecCall![1] as string[];
    expect(execArgs[0]).toBe('node');
    expect(execArgs[1]).toBe('/workspace/sdk-runner.js');
    expect(execArgs).toContain('--message');
    expect(execArgs).toContain('Hello SDK');
  });

  it('reuses warm container for same chat', async () => {
    const response = JSON.stringify({
      result: 'Ok',
      is_error: false,
      session_id: 'sdk-sess-2',
      num_turns: 1,
      input_tokens: 100,
      output_tokens: 20,
    });

    (mockContainerRuntime.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      stdout: response,
      stderr: '',
      exitCode: 0,
    });

    await runtime.execute({
      id: 'task-1',
      chatId: 'tg:sdk-reuse',
      message: 'First',
      username: 'testuser',
      workDir: '/workspace',
      maxTurns: 25,
      env: {},
    });

    await runtime.execute({
      id: 'task-2',
      chatId: 'tg:sdk-reuse',
      message: 'Second',
      username: 'testuser',
      workDir: '/workspace',
      maxTurns: 25,
      env: {},
    });

    expect(mockContainerRuntime.create).toHaveBeenCalledTimes(1);
    // exec is called multiple times per execute (post-start copy, command, backup reads)
    // but the key assertion is that create was NOT called again (container reuse)
    expect(mockContainerRuntime.exec).toHaveBeenCalled();
  });

  it('handles SDK error response', async () => {
    const errorResponse = JSON.stringify({
      result: 'API rate limit exceeded',
      is_error: true,
      session_id: '',
      num_turns: 0,
      input_tokens: 0,
      output_tokens: 0,
    });

    (mockContainerRuntime.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      stdout: errorResponse,
      stderr: '',
      exitCode: 1,
    });

    const result = await runtime.execute({
      id: 'task-err',
      chatId: 'tg:sdk-err',
      message: 'Fail',
      username: 'testuser',
      workDir: '/workspace',
      maxTurns: 25,
      env: {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('API rate limit exceeded');
  });

  it('handles empty stdout', async () => {
    (mockContainerRuntime.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      stdout: '',
      stderr: 'Container crashed',
      exitCode: 1,
    });

    const result = await runtime.execute({
      id: 'task-empty',
      chatId: 'tg:sdk-empty',
      message: 'Hi',
      username: 'testuser',
      workDir: '/workspace',
      maxTurns: 25,
      env: {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Container crashed');
  });

  it('isHealthy checks image exists', async () => {
    (mockContainerRuntime.imageExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    expect(await runtime.isHealthy()).toBe(true);

    (mockContainerRuntime.imageExists as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    expect(await runtime.isHealthy()).toBe(false);
  });

  it('shuts down warm containers', async () => {
    const response = JSON.stringify({
      result: 'Ok',
      is_error: false,
      session_id: 'sdk-sess-3',
      num_turns: 1,
      input_tokens: 50,
      output_tokens: 10,
    });

    (mockContainerRuntime.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      stdout: response,
      stderr: '',
      exitCode: 0,
    });

    await runtime.execute({
      id: 'task-sd',
      chatId: 'tg:sdk-shutdown',
      message: 'Hi',
      username: 'testuser',
      workDir: '/workspace',
      maxTurns: 25,
      env: {},
    });

    expect(runtime.getWarmContainerCount()).toBe(1);

    await runtime.shutdown();

    expect(runtime.getWarmContainerCount()).toBe(0);
    expect(mockContainerRuntime.stop).toHaveBeenCalledOnce();
    expect(mockContainerRuntime.remove).toHaveBeenCalledOnce();
  });

  it('passes resume session ID to sdk-runner', async () => {
    // First call — creates container, no resume
    const response1 = JSON.stringify({
      result: 'First',
      is_error: false,
      session_id: 'sdk-sess-resume',
      num_turns: 1,
      input_tokens: 50,
      output_tokens: 10,
    });

    (mockContainerRuntime.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      stdout: response1,
      stderr: '',
      exitCode: 0,
    });

    await runtime.execute({
      id: 'task-r1',
      chatId: 'tg:sdk-resume',
      message: 'Start',
      username: 'testuser',
      workDir: '/workspace',
      maxTurns: 25,
      env: {},
    });

    // Second call — should include --resume
    const response2 = JSON.stringify({
      result: 'Continued',
      is_error: false,
      session_id: 'sdk-sess-resume',
      num_turns: 1,
      input_tokens: 50,
      output_tokens: 10,
    });

    (mockContainerRuntime.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      stdout: response2,
      stderr: '',
      exitCode: 0,
    });

    await runtime.execute({
      id: 'task-r2',
      chatId: 'tg:sdk-resume',
      message: 'Continue',
      username: 'testuser',
      workDir: '/workspace',
      maxTurns: 25,
      env: {},
    });

    // Find the second sdk-runner exec call (the one with --resume)
    const allExecCalls = (mockContainerRuntime.exec as ReturnType<typeof vi.fn>).mock.calls;
    const sdkExecCalls = allExecCalls.filter(
      (call: unknown[]) => Array.isArray(call[1]) && (call[1] as string[])[0] === 'node',
    );
    expect(sdkExecCalls.length).toBeGreaterThanOrEqual(2);
    const secondExecArgs = sdkExecCalls[1][1] as string[];
    const resumeIdx = secondExecArgs.indexOf('--resume');
    expect(resumeIdx).toBeGreaterThan(-1);
    expect(secondExecArgs[resumeIdx + 1]).toBe('sdk-sess-resume');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Runtime Factory
// ═══════════════════════════════════════════════════════════════════════════

describe('createAgentRuntime', () => {
  it('creates CliRuntime for cli config', () => {
    const config = flowhelmConfigSchema.parse({ username: 'testuser', agent: { runtime: 'cli' } });
    const { runtime, sessionManager } = createAgentRuntime({
      config,
      containerRuntime: createMockContainerRuntime(),
      sql: {} as any,
      proxyUrl: 'http://proxy:10255',
    });
    expect(runtime).toBeInstanceOf(CliRuntime);
    expect(sessionManager).toBeDefined();
  });

  it('creates SdkRuntime for sdk config', () => {
    const config = flowhelmConfigSchema.parse({ username: 'testuser', agent: { runtime: 'sdk' } });
    const { runtime, sessionManager } = createAgentRuntime({
      config,
      containerRuntime: createMockContainerRuntime(),
      sql: {} as any,
      proxyUrl: 'http://proxy:10255',
    });
    expect(runtime).toBeInstanceOf(SdkRuntime);
    expect(sessionManager).toBeDefined();
  });
});
