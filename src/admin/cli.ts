/**
 * FlowHelm CLI commands.
 *
 * Skill management: install, uninstall, list, search, info, update.
 * Identity management: identity agent/user show/set, personality agent/user show/set/reset.
 * Channel setup: setup telegram, setup gmail (configure + recommend skill install).
 * Admin commands: admin init, add-user, remove-user, status, set-limits.
 *
 * All commands are non-interactive (flags only). See ADR-027.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as fsp from 'node:fs/promises';
import type { SkillStore } from '../skills/store.js';
import type { RegistryClient } from '../skills/registry.js';
import type { IdentityManager } from '../orchestrator/identity.js';
import type { ProfileManager } from '../orchestrator/profile-manager.js';
import type { AgentPersonalityDimension, UserPersonalityDimension } from '../orchestrator/types.js';
import { stringify as stringifyYaml } from 'yaml';
import { PortRegistry } from './port-registry.js';
import { UserManager } from './user-manager.js';
import { isCgroupsV2Available, setLimits, readUsage, formatBytes } from './resource-limits.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CliContext {
  skillStore: SkillStore;
  registryClient: RegistryClient;
  /** Log function (defaults to console.log). */
  log?: (msg: string) => void;
  /** Error function (defaults to console.error). */
  error?: (msg: string) => void;
}

export interface CliResult {
  success: boolean;
  message: string;
}

export interface IdentityCliContext {
  identityManager: IdentityManager;
  profileManager: ProfileManager;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
}

const AGENT_PERSONALITY_DIMENSIONS: AgentPersonalityDimension[] = [
  'communication_style',
  'humor',
  'emotional_register',
  'values',
  'rapport',
  'boundaries',
];

const USER_PERSONALITY_DIMENSIONS: UserPersonalityDimension[] = [
  'communication_style',
  'work_patterns',
  'decision_making',
  'priorities',
  'preferences',
  'boundaries',
];

// ─── CLI Commands ───────────────────────────────────────────────────────────

/**
 * Install a skill from the registry, a local directory, or a Git URL.
 */
