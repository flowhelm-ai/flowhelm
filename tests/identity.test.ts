import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  IdentityManager,
  confirmConfidence,
  contradictConfidence,
} from '../src/orchestrator/identity.js';
import { createTestDatabase, applySchema } from './helpers/pg-container.js';
import type { Sql } from '../src/orchestrator/connection.js';

let sql: Sql;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;
  await applySchema(sql);
});

afterEach(async () => {
  await cleanup();
});

// ─── Confidence Model (pure functions) ───────────────────────────────────

describe('confirmConfidence', () => {
  it('grows asymptotically toward 0.95', () => {
    let c = 0.3;
    for (let i = 0; i < 50; i++) {
      c = confirmConfidence(c);
    }
    // After many confirmations, should be very close to 0.95
    expect(c).toBeGreaterThan(0.94);
    expect(c).toBeLessThanOrEqual(0.95);
  });

  it('never exceeds 0.95', () => {
    let c = 0.94;
    // Even starting very close to the ceiling, repeated confirmations stay at 0.95
    for (let i = 0; i < 100; i++) {
      c = confirmConfidence(c);
    }
    expect(c).toBeLessThanOrEqual(0.95);
  });
});

describe('contradictConfidence', () => {
  it('decays by 20% per contradiction', () => {
    const initial = 0.8;
    const result = contradictConfidence(initial);
    expect(result).toBeCloseTo(0.64, 5); // 0.8 * 0.8 = 0.64
  });

  it('never goes below 0.1', () => {
    let c = 0.5;
    for (let i = 0; i < 100; i++) {
      c = contradictConfidence(c);
    }
    expect(c).toBeGreaterThanOrEqual(0.1);
    expect(c).toBeCloseTo(0.1, 5);
  });
});

// ─── Agent Identity (profile-scoped) ────────────────────────────────────

describe('IdentityManager — Agent Identity', () => {
  let manager: IdentityManager;
  let profileId: string;

  beforeEach(async () => {
    manager = new IdentityManager({ sql });
    // Get the default profile created by schema seed
    const rows = await sql`SELECT id FROM agent_profiles WHERE is_default = true LIMIT 1`;
    profileId = rows[0].id as string;
  });

  it('getAgentIdentity returns null when empty', async () => {
    const result = await manager.getAgentIdentity(profileId);
    expect(result).toBeNull();
  });

  it('setAgentIdentity creates a new identity', async () => {
    const identity = await manager.setAgentIdentity(profileId, {
      role: 'executive assistant',
      expertise: ['scheduling', 'email management'],
      tone: 'professional but warm',
    });

    expect(identity.role).toBe('executive assistant');
    expect(identity.tone).toBe('professional but warm');
    expect(identity.expertise).toEqual(['scheduling', 'email management']);
    expect(identity.instructions).toBeUndefined();
    expect(identity.createdAt).toBeGreaterThan(0);
    expect(identity.updatedAt).toBe(identity.createdAt);
  });

  it('setAgentIdentity updates existing identity', async () => {
    await manager.setAgentIdentity(profileId, {
      role: 'assistant',
      expertise: ['general'],
      tone: 'casual',
    });

    const updated = await manager.setAgentIdentity(profileId, {
      role: 'senior assistant',
      expertise: ['scheduling', 'research'],
      tone: 'formal',
      instructions: 'Always confirm before booking meetings.',
    });

    expect(updated.role).toBe('senior assistant');
    expect(updated.tone).toBe('formal');
    expect(updated.instructions).toBe('Always confirm before booking meetings.');
    expect(updated.updatedAt).toBeGreaterThanOrEqual(updated.createdAt);

    // Only one row should exist for this profile
    const fetched = await manager.getAgentIdentity(profileId);
    expect(fetched).not.toBeNull();
    expect(fetched!.role).toBe('senior assistant');
  });

  it('setAgentIdentity stores expertise as array', async () => {
    const identity = await manager.setAgentIdentity(profileId, {
      role: 'data analyst',
      expertise: ['SQL', 'Python', 'visualization', 'statistics'],
      tone: 'precise',
    });

    expect(Array.isArray(identity.expertise)).toBe(true);
    expect(identity.expertise).toHaveLength(4);
    expect(identity.expertise).toContain('SQL');
    expect(identity.expertise).toContain('statistics');

    // Verify round-trip through the database
    const fetched = await manager.getAgentIdentity(profileId);
    expect(fetched!.expertise).toEqual(['SQL', 'Python', 'visualization', 'statistics']);
  });

  it('two profiles have independent agent identities', async () => {
    // Create a second profile
    const now = Date.now();
    const rows2 = await sql`
      INSERT INTO agent_profiles (name, description, is_default, created_at, updated_at)
      VALUES ('second', null, false, ${now}, ${now})
      RETURNING id
    `;
    const profileId2 = rows2[0].id as string;

    await manager.setAgentIdentity(profileId, {
      role: 'assistant',
      expertise: ['general'],
      tone: 'casual',
    });
    await manager.setAgentIdentity(profileId2, {
      role: 'analyst',
      expertise: ['data'],
      tone: 'precise',
    });

    const id1 = await manager.getAgentIdentity(profileId);
    const id2 = await manager.getAgentIdentity(profileId2);
    expect(id1!.role).toBe('assistant');
    expect(id2!.role).toBe('analyst');
  });
});

