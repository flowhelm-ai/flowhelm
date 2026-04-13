/**
 * Registry client for flowhelm-ai/flowhelm-skills.
 *
 * Fetches registry.json from GitHub raw content, resolves skill names
 * to download URLs, and downloads skill directories. Supports TTL
 * caching of the registry index to avoid repeated fetches.
 *
 * See ADR-027.
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import {
  registryIndexSchema,
  type RegistryIndex,
  type RegistrySkillEntry,
} from '../config/schema.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RegistryClientOptions {
  /** GitHub org/repo for the skills registry. Default: flowhelm-ai/flowhelm-skills. */
  repo?: string;
  /** Branch to fetch from. Default: main. */
  branch?: string;
  /** TTL for registry.json cache in ms. Default: 5 minutes. */
  cacheTtlMs?: number;
  /** Custom fetch function (for testing). */
  fetchFn?: typeof globalThis.fetch;
}

export interface RegistrySearchResult {
  name: string;
  description: string;
  version: string;
}

// ─── Registry Client ────────────────────────────────────────────────────────

export class RegistryClient {
  private readonly repo: string;
  private readonly branch: string;
  private readonly cacheTtlMs: number;
  private readonly fetchFn: typeof globalThis.fetch;

  private cachedIndex: RegistryIndex | null = null;
  private cachedAt = 0;

  constructor(options?: RegistryClientOptions) {
    this.repo = options?.repo ?? 'flowhelm-ai/flowhelm-skills';
    this.branch = options?.branch ?? 'main';
    this.cacheTtlMs = options?.cacheTtlMs ?? 300_000; // 5 min
    this.fetchFn = options?.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Fetch and cache the registry index.
   * Returns cached version if within TTL.
   */
  async getIndex(): Promise<RegistryIndex> {
    if (this.cachedIndex && Date.now() - this.cachedAt < this.cacheTtlMs) {
      return this.cachedIndex;
    }

    const url = `https://raw.githubusercontent.com/${this.repo}/${this.branch}/registry.json`;
    const response = await this.fetchFn(url);

    if (!response.ok) {
      throw new Error(
        `Failed to fetch registry: ${String(response.status)} ${response.statusText}`,
      );
    }

    const json = (await response.json()) as unknown;
    const index = registryIndexSchema.parse(json);

    this.cachedIndex = index;
    this.cachedAt = Date.now();

    return index;
  }

  /** Look up a skill by name in the registry. */
  async lookup(name: string): Promise<RegistrySkillEntry | null> {
    const index = await this.getIndex();
    return index.skills.find((s) => s.name === name) ?? null;
  }

  /**
   * Search the registry by keyword.
   * Matches against name and description (case-insensitive).
   */
  async search(query: string): Promise<RegistrySearchResult[]> {
    const index = await this.getIndex();
    const lower = query.toLowerCase();

    return index.skills
      .filter(
        (s) => s.name.toLowerCase().includes(lower) || s.description.toLowerCase().includes(lower),
      )
      .map((s) => ({
        name: s.name,
        description: s.description,
        version: s.version,
      }));
  }

  /**
   * Download a skill directory from the registry to a temporary directory.
   * Returns the path to the downloaded skill directory.
   *
   * Uses the GitHub API to fetch the directory contents (individual files).
   */
  async download(name: string): Promise<string> {
    const entry = await this.lookup(name);
    if (!entry) {
      throw new Error(`Skill "${name}" not found in registry`);
    }

    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), `flowhelm-skill-${name}-`));

    // Fetch the skill directory listing from GitHub API
    const apiUrl = `https://api.github.com/repos/${this.repo}/contents/${entry.path}?ref=${this.branch}`;
    const response = await this.fetchFn(apiUrl, {
      headers: { Accept: 'application/vnd.github.v3+json' },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch skill contents: ${String(response.status)} ${response.statusText}`,
      );
    }

    const contents = (await response.json()) as Array<{
      name: string;
      type: string;
      download_url: string | null;
    }>;

    // Download each file
    for (const item of contents) {
      if (item.type === 'file' && item.download_url) {
        const fileResponse = await this.fetchFn(item.download_url);
        if (fileResponse.ok) {
          const content = await fileResponse.text();
          await fsp.writeFile(path.join(tempDir, item.name), content, 'utf-8');
        }
      } else if (item.type === 'dir') {
        // Recursively download subdirectories
        await this.downloadSubdir(`${entry.path}/${item.name}`, path.join(tempDir, item.name));
      }
    }

    // Verify SKILL.md integrity if sha256 is present in registry entry
    if (entry.sha256) {
      const skillMdPath = path.join(tempDir, 'SKILL.md');
      try {
        const skillMdContent = await fsp.readFile(skillMdPath, 'utf-8');
        const hash = createHash('sha256').update(skillMdContent).digest('hex');
        if (hash !== entry.sha256) {
          await fsp.rm(tempDir, { recursive: true, force: true });
          throw new Error(
            `Integrity check failed for "${name}": expected sha256 ${entry.sha256}, got ${hash}`,
          );
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('Integrity check failed')) throw err;
        // SKILL.md missing — let install validation catch it
      }
    }

    return tempDir;
  }

  /** Download a subdirectory recursively. */
  private async downloadSubdir(repoPath: string, localDir: string): Promise<void> {
    await fsp.mkdir(localDir, { recursive: true });

    const apiUrl = `https://api.github.com/repos/${this.repo}/contents/${repoPath}?ref=${this.branch}`;
    const response = await this.fetchFn(apiUrl, {
      headers: { Accept: 'application/vnd.github.v3+json' },
    });

    if (!response.ok) return;

    const contents = (await response.json()) as Array<{
      name: string;
      type: string;
      download_url: string | null;
    }>;

    for (const item of contents) {
      if (item.type === 'file' && item.download_url) {
        const fileResponse = await this.fetchFn(item.download_url);
        if (fileResponse.ok) {
          const content = await fileResponse.text();
          await fsp.writeFile(path.join(localDir, item.name), content, 'utf-8');
        }
      } else if (item.type === 'dir') {
        await this.downloadSubdir(`${repoPath}/${item.name}`, path.join(localDir, item.name));
      }
    }
  }

  /** Invalidate the cached registry index. */
  clearCache(): void {
    this.cachedIndex = null;
    this.cachedAt = 0;
  }
}
