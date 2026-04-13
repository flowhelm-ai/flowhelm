/**
 * Channel command handler.
 *
 * Intercepts /-prefixed commands from channels (Telegram, WhatsApp, etc.)
 * before they reach the agent. Commands are executed directly against the
 * database — zero API token cost, instant response.
 *
 * Supported commands: /identity, /personality, /profile, /help
 *
 * See Phase 10C in docs/implementation-plan.md.
 */

import type { IdentityManager } from './identity.js';
import type { ProfileManager } from './profile-manager.js';
import type { AgentPersonalityDimension, UserPersonalityDimension } from './types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ChannelCommandResult {
  /** Whether a command was recognized and handled. */
  handled: boolean;
  /** Response text to send back to the channel (if handled). */
  response?: string;
}

export interface ChannelCommandContext {
  /** Chat ID for profile resolution. */
  chatId: string;
  identityManager: IdentityManager;
  profileManager: ProfileManager;
}

// ─── Constants ──────────────────────────────────────────────────────────────

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

// ─── ChannelCommandHandler ──────────────────────────────────────────────────

export class ChannelCommandHandler {
  private readonly identity: IdentityManager;
  private readonly profileManager: ProfileManager;

  constructor(identity: IdentityManager, profileManager: ProfileManager) {
    this.identity = identity;
    this.profileManager = profileManager;
  }

  /**
   * Try to handle a message as a channel command.
   *
   * Returns `{ handled: false }` if the message is not a recognized command,
   * allowing it to pass through to the agent.
   */
  async handle(text: string, chatId: string): Promise<ChannelCommandResult> {
    const trimmed = text.trim();
    if (!trimmed.startsWith('/')) {
      return { handled: false };
    }

    // Tokenize: split on whitespace, preserving values after =
    const tokens = tokenize(trimmed);
    const command = tokens[0]?.toLowerCase();

    switch (command) {
      case '/identity':
        return this.handleIdentity(tokens.slice(1), chatId);
      case '/personality':
        return this.handlePersonality(tokens.slice(1), chatId);
      case '/profile':
        return this.handleProfile(tokens.slice(1), chatId);
      case '/help':
        return this.handleHelp(tokens.slice(1));
      default:
        // Not a recognized command — pass through to agent
        return { handled: false };
    }
  }

  // ── /identity ──────────────────────────────────────────────────────────

  private async handleIdentity(args: string[], chatId: string): Promise<ChannelCommandResult> {
    const sub = args[0]?.toLowerCase();

    if (!sub || sub === 'show') {
      return this.identityShow(chatId);
    }

    if (sub === 'set') {
      const target = args[1]?.toLowerCase();
      if (target === 'agent') {
        return this.identitySetAgent(args.slice(2), chatId);
      }
      if (target === 'user') {
        return this.identitySetUser(args.slice(2));
      }
      return ok('Usage:\n/identity set agent role=...\n/identity set user name=...');
    }

    return ok(
      'Usage:\n/identity show\n/identity set agent <field>=<value>\n/identity set user <field>=<value>',
    );
  }

  private async identityShow(chatId: string): Promise<ChannelCommandResult> {
    const profileId = await this.resolveProfileId(chatId);
    const lines: string[] = [];

    // Agent identity
    if (profileId) {
      const agent = await this.identity.getAgentIdentity(profileId);
      if (agent) {
        lines.push('Agent Identity:');
        lines.push(`  Role: ${agent.role}`);
        lines.push(`  Tone: ${agent.tone}`);
        lines.push(
          `  Expertise: ${agent.expertise.length > 0 ? agent.expertise.join(', ') : '(none)'}`,
        );
        if (agent.instructions) lines.push(`  Instructions: ${agent.instructions}`);
      } else {
        lines.push('Agent Identity: (not configured)');
      }
    } else {
      lines.push('Agent Identity: (no profile)');
    }

    // User identity
    const user = await this.identity.getUserIdentity();
    if (user) {
      lines.push('');
      lines.push('User Identity:');
      if (user.name) lines.push(`  Name: ${user.name}`);
      if (user.role) lines.push(`  Role: ${user.role}`);
      if (user.organization) lines.push(`  Organization: ${user.organization}`);
      if (user.timezone) lines.push(`  Timezone: ${user.timezone}`);
      if (user.language) lines.push(`  Language: ${user.language}`);
    } else {
      lines.push('');
      lines.push('User Identity: (not configured)');
    }

    return ok(lines.join('\n'));
  }

