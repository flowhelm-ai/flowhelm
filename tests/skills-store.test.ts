import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { SkillStore, parseFrontmatter } from '../src/skills/store.js';
import { RegistryClient } from '../src/skills/registry.js';
import {
  skillFrontmatterSchema,
  installedManifestSchema,
  registryIndexSchema,
  registrySkillEntrySchema,
} from '../src/config/schema.js';

// ─── Test Helpers ───────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'flowhelm-skills-test-'));
});

afterEach(async () => {
  await fsp.rm(tempDir, { recursive: true, force: true });
});

async function createSkillDir(
  baseDir: string,
  name: string,
  frontmatter: Record<string, unknown>,
  body = 'Test skill instructions.',
): Promise<string> {
  const skillDir = path.join(baseDir, name);
  await fsp.mkdir(skillDir, { recursive: true });

  const requires = frontmatter['requires'] as Record<string, unknown> | undefined;
  let requiresBlock = '';
  if (requires) {
    requiresBlock = 'requires:\n';
    for (const [k, v] of Object.entries(requires)) {
      if (Array.isArray(v)) {
        requiresBlock += `  ${k}: [${v.join(', ')}]\n`;
      }
    }
  }

  const content = [
    '---',
    `name: ${String(frontmatter['name'])}`,
    `description: ${String(frontmatter['description'])}`,
    `version: ${String(frontmatter['version'])}`,
    requiresBlock.trim(),
    '---',
    '',
    body,
  ]
    .filter(Boolean)
    .join('\n');

  await fsp.writeFile(path.join(skillDir, 'SKILL.md'), content, 'utf-8');
  return skillDir;
}

// ─── parseFrontmatter ───────────────────────────────────────────────────────

describe('parseFrontmatter', () => {
  it('parses basic frontmatter with scalars', () => {
    const content = `---
name: test-skill
description: A test skill.
version: 1.0.0
---

Body content here.`;

    const { data, body } = parseFrontmatter(content);
    expect(data['name']).toBe('test-skill');
    expect(data['description']).toBe('A test skill.');
    expect(data['version']).toBe('1.0.0');
    expect(body.trim()).toBe('Body content here.');
  });

  it('parses flow arrays', () => {
    const content = `---
name: gmail
description: Gmail skill.
version: 1.0.0
requires:
  channels: [gmail, calendar]
  bins: [gws]
  env: [GOOGLE_OAUTH_TOKEN]
  skills: []
  os: [linux, macos]
---

Instructions.`;

    const { data } = parseFrontmatter(content);
    const requires = data['requires'] as Record<string, unknown>;
    expect(requires['channels']).toEqual(['gmail', 'calendar']);
    expect(requires['bins']).toEqual(['gws']);
    expect(requires['env']).toEqual(['GOOGLE_OAUTH_TOKEN']);
    expect(requires['skills']).toEqual([]);
    expect(requires['os']).toEqual(['linux', 'macos']);
  });

  it('returns empty data when no frontmatter present', () => {
    const content = 'Just a body without frontmatter.';
    const { data, body } = parseFrontmatter(content);
    expect(data).toEqual({});
    expect(body).toBe(content);
  });

  it('handles empty body after frontmatter', () => {
    const content = `---
name: minimal
description: Minimal.
version: 0.1.0
---
`;
    const { data, body } = parseFrontmatter(content);
    expect(data['name']).toBe('minimal');
    expect(body.trim()).toBe('');
  });

  it('handles quoted strings', () => {
    const content = `---
name: test
description: "A quoted description"
version: 1.0.0
---
`;
    const { data } = parseFrontmatter(content);
    expect(data['description']).toBe('A quoted description');
  });

  it('skips comment lines', () => {
    const content = `---
# This is a comment
name: test
description: Test.
version: 1.0.0
---
`;
    const { data } = parseFrontmatter(content);
    expect(data['name']).toBe('test');
  });
});

// ─── Zod Schema Validation ─────────────────────────────────────────────────