// ─── Agent Personality (profile-scoped) ─────────────────────────────────

describe('IdentityManager — Agent Personality', () => {
  let manager: IdentityManager;
  let profileId: string;

  beforeEach(async () => {
    manager = new IdentityManager({ sql });
    const rows = await sql`SELECT id FROM agent_profiles WHERE is_default = true LIMIT 1`;
    profileId = rows[0].id as string;
  });

  it('getAgentPersonality returns empty array when empty', async () => {
    const result = await manager.getAgentPersonality(profileId);
    expect(result).toEqual([]);
  });

  it('observeAgentPersonality creates new dimension at 0.8 confidence', async () => {
    const entry = await manager.observeAgentPersonality(
      profileId,
      'humor',
      'Dry wit with occasional puns',
    );

    expect(entry.dimension).toBe('humor');
    expect(entry.content).toBe('Dry wit with occasional puns');
    expect(entry.confidence).toBeCloseTo(0.8, 5);
    expect(entry.evidenceCount).toBe(1);
    expect(entry.id).toBeDefined();
  });

  it('observeAgentPersonality updates existing dimension (bumps confidence)', async () => {
    await manager.observeAgentPersonality(profileId, 'humor', 'Dry wit');

    const updated = await manager.observeAgentPersonality(
      profileId,
      'humor',
      'Dry wit with occasional sarcasm',
    );

    // Confidence should increase from 0.8 via confirmConfidence
    const expectedConfidence = confirmConfidence(0.8);
    expect(updated.confidence).toBeCloseTo(expectedConfidence, 5);
    expect(updated.evidenceCount).toBe(2);
    expect(updated.content).toBe('Dry wit with occasional sarcasm');
  });

  it('observeAgentPersonality caps at 6 unique dimensions per profile (UNIQUE constraint)', async () => {
    const dimensions = [
      'communication_style',
      'humor',
      'emotional_register',
      'values',
      'rapport',
      'boundaries',
    ] as const;

    for (const dim of dimensions) {
      await manager.observeAgentPersonality(profileId, dim, `Content for ${dim}`);
    }

    const all = await manager.getAgentPersonality(profileId);
    expect(all).toHaveLength(6);

    // Attempting a 7th unique dimension should fail due to CHECK constraint
    await expect(
      manager.observeAgentPersonality(profileId, 'nonexistent' as never, 'Should fail'),
    ).rejects.toThrow();
  });

  it('two profiles have independent personality dimensions', async () => {
    const now = Date.now();
    const rows2 = await sql`
      INSERT INTO agent_profiles (name, description, is_default, created_at, updated_at)
      VALUES ('alt', null, false, ${now}, ${now})
      RETURNING id
    `;
    const profileId2 = rows2[0].id as string;

    await manager.observeAgentPersonality(profileId, 'humor', 'Dry wit');
    await manager.observeAgentPersonality(profileId2, 'humor', 'Slapstick');

    const p1 = await manager.getAgentPersonality(profileId);
    const p2 = await manager.getAgentPersonality(profileId2);
    expect(p1[0].content).toBe('Dry wit');
    expect(p2[0].content).toBe('Slapstick');
  });
});

// ─── User Identity ───────────────────────────────────────────────────────

describe('IdentityManager — User Identity', () => {
  let manager: IdentityManager;

  beforeEach(() => {
    manager = new IdentityManager({ sql });
  });

  it('getUserIdentity returns null when empty', async () => {
    const result = await manager.getUserIdentity();
    expect(result).toBeNull();
  });

  it('updateUserIdentity creates new record', async () => {
    const identity = await manager.updateUserIdentity({
      name: 'Stan',
      role: 'Engineering Manager',
      organization: 'FlowHelm',
      timezone: 'Europe/Helsinki',
      language: 'en',
    });

    expect(identity.name).toBe('Stan');
    expect(identity.role).toBe('Engineering Manager');
    expect(identity.organization).toBe('FlowHelm');
    expect(identity.timezone).toBe('Europe/Helsinki');
    expect(identity.language).toBe('en');
    expect(identity.createdAt).toBeGreaterThan(0);
  });

  it('updateUserIdentity uses COALESCE for partial updates', async () => {
    // Create initial record with full fields
    await manager.updateUserIdentity({
      name: 'Stan',
      role: 'Engineering Manager',
      organization: 'FlowHelm',
      timezone: 'Europe/Helsinki',
    });

    // Partial update — only change organization
    const updated = await manager.updateUserIdentity({
      organization: 'Acme Corp',
    });

    // Name, role, and timezone should be preserved via COALESCE
    expect(updated.name).toBe('Stan');
    expect(updated.role).toBe('Engineering Manager');
    expect(updated.organization).toBe('Acme Corp');
    expect(updated.timezone).toBe('Europe/Helsinki');
  });
});