  private async identitySetAgent(args: string[], chatId: string): Promise<ChannelCommandResult> {
    const fields = parseKeyValuePairs(args);
    if (Object.keys(fields).length === 0) {
      return ok(
        'Usage: /identity set agent role=Executive assistant\n' +
          'Fields: role, tone, expertise, instructions',
      );
    }

    const profileId = await this.resolveProfileId(chatId);
    if (!profileId) {
      return ok('No profile assigned to this chat.');
    }

    // Merge with existing
    const existing = await this.identity.getAgentIdentity(profileId);
    const role = fields['role'] ?? existing?.role;
    const tone = fields['tone'] ?? existing?.tone;

    if (!role || !tone) {
      return ok(
        'Both role and tone are required when creating agent identity.\n' +
          'Example: /identity set agent role=Assistant, tone=Professional',
      );
    }

    const expertise = fields['expertise']
      ? fields['expertise']
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : (existing?.expertise ?? []);
    const instructions = fields['instructions'] ?? existing?.instructions;

    await this.identity.setAgentIdentity(profileId, {
      role,
      expertise,
      tone,
      instructions,
    });

    return ok('Agent identity updated.');
  }

  private async identitySetUser(args: string[]): Promise<ChannelCommandResult> {
    const fields = parseKeyValuePairs(args);
    if (Object.keys(fields).length === 0) {
      return ok(
        'Usage: /identity set user name=Stan Tyan\n' +
          'Fields: name, role, org, timezone, language',
      );
    }

    await this.identity.updateUserIdentity({
      name: fields['name'],
      role: fields['role'],
      organization: fields['org'],
      timezone: fields['timezone'],
      language: fields['language'],
    });

    return ok('User identity updated.');
  }

  // ── /personality ───────────────────────────────────────────────────────

  private async handlePersonality(args: string[], chatId: string): Promise<ChannelCommandResult> {
    const sub = args[0]?.toLowerCase();

    if (!sub || sub === 'show') {
      return this.personalityShow(chatId);
    }

    if (sub === 'set') {
      const target = args[1]?.toLowerCase();
      if (target === 'agent') {
        return this.personalitySetAgent(args.slice(2), chatId);
      }
      if (target === 'user') {
        return this.personalitySetUser(args.slice(2));
      }
      return ok(
        'Usage:\n/personality set agent <dimension>=<content>\n/personality set user <dimension>=<content>',
      );
    }

    if (sub === 'reset') {
      const target = args[1]?.toLowerCase();
      if (target === 'agent') {
        return this.personalityResetAgent(args.slice(2), chatId);
      }
      if (target === 'user') {
        return this.personalityResetUser(args.slice(2));
      }
      return ok(
        'Usage:\n/personality reset agent <dimension>\n/personality reset user <dimension>',
      );
    }

    return ok(
      'Usage:\n/personality show\n/personality set agent|user <dimension>=<content>\n/personality reset agent|user <dimension>',
    );
  }