export async function installCommand(nameOrPath: string, ctx: CliContext): Promise<CliResult> {
  const log = ctx.log ?? console.log;

  // Determine source type
  const isLocalPath =
    nameOrPath.startsWith('./') || nameOrPath.startsWith('/') || nameOrPath.startsWith('~');
  const isGitUrl = nameOrPath.startsWith('https://') || nameOrPath.startsWith('git://');

  let sourceDir: string;
  let source: 'registry' | 'local' | 'git';

  if (isLocalPath) {
    // Local directory install
    const resolved = path.resolve(nameOrPath);
    if (!fs.existsSync(path.join(resolved, 'SKILL.md'))) {
      return { success: false, message: `No SKILL.md found in ${resolved}` };
    }
    sourceDir = resolved;
    source = 'local';
  } else if (isGitUrl) {
    // Git URL — not implemented in Phase 5A (needs git clone)
    return {
      success: false,
      message: 'Git URL install is not yet supported. Use registry name or local path.',
    };
  } else {
    // Registry install
    log(`Fetching "${nameOrPath}" from registry...`);
    try {
      sourceDir = await ctx.registryClient.download(nameOrPath);
      source = 'registry';
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Download failed';
      return { success: false, message: msg };
    }
  }

  // Parse and validate
  let frontmatter;
  try {
    frontmatter = await ctx.skillStore.readSkillMd(sourceDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Invalid SKILL.md';
    return { success: false, message: `Invalid SKILL.md: ${msg}` };
  }

  // Check soft requirements and warn
  const softWarnings = ctx.skillStore.checkSoftRequirements(frontmatter);
  if (softWarnings.length > 0) {
    log('');
    log('Requirements not yet met:');
    for (const w of softWarnings) {
      log(`  ${w.field}: ${w.missing.join(', ')}`);
    }
    log('');
    log('The skill will be installed but may not be fully functional');
    log('until requirements are configured.');
    log('');
  }

  // Install
  try {
    const entry = await ctx.skillStore.install(sourceDir, { source });
    log(`Installed ${entry.name} v${entry.version}`);
    log('Takes effect on next agent invocation.');
    return { success: true, message: `Installed ${entry.name} v${entry.version}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Install failed';
    return { success: false, message: msg };
  } finally {
    // Cleanup temp dir for registry downloads
    if (source === 'registry' && sourceDir.includes('flowhelm-skill-')) {
      await fsp.rm(sourceDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * Uninstall a skill.
 */
export async function uninstallCommand(name: string, ctx: CliContext): Promise<CliResult> {
  const log = ctx.log ?? console.log;

  try {
    await ctx.skillStore.remove(name);
    log(`Uninstalled "${name}"`);
    log('Takes effect on next agent invocation.');
    return { success: true, message: `Uninstalled "${name}"` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Uninstall failed';
    return { success: false, message: msg };
  }
}

/**
 * List installed and built-in skills.
 */
export async function listCommand(ctx: CliContext): Promise<CliResult> {
  const log = ctx.log ?? console.log;
  const installed = await ctx.skillStore.list();

  if (installed.length === 0) {
    log('No skills installed.');
    log('');
    log('Built-in skills (always available):');
    log('  capabilities  Agent self-description');
    log('  status        System health report');
    log('');
    log('Run "flowhelm search <query>" to find skills to install.');
    return { success: true, message: 'No skills installed' };
  }

  log('Installed skills:');
  for (const s of installed) {
    log(`  ${s.name.padEnd(20)} v${s.version.padEnd(10)} (${s.source})`);
  }

  log('');
  log('Built-in skills (always available):');
  log('  capabilities  Agent self-description');
  log('  status        System health report');

  return { success: true, message: `${String(installed.length)} skill(s) installed` };
}

/**
 * Search the registry by keyword.
 */
export async function searchCommand(query: string, ctx: CliContext): Promise<CliResult> {
  const log = ctx.log ?? console.log;

  try {
    const results = await ctx.registryClient.search(query);

    if (results.length === 0) {
      log(`No skills found matching "${query}".`);
      return { success: true, message: 'No results' };
    }

    // Check which are already installed
    const manifest = await ctx.skillStore.readManifest();
    const installedNames = new Set(manifest.map((s: { name: string }) => s.name));

    log(`Results for "${query}":`);
    for (const r of results) {
      const status = installedNames.has(r.name) ? ' [installed]' : '';
      log(`  ${r.name.padEnd(20)} v${r.version.padEnd(10)} ${r.description}${status}`);
    }

    return { success: true, message: `${String(results.length)} result(s)` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Search failed';
    return { success: false, message: msg };
  }
}

/**
 * Show detailed info about a skill.
 */
export async function infoCommand(name: string, ctx: CliContext): Promise<CliResult> {
  const log = ctx.log ?? console.log;

  // Check if installed locally
  const installedEntry = await ctx.skillStore.get(name);

  if (installedEntry) {
    log(`${name} v${installedEntry.version} [installed]`);
    log(`  Source: ${installedEntry.source}`);
    log(`  Installed: ${installedEntry.installedAt}`);
    const req = installedEntry.requires;
    if (req.channels.length > 0) log(`  Channels: ${req.channels.join(', ')}`);
    if (req.bins.length > 0) log(`  Binaries: ${req.bins.join(', ')}`);
    if (req.env.length > 0) log(`  Env vars: ${req.env.join(', ')}`);
    if (req.skills.length > 0) log(`  Skills: ${req.skills.join(', ')}`);
    if (req.os.length > 0) log(`  OS: ${req.os.join(', ')}`);
    return { success: true, message: `${name} v${installedEntry.version}` };
  }

  // Check registry
  try {
    const entry = await ctx.registryClient.lookup(name);
    if (!entry) {
      return { success: false, message: `Skill "${name}" not found` };
    }

    log(`${entry.name} v${entry.version} [not installed]`);
    log(`  ${entry.description}`);
    log(`  Install: flowhelm install ${entry.name}`);
    return { success: true, message: `${entry.name} v${entry.version}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Lookup failed';
    return { success: false, message: msg };
  }
}

/**
 * Update installed skills from the registry.
 */
export async function updateCommand(name: string | undefined, ctx: CliContext): Promise<CliResult> {
  const log = ctx.log ?? console.log;
  const manifest = await ctx.skillStore.readManifest();

  // Filter to specific skill or all
  const toUpdate = name
    ? manifest.filter((s: { name: string }) => s.name === name)
    : manifest.filter((s: { source: string }) => s.source === 'registry');

  if (toUpdate.length === 0) {
    if (name) {
      return { success: false, message: `Skill "${name}" is not installed` };
    }
    log('No registry-installed skills to update.');
    return { success: true, message: 'Nothing to update' };
  }

  let updated = 0;
  for (const skill of toUpdate) {
    try {
      const registryEntry = await ctx.registryClient.lookup(skill.name);
      if (!registryEntry) {
        log(`  ${skill.name}: not found in registry, skipping`);
        continue;
      }

      if (registryEntry.version === skill.version) {
        log(`  ${skill.name}: already up to date (v${skill.version})`);
        continue;
      }

      // Download and reinstall
      const sourceDir = await ctx.registryClient.download(skill.name);
      try {
        await ctx.skillStore.install(sourceDir, { source: 'registry' });
        log(`  ${skill.name}: updated v${skill.version} -> v${registryEntry.version}`);
        updated++;
      } finally {
        await fsp.rm(sourceDir, { recursive: true, force: true }).catch(() => {});
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Update failed';
      log(`  ${skill.name}: failed — ${msg}`);
    }
  }

  const msg = `${String(updated)} skill(s) updated`;
  log(msg);
  return { success: true, message: msg };
}

// ─── Identity & Personality Commands ──────────────────────────────────────

async function resolveProfileId(
  profileName: string | undefined,
  ctx: IdentityCliContext,
): Promise<string | null> {
  if (profileName) {
    const profile = await ctx.profileManager.getProfileByName(profileName);
    return profile?.id ?? null;
  }
  const defaultProfile = await ctx.profileManager.getDefaultProfile();
  return defaultProfile?.id ?? null;
}

/**
 * flowhelm identity agent show [--profile <name>]
 */
export async function identityAgentShowCommand(
  options: { profile?: string },
  ctx: IdentityCliContext,
): Promise<CliResult> {
  const log = ctx.log ?? console.log;
  const profileId = await resolveProfileId(options.profile, ctx);
  if (!profileId) {
    return {
      success: false,
      message: options.profile
        ? `Profile "${options.profile}" not found`
        : 'No default profile found',
    };
  }

  const identity = await ctx.identityManager.getAgentIdentity(profileId);
  if (!identity) {
    log('No agent identity configured.');
    log('Set one with: flowhelm identity agent set --role "..."');
    return { success: true, message: 'No agent identity' };
  }

  log(`Role:         ${identity.role}`);
  log(`Tone:         ${identity.tone}`);
  log(`Expertise:    ${identity.expertise.length > 0 ? identity.expertise.join(', ') : '(none)'}`);
  log(`Instructions: ${identity.instructions ?? '(none)'}`);
  return { success: true, message: 'OK' };
}

/**
 * flowhelm identity agent set [--profile <name>] --role "..." [--tone "..."]
 *   [--expertise "a,b,c"] [--instructions "..."]
 */
export async function identityAgentSetCommand(
  options: {
    profile?: string;
    role?: string;
    tone?: string;
    expertise?: string;
    instructions?: string;
  },
  ctx: IdentityCliContext,
): Promise<CliResult> {
  const log = ctx.log ?? console.log;
  const profileId = await resolveProfileId(options.profile, ctx);
  if (!profileId) {
    return {
      success: false,
      message: options.profile
        ? `Profile "${options.profile}" not found`
        : 'No default profile found',
    };
  }

  // Merge with existing
  const existing = await ctx.identityManager.getAgentIdentity(profileId);
  const role = options.role ?? existing?.role;
  const tone = options.tone ?? existing?.tone;
  if (!role || !tone) {
    return {
      success: false,
      message: 'Both --role and --tone are required when creating agent identity',
    };
  }

  const expertise = options.expertise
    ? options.expertise
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : (existing?.expertise ?? []);
  const instructions = options.instructions ?? existing?.instructions;

  await ctx.identityManager.setAgentIdentity(profileId, {
    role,
    expertise,
    tone,
    instructions,
  });

  log('Agent identity updated.');
  return { success: true, message: 'Agent identity updated' };
}

/**
 * flowhelm identity user show
 */
export async function identityUserShowCommand(ctx: IdentityCliContext): Promise<CliResult> {
  const log = ctx.log ?? console.log;
  const identity = await ctx.identityManager.getUserIdentity();
  if (!identity) {
    log('No user identity configured.');
    log('Set one with: flowhelm identity user set --name "..."');
    return { success: true, message: 'No user identity' };
  }

  log(`Name:         ${identity.name ?? '(not set)'}`);
  log(`Role:         ${identity.role ?? '(not set)'}`);
  log(`Organization: ${identity.organization ?? '(not set)'}`);
  log(`Timezone:     ${identity.timezone ?? '(not set)'}`);
  log(`Language:     ${identity.language}`);
  log(`Notes:        ${identity.notes ?? '(not set)'}`);
  return { success: true, message: 'OK' };
}

/**
 * flowhelm identity user set --name "..." [--role "..."] [--org "..."]
 *   [--timezone "..."] [--language "..."] [--notes "..."]
 */
export async function identityUserSetCommand(
  options: {
    name?: string;
    role?: string;
    org?: string;
    timezone?: string;
    language?: string;
    notes?: string;
  },
  ctx: IdentityCliContext,
): Promise<CliResult> {
  const log = ctx.log ?? console.log;
  const hasAny =
    options.name ||
    options.role ||
    options.org ||
    options.timezone ||
    options.language ||
    options.notes;
  if (!hasAny) {
    return {
      success: false,
      message:
        'At least one field required: --name, --role, --org, --timezone, --language, --notes',
    };
  }

  await ctx.identityManager.updateUserIdentity({
    name: options.name,
    role: options.role,
    organization: options.org,
    timezone: options.timezone,
    language: options.language,
    notes: options.notes,
  });

  log('User identity updated.');
  return { success: true, message: 'User identity updated' };
}

/**
 * flowhelm personality agent show [--profile <name>]
 */
export async function personalityAgentShowCommand(
  options: { profile?: string },
  ctx: IdentityCliContext,
): Promise<CliResult> {
  const log = ctx.log ?? console.log;
  const profileId = await resolveProfileId(options.profile, ctx);
  if (!profileId) {
    return {
      success: false,
      message: options.profile
        ? `Profile "${options.profile}" not found`
        : 'No default profile found',
    };
  }

  const entries = await ctx.identityManager.getAgentPersonality(profileId);
  if (entries.length === 0) {
    log('No agent personality dimensions configured.');
    log(
      'Set one with: flowhelm personality agent set --dimension communication_style --content "..."',
    );
    return { success: true, message: 'No agent personality' };
  }

  for (const e of entries) {
    log(`${e.dimension.padEnd(22)} (confidence: ${e.confidence.toFixed(2)})  ${e.content}`);
  }
  return { success: true, message: `${String(entries.length)} dimension(s)` };
}

/**
 * flowhelm personality agent set [--profile <name>] --dimension <dim> --content "..."
 */
export async function personalityAgentSetCommand(
  options: { profile?: string; dimension?: string; content?: string },
  ctx: IdentityCliContext,
): Promise<CliResult> {
  const log = ctx.log ?? console.log;
  if (!options.dimension || !options.content) {
    return { success: false, message: 'Both --dimension and --content are required' };
  }

  if (!AGENT_PERSONALITY_DIMENSIONS.includes(options.dimension as AgentPersonalityDimension)) {
    return {
      success: false,
      message: `Invalid dimension. Valid: ${AGENT_PERSONALITY_DIMENSIONS.join(', ')}`,
    };
  }

  const profileId = await resolveProfileId(options.profile, ctx);
  if (!profileId) {
    return {
      success: false,
      message: options.profile
        ? `Profile "${options.profile}" not found`
        : 'No default profile found',
    };
  }

  await ctx.identityManager.observeAgentPersonality(
    profileId,
    options.dimension as AgentPersonalityDimension,
    options.content,
  );
  log(`Agent personality "${options.dimension}" updated.`);
  return { success: true, message: `Agent personality "${options.dimension}" updated` };
}

/**
 * flowhelm personality agent reset [--profile <name>] --dimension <dim>
 */
export async function personalityAgentResetCommand(
  options: { profile?: string; dimension?: string },
  ctx: IdentityCliContext,
): Promise<CliResult> {
  const log = ctx.log ?? console.log;
  if (!options.dimension) {
    return { success: false, message: '--dimension is required' };
  }

  if (!AGENT_PERSONALITY_DIMENSIONS.includes(options.dimension as AgentPersonalityDimension)) {
    return {
      success: false,
      message: `Invalid dimension. Valid: ${AGENT_PERSONALITY_DIMENSIONS.join(', ')}`,
    };
  }

  const profileId = await resolveProfileId(options.profile, ctx);
  if (!profileId) {
    return {
      success: false,
      message: options.profile
        ? `Profile "${options.profile}" not found`
        : 'No default profile found',
    };
  }

  const deleted = await ctx.identityManager.deleteAgentPersonality(
    profileId,
    options.dimension as AgentPersonalityDimension,
  );

  if (deleted) {
    log(
      `Agent personality "${options.dimension}" reset. The agent can re-infer it from conversation.`,
    );
    return { success: true, message: `Agent personality "${options.dimension}" reset` };
  }

  log(`No agent personality "${options.dimension}" found to reset.`);
  return { success: true, message: 'Nothing to reset' };
}

/**
 * flowhelm personality user show
 */
export async function personalityUserShowCommand(ctx: IdentityCliContext): Promise<CliResult> {
  const log = ctx.log ?? console.log;
  const entries = await ctx.identityManager.getUserPersonality();
  if (entries.length === 0) {
    log('No user personality dimensions configured.');
    log(
      'Set one with: flowhelm personality user set --dimension communication_style --content "..."',
    );
    return { success: true, message: 'No user personality' };
  }

  for (const e of entries) {
    log(
      `${e.dimension.padEnd(22)} (confidence: ${e.confidence.toFixed(2)}, source: ${e.source})  ${e.content}`,
    );
  }
  return { success: true, message: `${String(entries.length)} dimension(s)` };
}

/**
 * flowhelm personality user set --dimension <dim> --content "..."
 */
export async function personalityUserSetCommand(
  options: { dimension?: string; content?: string },
  ctx: IdentityCliContext,
): Promise<CliResult> {
  const log = ctx.log ?? console.log;
  if (!options.dimension || !options.content) {
    return { success: false, message: 'Both --dimension and --content are required' };
  }

  if (!USER_PERSONALITY_DIMENSIONS.includes(options.dimension as UserPersonalityDimension)) {
    return {
      success: false,
      message: `Invalid dimension. Valid: ${USER_PERSONALITY_DIMENSIONS.join(', ')}`,
    };
  }

  await ctx.identityManager.observeUserPersonality(
    options.dimension as UserPersonalityDimension,
    options.content,
    'declared',
  );
  log(`User personality "${options.dimension}" updated.`);
  return { success: true, message: `User personality "${options.dimension}" updated` };
}

/**
 * flowhelm personality user reset --dimension <dim>
 */
export async function personalityUserResetCommand(
  options: { dimension?: string },
  ctx: IdentityCliContext,
): Promise<CliResult> {
  const log = ctx.log ?? console.log;
  if (!options.dimension) {
    return { success: false, message: '--dimension is required' };
  }

  if (!USER_PERSONALITY_DIMENSIONS.includes(options.dimension as UserPersonalityDimension)) {
    return {
      success: false,
      message: `Invalid dimension. Valid: ${USER_PERSONALITY_DIMENSIONS.join(', ')}`,
    };
  }

  const deleted = await ctx.identityManager.deleteUserPersonality(
    options.dimension as UserPersonalityDimension,
  );

  if (deleted) {
    log(
      `User personality "${options.dimension}" reset. The agent can re-infer it from conversation.`,
    );
    return { success: true, message: `User personality "${options.dimension}" reset` };
  }

  log(`No user personality "${options.dimension}" found to reset.`);
  return { success: true, message: 'Nothing to reset' };
}

// ─── Identity/Personality Dispatchers ────────────────────────────────────

/**
 * Dispatch identity subcommands: identity agent show/set, identity user show/set.
 */
export async function dispatchIdentityCommand(
  args: string[],
  ctx: IdentityCliContext,
): Promise<CliResult> {
  const errFn = ctx.error ?? console.error;
  const target = args[0]; // 'agent' or 'user'
  const action = args[1]; // 'show' or 'set'

  if (target === 'agent' && action === 'show') {
    return identityAgentShowCommand({ profile: extractFlag(args, 'profile') }, ctx);
  }
  if (target === 'agent' && action === 'set') {
    return identityAgentSetCommand(
      {
        profile: extractFlag(args, 'profile'),
        role: extractFlag(args, 'role'),
        tone: extractFlag(args, 'tone'),
        expertise: extractFlag(args, 'expertise'),
        instructions: extractFlag(args, 'instructions'),
      },
      ctx,
    );
  }
  if (target === 'user' && action === 'show') {
    return identityUserShowCommand(ctx);
  }
  if (target === 'user' && action === 'set') {
    return identityUserSetCommand(
      {
        name: extractFlag(args, 'name'),
        role: extractFlag(args, 'role'),
        org: extractFlag(args, 'org'),
        timezone: extractFlag(args, 'timezone'),
        language: extractFlag(args, 'language'),
        notes: extractFlag(args, 'notes'),
      },
      ctx,
    );
  }

  errFn('Usage: flowhelm identity <agent|user> <show|set> [flags]');
  return { success: false, message: 'Invalid identity command' };
}

/**
 * Dispatch personality subcommands: personality agent/user show/set/reset.
 */
export async function dispatchPersonalityCommand(
  args: string[],
  ctx: IdentityCliContext,
): Promise<CliResult> {
  const errFn = ctx.error ?? console.error;
  const target = args[0]; // 'agent' or 'user'
  const action = args[1]; // 'show', 'set', or 'reset'

  if (target === 'agent' && action === 'show') {
    return personalityAgentShowCommand({ profile: extractFlag(args, 'profile') }, ctx);
  }
  if (target === 'agent' && action === 'set') {
    return personalityAgentSetCommand(
      {
        profile: extractFlag(args, 'profile'),
        dimension: extractFlag(args, 'dimension'),
        content: extractFlag(args, 'content'),
      },
      ctx,
    );
  }
  if (target === 'agent' && action === 'reset') {
    return personalityAgentResetCommand(
      {
        profile: extractFlag(args, 'profile'),
        dimension: extractFlag(args, 'dimension'),
      },
      ctx,
    );
  }
  if (target === 'user' && action === 'show') {
    return personalityUserShowCommand(ctx);
  }
  if (target === 'user' && action === 'set') {
    return personalityUserSetCommand(
      {
        dimension: extractFlag(args, 'dimension'),
        content: extractFlag(args, 'content'),
      },
      ctx,
    );
  }
  if (target === 'user' && action === 'reset') {
    return personalityUserResetCommand(
      {
        dimension: extractFlag(args, 'dimension'),
      },
      ctx,
    );
  }

  errFn('Usage: flowhelm personality <agent|user> <show|set|reset> [flags]');
  return { success: false, message: 'Invalid personality command' };
}

// ─── Setup Commands ────────────────────────────────────────────────────────

export interface SetupContext {
  /** Config directory (default: ~/.flowhelm). */
  configDir: string;
  /** Config file name (default: config.yaml). */
  configFileName?: string;
  skillStore: SkillStore;
  registryClient: RegistryClient;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
}

/**
 * Setup Telegram channel.
 *
 * Writes bot token and allowed users to config.yaml, then recommends
 * installing the telegram companion skill.
 *
 * Usage: flowhelm setup telegram --bot-token <token> [--allowed-users 123,456]
 */
export async function setupTelegramCommand(
  options: { botToken: string; allowedUsers?: number[] },
  ctx: SetupContext,
): Promise<CliResult> {
  const log = ctx.log ?? console.log;
  const configDir = ctx.configDir;
  const configFileName = ctx.configFileName ?? 'config.yaml';
  const configPath = path.join(configDir, configFileName);

  // Ensure config dir exists
  await fsp.mkdir(configDir, { recursive: true });

  // Load existing config or start fresh
  let existing: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    const raw = await fsp.readFile(configPath, 'utf-8');
    const { parse: parseYaml } = await import('yaml');
    const parsed: unknown = parseYaml(raw);
    if (parsed && typeof parsed === 'object') {
      existing = parsed as Record<string, unknown>;
    }
  }

  // Store bot token in encrypted credential vault (channel container reads from vault)
  const secretsDir = path.join(configDir, 'secrets');
  await fsp.mkdir(secretsDir, { recursive: true });
  const { CredentialStore } = await import('../proxy/credential-store.js');
  const credStore = new CredentialStore({ secretsDir });
  const rules = await credStore.load();
  rules.credentials = rules.credentials.filter((c) => c.name !== 'telegram-bot');
  rules.credentials.push({
    name: 'telegram-bot',
    hostPattern: 'api.telegram.org',
    header: 'x-bot-token',
    value: options.botToken,
  });
  await credStore.save(rules);
  log('Telegram bot token stored in encrypted vault');

  // Merge telegram config
  const channels = (existing['channels'] as Record<string, unknown>) ?? {};
  channels['telegram'] = {
    botToken: options.botToken,
    allowedUsers: options.allowedUsers ?? [],
  };
  existing['channels'] = channels;

  // Write config
  await fsp.writeFile(configPath, stringifyYaml(existing), 'utf-8');
  log(`Telegram channel configured in ${configPath}`);
  log('');

  // Recommend skill install
  const isInstalled = await ctx.skillStore.isInstalled('telegram');
  if (isInstalled) {
    log('Telegram skill is already installed.');
  } else {
    log('Recommended: Install the telegram skill for rich Telegram features:');
    log('  flowhelm install telegram');
    log('  (message formatting, media handling, group chat behavior)');
    log('');
    log("The channel works without the skill — the agent just won't know");
    log('about Telegram-specific features like MarkdownV2 formatting.');
  }

  return { success: true, message: 'Telegram channel configured' };
}

/**
 * Setup Gmail channel.
 *
 * Writes Gmail config to config.yaml, stores refresh token in secrets dir,
 * then recommends installing the gmail and calendar companion skills.
 *
 * Usage: flowhelm setup gmail --email <addr> --client-id <id> --client-secret <secret>
 *        --refresh-token <token> [--gcp-project <id>] [--service-account-key <path>]
 *        [--transport pubsub|imap] [--notification-channel telegram|whatsapp]
 */
export async function setupGmailCommand(
  options: {
    emailAddress: string;
    oauthClientId: string;
    oauthClientSecret: string;
    oauthRefreshToken: string;
    gcpProject?: string;
    /** Path to SA key JSON file (legacy). */
    serviceAccountKeyPath?: string;
    /** SA key JSON content (preferred — no file needed). */
    serviceAccountKeyJson?: string;
    transport?: 'pubsub' | 'imap';
    notificationChannel?: 'telegram' | 'whatsapp';
  },
  ctx: SetupContext,
): Promise<CliResult> {
  const log = ctx.log ?? console.log;
  const configDir = ctx.configDir;
  const configFileName = ctx.configFileName ?? 'config.yaml';
  const configPath = path.join(configDir, configFileName);

  // Validate transport-specific requirements
  const transport = options.transport ?? 'pubsub';
  if (transport === 'pubsub' && !options.gcpProject) {
    return {
      success: false,
      message: 'Pub/Sub transport requires --gcp-project. Use --transport imap for IMAP IDLE.',
    };
  }

  // Ensure config dir and secrets dir exist
  await fsp.mkdir(configDir, { recursive: true });
  const secretsDir = path.join(configDir, 'secrets');
  await fsp.mkdir(secretsDir, { recursive: true });

  // Store all Gmail secrets in the encrypted credential vault
  const { CredentialStore } = await import('../proxy/credential-store.js');
  const credStore = new CredentialStore({ secretsDir });
  const rules = await credStore.load();

  // Store OAuth credentials as credential rules (for proxy MITM injection + channel vault read)
  const setOrUpdate = (name: string, host: string, header: string, value: string): void => {
    rules.credentials = rules.credentials.filter((c) => c.name !== name);
    rules.credentials.push({ name, hostPattern: host, header, value });
  };
  setOrUpdate(
    'gmail-oauth-client-id',
    'oauth2.googleapis.com',
    'x-client-id',
    options.oauthClientId,
  );
  setOrUpdate(
    'gmail-oauth-client-secret',
    'oauth2.googleapis.com',
    'x-client-secret',
    options.oauthClientSecret,
  );
  setOrUpdate(
    'gmail-oauth-refresh-token',
    'oauth2.googleapis.com',
    'x-refresh-token',
    options.oauthRefreshToken,
  );
  setOrUpdate('gmail-email-address', 'gmail.googleapis.com', 'x-email', options.emailAddress);

  // Store SA key JSON in vault — accept inline JSON content or file path
  const saKeyRaw =
    options.serviceAccountKeyJson ??
    (options.serviceAccountKeyPath
      ? await fsp.readFile(options.serviceAccountKeyPath, 'utf-8')
      : undefined);
  if (saKeyRaw) {
    const saKeyContent = saKeyRaw.trim();
    // Validate it's valid JSON with required fields
    const saKeyParsed = JSON.parse(saKeyContent) as Record<string, unknown>;
    if (!saKeyParsed['client_email'] || !saKeyParsed['private_key']) {
      return {
        success: false,
        message: 'Invalid service account key: missing client_email or private_key',
      };
    }
    setOrUpdate('gmail-service-account-key', 'pubsub.googleapis.com', 'x-sa-key', saKeyContent);
    log('Service account key stored in encrypted vault');
  }

  await credStore.save(rules);
  log('Gmail credentials stored in encrypted vault');

  // Load existing config or start fresh
  let existing: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    const raw = await fsp.readFile(configPath, 'utf-8');
    const { parse: parseYaml } = await import('yaml');
    const parsed: unknown = parseYaml(raw);
    if (parsed && typeof parsed === 'object') {
      existing = parsed as Record<string, unknown>;
    }
  }

  // Build Gmail config (no secrets in config file)
  const gmailConfig: Record<string, unknown> = {
    enabled: true,
    emailAddress: options.emailAddress,
    transport,
    oauthClientId: options.oauthClientId,
    oauthClientSecret: options.oauthClientSecret,
  };
  if (options.gcpProject) gmailConfig['gcpProject'] = options.gcpProject;
  // Note: serviceAccountKeyPath is NOT written to config — the SA key is stored
  // in the encrypted vault and materialized to tmpfs at runtime.
  if (options.notificationChannel) {
    gmailConfig['notificationChannel'] = options.notificationChannel;
  }

  // Merge into channels config
  const channels = (existing['channels'] as Record<string, unknown>) ?? {};
  channels['gmail'] = gmailConfig;
  existing['channels'] = channels;

  // Write config
  await fsp.writeFile(configPath, stringifyYaml(existing), 'utf-8');
  log(`Gmail channel configured in ${configPath}`);
  log('');

  // Transport-specific notes
  if (transport === 'pubsub') {
    log(`Transport: Pub/Sub REST pull (GCP project: ${options.gcpProject ?? 'not set'})`);
    if (!options.serviceAccountKeyPath) {
      log('');
      log('Note: You also need a GCP service account with Pub/Sub Subscriber role.');
      log('Re-run with --service-account-key /path/to/key.json (stored in encrypted vault).');
    }
    log('');
    log('Pub/Sub setup checklist:');
    log('  1. Enable Gmail API and Cloud Pub/Sub API in your GCP project');
    log('  2. Create a Pub/Sub topic named "flowhelm-gmail"');
    log('  3. Create a pull subscription named "flowhelm-gmail-sub"');
    log('  4. Grant gmail-api-push@system.gserviceaccount.com publish rights on the topic');
  } else {
    log('Transport: IMAP IDLE (no GCP required)');
    log('');
    log('IMAP connects directly to imap.gmail.com using OAuth2.');
    log('Ensure "Less secure app access" is not required (OAuth2 bypasses it).');
  }

  log('');

  // Recommend skill installs
  const gmailInstalled = await ctx.skillStore.isInstalled('gmail');
  const calendarInstalled = await ctx.skillStore.isInstalled('calendar');

  if (!gmailInstalled || !calendarInstalled) {
    log('Recommended skills:');
    if (!gmailInstalled) {
      log('  flowhelm install gmail     (email operations: compose, reply, search, labels)');
    }
    if (!calendarInstalled) {
      log('  flowhelm install calendar  (event management: create, check availability)');
    }
    log('');
    log("The channel works without skills — the agent just won't know");
    log('about Gmail-specific operations like search syntax or label management.');
  } else {
    log('Gmail and calendar skills are already installed.');
  }

  return { success: true, message: 'Gmail channel configured' };
}

/**
 * Setup agent and user identity in one command.
 *
 * Usage: flowhelm setup identity --agent-role "..." [--agent-tone "..."]
 *        [--agent-expertise "a,b,c"] [--user-name "..."] [--user-role "..."]
 *        [--user-timezone "..."]
 */
export async function setupIdentityCommand(
  options: {
    agentRole?: string;
    agentTone?: string;
    agentExpertise?: string;
    agentInstructions?: string;
    userName?: string;
    userRole?: string;
    userOrg?: string;
    userTimezone?: string;
    userLanguage?: string;
    userNotes?: string;
  },
  ctx: IdentityCliContext,
): Promise<CliResult> {
  const log = ctx.log ?? console.log;
  let changed = false;

  // Resolve default profile
  const profileId = await resolveProfileId(undefined, ctx);
  if (!profileId) {
    return {
      success: false,
      message: 'No default profile found. Run the orchestrator first to initialize the database.',
    };
  }

  // Set agent identity
  if (options.agentRole) {
    const existing = await ctx.identityManager.getAgentIdentity(profileId);
    const role = options.agentRole;
    const tone = options.agentTone ?? existing?.tone ?? 'Helpful and professional';
    const expertise = options.agentExpertise
      ? options.agentExpertise
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : (existing?.expertise ?? []);
    const instructions = options.agentInstructions ?? existing?.instructions;

    await ctx.identityManager.setAgentIdentity(profileId, { role, tone, expertise, instructions });
    log(`Agent identity set: ${role}`);
    changed = true;
  }

  // Set user identity
  if (options.userName) {
    await ctx.identityManager.updateUserIdentity({
      name: options.userName,
      role: options.userRole,
      organization: options.userOrg,
      timezone: options.userTimezone,
      language: options.userLanguage,
      notes: options.userNotes,
    });
    log(`User identity set: ${options.userName}`);
    changed = true;
  }

  if (!changed) {
    log('No identity fields specified.');
    log('');
    log('Usage: flowhelm setup identity \\');
    log('  --agent-role "Personal assistant" \\');
    log('  --agent-tone "Friendly, concise" \\');
    log('  --agent-expertise "email,scheduling,research" \\');
    log('  --user-name "Stan Tyan" \\');
    log('  --user-role "CTO" \\');
    log('  --user-timezone "Europe/Helsinki"');
    return { success: true, message: 'No changes' };
  }

  log('');
  log('Identity configured. Your agent will use this persona from the next message.');
  log('You can also adjust identity from any channel:');
  log('  /identity set agent role=...');
  log('  /identity set user name=...');

  return { success: true, message: 'Identity configured' };
}

/**
 * Parse and dispatch CLI commands.
 */
export async function dispatchCommand(args: string[], ctx: CliContext): Promise<CliResult> {
  const command = args[0];
  const errFn = ctx.error ?? console.error;

  switch (command) {
    case 'install':
      if (!args[1]) {
        errFn('Usage: flowhelm install <name|path>');
        return { success: false, message: 'Missing skill name' };
      }
      return installCommand(args[1], ctx);

    case 'uninstall':
      if (!args[1]) {
        errFn('Usage: flowhelm uninstall <name>');
        return { success: false, message: 'Missing skill name' };
      }
      return uninstallCommand(args[1], ctx);

    case 'list':
      return listCommand(ctx);

    case 'search':
      if (!args[1]) {
        errFn('Usage: flowhelm search <query>');
        return { success: false, message: 'Missing search query' };
      }
      return searchCommand(args[1], ctx);

    case 'info':
      if (!args[1]) {
        errFn('Usage: flowhelm info <name>');
        return { success: false, message: 'Missing skill name' };
      }
      return infoCommand(args[1], ctx);

    case 'update':
      return updateCommand(args[1], ctx);

    case 'setup':
      // Dispatch setup subcommands
      return dispatchSetupCommand(args.slice(1), ctx, errFn);

    default:
      errFn(`Unknown command: ${command ?? '(none)'}`);
      errFn(
        'Commands: install, uninstall, list, search, info, update, setup, identity, personality, admin',
      );
      return { success: false, message: `Unknown command: ${command ?? '(none)'}` };
  }
}

/** Parse and dispatch setup subcommands. */
async function dispatchSetupCommand(
  args: string[],
  ctx: CliContext,
  errFn: (msg: string) => void,
): Promise<CliResult> {
  const subcommand = args[0];

  switch (subcommand) {
    case 'telegram': {
      const botToken = extractFlag(args, 'bot-token');
      if (!botToken) {
        errFn('Usage: flowhelm setup telegram --bot-token <token> [--allowed-users 123,456]');
        return { success: false, message: 'Missing --bot-token' };
      }

      const allowedUsersStr = extractFlag(args, 'allowed-users');
      const allowedUsers = allowedUsersStr
        ? allowedUsersStr
            .split(',')
            .map((s) => Number(s.trim()))
            .filter((n) => !isNaN(n))
        : undefined;

      // Build setup context from CLI context
      const setupCtx: SetupContext = {
        configDir: path.resolve((process.env['HOME'] ?? '~') + '/.flowhelm'),
        skillStore: ctx.skillStore,
        registryClient: ctx.registryClient,
        log: ctx.log,
        error: ctx.error,
      };

      return setupTelegramCommand({ botToken, allowedUsers }, setupCtx);
    }

    case 'gmail': {
      const email = extractFlag(args, 'email');
      if (!email) {
        errFn(
          'Usage: flowhelm setup gmail --email <addr> --client-id <id> --client-secret <secret> --refresh-token <token> [--gcp-project <id>] [--service-account-key <path>] [--transport pubsub|imap] [--notification-channel telegram|whatsapp]',
        );
        return { success: false, message: 'Missing --email' };
      }
      const clientId = extractFlag(args, 'client-id');
      const clientSecret = extractFlag(args, 'client-secret');
      const refreshToken = extractFlag(args, 'refresh-token');
      if (!clientId || !clientSecret || !refreshToken) {
        errFn('Missing required OAuth flags: --client-id, --client-secret, --refresh-token');
        return { success: false, message: 'Missing OAuth credentials' };
      }

      const setupCtx: SetupContext = {
        configDir: path.resolve((process.env['HOME'] ?? '~') + '/.flowhelm'),
        skillStore: ctx.skillStore,
        registryClient: ctx.registryClient,
        log: ctx.log,
        error: ctx.error,
      };

      // --service-account-key accepts either a file path or inline JSON content
      const saKeyValue = extractFlag(args, 'service-account-key');
      const saKeyIsJson = saKeyValue?.trimStart().startsWith('{');

      return setupGmailCommand(
        {
          emailAddress: email,
          oauthClientId: clientId,
          oauthClientSecret: clientSecret,
          oauthRefreshToken: refreshToken,
          gcpProject: extractFlag(args, 'gcp-project'),
          serviceAccountKeyPath: saKeyIsJson ? undefined : saKeyValue,
          serviceAccountKeyJson: saKeyIsJson ? saKeyValue : undefined,
          transport: (extractFlag(args, 'transport') as 'pubsub' | 'imap') ?? 'pubsub',
          notificationChannel: extractFlag(args, 'notification-channel') as
            | 'telegram'
            | 'whatsapp'
            | undefined,
        },
        setupCtx,
      );
    }

    case 'voice': {
      // Delegate to the interactive voice section from the setup wizard
      const { createInterface } = await import('node:readline');
      const { runSetupVoice } = await import('./setup-wizard.js');
      const voiceConfigDir = path.resolve((process.env['HOME'] ?? '~') + '/.flowhelm');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const voiceFlags: Record<string, string> = {};
        const provider = extractFlag(args, 'provider');
        const model = extractFlag(args, 'voice-model') ?? extractFlag(args, 'model');
        const openaiKey = extractFlag(args, 'openai-key');
        const language = extractFlag(args, 'language');
        if (provider) voiceFlags['voice'] = provider;
        if (model) voiceFlags['voice-model'] = model;
        if (openaiKey) voiceFlags['openai-key'] = openaiKey;
        if (language) voiceFlags['language'] = language;
        const hasFlags = Object.keys(voiceFlags).length > 0;
        const result = await runSetupVoice({
          rl,
          output: process.stdout,
          configDir: voiceConfigDir,
          flags: hasFlags ? voiceFlags : undefined,
        });
        return {
          success: result.completed,
          message: result.completed
            ? 'Voice transcription configured. Restart FlowHelm to apply.'
            : 'Voice setup incomplete',
        };
      } finally {
        rl.close();
      }
    }

    default:
      errFn(`Unknown setup target: ${subcommand ?? '(none)'}`);
      errFn(
        'Available: flowhelm setup telegram, flowhelm setup gmail, flowhelm setup identity, flowhelm setup voice',
      );
      return { success: false, message: `Unknown setup target: ${subcommand ?? '(none)'}` };
  }
}

