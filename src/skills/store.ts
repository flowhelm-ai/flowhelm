/**
 * Per-user skill store.
 *
 * Manages skills at ~/.flowhelm/skills/. Each skill is a directory
 * containing a SKILL.md file and optional supporting files. The
 * installed.json manifest tracks installed skills with metadata.
 *
 * See ADR-027.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import {
  skillFrontmatterSchema,
  installedManifestSchema,
  type SkillFrontmatter,
  type InstalledSkillEntry,
  type InstalledManifest,
} from '../config/schema.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type SkillSource = 'registry' | 'local' | 'git';

export interface InstallOptions {
  /** Where the skill came from. */
  source: SkillSource;
}

export interface RequirementsWarning {
  field: string;
  missing: string[];
}

export interface SkillInfo {
  /** Parsed SKILL.md frontmatter. */
  frontmatter: SkillFrontmatter;
  /** Path to the skill directory in the store. */
  path: string;
  /** Install metadata (if installed). */
  manifest?: InstalledSkillEntry;
}

export interface SkillStoreOptions {
  /** Path to the skills directory (default: ~/.flowhelm/skills). */
  skillsDir: string;
}

// ─── YAML Frontmatter Parser ────────────────────────────────────────────────

/**
 * Minimal YAML frontmatter parser for SKILL.md files.
 * Handles the subset of YAML needed for skill frontmatter:
 * scalar strings, arrays (flow syntax [a, b]), and nested objects.
 */
export function parseFrontmatter(content: string): { data: Record<string, unknown>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { data: {}, body: content };
  }

  const yamlBlock = match[1] ?? '';
  const body = match[2] ?? '';
  const data: Record<string, unknown> = {};

  let currentObject: Record<string, unknown> | null = null;
  let currentKey: string | null = null;

  for (const line of yamlBlock.split('\n')) {
    const trimmed = line.trimEnd();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    // Indented line — part of a nested object
    const indentedMatch = trimmed.match(/^[ ]{2}(\w[\w-]*)\s*:\s*(.*)$/);
    if (indentedMatch && currentObject && currentKey) {
      const key = indentedMatch[1] ?? '';
      const value = indentedMatch[2] ?? '';
      currentObject[key] = parseYamlValue(value);
      continue;
    }

    // Top-level key
    const topMatch = trimmed.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
    if (topMatch) {
      const key = topMatch[1] ?? '';
      const value = (topMatch[2] ?? '').trim();

      if (value === '') {
        // Start of a nested object
        currentKey = key;
        currentObject = {};
        data[key] = currentObject;
      } else {
        currentKey = null;
        currentObject = null;
        data[key] = parseYamlValue(value);
      }
    }
  }

  return { data, body };
}