// ─── User Personality ────────────────────────────────────────────────────

describe('IdentityManager — User Personality', () => {
  let manager: IdentityManager;

  beforeEach(() => {
    manager = new IdentityManager({ sql });
  });

  it('observeUserPersonality creates at 0.3 confidence (inferred)', async () => {
    const entry = await manager.observeUserPersonality(
      'communication_style',
      'Prefers concise messages',
      'inferred',
    );

    expect(entry.dimension).toBe('communication_style');
    expect(entry.content).toBe('Prefers concise messages');
    expect(entry.confidence).toBeCloseTo(0.3, 5);
    expect(entry.source).toBe('inferred');
    expect(entry.evidenceCount).toBe(1);
  });

  it('observeUserPersonality creates at 0.7 confidence (declared)', async () => {
    const entry = await manager.observeUserPersonality(
      'preferences',
      'Prefers morning meetings',
      'declared',
    );

    expect(entry.confidence).toBeCloseTo(0.7, 5);
    expect(entry.source).toBe('declared');
  });

  it('observeUserPersonality updates existing, bumps confidence', async () => {
    await manager.observeUserPersonality(
      'work_patterns',
      'Most productive in mornings',
      'inferred',
    );

    const updated = await manager.observeUserPersonality(
      'work_patterns',
      'Consistently most productive before noon',
      'inferred',
    );

    // Confidence should increase from 0.3 via confirmConfidence
    const expectedConfidence = confirmConfidence(0.3);
    expect(updated.confidence).toBeCloseTo(expectedConfidence, 5);
    expect(updated.evidenceCount).toBe(2);
    expect(updated.content).toBe('Consistently most productive before noon');
  });
});

// ─── Context Building ────────────────────────────────────────────────────

describe('IdentityManager — buildIdentityContext', () => {
  let manager: IdentityManager;
  let profileId: string;

  beforeEach(async () => {
    manager = new IdentityManager({ sql });
    const rows = await sql`SELECT id FROM agent_profiles WHERE is_default = true LIMIT 1`;
    profileId = rows[0].id as string;
  });

  it('returns XML with all 4 sections', async () => {
    // Set up all 4 identity/personality sections
    await manager.setAgentIdentity(profileId, {
      role: 'executive assistant',
      expertise: ['scheduling', 'email'],
      tone: 'professional',
      instructions: 'Be proactive.',
    });

    await manager.observeAgentPersonality(profileId, 'humor', 'Light and playful');
    await manager.observeAgentPersonality(profileId, 'communication_style', 'Direct and clear');

    await manager.updateUserIdentity({
      name: 'Stan',
      role: 'CTO',
      timezone: 'Europe/Helsinki',
    });

    await manager.observeUserPersonality(
      'communication_style',
      'Prefers bullet points',
      'declared',
    );

    const xml = await manager.buildIdentityContext(
      {
        personalityConfidenceThreshold: 0.0,
        userPersonalityConfidenceThreshold: 0.0,
      },
      profileId,
    );

    // Verify all 4 sections are present
    expect(xml).toContain('<identity>');
    expect(xml).toContain('</identity>');
    expect(xml).toContain('<agent role="executive assistant"');
    expect(xml).toContain('<expertise>scheduling, email</expertise>');
    expect(xml).toContain('<instructions>Be proactive.</instructions>');
    expect(xml).toContain('<agent_personality>');
    expect(xml).toContain('</agent_personality>');
    expect(xml).toContain('<user ');
    expect(xml).toContain('name="Stan"');
    expect(xml).toContain('role="CTO"');
    expect(xml).toContain('tz="Europe/Helsinki"');
    expect(xml).toContain('<user_personality>');
    expect(xml).toContain('</user_personality>');
    expect(xml).toContain('Prefers bullet points');
  });

  it('filters personality by confidence threshold', async () => {
    await manager.setAgentIdentity(profileId, {
      role: 'assistant',
      expertise: [],
      tone: 'neutral',
    });

    // Create agent personality at 0.8 confidence (initial)
    await manager.observeAgentPersonality(profileId, 'humor', 'Witty');

    // Create user personality at 0.3 confidence (inferred)
    await manager.observeUserPersonality('communication_style', 'Verbose', 'inferred');

    // Create user personality at 0.7 confidence (declared)
    await manager.observeUserPersonality('preferences', 'Dark mode', 'declared');

    // Use thresholds that filter out low-confidence entries
    const xml = await manager.buildIdentityContext(
      {
        personalityConfidenceThreshold: 0.75, // Should include humor (0.8)
        userPersonalityConfidenceThreshold: 0.5, // Should include "Dark mode" (0.7) but not "Verbose" (0.3)
      },
      profileId,
    );

    // Agent personality at 0.8 should pass threshold 0.75
    expect(xml).toContain('Witty');

    // User personality at 0.7 should pass threshold 0.5
    expect(xml).toContain('Dark mode');

    // User personality at 0.3 should be filtered by threshold 0.5
    expect(xml).not.toContain('Verbose');
  });
});