// ─── Admin Commands ────────────────────────────────────────────────────────

export interface AdminContext {
  /** Port registry instance. */
  portRegistry: PortRegistry;
  /** User manager instance. */
  userManager: UserManager;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
}

/**
 * Create an AdminContext with default paths.
 */
export function createAdminContext(options?: {
  registryPath?: string;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
}): AdminContext {
  const portRegistry = new PortRegistry({ registryPath: options?.registryPath });
  const userManager = new UserManager({
    portRegistry,
    log: options?.log,
  });
  return {
    portRegistry,
    userManager,
    log: options?.log,
    error: options?.error,
  };
}

/**
 * flowhelm admin init — first-time VM setup.
 */
export async function adminInitCommand(ctx: AdminContext): Promise<CliResult> {
  const log = ctx.log ?? console.log;

  // 1. Verify running as root
  if (process.getuid && process.getuid() !== 0) {
    return { success: false, message: 'flowhelm admin init must be run as root' };
  }

  // 2. Create /etc/flowhelm/
  log('Creating /etc/flowhelm/...');
  await fsp.mkdir('/etc/flowhelm', { recursive: true });

  // 3. Verify Podman
  log('Verifying Podman...');
  try {
    const { execFile: execFileCb } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFileCb);
    const { stdout } = await execFileAsync('podman', ['--version']);
    log(`  ${stdout.trim()}`);
  } catch {
    return { success: false, message: 'Podman is not installed. Install it first.' };
  }

  // 4. Verify cgroups v2
  log('Checking cgroups v2...');
  const cgroupsOk = await isCgroupsV2Available();
  if (cgroupsOk) {
    log('  cgroups v2 active');
  } else {
    log('  WARNING: cgroups v2 not detected. Per-user resource limits will not work.');
  }

  // 5. Verify Node.js
  log('Checking Node.js...');
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.slice(1).split('.')[0] ?? '0', 10);
  if (major < 22) {
    return { success: false, message: `Node.js 22+ required. Found: ${nodeVersion}` };
  }
  log(`  Node.js ${nodeVersion}`);

  // 6. Initialize port registry
  log('Initializing port registry...');
  await ctx.portRegistry.init();
  log(`  ${ctx.portRegistry.registryPath}`);

  log('');
  log('FlowHelm admin initialized.');
  log('');
  log('Next steps:');
  log('  flowhelm admin add-user <name> --ssh-key <path>');

  return { success: true, message: 'Admin initialized' };
}