  private async personalityShow(chatId: string): Promise<ChannelCommandResult> {
    const profileId = await this.resolveProfileId(chatId);
    const lines: string[] = [];

    // Agent personality
    if (profileId) {
      const agentEntries = await this.identity.getAgentPersonality(profileId);
      if (agentEntries.length > 0) {
        lines.push('Agent Personality:');
        for (const e of agentEntries) {
          lines.push(`  ${e.dimension}: ${e.content} (confidence: ${e.confidence.toFixed(2)})`);
        }
      } else {
        lines.push('Agent Personality: (none configured)');
      }
    } else {
      lines.push('Agent Personality: (no profile)');
    }

    // User personality
    const userEntries = await this.identity.getUserPersonality();
    if (userEntries.length > 0) {
      lines.push('');
      lines.push('User Personality:');
      for (const e of userEntries) {
        lines.push(
          `  ${e.dimension}: ${e.content} (confidence: ${e.confidence.toFixed(2)}, source: ${e.source})`,
        );
      }
    } else {
      lines.push('');
      lines.push('User Personality: (none configured)');
    }

    return ok(lines.join('\n'));
  }

  private async personalitySetAgent(args: string[], chatId: string): Promise<ChannelCommandResult> {
    // Expect: dimension=content (the dimension is the key, content is the value)
    const fields = parseKeyValuePairs(args);
    const entries = Object.entries(fields);

    if (entries.length === 0) {
      return ok(
        'Usage: /personality set agent communication_style=Concise, uses bullet points\n' +
          `Valid dimensions: ${AGENT_PERSONALITY_DIMENSIONS.join(', ')}`,
      );
    }

    const profileId = await this.resolveProfileId(chatId);
    if (!profileId) {
      return ok('No profile assigned to this chat.');
    }

    const results: string[] = [];
    for (const [key, value] of entries) {
      if (!AGENT_PERSONALITY_DIMENSIONS.includes(key as AgentPersonalityDimension)) {
        results.push(
          `Invalid dimension "${key}". Valid: ${AGENT_PERSONALITY_DIMENSIONS.join(', ')}`,
        );
        continue;
      }
      await this.identity.observeAgentPersonality(
        profileId,
        key as AgentPersonalityDimension,
        value,
      );
      results.push(`Agent personality "${key}" updated.`);
    }

    return ok(results.join('\n'));
  }

  private async personalitySetUser(args: string[]): Promise<ChannelCommandResult> {
    const fields = parseKeyValuePairs(args);
    const entries = Object.entries(fields);

    if (entries.length === 0) {
      return ok(
        'Usage: /personality set user work_patterns=Active 9am-6pm\n' +
          `Valid dimensions: ${USER_PERSONALITY_DIMENSIONS.join(', ')}`,
      );
    }

    const results: string[] = [];
    for (const [key, value] of entries) {
      if (!USER_PERSONALITY_DIMENSIONS.includes(key as UserPersonalityDimension)) {
        results.push(
          `Invalid dimension "${key}". Valid: ${USER_PERSONALITY_DIMENSIONS.join(', ')}`,
        );
        continue;
      }
      await this.identity.observeUserPersonality(
        key as UserPersonalityDimension,
        value,
        'declared',
      );
      results.push(`User personality "${key}" updated.`);
    }

    return ok(results.join('\n'));
  }

  private async personalityResetAgent(
    args: string[],
    chatId: string,
  ): Promise<ChannelCommandResult> {
    const dimension = args.join(' ').trim().toLowerCase();
    if (!dimension) {
      return ok(
        'Usage: /personality reset agent <dimension>\n' +
          `Valid dimensions: ${AGENT_PERSONALITY_DIMENSIONS.join(', ')}`,
      );
    }

    if (!AGENT_PERSONALITY_DIMENSIONS.includes(dimension as AgentPersonalityDimension)) {
      return ok(
        `Invalid dimension "${dimension}". Valid: ${AGENT_PERSONALITY_DIMENSIONS.join(', ')}`,
      );
    }

    const profileId = await this.resolveProfileId(chatId);
    if (!profileId) {
      return ok('No profile assigned to this chat.');
    }

    const deleted = await this.identity.deleteAgentPersonality(
      profileId,
      dimension as AgentPersonalityDimension,
    );

    if (deleted) {
      return ok(
        `Agent personality "${dimension}" reset. The agent can re-infer it from conversation.`,
      );
    }
    return ok(`No agent personality "${dimension}" found to reset.`);
  }