describe('skillFrontmatterSchema', () => {
  it('validates valid frontmatter', () => {
    const result = skillFrontmatterSchema.parse({
      name: 'gmail',
      description: 'Gmail skill.',
      version: '1.0.0',
      requires: {
        channels: ['gmail'],
        bins: ['gws'],
        env: [],
        skills: [],
        os: ['linux'],
      },
    });
    expect(result.name).toBe('gmail');
    expect(result.requires.channels).toEqual(['gmail']);
  });

  it('defaults requires to empty when omitted', () => {
    const result = skillFrontmatterSchema.parse({
      name: 'simple',
      description: 'Simple skill.',
      version: '1.0.0',
    });
    expect(result.requires.channels).toEqual([]);
    expect(result.requires.bins).toEqual([]);
    expect(result.requires.env).toEqual([]);
    expect(result.requires.skills).toEqual([]);
    expect(result.requires.os).toEqual([]);
  });

  it('rejects invalid skill names', () => {
    expect(() =>
      skillFrontmatterSchema.parse({
        name: 'Invalid Name',
        description: 'Bad.',
        version: '1.0.0',
      }),
    ).toThrow();
  });

  it('rejects names starting with a digit', () => {
    expect(() =>
      skillFrontmatterSchema.parse({
        name: '123skill',
        description: 'Bad.',
        version: '1.0.0',
      }),
    ).toThrow();
  });

  it('rejects invalid versions', () => {
    expect(() =>
      skillFrontmatterSchema.parse({
        name: 'test',
        description: 'Bad.',
        version: 'v1.0',
      }),
    ).toThrow();
  });

  it('rejects empty description', () => {
    expect(() =>
      skillFrontmatterSchema.parse({
        name: 'test',
        description: '',
        version: '1.0.0',
      }),
    ).toThrow();
  });

  it('rejects invalid OS values', () => {
    expect(() =>
      skillFrontmatterSchema.parse({
        name: 'test',
        description: 'Test.',
        version: '1.0.0',
        requires: { os: ['windows'] },
      }),
    ).toThrow();
  });
});

