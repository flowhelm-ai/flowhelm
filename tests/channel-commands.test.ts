import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChannelCommandHandler } from '../src/orchestrator/channel-commands.js';
import { IdentityManager } from '../src/orchestrator/identity.js';
import { ProfileManager } from '../src/orchestrator/profile-manager.js';
import { createTestDatabase, applySchema } from './helpers/pg-container.js';
import type { Sql } from '../src/orchestrator/connection.js';

let sql: Sql;
let cleanup: () => Promise<void>;
let identityManager: IdentityManager;
let profileManager: ProfileManager;
let handler: ChannelCommandHandler;
let defaultProfileId: string;

const CHAT_ID = 'tg:123';

beforeEach(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;
  await applySchema(sql);

  identityManager = new IdentityManager({ sql });
  profileManager = new ProfileManager({ sql });
  handler = new ChannelCommandHandler(identityManager, profileManager);

  // Schema seeds a 'default' profile — use it
  const profile = await profileManager.getDefaultProfile();
  defaultProfileId = profile!.id;

  // Assign the chat to the default profile
  await sql`
    INSERT INTO chats (id, channel, external_id, profile_id, created_at, updated_at)
    VALUES (${CHAT_ID}, ${'telegram'}, ${'123'}, ${defaultProfileId}, ${Date.now()}, ${Date.now()})
    ON CONFLICT (id) DO NOTHING
  `;
});

afterEach(async () => {
  await cleanup();
});

// ─── Non-command passthrough ────────────────────────────────────────────

describe('passthrough', () => {
  it('passes through normal messages', async () => {
    const result = await handler.handle('Hello, how are you?', CHAT_ID);
    expect(result.handled).toBe(false);
    expect(result.response).toBeUndefined();
  });

  it('passes through unrecognized / commands', async () => {
    const result = await handler.handle('/unknown something', CHAT_ID);
    expect(result.handled).toBe(false);
  });

  it('passes through messages without / prefix', async () => {
    const result = await handler.handle('identity show', CHAT_ID);
    expect(result.handled).toBe(false);
  });
});

// ─── /identity show ─────────────────────────────────────────────────────

describe('/identity show', () => {
  it('shows empty state', async () => {
    const result = await handler.handle('/identity show', CHAT_ID);
    expect(result.handled).toBe(true);
    expect(result.response).toContain('not configured');
  });

  it('shows agent and user identity', async () => {
    await identityManager.setAgentIdentity(defaultProfileId, {
      role: 'Executive assistant',
      expertise: ['email', 'calendar'],
      tone: 'Professional',
      instructions: 'Draft emails first',
    });
    await identityManager.updateUserIdentity({
      name: 'Stan',
      role: 'CTO',
      timezone: 'Europe/Helsinki',
    });

    const result = await handler.handle('/identity show', CHAT_ID);
    expect(result.handled).toBe(true);
    expect(result.response).toContain('Executive assistant');
    expect(result.response).toContain('Professional');
    expect(result.response).toContain('email, calendar');
    expect(result.response).toContain('Draft emails first');
    expect(result.response).toContain('Stan');
    expect(result.response).toContain('CTO');
    expect(result.response).toContain('Europe/Helsinki');
  });

  it('handles bare /identity as show', async () => {
    const result = await handler.handle('/identity', CHAT_ID);
    expect(result.handled).toBe(true);
    expect(result.response).toContain('not configured');
  });

  it('is case-insensitive', async () => {
    const result = await handler.handle('/Identity Show', CHAT_ID);
    expect(result.handled).toBe(true);
    expect(result.response).toContain('not configured');
  });
});

// ─── /identity set agent ────────────────────────────────────────────────

