import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  identityAgentShowCommand,
  identityAgentSetCommand,
  identityUserShowCommand,
  identityUserSetCommand,
  personalityAgentShowCommand,
  personalityAgentSetCommand,
  personalityAgentResetCommand,
  personalityUserShowCommand,
  personalityUserSetCommand,
  personalityUserResetCommand,
  dispatchIdentityCommand,
  dispatchPersonalityCommand,
  setupIdentityCommand,
  type IdentityCliContext,
} from '../src/admin/cli.js';
import { IdentityManager } from '../src/orchestrator/identity.js';
import { ProfileManager } from '../src/orchestrator/profile-manager.js';
import { createTestDatabase, applySchema } from './helpers/pg-container.js';
import type { Sql } from '../src/orchestrator/connection.js';

let sql: Sql;
let cleanup: () => Promise<void>;
let identityManager: IdentityManager;
let profileManager: ProfileManager;
let defaultProfileId: string;
let output: string[];

function makeCtx(): IdentityCliContext {
  output = [];
  return {
    identityManager,
    profileManager,
    log: (msg: string) => output.push(msg),
    error: (msg: string) => output.push(`ERR: ${msg}`),
  };
}

beforeEach(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;
  await applySchema(sql);

  identityManager = new IdentityManager({ sql });
  profileManager = new ProfileManager({ sql });

  // Schema seeds a 'default' profile — use it
  const profile = await profileManager.getDefaultProfile();
  defaultProfileId = profile!.id;
});

afterEach(async () => {
  await cleanup();
});

// ─── Identity Agent Commands ─────────────────────────────────────────────

describe('identity agent show', () => {
  it('shows message when no identity configured', async () => {
    const result = await identityAgentShowCommand({}, makeCtx());
    expect(result.success).toBe(true);
    expect(output.some((l) => l.includes('No agent identity'))).toBe(true);
  });

  it('displays agent identity fields', async () => {
    await identityManager.setAgentIdentity(defaultProfileId, {
      role: 'Executive assistant',
      expertise: ['email', 'calendar'],
      tone: 'Professional but warm',
      instructions: 'Always draft emails first',
    });

    const result = await identityAgentShowCommand({}, makeCtx());
    expect(result.success).toBe(true);
    expect(output.some((l) => l.includes('Executive assistant'))).toBe(true);
    expect(output.some((l) => l.includes('email, calendar'))).toBe(true);
    expect(output.some((l) => l.includes('Professional but warm'))).toBe(true);
    expect(output.some((l) => l.includes('Always draft emails first'))).toBe(true);
  });

  it('fails for non-existent profile', async () => {
    const result = await identityAgentShowCommand({ profile: 'nope' }, makeCtx());
    expect(result.success).toBe(false);
    expect(result.message).toContain('not found');
  });
});

describe('identity agent set', () => {
  it('creates new agent identity', async () => {
    const result = await identityAgentSetCommand(
      { role: 'Code reviewer', tone: 'Direct' },
      makeCtx(),
    );
    expect(result.success).toBe(true);

    const identity = await identityManager.getAgentIdentity(defaultProfileId);
    expect(identity?.role).toBe('Code reviewer');
    expect(identity?.tone).toBe('Direct');
  });

  it('merges with existing identity', async () => {
    await identityManager.setAgentIdentity(defaultProfileId, {
      role: 'Assistant',
      expertise: ['email'],
      tone: 'Friendly',
      instructions: 'Be helpful',
    });

    // Only update role — tone should be preserved
    const result = await identityAgentSetCommand({ role: 'Senior assistant' }, makeCtx());
    expect(result.success).toBe(true);

    const identity = await identityManager.getAgentIdentity(defaultProfileId);
    expect(identity?.role).toBe('Senior assistant');
    expect(identity?.tone).toBe('Friendly');
    expect(identity?.instructions).toBe('Be helpful');
  });

  it('parses comma-separated expertise', async () => {
    await identityAgentSetCommand(
      { role: 'Dev', tone: 'Direct', expertise: 'TypeScript, Go, Rust' },
      makeCtx(),
    );

    const identity = await identityManager.getAgentIdentity(defaultProfileId);
    expect(identity?.expertise).toEqual(['TypeScript', 'Go', 'Rust']);
  });

  it('requires role and tone for new identity', async () => {
    const result = await identityAgentSetCommand({ role: 'Dev' }, makeCtx());
    expect(result.success).toBe(false);
    expect(result.message).toContain('--role and --tone are required');
  });

  it('supports named profile', async () => {
    const other = await profileManager.createProfile('work', 'Work profile');
    await identityAgentSetCommand({ profile: 'work', role: 'Worker', tone: 'Formal' }, makeCtx());

    const identity = await identityManager.getAgentIdentity(other.id);
    expect(identity?.role).toBe('Worker');
  });
});

