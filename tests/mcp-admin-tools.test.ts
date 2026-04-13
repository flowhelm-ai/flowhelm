import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { McpServer } from '../src/orchestrator/mcp-server.js';
import { SkillStore } from '../src/skills/store.js';
import { RegistryClient } from '../src/skills/registry.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

let tempDir: string;
let skillStore: SkillStore;
let registryClient: RegistryClient;

const mockRegistry = {
  version: 1,
  skills: [
    { name: 'gmail', description: 'Gmail integration.', version: '1.0.0', path: 'skills/gmail' },
    {
      name: 'browser',
      description: 'Web browsing tool.',
      version: '2.0.0',
      path: 'skills/browser',
    },
    {
      name: 'data-analysis',
      description: 'Analyze CSV data.',
      version: '1.1.0',
      path: 'skills/data-analysis',
    },
  ],
};

function createMockFetch(): typeof globalThis.fetch {
  return (async (input: string | URL | Request) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if (url.includes('registry.json')) {
      return { ok: true, json: async () => mockRegistry } as Response;
    }

    if (url.includes('api.github.com/repos') && url.includes('/contents/')) {
      return {
        ok: true,
        json: async () => [
          { name: 'SKILL.md', type: 'file', download_url: 'https://raw.test/SKILL.md' },
        ],
      } as Response;
    }

    if (url.includes('raw.test') || url.includes('raw.githubusercontent.com')) {
      return {
        ok: true,
        text: async () =>
          '---\nname: gmail\ndescription: Gmail integration.\nversion: 1.0.0\n---\nGmail skill instructions.',
      } as Response;
    }

    return { ok: false, status: 404 } as Response;
  }) as typeof globalThis.fetch;
}

/** Minimal mocks for memory, identity, profile, database. */
function createMinimalMocks() {
  return {
    memory: {
      getMemoryStats: async () => ({
        working: 10,
        semantic: 5,
        meta: 2,
        external: 3,
      }),
      querySemanticMemory: async () => [],
      queryMetaMemory: async () => [],
      queryExternalMemory: async () => [],
      expandMemory: async () => ({}),
      storeSemanticMemory: async () => 'test-id',
      getSessionMessages: async () => [],
    } as any,
    identity: {
      getAgentIdentity: async () => ({ role: 'test', expertise: [], tone: 'neutral' }),
      getAgentPersonality: async () => [],
      getUserIdentity: async () => ({ language: 'en' }),
      getUserPersonality: async () => [],
      observeAgentPersonality: async () => ({}),
      observeUserPersonality: async () => ({}),
      proposeIdentityUpdate: async () => ({ id: '1', field: 'role', newValue: 'x', reason: 'y' }),
      updateUserIdentity: async () => ({}),
    } as any,
    profileManager: {
      getChatProfile: async () => ({ id: 'profile-1' }),
      getDefaultProfile: async () => ({ id: 'profile-1', name: 'default' }),
      getProfile: async () => ({ id: 'profile-1', name: 'default', isDefault: true }),
      getProfileByName: async () => null,
      listProfiles: async () => [
        {
          name: 'default',
          description: null,
          isDefault: true,
          chatCount: 1,
          semanticMemoryCount: 5,
          metaMemoryCount: 2,
        },
      ],
      assignChat: async () => 'profile-1',
    } as any,
    database: {
      getRecentMessages: async () => [],
    } as any,
  };
}

function makeRequest(method: string, params?: Record<string, unknown>) {
  return {
    jsonrpc: '2.0' as const,
    id: 1,
    method,
    params,
  };
}

function callTool(server: McpServer, name: string, args: Record<string, unknown> = {}) {
  return server.handleRequest(makeRequest('tools/call', { name, arguments: args }));
}

function parseResult(response: any): unknown {
  const text = response?.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'flowhelm-mcp-admin-test-'));
  const storeDir = path.join(tempDir, 'skills');
  skillStore = new SkillStore({ skillsDir: storeDir });
  await skillStore.init();
  registryClient = new RegistryClient({ fetchFn: createMockFetch() });
});

afterEach(async () => {
  await fsp.rm(tempDir, { recursive: true, force: true });
});

// ─── install_skill ──────────────────────────────────────────────────────────