describe('/identity set agent', () => {
  it('creates new agent identity', async () => {
    const result = await handler.handle(
      '/identity set agent role=Code reviewer, tone=Direct',
      CHAT_ID,
    );
    expect(result.handled).toBe(true);
    expect(result.response).toContain('updated');

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

    const result = await handler.handle('/identity set agent role=Senior assistant', CHAT_ID);
    expect(result.handled).toBe(true);

    const identity = await identityManager.getAgentIdentity(defaultProfileId);
    expect(identity?.role).toBe('Senior assistant');
    expect(identity?.tone).toBe('Friendly');
    expect(identity?.instructions).toBe('Be helpful');
  });

  it('sets expertise as comma-separated list', async () => {
    await handler.handle('/identity set agent role=Dev, tone=Direct', CHAT_ID);
    const result = await handler.handle(
      '/identity set agent expertise=TypeScript, Go, Rust',
      CHAT_ID,
    );
    expect(result.handled).toBe(true);

    const identity = await identityManager.getAgentIdentity(defaultProfileId);
    expect(identity?.expertise).toEqual(['TypeScript', 'Go', 'Rust']);
  });

  it('requires role and tone for new identity', async () => {
    const result = await handler.handle('/identity set agent role=Dev', CHAT_ID);
    expect(result.handled).toBe(true);
    expect(result.response).toContain('role and tone are required');
  });

  it('shows usage when no fields provided', async () => {
    const result = await handler.handle('/identity set agent', CHAT_ID);
    expect(result.handled).toBe(true);
    expect(result.response).toContain('Usage');
  });
});

// ─── /identity set user ─────────────────────────────────────────────────

describe('/identity set user', () => {
  it('creates user identity', async () => {
    const result = await handler.handle('/identity set user name=Stan Tyan, role=CTO', CHAT_ID);
    expect(result.handled).toBe(true);
    expect(result.response).toContain('updated');

    const identity = await identityManager.getUserIdentity();
    expect(identity?.name).toBe('Stan Tyan');
    expect(identity?.role).toBe('CTO');
  });

  it('sets timezone', async () => {
    await handler.handle('/identity set user timezone=Europe/Helsinki', CHAT_ID);
    const identity = await identityManager.getUserIdentity();
    expect(identity?.timezone).toBe('Europe/Helsinki');
  });

  it('merges with existing user identity', async () => {
    await identityManager.updateUserIdentity({ name: 'Stan', role: 'CTO' });
    await handler.handle('/identity set user org=Acme Corp', CHAT_ID);

    const identity = await identityManager.getUserIdentity();
    expect(identity?.name).toBe('Stan');
    expect(identity?.organization).toBe('Acme Corp');
  });

  it('shows usage when no fields provided', async () => {
    const result = await handler.handle('/identity set user', CHAT_ID);
    expect(result.handled).toBe(true);
    expect(result.response).toContain('Usage');
  });
});

// ─── /identity set (invalid target) ────────────────────────────────────

describe('/identity set (invalid)', () => {
  it('shows usage for missing target', async () => {
    const result = await handler.handle('/identity set', CHAT_ID);
    expect(result.handled).toBe(true);
    expect(result.response).toContain('Usage');
  });

  it('shows usage for invalid target', async () => {
    const result = await handler.handle('/identity set invalid role=X', CHAT_ID);
    expect(result.handled).toBe(true);
    expect(result.response).toContain('Usage');
  });
});

// ─── /personality show ──────────────────────────────────────────────────

describe('/personality show', () => {
  it('shows empty state', async () => {
    const result = await handler.handle('/personality show', CHAT_ID);
    expect(result.handled).toBe(true);
    expect(result.response).toContain('none configured');
  });

  it('shows agent and user personality', async () => {
    await identityManager.observeAgentPersonality(
      defaultProfileId,
      'communication_style',
      'Concise, bullet points',
    );
    await identityManager.observeUserPersonality('work_patterns', 'Active 9-6', 'declared');

    const result = await handler.handle('/personality show', CHAT_ID);
    expect(result.handled).toBe(true);
    expect(result.response).toContain('communication_style');
    expect(result.response).toContain('Concise, bullet points');
    expect(result.response).toContain('work_patterns');
    expect(result.response).toContain('Active 9-6');
    expect(result.response).toContain('declared');
  });

  it('handles bare /personality as show', async () => {
    const result = await handler.handle('/personality', CHAT_ID);
    expect(result.handled).toBe(true);
    expect(result.response).toContain('none configured');
  });
});

// ─── /personality set agent ─────────────────────────────────────────────

