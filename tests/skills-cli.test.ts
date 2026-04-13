import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { SkillStore } from '../src/skills/store.js';
import { RegistryClient } from '../src/skills/registry.js';
import {
  installCommand,
  uninstallCommand,
  listCommand,
  searchCommand,
  infoCommand,
  updateCommand,
  dispatchCommand,
  setupTelegramCommand,
  type CliContext,
  type SetupContext,
} from '../src/admin/cli.js';

// ─── Test Helpers ───────────────────────────────────────────────────────────

let tempDir: string;
let skillStore: SkillStore;
let registryClient: RegistryClient;
let logs: string[];
let errors: string[];

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
          {
            name: 'SKILL.md',
            type: 'file',
            download_url: `https://raw.githubusercontent.com/test/SKILL.md`,
          },
        ],
      } as Response;
    }

    if (url.includes('raw.githubusercontent.com')) {
      // Extract skill name from the URL context (the last lookup determines which skill)
      const skillName = url.includes('gmail')
        ? 'gmail'
        : url.includes('browser')
          ? 'browser'
          : 'data-analysis';
      const version = mockRegistry.skills.find((s) => s.name === skillName)?.version ?? '1.0.0';
      return {
        ok: true,
        text: async () =>
          `---\nname: ${skillName}\ndescription: ${skillName} skill.\nversion: ${version}\n---\nInstructions for ${skillName}.`,
      } as Response;
    }

    return { ok: false, status: 404 } as Response;
  }) as typeof globalThis.fetch;
}

function ctx(): CliContext {
  return {
    skillStore,
    registryClient,
    log: (msg: string) => logs.push(msg),
    error: (msg: string) => errors.push(msg),
  };
}