describe('installedManifestSchema', () => {
  it('validates a valid manifest', () => {
    const result = installedManifestSchema.parse([
      {
        name: 'gmail',
        version: '1.0.0',
        source: 'registry',
        installedAt: '2026-04-07T12:00:00Z',
        requires: { channels: ['gmail'], bins: [], env: [], skills: [], os: [] },
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('gmail');
  });

  it('validates empty manifest', () => {
    const result = installedManifestSchema.parse([]);
    expect(result).toEqual([]);
  });
});

describe('registryIndexSchema', () => {
  it('validates a valid registry index', () => {
    const result = registryIndexSchema.parse({
      version: 1,
      skills: [{ name: 'gmail', description: 'Gmail.', version: '1.0.0', path: 'skills/gmail' }],
    });
    expect(result.version).toBe(1);
    expect(result.skills).toHaveLength(1);
  });

  it('validates registry entry with sha256', () => {
    const hash = 'a'.repeat(64);
    const result = registrySkillEntrySchema.parse({
      name: 'test',
      description: 'Test.',
      version: '1.0.0',
      path: 'skills/test',
      sha256: hash,
    });
    expect(result.sha256).toBe(hash);
  });

  it('accepts registry entry without sha256', () => {
    const result = registrySkillEntrySchema.parse({
      name: 'test',
      description: 'Test.',
      version: '1.0.0',
      path: 'skills/test',
    });
    expect(result.sha256).toBeUndefined();
  });

  it('rejects invalid sha256 format', () => {
    expect(() =>
      registrySkillEntrySchema.parse({
        name: 'test',
        description: 'Test.',
        version: '1.0.0',
        path: 'skills/test',
        sha256: 'not-a-valid-hash',
      }),
    ).toThrow();
  });

  it('rejects sha256 with wrong length', () => {
    expect(() =>
      registrySkillEntrySchema.parse({
        name: 'test',
        description: 'Test.',
        version: '1.0.0',
        path: 'skills/test',
        sha256: 'abcdef1234', // too short
      }),
    ).toThrow();
  });
});

// ─── SkillStore ─────────────────────────────────────────────────────────────

describe('SkillStore', () => {
  let store: SkillStore;
  let sourceDir: string;

  beforeEach(async () => {
    const storeDir = path.join(tempDir, 'store');
    store = new SkillStore({ skillsDir: storeDir });
    await store.init();
    sourceDir = path.join(tempDir, 'source');
    await fsp.mkdir(sourceDir, { recursive: true });
  });

  it('initializes with empty manifest', async () => {
    const manifest = await store.readManifest();
    expect(manifest).toEqual([]);
  });

  it('lists installed skills (empty initially)', async () => {
    const skills = await store.list();
    expect(skills).toEqual([]);
  });

  it('installs a skill from a source directory', async () => {
    const skillDir = await createSkillDir(sourceDir, 'test-skill', {
      name: 'test-skill',
      description: 'A test skill.',
      version: '1.0.0',
    });

    const entry = await store.install(skillDir, { source: 'local' });
    expect(entry.name).toBe('test-skill');
    expect(entry.version).toBe('1.0.0');
    expect(entry.source).toBe('local');

    // Verify manifest updated
    const manifest = await store.readManifest();
    expect(manifest).toHaveLength(1);
    expect(manifest[0].name).toBe('test-skill');

    // Verify skill directory was copied
    const installedSkillMd = path.join(store.getSkillDir('test-skill'), 'SKILL.md');
    expect(fs.existsSync(installedSkillMd)).toBe(true);
  });

  it('installs a skill with supporting files', async () => {
    const skillDir = await createSkillDir(sourceDir, 'with-files', {
      name: 'with-files',
      description: 'Skill with extra files.',
      version: '1.0.0',
    });

    // Add supporting files
    const scriptsDir = path.join(skillDir, 'scripts');
    await fsp.mkdir(scriptsDir, { recursive: true });
    await fsp.writeFile(path.join(scriptsDir, 'helper.sh'), '#!/bin/bash\necho hi', 'utf-8');

    await store.install(skillDir, { source: 'local' });

    // Verify supporting files were copied
    const installedScript = path.join(store.getSkillDir('with-files'), 'scripts', 'helper.sh');
    expect(fs.existsSync(installedScript)).toBe(true);
  });

  it('overwrites existing skill on reinstall', async () => {
    const skillDir = await createSkillDir(sourceDir, 'upgradable', {
      name: 'upgradable',
      description: 'Version 1.',
      version: '1.0.0',
    });

    await store.install(skillDir, { source: 'registry' });

    // Reinstall with new version
    const skillDirV2 = await createSkillDir(sourceDir, 'upgradable-v2', {
      name: 'upgradable',
      description: 'Version 2.',
      version: '2.0.0',
    });

    const entry = await store.install(skillDirV2, { source: 'registry' });
    expect(entry.version).toBe('2.0.0');

    const manifest = await store.readManifest();
    expect(manifest).toHaveLength(1);
    expect(manifest[0].version).toBe('2.0.0');
  });

  it('checks if a skill is installed', async () => {
    expect(await store.isInstalled('test-skill')).toBe(false);

    const skillDir = await createSkillDir(sourceDir, 'test-skill', {
      name: 'test-skill',
      description: 'Test.',
      version: '1.0.0',
    });
    await store.install(skillDir, { source: 'local' });

    expect(await store.isInstalled('test-skill')).toBe(true);
  });

  it('gets a specific installed skill', async () => {
    const skillDir = await createSkillDir(sourceDir, 'get-test', {
      name: 'get-test',
      description: 'Test.',
      version: '1.0.0',
    });
    await store.install(skillDir, { source: 'local' });

    const entry = await store.get('get-test');
    expect(entry).not.toBeNull();
    expect(entry!.name).toBe('get-test');

    expect(await store.get('nonexistent')).toBeNull();
  });

  it('removes an installed skill', async () => {
    const skillDir = await createSkillDir(sourceDir, 'removable', {
      name: 'removable',
      description: 'To be removed.',
      version: '1.0.0',
    });
    await store.install(skillDir, { source: 'local' });
    expect(await store.isInstalled('removable')).toBe(true);

    await store.remove('removable');

    expect(await store.isInstalled('removable')).toBe(false);
    expect(fs.existsSync(store.getSkillDir('removable'))).toBe(false);
  });

  it('throws when removing a non-installed skill', async () => {
    await expect(store.remove('nonexistent')).rejects.toThrow('not installed');
  });

  it('blocks removal if other skills depend on it', async () => {
    // Install dependency
    const depDir = await createSkillDir(sourceDir, 'base-skill', {
      name: 'base-skill',
      description: 'Base.',
      version: '1.0.0',
    });
    await store.install(depDir, { source: 'local' });

    // Install dependent
    const depentDir = await createSkillDir(sourceDir, 'dependent', {
      name: 'dependent',
      description: 'Depends on base.',
      version: '1.0.0',
      requires: { skills: ['base-skill'] },
    });
    await store.install(depentDir, { source: 'local' });

    await expect(store.remove('base-skill')).rejects.toThrow('required by dependent');
  });

  it('blocks installation with missing skill dependencies', async () => {
    const skillDir = await createSkillDir(sourceDir, 'needs-dep', {
      name: 'needs-dep',
      description: 'Needs missing dep.',
      version: '1.0.0',
      requires: { skills: ['nonexistent-dep'] },
    });

    await expect(store.install(skillDir, { source: 'local' })).rejects.toThrow(
      'Missing required skills',
    );
  });

  it('allows installation when skill dependencies are met', async () => {
    // Install the dependency first
    const depDir = await createSkillDir(sourceDir, 'dep', {
      name: 'dep',
      description: 'Dependency.',
      version: '1.0.0',
    });
    await store.install(depDir, { source: 'local' });

    // Now install the dependent skill
    const skillDir = await createSkillDir(sourceDir, 'has-dep', {
      name: 'has-dep',
      description: 'Has dep.',
      version: '1.0.0',
      requires: { skills: ['dep'] },
    });
    const entry = await store.install(skillDir, { source: 'local' });
    expect(entry.name).toBe('has-dep');
  });

  it('throws on invalid SKILL.md frontmatter', async () => {
    const badDir = path.join(sourceDir, 'bad-skill');
    await fsp.mkdir(badDir, { recursive: true });
    await fsp.writeFile(path.join(badDir, 'SKILL.md'), '---\nname: BAD NAME\n---\nBad.', 'utf-8');

    await expect(store.install(badDir, { source: 'local' })).rejects.toThrow();
  });

  it('throws when SKILL.md is missing', async () => {
    const emptyDir = path.join(sourceDir, 'empty');
    await fsp.mkdir(emptyDir, { recursive: true });

    await expect(store.install(emptyDir, { source: 'local' })).rejects.toThrow();
  });

  it('reads SKILL.md from a directory', async () => {
    const skillDir = await createSkillDir(sourceDir, 'readable', {
      name: 'readable',
      description: 'Read test.',
      version: '2.0.0',
    });

    const fm = await store.readSkillMd(skillDir);
    expect(fm.name).toBe('readable');
    expect(fm.version).toBe('2.0.0');
  });

  it('returns installed skill directories for container sync', async () => {
    const s1 = await createSkillDir(sourceDir, 'skill-a', {
      name: 'skill-a',
      description: 'A.',
      version: '1.0.0',
    });
    const s2 = await createSkillDir(sourceDir, 'skill-b', {
      name: 'skill-b',
      description: 'B.',
      version: '1.0.0',
    });
    await store.install(s1, { source: 'local' });
    await store.install(s2, { source: 'local' });

    const dirs = await store.getInstalledSkillDirs();
    expect(dirs).toHaveLength(2);
    expect(dirs.map((d) => d.name).sort()).toEqual(['skill-a', 'skill-b']);
  });
});

// ─── SkillStore.checkSoftRequirements ────────────────────────────────────────

describe('SkillStore.checkSoftRequirements', () => {
  let store: SkillStore;

  beforeEach(async () => {
    store = new SkillStore({ skillsDir: path.join(tempDir, 'store') });
    await store.init();
  });

  it('returns no warnings when all requirements met', () => {
    const fm = skillFrontmatterSchema.parse({
      name: 'test',
      description: 'Test.',
      version: '1.0.0',
      requires: {
        channels: ['gmail'],
        bins: ['gws'],
        env: ['TOKEN'],
      },
    });

    const warnings = store.checkSoftRequirements(fm, {
      channels: ['gmail', 'telegram'],
      bins: ['gws', 'ffmpeg'],
      env: ['TOKEN', 'OTHER'],
    });
    expect(warnings).toEqual([]);
  });

  it('returns warnings for missing channels', () => {
    const fm = skillFrontmatterSchema.parse({
      name: 'test',
      description: 'Test.',
      version: '1.0.0',
      requires: { channels: ['gmail', 'calendar'] },
    });

    const warnings = store.checkSoftRequirements(fm, { channels: ['gmail'] });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].field).toBe('channels');
    expect(warnings[0].missing).toEqual(['calendar']);
  });

  it('returns warnings for missing binaries', () => {
    const fm = skillFrontmatterSchema.parse({
      name: 'test',
      description: 'Test.',
      version: '1.0.0',
      requires: { bins: ['gws'] },
    });

    const warnings = store.checkSoftRequirements(fm, { bins: [] });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].field).toBe('bins');
    expect(warnings[0].missing).toEqual(['gws']);
  });

  it('returns warnings for missing env vars', () => {
    const fm = skillFrontmatterSchema.parse({
      name: 'test',
      description: 'Test.',
      version: '1.0.0',
      requires: { env: ['API_KEY'] },
    });

    const warnings = store.checkSoftRequirements(fm);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].field).toBe('env');
  });

  it('returns no warnings for a skill with no requirements', () => {
    const fm = skillFrontmatterSchema.parse({
      name: 'simple',
      description: 'No reqs.',
      version: '1.0.0',
    });

    const warnings = store.checkSoftRequirements(fm);
    expect(warnings).toEqual([]);
  });
});