describe('/personality set agent', () => {
  it('sets agent personality dimension', async () => {
    const result = await handler.handle('/personality set agent humor=Dry humor only', CHAT_ID);
    expect(result.handled).toBe(true);
    expect(result.response).toContain('humor');
    expect(result.response).toContain('updated');

    const entries = await identityManager.getAgentPersonality(defaultProfileId);
    expect(entries).toHaveLength(1);
    expect(entries[0].dimension).toBe('humor');
    expect(entries[0].content).toBe('Dry humor only');
  });

  it('rejects invalid dimension', async () => {
    const result = await handler.handle('/personality set agent invalid_dim=test', CHAT_ID);
    expect(result.handled).toBe(true);
    expect(result.response).toContain('Invalid dimension');
  });

  it('shows usage when empty', async () => {
    const result = await handler.handle('/personality set agent', CHAT_ID);
    expect(result.handled).toBe(true);
    expect(result.response).toContain('Usage');
  });
});

// ─── /personality set user ──────────────────────────────────────────────

describe('/personality set user', () => {
  it('sets user personality with declared source', async () => {
    const result = await handler.handle(
      '/personality set user work_patterns=Active 9am-6pm',
      CHAT_ID,
    );
    expect(result.handled).toBe(true);
    expect(result.response).toContain('updated');

    const entries = await identityManager.getUserPersonality();
    expect(entries).toHaveLength(1);
    expect(entries[0].source).toBe('declared');
  });

  it('rejects invalid dimension', async () => {
    const result = await handler.handle('/personality set user invalid_dim=test', CHAT_ID);
    expect(result.handled).toBe(true);
    expect(result.response).toContain('Invalid dimension');
  });
});

// ─── /personality reset agent ───────────────────────────────────────────

describe('/personality reset agent', () => {
  it('resets existing dimension', async () => {
    await identityManager.observeAgentPersonality(defaultProfileId, 'humor', 'Dry');
    const result = await handler.handle('/personality reset agent humor', CHAT_ID);
    expect(result.handled).toBe(true);
    expect(result.response).toContain('reset');

    const entries = await identityManager.getAgentPersonality(defaultProfileId);
    expect(entries).toHaveLength(0);
  });

  it('handles non-existent dimension gracefully', async () => {
    const result = await handler.handle('/personality reset agent humor', CHAT_ID);
    expect(result.handled).toBe(true);
    expect(result.response).toContain('No agent personality');
  });

  it('rejects invalid dimension', async () => {
    const result = await handler.handle('/personality reset agent nope', CHAT_ID);
    expect(result.handled).toBe(true);
    expect(result.response).toContain('Invalid dimension');
  });

  it('shows usage when empty', async () => {
    const result = await handler.handle('/personality reset agent', CHAT_ID);
    expect(result.handled).toBe(true);
    expect(result.response).toContain('Usage');
  });
});

// ─── /personality reset user ────────────────────────────────────────────

describe('/personality reset user', () => {
  it('resets existing dimension', async () => {
    await identityManager.observeUserPersonality('work_patterns', 'Active 9-6', 'declared');
    const result = await handler.handle('/personality reset user work_patterns', CHAT_ID);
    expect(result.handled).toBe(true);
    expect(result.response).toContain('reset');

    const entries = await identityManager.getUserPersonality();
    expect(entries).toHaveLength(0);
  });

  it('handles non-existent dimension gracefully', async () => {
    const result = await handler.handle('/personality reset user work_patterns', CHAT_ID);
    expect(result.handled).toBe(true);
    expect(result.response).toContain('No user personality');
  });

  it('rejects invalid dimension', async () => {
    const result = await handler.handle('/personality reset user invalid', CHAT_ID);
    expect(result.handled).toBe(true);
    expect(result.response).toContain('Invalid dimension');
  });
});

// ─── /profile list ──────────────────────────────────────────────────────

describe('/profile list', () => {
  it('lists profiles', async () => {
    const result = await handler.handle('/profile list', CHAT_ID);
    expect(result.handled).toBe(true);
    expect(result.response).toContain('default');
    expect(result.response).toContain('Profiles:');
  });

  it('handles bare /profile as list', async () => {
    const result = await handler.handle('/profile', CHAT_ID);
    expect(result.handled).toBe(true);
    expect(result.response).toContain('default');
  });
});

