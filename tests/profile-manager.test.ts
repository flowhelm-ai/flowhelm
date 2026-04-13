import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ProfileManager } from '../src/orchestrator/profile-manager.js';
import { createTestDatabase, applySchema } from './helpers/pg-container.js';
import type { Sql } from '../src/orchestrator/connection.js';

let sql: Sql;
let cleanup: () => Promise<void>;
let manager: ProfileManager;

beforeEach(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;
  await applySchema(sql);
  manager = new ProfileManager({ sql, maxProfilesPerUser: 10 });
});

afterEach(async () => {
  await cleanup();
});

// ─── Create ─────────────────────────────────────────────────────────────

describe('ProfileManager — createProfile', () => {
  it('creates a profile with name and description', async () => {
    const profile = await manager.createProfile('work', 'Work assistant');
    expect(profile.name).toBe('work');
    expect(profile.description).toBe('Work assistant');
    expect(profile.createdAt).toBeGreaterThan(0);
    expect(profile.id).toBeDefined();
  });

  it('schema-created default profile is the default', async () => {
    // Schema seed creates a "default" profile automatically
    const def = await manager.getDefaultProfile();
    expect(def).not.toBeNull();
    expect(def!.name).toBe('default');
    expect(def!.isDefault).toBe(true);
  });

  it('new profiles are NOT default when default already exists', async () => {
    const second = await manager.createProfile('second');
    expect(second.isDefault).toBe(false);
  });

  it('rejects duplicate name', async () => {
    await manager.createProfile('work');
    await expect(manager.createProfile('work')).rejects.toThrow();
  });

  it('enforces max profile limit', async () => {
    // Schema seed already created "default", so limit of 3 means we can create 2 more
    const limited = new ProfileManager({ sql, maxProfilesPerUser: 3 });
    await limited.createProfile('one');
    await limited.createProfile('two');
    await expect(limited.createProfile('three')).rejects.toThrow(/limit reached/);
  });
});

// ─── Read ───────────────────────────────────────────────────────────────