// ─── Identity User Commands ──────────────────────────────────────────────

describe('identity user show', () => {
  it('shows message when no identity configured', async () => {
    const result = await identityUserShowCommand(makeCtx());
    expect(result.success).toBe(true);
    expect(output.some((l) => l.includes('No user identity'))).toBe(true);
  });

  it('displays user identity fields', async () => {
    await identityManager.updateUserIdentity({
      name: 'Stan',
      role: 'CTO',
      organization: 'Acme',
      timezone: 'Europe/Helsinki',
    });

    const result = await identityUserShowCommand(makeCtx());
    expect(result.success).toBe(true);
    expect(output.some((l) => l.includes('Stan'))).toBe(true);
    expect(output.some((l) => l.includes('CTO'))).toBe(true);
    expect(output.some((l) => l.includes('Europe/Helsinki'))).toBe(true);
  });
});

describe('identity user set', () => {
  it('creates new user identity', async () => {
    const result = await identityUserSetCommand(
      { name: 'Stan', role: 'CTO', timezone: 'Europe/Helsinki' },
      makeCtx(),
    );
    expect(result.success).toBe(true);

    const identity = await identityManager.getUserIdentity();
    expect(identity?.name).toBe('Stan');
    expect(identity?.role).toBe('CTO');
  });

  it('merges with existing identity', async () => {
    await identityManager.updateUserIdentity({ name: 'Stan', role: 'CTO' });
    await identityUserSetCommand({ org: 'Acme Corp' }, makeCtx());

    const identity = await identityManager.getUserIdentity();
    expect(identity?.name).toBe('Stan');
    expect(identity?.organization).toBe('Acme Corp');
  });

  it('requires at least one field', async () => {
    const result = await identityUserSetCommand({}, makeCtx());
    expect(result.success).toBe(false);
  });
});

// ─── Personality Agent Commands ──────────────────────────────────────────

describe('personality agent show', () => {
  it('shows message when empty', async () => {
    const result = await personalityAgentShowCommand({}, makeCtx());
    expect(result.success).toBe(true);
    expect(output.some((l) => l.includes('No agent personality'))).toBe(true);
  });

  it('displays personality dimensions', async () => {
    await identityManager.observeAgentPersonality(
      defaultProfileId,
      'communication_style',
      'Concise, bullet points',
    );
    await identityManager.observeAgentPersonality(defaultProfileId, 'humor', 'Dry humor OK');

    const result = await personalityAgentShowCommand({}, makeCtx());
    expect(result.success).toBe(true);
    expect(output.some((l) => l.includes('communication_style'))).toBe(true);
    expect(output.some((l) => l.includes('humor'))).toBe(true);
    expect(result.message).toContain('2 dimension');
  });
});