/**
 * flowhelm admin add-user <name> --ssh-key <path> [--ram-limit 4G] [--cpu-limit 2]
 */
export async function adminAddUserCommand(args: string[], ctx: AdminContext): Promise<CliResult> {
  const errFn = ctx.error ?? console.error;
  const name = args[0];
  if (!name || name.startsWith('--')) {
    errFn(
      'Usage: flowhelm admin add-user <name> --ssh-key <path> [--ram-limit 4G] [--cpu-limit 2]',
    );
    return { success: false, message: 'Missing username' };
  }

  const sshKeyPath = extractFlag(args, 'ssh-key');
  if (!sshKeyPath) {
    errFn('Missing --ssh-key flag');
    return { success: false, message: 'Missing --ssh-key' };
  }

  const ramLimit = extractFlag(args, 'ram-limit');
  const cpuLimitStr = extractFlag(args, 'cpu-limit');
  const maxAgentsStr = extractFlag(args, 'max-agents');
  const agentRuntime = extractFlag(args, 'agent-runtime') as 'cli' | 'sdk' | undefined;

  return ctx.userManager.addUser({
    name,
    sshKeyPath,
    ramLimit: ramLimit ?? undefined,
    cpuLimit: cpuLimitStr ? parseFloat(cpuLimitStr) : undefined,
    maxAgents: maxAgentsStr ? parseInt(maxAgentsStr, 10) : undefined,
    agentRuntime,
  });
}