async function createLocalSkill(
  name: string,
  version = '1.0.0',
  requires?: Record<string, string[]>,
): Promise<string> {
  const dir = path.join(tempDir, 'local', name);
  await fsp.mkdir(dir, { recursive: true });

  let requiresBlock = '';
  if (requires) {
    requiresBlock = 'requires:\n';
    for (const [k, v] of Object.entries(requires)) {
      requiresBlock += `  ${k}: [${v.join(', ')}]\n`;
    }
  }

  await fsp.writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} skill.\nversion: ${version}\n${requiresBlock}---\nInstructions.`,
    'utf-8',
  );
  return dir;
}

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'flowhelm-cli-test-'));
  const storeDir = path.join(tempDir, 'skills-store');
  skillStore = new SkillStore({ skillsDir: storeDir });
  await skillStore.init();
  registryClient = new RegistryClient({ fetchFn: createMockFetch() });
  logs = [];
  errors = [];
});

afterEach(async () => {
  await fsp.rm(tempDir, { recursive: true, force: true });
});

// ─── installCommand ─────────────────────────────────────────────────────────

describe('installCommand', () => {
  it('installs from a local directory', async () => {
    const dir = await createLocalSkill('my-skill');
    const result = await installCommand(dir, ctx());

    expect(result.success).toBe(true);
    expect(result.message).toContain('my-skill');
    expect(await skillStore.isInstalled('my-skill')).toBe(true);
  });

  it('installs from the registry', async () => {
    // We need a mock that returns a valid SKILL.md for the downloaded file
    const fetchFn = (async (input: string | URL | Request) => {
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
            '---\nname: gmail\ndescription: Gmail integration.\nversion: 1.0.0\n---\nGmail instructions.',
        } as Response;
      }
      return { ok: false, status: 404 } as Response;
    }) as typeof globalThis.fetch;

    const client = new RegistryClient({ fetchFn });
    const result = await installCommand('gmail', {
      ...ctx(),
      registryClient: client,
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain('gmail');
    expect(await skillStore.isInstalled('gmail')).toBe(true);
  });

  it('fails for missing SKILL.md in local path', async () => {
    const emptyDir = path.join(tempDir, 'empty');
    await fsp.mkdir(emptyDir, { recursive: true });

    const result = await installCommand(emptyDir, ctx());
    expect(result.success).toBe(false);
    expect(result.message).toContain('No SKILL.md');
  });

  it('rejects git URL install (not yet implemented)', async () => {
    const result = await installCommand('https://github.com/user/skill.git', ctx());
    expect(result.success).toBe(false);
    expect(result.message).toContain('not yet supported');
  });

  it('shows soft requirement warnings', async () => {
    const dir = await createLocalSkill('needs-stuff', '1.0.0', {
      channels: ['gmail'],
      bins: ['gws'],
    });

    await installCommand(dir, ctx());

    // Should still install despite warnings
    expect(await skillStore.isInstalled('needs-stuff')).toBe(true);
    expect(logs.some((l) => l.includes('Requirements not yet met'))).toBe(true);
  });
});

// ─── uninstallCommand ───────────────────────────────────────────────────────

describe('uninstallCommand', () => {
  it('uninstalls an installed skill', async () => {
    const dir = await createLocalSkill('removable');
    await skillStore.install(dir, { source: 'local' });

    const result = await uninstallCommand('removable', ctx());
    expect(result.success).toBe(true);
    expect(await skillStore.isInstalled('removable')).toBe(false);
  });

  it('fails for non-installed skill', async () => {
    const result = await uninstallCommand('nonexistent', ctx());
    expect(result.success).toBe(false);
    expect(result.message).toContain('not installed');
  });

  it('blocks removal when dependents exist', async () => {
    const base = await createLocalSkill('base');
    await skillStore.install(base, { source: 'local' });

    const dependent = await createLocalSkill('dependent', '1.0.0', {
      skills: ['base'],
    });
    await skillStore.install(dependent, { source: 'local' });

    const result = await uninstallCommand('base', ctx());
    expect(result.success).toBe(false);
    expect(result.message).toContain('required by');
  });
});

// ─── listCommand ────────────────────────────────────────────────────────────

describe('listCommand', () => {
  it('shows message when no skills installed', async () => {
    const result = await listCommand(ctx());
    expect(result.success).toBe(true);
    expect(logs.some((l) => l.includes('No skills installed'))).toBe(true);
    expect(logs.some((l) => l.includes('capabilities'))).toBe(true);
    expect(logs.some((l) => l.includes('status'))).toBe(true);
  });

  it('lists installed skills', async () => {
    const dir = await createLocalSkill('my-skill');
    await skillStore.install(dir, { source: 'local' });

    const result = await listCommand(ctx());
    expect(result.success).toBe(true);
    expect(logs.some((l) => l.includes('my-skill'))).toBe(true);
  });
});

// ─── searchCommand ──────────────────────────────────────────────────────────

describe('searchCommand', () => {
  it('returns matching skills', async () => {
    const result = await searchCommand('gmail', ctx());
    expect(result.success).toBe(true);
    expect(logs.some((l) => l.includes('gmail'))).toBe(true);
  });

  it('marks installed skills', async () => {
    // Install gmail first
    const dir = await createLocalSkill('gmail');
    await skillStore.install(dir, { source: 'local' });

    const result = await searchCommand('gmail', ctx());
    expect(result.success).toBe(true);
    expect(logs.some((l) => l.includes('[installed]'))).toBe(true);
  });

  it('returns empty for no matches', async () => {
    const result = await searchCommand('nonexistent-xyz', ctx());
    expect(result.success).toBe(true);
    expect(logs.some((l) => l.includes('No skills found'))).toBe(true);
  });
});

// ─── infoCommand ────────────────────────────────────────────────────────────

describe('infoCommand', () => {
  it('shows info for installed skill', async () => {
    const dir = await createLocalSkill('my-skill', '2.0.0');
    await skillStore.install(dir, { source: 'local' });

    const result = await infoCommand('my-skill', ctx());
    expect(result.success).toBe(true);
    expect(logs.some((l) => l.includes('[installed]'))).toBe(true);
    expect(logs.some((l) => l.includes('2.0.0'))).toBe(true);
  });

  it('shows info for registry skill', async () => {
    const result = await infoCommand('gmail', ctx());
    expect(result.success).toBe(true);
    expect(logs.some((l) => l.includes('[not installed]'))).toBe(true);
  });

  it('fails for unknown skill', async () => {
    const result = await infoCommand('nonexistent-xyz', ctx());
    expect(result.success).toBe(false);
    expect(result.message).toContain('not found');
  });
});

// ─── updateCommand ──────────────────────────────────────────────────────────

describe('updateCommand', () => {
  it('reports when no registry skills installed', async () => {
    const result = await updateCommand(undefined, ctx());
    expect(result.success).toBe(true);
    expect(logs.some((l) => l.includes('No registry-installed'))).toBe(true);
  });

  it('reports up-to-date when versions match', async () => {
    // Install gmail v1.0.0 (same as registry)
    const dir = await createLocalSkill('gmail', '1.0.0');
    await skillStore.install(dir, { source: 'registry' });

    const result = await updateCommand('gmail', ctx());
    expect(result.success).toBe(true);
    expect(logs.some((l) => l.includes('up to date'))).toBe(true);
  });

  it('fails for non-installed specific skill', async () => {
    const result = await updateCommand('nonexistent', ctx());
    expect(result.success).toBe(false);
    expect(result.message).toContain('not installed');
  });
});

// ─── dispatchCommand ────────────────────────────────────────────────────────

describe('dispatchCommand', () => {
  it('dispatches install command', async () => {
    const dir = await createLocalSkill('dispatch-test');
    const result = await dispatchCommand(['install', dir], ctx());
    expect(result.success).toBe(true);
  });

  it('dispatches list command', async () => {
    const result = await dispatchCommand(['list'], ctx());
    expect(result.success).toBe(true);
  });

  it('errors on missing skill name for install', async () => {
    const result = await dispatchCommand(['install'], ctx());
    expect(result.success).toBe(false);
  });

  it('errors on unknown command', async () => {
    const result = await dispatchCommand(['unknown'], ctx());
    expect(result.success).toBe(false);
    expect(errors.some((l) => l.includes('Unknown command'))).toBe(true);
  });

  it('errors on empty args', async () => {
    const result = await dispatchCommand([], ctx());
    expect(result.success).toBe(false);
  });

  it('dispatches setup telegram', async () => {
    const configDir = path.join(tempDir, 'setup-dispatch');
    // Patch HOME so dispatchSetupCommand resolves configDir correctly
    const origHome = process.env['HOME'];
    process.env['HOME'] = tempDir;
    const result = await dispatchCommand(['setup', 'telegram', '--bot-token', '123:ABC'], ctx());
    process.env['HOME'] = origHome;
    expect(result.success).toBe(true);
    expect(result.message).toContain('Telegram channel configured');
  });

  it('errors on unknown setup target', async () => {
    const result = await dispatchCommand(['setup', 'unknown'], ctx());
    expect(result.success).toBe(false);
    expect(errors.some((l) => l.includes('Unknown setup target'))).toBe(true);
  });

  it('errors on setup telegram without --bot-token', async () => {
    const result = await dispatchCommand(['setup', 'telegram'], ctx());
    expect(result.success).toBe(false);
    expect(errors.some((l) => l.includes('--bot-token'))).toBe(true);
  });
});

// ─── setupTelegramCommand ──────────────────────────────────────────────────

describe('setupTelegramCommand', () => {
  function setupCtx(overrides: Partial<SetupContext> = {}): SetupContext {
    return {
      configDir: path.join(tempDir, 'setup-config'),
      skillStore,
      registryClient,
      log: (msg: string) => logs.push(msg),
      error: (msg: string) => errors.push(msg),
      ...overrides,
    };
  }

  it('writes telegram config to config.yaml', async () => {
    const sctx = setupCtx();
    const result = await setupTelegramCommand(
      { botToken: '123:ABC-DEF', allowedUsers: [111, 222] },
      sctx,
    );

    expect(result.success).toBe(true);
    const configPath = path.join(sctx.configDir, 'config.yaml');
    const content = await fsp.readFile(configPath, 'utf-8');
    expect(content).toContain('123:ABC-DEF');
    expect(content).toContain('111');
    expect(content).toContain('222');
  });

  it('creates config directory if missing', async () => {
    const sctx = setupCtx({
      configDir: path.join(tempDir, 'new-dir', 'nested'),
    });
    const result = await setupTelegramCommand({ botToken: '123:TOKEN' }, sctx);

    expect(result.success).toBe(true);
    const configPath = path.join(sctx.configDir, 'config.yaml');
    const stat = await fsp.stat(configPath);
    expect(stat.isFile()).toBe(true);
  });

  it('preserves existing config fields when adding telegram', async () => {
    const sctx = setupCtx();
    // Write existing config
    await fsp.mkdir(sctx.configDir, { recursive: true });
    await fsp.writeFile(
      path.join(sctx.configDir, 'config.yaml'),
      'username: stan\nlogLevel: debug\n',
      'utf-8',
    );

    await setupTelegramCommand({ botToken: '123:TOKEN' }, sctx);

    const content = await fsp.readFile(path.join(sctx.configDir, 'config.yaml'), 'utf-8');
    expect(content).toContain('username: stan');
    expect(content).toContain('logLevel: debug');
    expect(content).toContain('123:TOKEN');
  });

  it('defaults allowedUsers to empty array', async () => {
    const sctx = setupCtx();
    await setupTelegramCommand({ botToken: '123:TOKEN' }, sctx);

    const content = await fsp.readFile(path.join(sctx.configDir, 'config.yaml'), 'utf-8');
    expect(content).toContain('allowedUsers: []');
  });

  it('recommends skill install when not installed', async () => {
    const sctx = setupCtx();
    await setupTelegramCommand({ botToken: '123:TOKEN' }, sctx);

    expect(logs.some((l) => l.includes('flowhelm install telegram'))).toBe(true);
    expect(logs.some((l) => l.includes('Recommended'))).toBe(true);
  });

  it('skips recommendation when skill already installed', async () => {
    // Install telegram skill first
    const dir = await createLocalSkill('telegram');
    await skillStore.install(dir, { source: 'local' });

    const sctx = setupCtx();
    await setupTelegramCommand({ botToken: '123:TOKEN' }, sctx);

    expect(logs.some((l) => l.includes('already installed'))).toBe(true);
    expect(logs.some((l) => l.includes('Recommended'))).toBe(false);
  });
});