describe('install_skill MCP tool', () => {
  it('installs a skill from the registry', async () => {
    const mocks = createMinimalMocks();
    const server = new McpServer({
      socketPath: path.join(tempDir, 'test.sock'),
      ...mocks,
      skillStore,
      registryClient,
    });
    await server.start();

    try {
      const response = await callTool(server, 'install_skill', { name: 'gmail' });
      const result = parseResult(response) as any;

      expect(result.installed).toBe(true);
      expect(result.name).toBe('gmail');
      expect(result.version).toBe('1.0.0');
      expect(await skillStore.isInstalled('gmail')).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it('fails for unknown skill', async () => {
    const mocks = createMinimalMocks();
    const server = new McpServer({
      socketPath: path.join(tempDir, 'test.sock'),
      ...mocks,
      skillStore,
      registryClient,
    });
    await server.start();

    try {
      const response = await callTool(server, 'install_skill', { name: 'nonexistent' });
      const result = parseResult(response) as any;
      expect(result.error).toBeDefined();
    } finally {
      await server.stop();
    }
  });

  it('requires name parameter', async () => {
    const mocks = createMinimalMocks();
    const server = new McpServer({
      socketPath: path.join(tempDir, 'test.sock'),
      ...mocks,
      skillStore,
      registryClient,
    });
    await server.start();

    try {
      const response = await callTool(server, 'install_skill', {});
      const result = parseResult(response) as any;
      expect(result.error).toContain('name is required');
    } finally {
      await server.stop();
    }
  });
});

// ─── uninstall_skill ────────────────────────────────────────────────────────

describe('uninstall_skill MCP tool', () => {
  it('uninstalls an installed skill', async () => {
    const mocks = createMinimalMocks();
    const server = new McpServer({
      socketPath: path.join(tempDir, 'test.sock'),
      ...mocks,
      skillStore,
      registryClient,
    });
    await server.start();

    try {
      // Install first
      await callTool(server, 'install_skill', { name: 'gmail' });
      expect(await skillStore.isInstalled('gmail')).toBe(true);

      // Uninstall
      const response = await callTool(server, 'uninstall_skill', { name: 'gmail' });
      const result = parseResult(response) as any;
      expect(result.uninstalled).toBe(true);
      expect(await skillStore.isInstalled('gmail')).toBe(false);
    } finally {
      await server.stop();
    }
  });

  it('fails for non-installed skill', async () => {
    const mocks = createMinimalMocks();
    const server = new McpServer({
      socketPath: path.join(tempDir, 'test.sock'),
      ...mocks,
      skillStore,
      registryClient,
    });
    await server.start();

    try {
      const response = await callTool(server, 'uninstall_skill', { name: 'nonexistent' });
      const result = parseResult(response) as any;
      expect(result.error).toBeDefined();
    } finally {
      await server.stop();
    }
  });
});

// ─── list_skills ────────────────────────────────────────────────────────────

describe('list_skills MCP tool', () => {
  it('lists installed, built-in, and available skills', async () => {
    const mocks = createMinimalMocks();
    const server = new McpServer({
      socketPath: path.join(tempDir, 'test.sock'),
      ...mocks,
      skillStore,
      registryClient,
    });
    await server.start();

    try {
      const response = await callTool(server, 'list_skills');
      const result = parseResult(response) as any;

      expect(result.installed).toEqual([]);
      expect(result.built_in).toHaveLength(2);
      expect(result.built_in[0].name).toBe('capabilities');
      expect(result.available).toHaveLength(3); // All 3 registry skills
    } finally {
      await server.stop();
    }
  });

  it('excludes installed skills from available', async () => {
    const mocks = createMinimalMocks();
    const server = new McpServer({
      socketPath: path.join(tempDir, 'test.sock'),
      ...mocks,
      skillStore,
      registryClient,
    });
    await server.start();

    try {
      // Install gmail
      await callTool(server, 'install_skill', { name: 'gmail' });

      const response = await callTool(server, 'list_skills');
      const result = parseResult(response) as any;

      expect(result.installed).toHaveLength(1);
      expect(result.installed[0].name).toBe('gmail');
      expect(result.available).toHaveLength(2); // browser + data-analysis
    } finally {
      await server.stop();
    }
  });
});

// ─── search_skills ──────────────────────────────────────────────────────────

describe('search_skills MCP tool', () => {
  it('searches registry by keyword', async () => {
    const mocks = createMinimalMocks();
    const server = new McpServer({
      socketPath: path.join(tempDir, 'test.sock'),
      ...mocks,
      skillStore,
      registryClient,
    });
    await server.start();

    try {
      const response = await callTool(server, 'search_skills', { query: 'gmail' });
      const result = parseResult(response) as any;

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('gmail');
      expect(result[0].installed).toBe(false);
    } finally {
      await server.stop();
    }
  });

  it('marks installed skills in results', async () => {
    const mocks = createMinimalMocks();
    const server = new McpServer({
      socketPath: path.join(tempDir, 'test.sock'),
      ...mocks,
      skillStore,
      registryClient,
    });
    await server.start();

    try {
      await callTool(server, 'install_skill', { name: 'gmail' });

      const response = await callTool(server, 'search_skills', { query: 'gmail' });
      const result = parseResult(response) as any;

      expect(result[0].installed).toBe(true);
    } finally {
      await server.stop();
    }
  });
});

// ─── update_config ──────────────────────────────────────────────────────────

describe('update_config MCP tool', () => {
  it('accepts an allowlisted field', async () => {
    const mocks = createMinimalMocks();
    const server = new McpServer({
      socketPath: path.join(tempDir, 'test.sock'),
      ...mocks,
      skillStore,
      registryClient,
    });
    await server.start();

    try {
      const response = await callTool(server, 'update_config', {
        field: 'channels.gmail.enabled',
        value: true,
      });
      const result = parseResult(response) as any;
      expect(result.updated).toBe(true);
      expect(result.field).toBe('channels.gmail.enabled');
    } finally {
      await server.stop();
    }
  });

  it('rejects blocked security fields', async () => {
    const mocks = createMinimalMocks();
    const server = new McpServer({
      socketPath: path.join(tempDir, 'test.sock'),
      ...mocks,
      skillStore,
      registryClient,
    });
    await server.start();

    try {
      const response = await callTool(server, 'update_config', {
        field: 'auth.apiKey',
        value: 'stolen-key',
      });
      const result = parseResult(response) as any;
      expect(result.error).toContain('cannot be modified via chat');
    } finally {
      await server.stop();
    }
  });

  it('rejects non-allowlisted fields', async () => {
    const mocks = createMinimalMocks();
    const server = new McpServer({
      socketPath: path.join(tempDir, 'test.sock'),
      ...mocks,
      skillStore,
      registryClient,
    });
    await server.start();

    try {
      const response = await callTool(server, 'update_config', {
        field: 'logLevel',
        value: 'debug',
      });
      const result = parseResult(response) as any;
      expect(result.error).toContain('not in the allowlist');
    } finally {
      await server.stop();
    }
  });

  it('blocks username changes', async () => {
    const mocks = createMinimalMocks();
    const server = new McpServer({
      socketPath: path.join(tempDir, 'test.sock'),
      ...mocks,
      skillStore,
      registryClient,
    });
    await server.start();

    try {
      const response = await callTool(server, 'update_config', {
        field: 'username',
        value: 'hacker',
      });
      const result = parseResult(response) as any;
      expect(result.error).toContain('cannot be modified');
    } finally {
      await server.stop();
    }
  });
});

// ─── get_auth_url ───────────────────────────────────────────────────────────

describe('get_auth_url MCP tool', () => {
  it('returns placeholder for unimplemented services', async () => {
    const mocks = createMinimalMocks();
    const server = new McpServer({
      socketPath: path.join(tempDir, 'test.sock'),
      ...mocks,
      skillStore,
      registryClient,
    });
    await server.start();

    try {
      const response = await callTool(server, 'get_auth_url', {
        service: 'google',
        scopes: ['gmail.readonly'],
      });
      const result = parseResult(response) as any;
      expect(result.service).toBe('google');
      expect(result.requires_cli).toBe(true);
    } finally {
      await server.stop();
    }
  });
});

// ─── get_system_status ──────────────────────────────────────────────────────

describe('get_system_status MCP tool', () => {
  it('returns system health data', async () => {
    const mocks = createMinimalMocks();
    const server = new McpServer({
      socketPath: path.join(tempDir, 'test.sock'),
      ...mocks,
      skillStore,
      registryClient,
    });
    await server.start();

    try {
      const response = await callTool(server, 'get_system_status');
      const result = parseResult(response) as any;

      expect(result.memory).toBeDefined();
      expect(result.profiles.total).toBe(1);
      expect(result.skills.installed_count).toBe(0);
      expect(result.skills.built_in_count).toBe(2);
      expect(result.mcp_server.listening).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it('reflects installed skill count', async () => {
    const mocks = createMinimalMocks();
    const server = new McpServer({
      socketPath: path.join(tempDir, 'test.sock'),
      ...mocks,
      skillStore,
      registryClient,
    });
    await server.start();

    try {
      await callTool(server, 'install_skill', { name: 'gmail' });

      const response = await callTool(server, 'get_system_status');
      const result = parseResult(response) as any;
      expect(result.skills.installed_count).toBe(1);
    } finally {
      await server.stop();
    }
  });
});

// ─── tools/list includes admin tools ────────────────────────────────────────

describe('MCP tools/list', () => {
  it('includes all 25 tools', async () => {
    const mocks = createMinimalMocks();
    const server = new McpServer({
      socketPath: path.join(tempDir, 'test.sock'),
      ...mocks,
      skillStore,
      registryClient,
    });
    await server.start();

    try {
      const response = await server.handleRequest(makeRequest('tools/list'));
      const tools = (response?.result as any)?.tools;
      expect(tools).toHaveLength(25);

      const toolNames = tools.map((t: any) => t.name);
      expect(toolNames).toContain('install_skill');
      expect(toolNames).toContain('uninstall_skill');
      expect(toolNames).toContain('list_skills');
      expect(toolNames).toContain('search_skills');
      expect(toolNames).toContain('update_config');
      expect(toolNames).toContain('get_auth_url');
      expect(toolNames).toContain('get_system_status');
      expect(toolNames).toContain('google_workspace');
    } finally {
      await server.stop();
    }
  });
});