/**
 * flowhelm admin remove-user <name> --archive|--force
 */
export async function adminRemoveUserCommand(
  args: string[],
  ctx: AdminContext,
): Promise<CliResult> {
  const errFn = ctx.error ?? console.error;
  const name = args[0];
  if (!name || name.startsWith('--')) {
    errFn('Usage: flowhelm admin remove-user <name> --archive|--force');
    return { success: false, message: 'Missing username' };
  }

  const archive = args.includes('--archive');
  const force = args.includes('--force');

  return ctx.userManager.removeUser({ name, archive, force });
}

/**
 * flowhelm admin status — resource dashboard.
 */
export async function adminStatusCommand(ctx: AdminContext): Promise<CliResult> {
  const log = ctx.log ?? console.log;

  const users = await ctx.userManager.listUsers();
  if (users.length === 0) {
    log('No users provisioned.');
    log('Run: flowhelm admin add-user <name> --ssh-key <path>');
    return { success: true, message: 'No users' };
  }

  log(`FlowHelm users: ${String(users.length)}`);
  log('');
  log('  User              Linux User          Ports                    Service');
  log('  ────              ──────────          ─────                    ───────');

  for (const user of users) {
    const ports = user.ports
      ? `${String(user.ports.ports.proxy)}/${String(user.ports.ports.channel)}/${String(user.ports.ports.service)}/${String(user.ports.ports.database)}`
      : 'n/a';
    const service = user.hasService ? 'installed' : 'missing';

    log(`  ${user.name.padEnd(18)}${user.linuxUser.padEnd(20)}${ports.padEnd(25)}${service}`);

    // Try to get resource usage (may fail on macOS or without cgroups)
    try {
      const usage = await readUsage(user.linuxUser);
      if (usage.memoryBytes > 0) {
        const memStr = formatBytes(usage.memoryBytes);
        const limitStr =
          usage.memoryLimitBytes > 0 ? formatBytes(usage.memoryLimitBytes) : 'unlimited';
        log(`    Memory: ${memStr} / ${limitStr}`);
      }
    } catch {
      // Skip resource usage on non-Linux
    }
  }

  return { success: true, message: `${String(users.length)} user(s)` };
}