describe('personality agent set', () => {
  it('creates personality dimension', async () => {
    const result = await personalityAgentSetCommand(
      { dimension: 'humor', content: 'Dry humor only' },
      makeCtx(),
    );
    expect(result.success).toBe(true);

    const entries = await identityManager.getAgentPersonality(defaultProfileId);
    expect(entries).toHaveLength(1);
    expect(entries[0].dimension).toBe('humor');
    expect(entries[0].content).toBe('Dry humor only');
  });

  it('rejects invalid dimension', async () => {
    const result = await personalityAgentSetCommand(
      { dimension: 'invalid', content: 'test' },
      makeCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain('Invalid dimension');
  });

  it('requires both dimension and content', async () => {
    const result = await personalityAgentSetCommand({ dimension: 'humor' }, makeCtx());
    expect(result.success).toBe(false);
  });
});

describe('personality agent reset', () => {
  it('deletes existing dimension', async () => {
    await identityManager.observeAgentPersonality(defaultProfileId, 'humor', 'Dry');
    const result = await personalityAgentResetCommand({ dimension: 'humor' }, makeCtx());
    expect(result.success).toBe(true);
    expect(output.some((l) => l.includes('reset'))).toBe(true);

    const entries = await identityManager.getAgentPersonality(defaultProfileId);
    expect(entries).toHaveLength(0);
  });

  it('handles non-existent dimension gracefully', async () => {
    const result = await personalityAgentResetCommand({ dimension: 'humor' }, makeCtx());
    expect(result.success).toBe(true);
    expect(result.message).toContain('Nothing to reset');
  });

  it('rejects invalid dimension', async () => {
    const result = await personalityAgentResetCommand({ dimension: 'nope' }, makeCtx());
    expect(result.success).toBe(false);
  });
});

// ─── Personality User Commands ───────────────────────────────────────────

describe('personality user show', () => {
  it('shows message when empty', async () => {
    const result = await personalityUserShowCommand(makeCtx());
    expect(result.success).toBe(true);
    expect(output.some((l) => l.includes('No user personality'))).toBe(true);
  });

  it('displays personality with source', async () => {
    await identityManager.observeUserPersonality('work_patterns', 'Active 9-6', 'declared');
    const result = await personalityUserShowCommand(makeCtx());
    expect(result.success).toBe(true);
    expect(output.some((l) => l.includes('work_patterns'))).toBe(true);
    expect(output.some((l) => l.includes('declared'))).toBe(true);
  });
});

describe('personality user set', () => {
  it('creates user personality with declared source', async () => {
    const result = await personalityUserSetCommand(
      { dimension: 'work_patterns', content: 'Active 9am-6pm' },
      makeCtx(),
    );
    expect(result.success).toBe(true);

    const entries = await identityManager.getUserPersonality();
    expect(entries).toHaveLength(1);
    expect(entries[0].source).toBe('declared');
  });

  it('rejects invalid dimension', async () => {
    const result = await personalityUserSetCommand(
      { dimension: 'invalid', content: 'test' },
      makeCtx(),
    );
    expect(result.success).toBe(false);
  });
});

describe('personality user reset', () => {
  it('deletes existing dimension', async () => {
    await identityManager.observeUserPersonality('work_patterns', 'Active 9-6', 'declared');
    const result = await personalityUserResetCommand({ dimension: 'work_patterns' }, makeCtx());
    expect(result.success).toBe(true);

    const entries = await identityManager.getUserPersonality();
    expect(entries).toHaveLength(0);
  });
});

// ─── Dispatchers ─────────────────────────────────────────────────────────

describe('dispatchIdentityCommand', () => {
  it('routes "agent show" correctly', async () => {
    const result = await dispatchIdentityCommand(['agent', 'show'], makeCtx());
    expect(result.success).toBe(true);
  });

  it('routes "agent set" with flags', async () => {
    const result = await dispatchIdentityCommand(
      ['agent', 'set', '--role', 'Dev', '--tone', 'Direct'],
      makeCtx(),
    );
    expect(result.success).toBe(true);
    const identity = await identityManager.getAgentIdentity(defaultProfileId);
    expect(identity?.role).toBe('Dev');
  });

  it('routes "user show" correctly', async () => {
    const result = await dispatchIdentityCommand(['user', 'show'], makeCtx());
    expect(result.success).toBe(true);
  });

  it('routes "user set" with flags', async () => {
    const result = await dispatchIdentityCommand(
      ['user', 'set', '--name', 'Stan', '--role', 'CTO'],
      makeCtx(),
    );
    expect(result.success).toBe(true);
    const identity = await identityManager.getUserIdentity();
    expect(identity?.name).toBe('Stan');
  });

  it('rejects invalid subcommand', async () => {
    const result = await dispatchIdentityCommand(['invalid'], makeCtx());
    expect(result.success).toBe(false);
  });
});

describe('dispatchPersonalityCommand', () => {
  it('routes "agent show" correctly', async () => {
    const result = await dispatchPersonalityCommand(['agent', 'show'], makeCtx());
    expect(result.success).toBe(true);
  });

  it('routes "agent set" with flags', async () => {
    const result = await dispatchPersonalityCommand(
      ['agent', 'set', '--dimension', 'humor', '--content', 'Dry humor'],
      makeCtx(),
    );
    expect(result.success).toBe(true);
  });

  it('routes "agent reset" with flags', async () => {
    await identityManager.observeAgentPersonality(defaultProfileId, 'humor', 'Dry');
    const result = await dispatchPersonalityCommand(
      ['agent', 'reset', '--dimension', 'humor'],
      makeCtx(),
    );
    expect(result.success).toBe(true);
  });

  it('routes "user show" correctly', async () => {
    const result = await dispatchPersonalityCommand(['user', 'show'], makeCtx());
    expect(result.success).toBe(true);
  });

  it('routes "user set" with flags', async () => {
    const result = await dispatchPersonalityCommand(
      ['user', 'set', '--dimension', 'work_patterns', '--content', 'Active 9-6'],
      makeCtx(),
    );
    expect(result.success).toBe(true);
  });

  it('routes "user reset" with flags', async () => {
    await identityManager.observeUserPersonality('work_patterns', 'Active 9-6', 'declared');
    const result = await dispatchPersonalityCommand(
      ['user', 'reset', '--dimension', 'work_patterns'],
      makeCtx(),
    );
    expect(result.success).toBe(true);
  });

  it('rejects invalid subcommand', async () => {
    const result = await dispatchPersonalityCommand(['invalid'], makeCtx());
    expect(result.success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Setup Identity Command (Phase 10D)
// ═══════════════════════════════════════════════════════════════════════════

describe('setupIdentityCommand', () => {
  it('sets agent identity with role and tone', async () => {
    const result = await setupIdentityCommand(
      { agentRole: 'Personal assistant', agentTone: 'Friendly' },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    expect(result.message).toContain('Identity configured');

    const agent = await identityManager.getAgentIdentity(defaultProfileId);
    expect(agent?.role).toBe('Personal assistant');
    expect(agent?.tone).toBe('Friendly');
  });

  it('sets user identity with name and role', async () => {
    const result = await setupIdentityCommand(
      { userName: 'Stan Tyan', userRole: 'CTO' },
      makeCtx(),
    );
    expect(result.success).toBe(true);

    const user = await identityManager.getUserIdentity();
    expect(user?.name).toBe('Stan Tyan');
    expect(user?.role).toBe('CTO');
  });

  it('sets both agent and user identity in one call', async () => {
    const result = await setupIdentityCommand(
      {
        agentRole: 'Executive assistant',
        agentTone: 'Professional',
        agentExpertise: 'email,calendar',
        userName: 'Alex',
        userTimezone: 'Europe/Helsinki',
      },
      makeCtx(),
    );
    expect(result.success).toBe(true);

    const agent = await identityManager.getAgentIdentity(defaultProfileId);
    expect(agent?.role).toBe('Executive assistant');
    expect(agent?.expertise).toEqual(['email', 'calendar']);

    const user = await identityManager.getUserIdentity();
    expect(user?.name).toBe('Alex');
    expect(user?.timezone).toBe('Europe/Helsinki');
  });

  it('uses default tone when only role is provided', async () => {
    const result = await setupIdentityCommand({ agentRole: 'Code reviewer' }, makeCtx());
    expect(result.success).toBe(true);

    const agent = await identityManager.getAgentIdentity(defaultProfileId);
    expect(agent?.tone).toBe('Helpful and professional');
  });

  it('shows usage when no fields specified', async () => {
    const result = await setupIdentityCommand({}, makeCtx());
    expect(result.success).toBe(true);
    expect(result.message).toBe('No changes');
    expect(output.some((l) => l.includes('Usage'))).toBe(true);
  });

  it('merges with existing agent identity', async () => {
    // Set initial identity
    await identityManager.setAgentIdentity(defaultProfileId, {
      role: 'Assistant',
      tone: 'Casual',
      expertise: ['python'],
    });

    // Update role only — should keep existing tone
    await setupIdentityCommand(
      { agentRole: 'Senior assistant', agentExpertise: 'typescript,go' },
      makeCtx(),
    );

    const agent = await identityManager.getAgentIdentity(defaultProfileId);
    expect(agent?.role).toBe('Senior assistant');
    expect(agent?.expertise).toEqual(['typescript', 'go']);
  });
});