function parseYamlValue(raw: string): unknown {
  const trimmed = raw.trim();

  // Flow array: [a, b, c]
  const arrayMatch = trimmed.match(/^\[(.*)\]$/);
  if (arrayMatch) {
    const inner = (arrayMatch[1] ?? '').trim();
    if (inner === '') return [];
    return inner.split(',').map((item) => item.trim().replace(/^['"]|['"]$/g, ''));
  }

  // Quoted string
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  // Boolean / number
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  const num = Number(trimmed);
  if (!Number.isNaN(num) && trimmed !== '') return num;

  return trimmed;
}

// ─── SkillStore ─────────────────────────────────────────────────────────────

export class SkillStore {
  private readonly skillsDir: string;
  private readonly manifestPath: string;

  constructor(options: SkillStoreOptions) {
    this.skillsDir = options.skillsDir;
    this.manifestPath = path.join(this.skillsDir, 'installed.json');
  }

  /** Ensure the skills directory and manifest exist. */
  async init(): Promise<void> {
    await fsp.mkdir(this.skillsDir, { recursive: true });
    if (!fs.existsSync(this.manifestPath)) {
      await fsp.writeFile(this.manifestPath, '[]', 'utf-8');
    }
  }

  /** Read the installed manifest. */
  async readManifest(): Promise<InstalledManifest> {
    try {
      const raw = await fsp.readFile(this.manifestPath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      return installedManifestSchema.parse(parsed);
    } catch {
      return [];
    }
  }

  /** Write the installed manifest. */
  private async writeManifest(manifest: InstalledManifest): Promise<void> {
    await fsp.writeFile(this.manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  }

  /** List all installed skills. */
  async list(): Promise<InstalledSkillEntry[]> {
    return this.readManifest();
  }

  /** Get a specific installed skill by name. */
  async get(name: string): Promise<InstalledSkillEntry | null> {
    const manifest = await this.readManifest();
    return manifest.find((s) => s.name === name) ?? null;
  }

  /** Check if a skill is installed. */
  async isInstalled(name: string): Promise<boolean> {
    const entry = await this.get(name);
    return entry !== null;
  }

  /**
   * Read and validate a SKILL.md from a directory.
   * Returns the parsed frontmatter or throws if invalid.
   */
  async readSkillMd(skillDir: string): Promise<SkillFrontmatter> {
    const skillMdPath = path.join(skillDir, 'SKILL.md');
    const content = await fsp.readFile(skillMdPath, 'utf-8');
    const { data } = parseFrontmatter(content);
    return skillFrontmatterSchema.parse(data);
  }

  /**
   * Install a skill from a source directory into the store.
   *
   * @param sourceDir - Directory containing SKILL.md + optional files
   * @param options - Install options (source type)
   * @returns The installed skill entry
   * @throws If SKILL.md is invalid or dependencies are not met
   */
  async install(sourceDir: string, options: InstallOptions): Promise<InstalledSkillEntry> {
    const frontmatter = await this.readSkillMd(sourceDir);
    const name = frontmatter.name;

    // Check skill dependencies
    const depWarnings = await this.checkSkillDependencies(frontmatter);
    if (depWarnings.length > 0) {
      const missing = depWarnings.map((w) => w.missing.join(', ')).join('; ');
      throw new Error(`Missing required skills: ${missing}. Install them first.`);
    }

    // Copy skill directory to store
    const targetDir = path.join(this.skillsDir, name);
    await this.copyDir(sourceDir, targetDir);

    // Update manifest
    const manifest = await this.readManifest();
    const existingIdx = manifest.findIndex((s) => s.name === name);
    const entry: InstalledSkillEntry = {
      name,
      version: frontmatter.version,
      source: options.source,
      installedAt: new Date().toISOString(),
      requires: frontmatter.requires,
    };

    if (existingIdx >= 0) {
      manifest[existingIdx] = entry;
    } else {
      manifest.push(entry);
    }

    await this.writeManifest(manifest);
    return entry;
  }

  /**
   * Remove an installed skill.
   *
   * @throws If the skill is not installed or other skills depend on it
   */
  async remove(name: string): Promise<void> {
    const manifest = await this.readManifest();
    const idx = manifest.findIndex((s) => s.name === name);
    if (idx < 0) {
      throw new Error(`Skill "${name}" is not installed`);
    }

    // Check if other skills depend on this one
    const dependents = manifest.filter((s) => s.name !== name && s.requires.skills.includes(name));
    if (dependents.length > 0) {
      const names = dependents.map((s) => s.name).join(', ');
      throw new Error(`Cannot remove "${name}": required by ${names}. Uninstall them first.`);
    }

    // Remove the skill directory
    const skillDir = path.join(this.skillsDir, name);
    await fsp.rm(skillDir, { recursive: true, force: true });

    // Update manifest
    manifest.splice(idx, 1);
    await this.writeManifest(manifest);
  }

  /**
   * Check skill dependencies (requires.skills).
   * Returns an array of warnings for missing dependencies.
   * This is a hard check — missing skill deps block installation.
   */
  async checkSkillDependencies(frontmatter: SkillFrontmatter): Promise<RequirementsWarning[]> {
    const requiredSkills = frontmatter.requires.skills;
    if (requiredSkills.length === 0) return [];

    const manifest = await this.readManifest();
    const installedNames = new Set(manifest.map((s) => s.name));
    const missing = requiredSkills.filter((s) => !installedNames.has(s));

    if (missing.length === 0) return [];
    return [{ field: 'skills', missing }];
  }

  /**
   * Check soft requirements (channels, bins, env).
   * Returns warnings but does not block installation.
   */
  checkSoftRequirements(
    frontmatter: SkillFrontmatter,
    context?: { channels?: string[]; bins?: string[]; env?: string[] },
  ): RequirementsWarning[] {
    const warnings: RequirementsWarning[] = [];
    const ctx = context ?? {};

    if (frontmatter.requires.channels.length > 0) {
      const configured = new Set(ctx.channels ?? []);
      const missing = frontmatter.requires.channels.filter((c) => !configured.has(c));
      if (missing.length > 0) warnings.push({ field: 'channels', missing });
    }

    if (frontmatter.requires.bins.length > 0) {
      const available = new Set(ctx.bins ?? []);
      const missing = frontmatter.requires.bins.filter((b) => !available.has(b));
      if (missing.length > 0) warnings.push({ field: 'bins', missing });
    }

    if (frontmatter.requires.env.length > 0) {
      const available = new Set(ctx.env ?? []);
      const missing = frontmatter.requires.env.filter((e) => !available.has(e));
      if (missing.length > 0) warnings.push({ field: 'env', missing });
    }

    if (frontmatter.requires.os.length > 0) {
      const platform = process.platform === 'darwin' ? 'macos' : 'linux';
      if (!frontmatter.requires.os.includes(platform)) {
        warnings.push({ field: 'os', missing: [platform] });
      }
    }

    return warnings;
  }

  /** Get the skill directory path in the store. */
  getSkillDir(name: string): string {
    return path.join(this.skillsDir, name);
  }

  /** Get all installed skill directories for container sync. */
  async getInstalledSkillDirs(): Promise<{ name: string; dir: string }[]> {
    const manifest = await this.readManifest();
    return manifest.map((s) => ({
      name: s.name,
      dir: path.join(this.skillsDir, s.name),
    }));
  }

  /** Recursively copy a directory. */
  private async copyDir(src: string, dest: string): Promise<void> {
    await fsp.mkdir(dest, { recursive: true });
    const entries = await fsp.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        await this.copyDir(srcPath, destPath);
      } else {
        await fsp.copyFile(srcPath, destPath);
      }
    }
  }
}