describe('ProfileManager — get/list', () => {
  it('getProfile by ID', async () => {
    const created = await manager.createProfile('test');
    const fetched = await manager.getProfile(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe('test');
  });

  it('getProfileByName', async () => {
    await manager.createProfile('work');
    const fetched = await manager.getProfileByName('work');
    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe('work');
  });

  it('getProfile returns null for unknown ID', async () => {
    const fetched = await manager.getProfile('00000000-0000-0000-0000-000000000000');
    expect(fetched).toBeNull();
  });

  it('getProfileByName returns null for unknown name', async () => {
    const fetched = await manager.getProfileByName('nonexistent');
    expect(fetched).toBeNull();
  });

  it('listProfiles returns all with stats', async () => {
    await manager.createProfile('alpha');
    await manager.createProfile('beta');
    const profiles = await manager.listProfiles();
    // 3 profiles: default (from schema seed) + alpha + beta
    expect(profiles).toHaveLength(3);
    expect(profiles[0].chatCount).toBe(0);
    expect(profiles[0].semanticMemoryCount).toBe(0);
    expect(profiles[0].metaMemoryCount).toBe(0);
  });

  it('getDefaultProfile returns the schema-created default', async () => {
    const def = await manager.getDefaultProfile();
    expect(def).not.toBeNull();
    expect(def!.name).toBe('default');
    expect(def!.isDefault).toBe(true);
  });
});

// ─── Default Management ─────────────────────────────────────────────────

describe('ProfileManager — setDefaultProfile', () => {
  it('switches default profile', async () => {
    // Schema seed created "default" as the default
    const defaultProfile = await manager.getDefaultProfile();
    const second = await manager.createProfile('second');

    expect(second.isDefault).toBe(false);

    await manager.setDefaultProfile(second.id);

    const updatedDefault = await manager.getProfile(defaultProfile!.id);
    const updatedSecond = await manager.getProfile(second.id);
    expect(updatedDefault!.isDefault).toBe(false);
    expect(updatedSecond!.isDefault).toBe(true);
  });

  it('is idempotent for already-default', async () => {
    const defaultProfile = await manager.getDefaultProfile();
    await manager.setDefaultProfile(defaultProfile!.id); // Already default
    const fetched = await manager.getProfile(defaultProfile!.id);
    expect(fetched!.isDefault).toBe(true);
  });

  it('throws for unknown profile', async () => {
    await expect(manager.setDefaultProfile('00000000-0000-0000-0000-000000000000')).rejects.toThrow(
      'Profile not found',
    );
  });
});

// ─── Chat Assignment ────────────────────────────────────────────────────

describe('ProfileManager — assignChat / getChatProfile', () => {
  it('assigns a chat and returns previous profile', async () => {
    const profileA = await manager.createProfile('A');
    const profileB = await manager.createProfile('B');

    // Create a chat assigned to profile A
    const now = Date.now();
    await sql`
      INSERT INTO chats (id, channel, external_id, profile_id, created_at, updated_at)
      VALUES ('chat1', 'telegram', 'ext1', ${profileA.id}, ${now}, ${now})
    `;

    const previousId = await manager.assignChat('chat1', profileB.id);
    expect(previousId).toBe(profileA.id);

    const resolved = await manager.getChatProfile('chat1');
    expect(resolved!.name).toBe('B');
  });

  it('getChatProfile returns null for unknown chat', async () => {
    const result = await manager.getChatProfile('nonexistent');
    expect(result).toBeNull();
  });

  it('assignChat throws for unknown profile', async () => {
    await expect(
      manager.assignChat('chat1', '00000000-0000-0000-0000-000000000000'),
    ).rejects.toThrow('Target profile not found');
  });

  it('assignChat throws for unknown chat', async () => {
    const profile = await manager.createProfile('test');
    await expect(manager.assignChat('no-such-chat', profile.id)).rejects.toThrow('Chat not found');
  });
});

// ─── Delete ─────────────────────────────────────────────────────────────

describe('ProfileManager — deleteProfile', () => {
  it('deletes a non-default profile with no chats', async () => {
    const extra = await manager.createProfile('extra');

    await manager.deleteProfile(extra.id);
    const fetched = await manager.getProfile(extra.id);
    expect(fetched).toBeNull();

    // Default should still exist
    const def = await manager.getDefaultProfile();
    expect(def).not.toBeNull();
  });

  it('rejects deleting the default profile', async () => {
    // The schema-created "default" profile is the default
    const defaultProfile = await manager.getDefaultProfile();
    expect(defaultProfile).not.toBeNull();
    await expect(manager.deleteProfile(defaultProfile!.id)).rejects.toThrow(/default/);
  });

  it('rejects deleting a profile with assigned chats', async () => {
    const first = await manager.createProfile('first');
    const second = await manager.createProfile('second');

    const now = Date.now();
    await sql`
      INSERT INTO chats (id, channel, external_id, profile_id, created_at, updated_at)
      VALUES ('chat1', 'telegram', 'ext1', ${second.id}, ${now}, ${now})
    `;

    await expect(manager.deleteProfile(second.id)).rejects.toThrow(/chats/);
  });

  it('cascades delete to identity and personality', async () => {
    const first = await manager.createProfile('first');
    const second = await manager.createProfile('second');

    const now = Date.now();
    await sql`
      INSERT INTO agent_identity (profile_id, role, expertise, tone, created_at, updated_at)
      VALUES (${second.id}, 'test', '{}', 'neutral', ${now}, ${now})
    `;
    await sql`
      INSERT INTO agent_personality (profile_id, dimension, content, created_at, updated_at)
      VALUES (${second.id}, 'humor', 'witty', ${now}, ${now})
    `;

    await manager.deleteProfile(second.id);

    // Check cascaded rows are gone
    const identityRows = await sql`SELECT * FROM agent_identity WHERE profile_id = ${second.id}`;
    expect(identityRows).toHaveLength(0);
    const personalityRows =
      await sql`SELECT * FROM agent_personality WHERE profile_id = ${second.id}`;
    expect(personalityRows).toHaveLength(0);
  });
});

// ─── Clone ──────────────────────────────────────────────────────────────

describe('ProfileManager — cloneProfile', () => {
  it('clones profile with identity and personality', async () => {
    const source = await manager.createProfile('source', 'Source profile');

    const now = Date.now();
    await sql`
      INSERT INTO agent_identity (profile_id, role, expertise, tone, instructions, created_at, updated_at)
      VALUES (${source.id}, 'assistant', '{scheduling,email}', 'formal', 'Be helpful.', ${now}, ${now})
    `;
    await sql`
      INSERT INTO agent_personality (profile_id, dimension, content, confidence, evidence_count, created_at, updated_at)
      VALUES (${source.id}, 'humor', 'dry wit', 0.8, 3, ${now}, ${now})
    `;

    const clone = await manager.cloneProfile(source.id, 'clone', 'Cloned profile');

    expect(clone.name).toBe('clone');
    expect(clone.description).toBe('Cloned profile');
    expect(clone.isDefault).toBe(false);
    expect(clone.id).not.toBe(source.id);

    // Verify cloned identity
    const identityRows = await sql`SELECT * FROM agent_identity WHERE profile_id = ${clone.id}`;
    expect(identityRows).toHaveLength(1);
    expect(identityRows[0].role).toBe('assistant');
    expect(identityRows[0].tone).toBe('formal');

    // Verify cloned personality
    const personalityRows =
      await sql`SELECT * FROM agent_personality WHERE profile_id = ${clone.id}`;
    expect(personalityRows).toHaveLength(1);
    expect(personalityRows[0].dimension).toBe('humor');
    expect(personalityRows[0].content).toBe('dry wit');
  });

  it('clone respects profile limit', async () => {
    // Schema seed already created "default", so limit of 3 means we can add 2 more
    const limited = new ProfileManager({ sql, maxProfilesPerUser: 3 });
    const source = await limited.createProfile('one');
    await limited.createProfile('two');

    await expect(limited.cloneProfile(source.id, 'three')).rejects.toThrow(/limit reached/);
  });

  it('clone throws for unknown source', async () => {
    await expect(
      manager.cloneProfile('00000000-0000-0000-0000-000000000000', 'new'),
    ).rejects.toThrow('Source profile not found');
  });
});

// ─── Schema Seed ────────────────────────────────────────────────────────

describe('Schema seed — default profile', () => {
  it('schema seed creates default profile on fresh database', async () => {
    // applySchema() already ran in beforeEach, which seeds the default profile
    const defaultProfile = await manager.getDefaultProfile();
    expect(defaultProfile).not.toBeNull();
    expect(defaultProfile!.name).toBe('default');
    expect(defaultProfile!.isDefault).toBe(true);
  });

  it('schema seed is idempotent — re-running does not create duplicate', async () => {
    // Run applySchema again
    await applySchema(sql);

    const profiles = await manager.listProfiles();
    // Should still have exactly the default profile (+ any created by the test)
    const defaultProfiles = profiles.filter((p) => p.name === 'default');
    expect(defaultProfiles).toHaveLength(1);
  });
});