  private async personalityResetUser(args: string[]): Promise<ChannelCommandResult> {
    const dimension = args.join(' ').trim().toLowerCase();
    if (!dimension) {
      return ok(
        'Usage: /personality reset user <dimension>\n' +
          `Valid dimensions: ${USER_PERSONALITY_DIMENSIONS.join(', ')}`,
      );
    }

    if (!USER_PERSONALITY_DIMENSIONS.includes(dimension as UserPersonalityDimension)) {
      return ok(
        `Invalid dimension "${dimension}". Valid: ${USER_PERSONALITY_DIMENSIONS.join(', ')}`,
      );
    }

    const deleted = await this.identity.deleteUserPersonality(
      dimension as UserPersonalityDimension,
    );

    if (deleted) {
      return ok(
        `User personality "${dimension}" reset. The agent can re-infer it from conversation.`,
      );
    }
    return ok(`No user personality "${dimension}" found to reset.`);
  }

  // ── /profile ───────────────────────────────────────────────────────────

  private async handleProfile(args: string[], chatId: string): Promise<ChannelCommandResult> {
    const sub = args[0]?.toLowerCase();

    if (!sub || sub === 'list') {
      return this.profileList();
    }

    if (sub === 'show') {
      return this.profileShow(chatId);
    }

    if (sub === 'switch') {
      const name = args.slice(1).join(' ').trim();
      if (!name) {
        return ok('Usage: /profile switch <name>');
      }
      return this.profileSwitch(name, chatId);
    }

    return ok('Usage:\n/profile list\n/profile show\n/profile switch <name>');
  }

  private async profileList(): Promise<ChannelCommandResult> {
    const profiles = await this.profileManager.listProfiles();
    if (profiles.length === 0) {
      return ok('No profiles configured.');
    }

    const lines = ['Profiles:'];
    for (const p of profiles) {
      const marker = p.isDefault ? ' (default)' : '';
      const desc = p.description ? ` — ${p.description}` : '';
      lines.push(
        `  ${p.name}${marker}${desc} [${String(p.chatCount)} chats, ${String(p.semanticMemoryCount)} memories]`,
      );
    }
    return ok(lines.join('\n'));
  }

  private async profileShow(chatId: string): Promise<ChannelCommandResult> {
    const profile = await this.profileManager.getChatProfile(chatId);
    if (!profile) {
      return ok('No profile assigned to this chat.');
    }

    const lines = [`Current profile: ${profile.name}`];
    if (profile.description) lines.push(`Description: ${profile.description}`);
    if (profile.isDefault) lines.push('(This is the default profile)');
    return ok(lines.join('\n'));
  }