// ─── RegistryClient ─────────────────────────────────────────────────────────

describe('RegistryClient', () => {
  const mockRegistry = {
    version: 1,
    skills: [
      { name: 'gmail', description: 'Gmail integration.', version: '1.0.0', path: 'skills/gmail' },
      {
        name: 'data-analysis',
        description: 'Analyze CSV data files.',
        version: '2.0.0',
        path: 'skills/data-analysis',
      },
      { name: 'browser', description: 'Web browsing.', version: '1.0.0', path: 'skills/browser' },
    ],
  };

  function createMockFetch(responses?: Record<string, unknown>): typeof globalThis.fetch {
    return (async (input: string | URL | Request) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes('registry.json')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => mockRegistry,
        } as Response;
      }

      // GitHub API contents response
      if (url.includes('api.github.com/repos') && url.includes('/contents/')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () =>
            responses?.['contents'] ?? [
              {
                name: 'SKILL.md',
                type: 'file',
                download_url: 'https://raw.githubusercontent.com/test/SKILL.md',
              },
            ],
        } as Response;
      }

      // Raw file download
      if (url.includes('raw.githubusercontent.com')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          text: async () =>
            '---\nname: gmail\ndescription: Gmail.\nversion: 1.0.0\n---\nInstructions.',
        } as Response;
      }

      return { ok: false, status: 404, statusText: 'Not Found' } as Response;
    }) as typeof globalThis.fetch;
  }

  it('fetches and caches the registry index', async () => {
    let fetchCount = 0;
    const fetchFn = (async (input: string | URL | Request) => {
      fetchCount++;
      return createMockFetch()(input);
    }) as typeof globalThis.fetch;

    const client = new RegistryClient({ fetchFn, cacheTtlMs: 60_000 });

    const index1 = await client.getIndex();
    expect(index1.skills).toHaveLength(3);
    expect(fetchCount).toBe(1);

    // Second call should use cache
    const index2 = await client.getIndex();
    expect(index2.skills).toHaveLength(3);
    expect(fetchCount).toBe(1);
  });

  it('re-fetches after cache TTL expires', async () => {
    let fetchCount = 0;
    const fetchFn = (async (input: string | URL | Request) => {
      fetchCount++;
      return createMockFetch()(input);
    }) as typeof globalThis.fetch;

    const client = new RegistryClient({ fetchFn, cacheTtlMs: 1 }); // 1ms TTL

    await client.getIndex();
    expect(fetchCount).toBe(1);

    // Wait for cache to expire
    await new Promise((r) => setTimeout(r, 10));

    await client.getIndex();
    expect(fetchCount).toBe(2);
  });

  it('looks up a skill by name', async () => {
    const client = new RegistryClient({ fetchFn: createMockFetch() });
    const entry = await client.lookup('gmail');
    expect(entry).not.toBeNull();
    expect(entry!.name).toBe('gmail');
    expect(entry!.path).toBe('skills/gmail');
  });

  it('returns null for unknown skill', async () => {
    const client = new RegistryClient({ fetchFn: createMockFetch() });
    const entry = await client.lookup('nonexistent');
    expect(entry).toBeNull();
  });

  it('searches skills by name keyword', async () => {
    const client = new RegistryClient({ fetchFn: createMockFetch() });
    const results = await client.search('gmail');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('gmail');
  });

  it('searches skills by description keyword', async () => {
    const client = new RegistryClient({ fetchFn: createMockFetch() });
    const results = await client.search('csv');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('data-analysis');
  });

  it('search is case-insensitive', async () => {
    const client = new RegistryClient({ fetchFn: createMockFetch() });
    const results = await client.search('GMAIL');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('gmail');
  });

  it('returns empty array for no matches', async () => {
    const client = new RegistryClient({ fetchFn: createMockFetch() });
    const results = await client.search('nonexistent-skill-xyz');
    expect(results).toEqual([]);
  });

  it('downloads a skill to a temp directory', async () => {
    const client = new RegistryClient({ fetchFn: createMockFetch() });
    const downloadDir = await client.download('gmail');

    try {
      const skillMd = path.join(downloadDir, 'SKILL.md');
      expect(fs.existsSync(skillMd)).toBe(true);
      const content = await fsp.readFile(skillMd, 'utf-8');
      expect(content).toContain('gmail');
    } finally {
      await fsp.rm(downloadDir, { recursive: true, force: true });
    }
  });

  it('throws when downloading a non-existent skill', async () => {
    const client = new RegistryClient({ fetchFn: createMockFetch() });
    await expect(client.download('nonexistent')).rejects.toThrow('not found in registry');
  });

  it('throws on failed registry fetch', async () => {
    const failFetch = (async () => ({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    })) as typeof globalThis.fetch;

    const client = new RegistryClient({ fetchFn: failFetch });
    await expect(client.getIndex()).rejects.toThrow('Failed to fetch registry');
  });

  it('clears cache explicitly', async () => {
    let fetchCount = 0;
    const fetchFn = (async (input: string | URL | Request) => {
      fetchCount++;
      return createMockFetch()(input);
    }) as typeof globalThis.fetch;

    const client = new RegistryClient({ fetchFn, cacheTtlMs: 60_000 });

    await client.getIndex();
    expect(fetchCount).toBe(1);

    client.clearCache();

    await client.getIndex();
    expect(fetchCount).toBe(2);
  });
});