/**
 * flowhelm admin set-limits <name> --ram-limit 4G --cpu-limit 2
 */
export async function adminSetLimitsCommand(args: string[], ctx: AdminContext): Promise<CliResult> {
  const errFn = ctx.error ?? console.error;
  const log = ctx.log ?? console.log;

  const name = args[0];
  if (!name || name.startsWith('--')) {
    errFn('Usage: flowhelm admin set-limits <name> --ram-limit 4G --cpu-limit 2');
    return { success: false, message: 'Missing username' };
  }

  const linuxUser = ctx.userManager.linuxUser(name);
  const ramLimit = extractFlag(args, 'ram-limit');
  const cpuLimitStr = extractFlag(args, 'cpu-limit');

  if (!ramLimit && !cpuLimitStr) {
    errFn('Specify at least one of --ram-limit or --cpu-limit');
    return { success: false, message: 'No limits specified' };
  }

  try {
    await setLimits(linuxUser, {
      ramLimit: ramLimit ?? undefined,
      cpuLimit: cpuLimitStr ? parseFloat(cpuLimitStr) : undefined,
    });

    if (ramLimit) log(`  RAM limit set to ${ramLimit} for ${name}`);
    if (cpuLimitStr) log(`  CPU limit set to ${cpuLimitStr} core(s) for ${name}`);

    return { success: true, message: `Limits updated for "${name}"` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: `Failed to set limits: ${msg}` };
  }
}