  private async profileSwitch(name: string, chatId: string): Promise<ChannelCommandResult> {
    const profile = await this.profileManager.getProfileByName(name);
    if (!profile) {
      return ok(`Profile "${name}" not found. Use /profile list to see available profiles.`);
    }

    try {
      await this.profileManager.assignChat(chatId, profile.id);
      return ok(`Switched to profile "${name}".`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return ok(`Failed to switch profile: ${msg}`);
    }
  }

  // ── /help ──────────────────────────────────────────────────────────────

  private handleHelp(args: string[]): ChannelCommandResult {
    const topic = args[0]?.toLowerCase();

    if (topic === 'identity') {
      return ok(HELP_IDENTITY);
    }
    if (topic === 'personality') {
      return ok(HELP_PERSONALITY);
    }
    if (topic === 'profile') {
      return ok(HELP_PROFILE);
    }

    return ok(HELP_GENERAL);
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  /**
   * Resolve the profile ID for a chat. Falls back to default profile.
   */
  private async resolveProfileId(chatId: string): Promise<string | null> {
    const chatProfile = await this.profileManager.getChatProfile(chatId);
    if (chatProfile) return chatProfile.id;

    const defaultProfile = await this.profileManager.getDefaultProfile();
    return defaultProfile?.id ?? null;
  }
}

// ─── Parsing Utilities ──────────────────────────────────────────────────────

/**
 * Tokenize a command string. Splits on whitespace but preserves
 * values after `=` (everything after `=` until the next key=value pair
 * or end of string).
 */
function tokenize(input: string): string[] {
  return input.split(/\s+/).filter(Boolean);
}

/**
 * Parse key=value pairs from args. Handles comma-separated pairs
 * and values with spaces (everything after `=` until the next `key=`).
 *
 * Examples:
 *   ["role=Executive", "assistant"] → { role: "Executive assistant" }
 *   ["role=Dev,", "tone=Direct"]    → { role: "Dev", tone: "Direct" }
 *   ["name=Stan,", "role=CTO"]     → { name: "Stan", role: "CTO" }
 */
function parseKeyValuePairs(args: string[]): Record<string, string> {
  // Join all args back into a single string, then split on comma-separated pairs
  const joined = args.join(' ').trim();
  if (!joined) return {};

  // Split on commas that are followed by a key= pattern (word=)
  // This allows values to contain commas when there's no key= after them
  const result: Record<string, string> = {};
  const pairPattern = /(\w+)=([\s\S]*?)(?=,\s*\w+=|$)/g;
  let match: RegExpExecArray | null;

  while ((match = pairPattern.exec(joined)) !== null) {
    const key = (match[1] ?? '').toLowerCase();
    const value = (match[2] ?? '').trim();
    if (value) {
      // Remove trailing comma if present
      result[key] = value.replace(/,\s*$/, '');
    }
  }

  return result;
}

/**
 * Create a handled result with a response.
 */
function ok(response: string): ChannelCommandResult {
  return { handled: true, response };
}

// ─── Help Text ──────────────────────────────────────────────────────────────

const HELP_GENERAL = `Available commands:

/identity show — View agent and user identity
/identity set agent <field>=<value> — Set agent identity fields
/identity set user <field>=<value> — Set user identity fields

/personality show — View agent and user personality
/personality set agent <dim>=<content> — Set agent personality dimension
/personality set user <dim>=<content> — Set user personality dimension
/personality reset agent <dim> — Reset agent personality dimension
/personality reset user <dim> — Reset user personality dimension

/profile list — List all profiles
/profile show — Show current profile
/profile switch <name> — Switch to a different profile

/help [identity|personality|profile] — Show detailed help`;

const HELP_IDENTITY = `Identity commands:

/identity show
  View both agent and user identity.

/identity set agent role=Executive assistant
/identity set agent tone=Professional but warm
/identity set agent expertise=email, calendar, scheduling
/identity set agent instructions=Always draft emails first
  Set agent identity fields. Multiple: /identity set agent role=Dev, tone=Direct

/identity set user name=Stan Tyan
/identity set user role=CTO
/identity set user org=Acme Corp
/identity set user timezone=Europe/Helsinki
/identity set user language=en
  Set user identity fields. Multiple: /identity set user name=Stan, role=CTO`;

const HELP_PERSONALITY = `Personality commands:

/personality show
  View all agent and user personality dimensions.

Agent personality dimensions: ${AGENT_PERSONALITY_DIMENSIONS.join(', ')}
User personality dimensions: ${USER_PERSONALITY_DIMENSIONS.join(', ')}

/personality set agent communication_style=Concise, uses bullet points
/personality set agent humor=Dry humor OK. No puns.
  Set agent personality dimensions.

/personality set user work_patterns=Active 9am-6pm
/personality set user communication_style=Short and direct
  Declare your personality dimensions.

/personality reset agent humor
/personality reset user decision_making
  Reset a dimension (let the agent re-infer it from conversations).`;

const HELP_PROFILE = `Profile commands:

/profile list
  List all profiles with stats.

/profile show
  Show the current chat's profile.

/profile switch work-assistant
  Switch this chat to a different profile.`;