// ─── /profile show ──────────────────────────────────────────────────────

describe('/profile show', () => {
  it('shows current profile', async () => {
    const result = await handler.handle('/profile show', CHAT_ID);
    expect(result.handled).toBe(true);
    expect(result.response).toContain('default');
    expect(result.response).toContain('Current profile');
  });

  it('handles chat with no profile', async () => {
    const result = await handler.handle('/profile show', 'tg:nonexistent');
    expect(result.handled).toBe(true);
    expect(result.response).toContain('No profile assigned');
  });
});

// ─── /profile switch ────────────────────────────────────────────────────

describe('/profile switch', () => {
  it('switches to existing profile', async () => {
    await profileManager.createProfile('work', 'Work profile');
    const result = await handler.handle('/profile switch work', CHAT_ID);
    expect(result.handled).toBe(true);
    expect(result.response).toContain('Switched to profile "work"');

    const profile = await profileManager.getChatProfile(CHAT_ID);
    expect(profile?.name).toBe('work');
  });

  it('handles non-existent profile', async () => {
    const result = await handler.handle('/profile switch nope', CHAT_ID);
    expect(result.handled).toBe(true);
    expect(result.response).toContain('not found');
    expect(result.response).toContain('/profile list');
  });

  it('shows usage when no name provided', async () => {
    const result = await handler.handle('/profile switch', CHAT_ID);
    expect(result.handled).toBe(true);
    expect(result.response).toContain('Usage');
  });
});

// ─── /help ──────────────────────────────────────────────────────────────

describe('/help', () => {
  it('shows general help', async () => {
    const result = await handler.handle('/help', CHAT_ID);
    expect(result.handled).toBe(true);
    expect(result.response).toContain('/identity');
    expect(result.response).toContain('/personality');
    expect(result.response).toContain('/profile');
    expect(result.response).toContain('/help');
  });

  it('shows identity help', async () => {
    const result = await handler.handle('/help identity', CHAT_ID);
    expect(result.handled).toBe(true);
    expect(result.response).toContain('Identity commands');
    expect(result.response).toContain('/identity set agent');
    expect(result.response).toContain('/identity set user');
  });

  it('shows personality help', async () => {
    const result = await handler.handle('/help personality', CHAT_ID);
    expect(result.handled).toBe(true);
    expect(result.response).toContain('Personality commands');
    expect(result.response).toContain('communication_style');
  });

  it('shows profile help', async () => {
    const result = await handler.handle('/help profile', CHAT_ID);
    expect(result.handled).toBe(true);
    expect(result.response).toContain('Profile commands');
    expect(result.response).toContain('/profile switch');
  });
});

// ─── Parsing edge cases ─────────────────────────────────────────────────

describe('parsing', () => {
  it('handles extra whitespace', async () => {
    const result = await handler.handle('  /identity   show  ', CHAT_ID);
    expect(result.handled).toBe(true);
    expect(result.response).toContain('not configured');
  });

  it('handles case-insensitive commands', async () => {
    const result = await handler.handle('/IDENTITY SHOW', CHAT_ID);
    expect(result.handled).toBe(true);
  });

  it('handles case-insensitive subcommands', async () => {
    const result = await handler.handle('/Personality Show', CHAT_ID);
    expect(result.handled).toBe(true);
  });

  it('handles values with spaces in key=value pairs', async () => {
    await handler.handle(
      '/identity set agent role=Executive assistant, tone=Professional but warm',
      CHAT_ID,
    );
    const identity = await identityManager.getAgentIdentity(defaultProfileId);
    expect(identity?.role).toBe('Executive assistant');
    expect(identity?.tone).toBe('Professional but warm');
  });

  it('handles multiple user fields in one command', async () => {
    await handler.handle('/identity set user name=Stan Tyan, role=CTO, org=Acme', CHAT_ID);
    const identity = await identityManager.getUserIdentity();
    expect(identity?.name).toBe('Stan Tyan');
    expect(identity?.role).toBe('CTO');
    expect(identity?.organization).toBe('Acme');
  });
});