/**
 * Dispatch admin subcommands.
 */
export async function dispatchAdminCommand(args: string[], ctx: AdminContext): Promise<CliResult> {
  const errFn = ctx.error ?? console.error;
  const subcommand = args[0];

  switch (subcommand) {
    case 'init':
      return adminInitCommand(ctx);
    case 'add-user':
      return adminAddUserCommand(args.slice(1), ctx);
    case 'remove-user':
      return adminRemoveUserCommand(args.slice(1), ctx);
    case 'status':
      return adminStatusCommand(ctx);
    case 'set-limits':
      return adminSetLimitsCommand(args.slice(1), ctx);
    case 'backup': {
      const { adminBackupCommand } = await import('./backup.js');
      return adminBackupCommand(args.slice(1), ctx);
    }
    case 'restore': {
      const { adminRestoreCommand } = await import('./backup.js');
      return adminRestoreCommand(args.slice(1), ctx);
    }
    default:
      errFn(`Unknown admin command: ${subcommand ?? '(none)'}`);
      errFn('Commands: init, add-user, remove-user, status, set-limits, backup, restore');
      return { success: false, message: `Unknown admin command: ${subcommand ?? '(none)'}` };
  }
}

/** Extract a --flag value from args. */
export function extractFlag(args: string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === `--${flag}` && args[i + 1]) {
      return args[i + 1];
    }
    if (arg?.startsWith(`--${flag}=`)) {
      return arg.slice(`--${flag}=`.length);
    }
  }
  return undefined;
}