// ─── SHA-256 Integrity Verification ─────────────────────────────────────────

describe('RegistryClient sha256 verification', () => {
  const skillMdContent =
    '---\nname: gmail\ndescription: Gmail.\nversion: 1.0.0\n---\nInstructions.';
  const correctHash = createHash('sha256').update(skillMdContent).digest('hex');

  function createSha256MockFetch(sha256: string): typeof globalThis.fetch {
    const registry = {
      version: 1,
      skills: [
        { name: 'gmail', description: 'Gmail.', version: '1.0.0', path: 'skills/gmail', sha256 },
      ],
    };

    return (async (input: string | URL | Request) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes('registry.json')) {
        return { ok: true, json: async () => registry } as Response;
      }
      if (url.includes('api.github.com/repos') && url.includes('/contents/')) {
        return {
          ok: true,
          json: async () => [
            {
              name: 'SKILL.md',
              type: 'file',
              download_url: 'https://raw.githubusercontent.com/test/SKILL.md',
            },
          ],
        } as Response;
      }
      if (url.includes('raw.githubusercontent.com')) {
        return { ok: true, text: async () => skillMdContent } as Response;
      }
      return { ok: false, status: 404 } as Response;
    }) as typeof globalThis.fetch;
  }

  it('passes download when sha256 matches', async () => {
    const client = new RegistryClient({ fetchFn: createSha256MockFetch(correctHash) });
    const downloadDir = await client.download('gmail');
    try {
      expect(fs.existsSync(path.join(downloadDir, 'SKILL.md'))).toBe(true);
    } finally {
      await fsp.rm(downloadDir, { recursive: true, force: true });
    }
  });

  it('rejects download when sha256 does not match', async () => {
    const wrongHash = 'b'.repeat(64);
    const client = new RegistryClient({ fetchFn: createSha256MockFetch(wrongHash) });
    await expect(client.download('gmail')).rejects.toThrow('Integrity check failed');
  });

  it('skips verification when sha256 is absent', async () => {
    const registry = {
      version: 1,
      skills: [{ name: 'gmail', description: 'Gmail.', version: '1.0.0', path: 'skills/gmail' }],
    };
    const fetchFn = (async (input: string | URL | Request) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('registry.json')) {
        return { ok: true, json: async () => registry } as Response;
      }
      if (url.includes('api.github.com/repos') && url.includes('/contents/')) {
        return {
          ok: true,
          json: async () => [
            {
              name: 'SKILL.md',
              type: 'file',
              download_url: 'https://raw.githubusercontent.com/test/SKILL.md',
            },
          ],
        } as Response;
      }
      if (url.includes('raw.githubusercontent.com')) {
        return { ok: true, text: async () => skillMdContent } as Response;
      }
      return { ok: false, status: 404 } as Response;
    }) as typeof globalThis.fetch;

    const client = new RegistryClient({ fetchFn });
    const downloadDir = await client.download('gmail');
    try {
      expect(fs.existsSync(path.join(downloadDir, 'SKILL.md'))).toBe(true);
    } finally {
      await fsp.rm(downloadDir, { recursive: true, force: true });
    }
  });
});
