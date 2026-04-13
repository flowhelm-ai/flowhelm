/**
 * Identity layer: agent identity + personality, user identity + personality.
 *
 * Four PostgreSQL tables give each user's agent persistent personhood
 * and a growing understanding of the user. Confidence models use
 * asymptotic growth for confirming observations and faster decay
 * for contradictions. See ADR-024.
 */

import type { Sql } from 'postgres';
import type {
  AgentIdentity,
  AgentPersonalityDimension,
  AgentPersonalityEntry,
  UserIdentity,
  UserPersonalityDimension,
  UserPersonalityEntry,
  PersonalitySource,
} from './types.js';

// ─── Confidence Model ─────────────────────────────────────────────────────

/** Asymptotic growth: confirmed observations approach 0.95. */
export function confirmConfidence(current: number): number {
  return Math.min(0.95, current + (1 - current) * 0.1);
}

/** Faster decay: contradictions reduce confidence quickly. */
export function contradictConfidence(current: number): number {
  return Math.max(0.1, current * 0.8);
}

// ─── Options ──────────────────────────────────────────────────────────────

export interface IdentityManagerOptions {
  sql: Sql;
}

export interface IdentityThresholds {
  personalityConfidenceThreshold: number;
  userPersonalityConfidenceThreshold: number;
}

export interface IdentityProposal {
  id: string;
  field: string;
  newValue: string;
  reason: string;
  createdAt: number;
}

// ─── IdentityManager ──────────────────────────────────────────────────────

export class IdentityManager {
  private readonly sql: Sql;

  constructor(options: IdentityManagerOptions) {
    this.sql = options.sql;
  }

  // ── Agent Identity (profile-scoped) ──

  async getAgentIdentity(profileId: string): Promise<AgentIdentity | null> {
    const rows = await this.sql`
      SELECT * FROM agent_identity WHERE profile_id = ${profileId} LIMIT 1
    `;
    if (rows.length === 0) return null;
    return this.rowToAgentIdentity(rows[0] as Record<string, unknown>);
  }

  async setAgentIdentity(
    profileId: string,
    identity: {
      role: string;
      expertise: string[];
      tone: string;
      instructions?: string;
    },
  ): Promise<AgentIdentity> {
    const now = Date.now();
    const existing = await this.getAgentIdentity(profileId);

    if (existing) {
      const rows = await this.sql`
        UPDATE agent_identity SET
          role = ${identity.role},
          expertise = ${identity.expertise},
          tone = ${identity.tone},
          instructions = ${identity.instructions ?? null},
          updated_at = ${now}
        WHERE profile_id = ${profileId}
        RETURNING *
      `;
      return this.rowToAgentIdentity(rows[0] as Record<string, unknown>);
    }

    const rows = await this.sql`
      INSERT INTO agent_identity (profile_id, role, expertise, tone, instructions, created_at, updated_at)
      VALUES (${profileId}, ${identity.role}, ${identity.expertise}, ${identity.tone},
              ${identity.instructions ?? null}, ${now}, ${now})
      RETURNING *
    `;
    return this.rowToAgentIdentity(rows[0] as Record<string, unknown>);
  }

  // ── Agent Personality (profile-scoped) ──

  async getAgentPersonality(profileId: string): Promise<AgentPersonalityEntry[]> {
    const rows = await this.sql`
      SELECT * FROM agent_personality WHERE profile_id = ${profileId} ORDER BY dimension
    `;
    return rows.map((r) => this.rowToAgentPersonality(r));
  }

  async observeAgentPersonality(
    profileId: string,
    dimension: AgentPersonalityDimension,
    content: string,
  ): Promise<AgentPersonalityEntry> {
    const now = Date.now();
    const existing = await this.sql`
      SELECT * FROM agent_personality
      WHERE profile_id = ${profileId} AND dimension = ${dimension}
    `;

    if (existing.length > 0) {
      const existingRow = existing[0] as Record<string, unknown>;
      const newConfidence = confirmConfidence(existingRow.confidence as number);
      const rows = await this.sql`
        UPDATE agent_personality SET
          content = ${content},
          confidence = ${newConfidence},
          evidence_count = evidence_count + 1,
          updated_at = ${now}
        WHERE profile_id = ${profileId} AND dimension = ${dimension}
        RETURNING *
      `;
      return this.rowToAgentPersonality(rows[0] as Record<string, unknown>);
    }

    const rows = await this.sql`
      INSERT INTO agent_personality (profile_id, dimension, content, confidence, evidence_count, created_at, updated_at)
      VALUES (${profileId}, ${dimension}, ${content}, ${0.8}, ${1}, ${now}, ${now})
      RETURNING *
    `;
    return this.rowToAgentPersonality(rows[0] as Record<string, unknown>);
  }

  async deleteAgentPersonality(
    profileId: string,
    dimension: AgentPersonalityDimension,
  ): Promise<boolean> {
    const result = await this.sql`
      DELETE FROM agent_personality
      WHERE profile_id = ${profileId} AND dimension = ${dimension}
    `;
    return result.count > 0;
  }

  // ── User Identity ──

  async getUserIdentity(): Promise<UserIdentity | null> {
    const rows = await this.sql`SELECT * FROM user_identity LIMIT 1`;
    if (rows.length === 0) return null;
    return this.rowToUserIdentity(rows[0] as Record<string, unknown>);
  }

  async updateUserIdentity(fields: {
    name?: string;
    role?: string;
    organization?: string;
    timezone?: string;
    language?: string;
    contact?: Record<string, unknown>;
    notes?: string;
  }): Promise<UserIdentity> {
    const now = Date.now();
    const existing = await this.getUserIdentity();

    if (existing) {
      const rows = await this.sql`
        UPDATE user_identity SET
          name = COALESCE(${fields.name ?? null}, name),
          role = COALESCE(${fields.role ?? null}, role),
          organization = COALESCE(${fields.organization ?? null}, organization),
          timezone = COALESCE(${fields.timezone ?? null}, timezone),
          language = COALESCE(${fields.language ?? null}, language),
          contact = COALESCE(${fields.contact ? JSON.stringify(fields.contact) : null}::jsonb, contact),
          notes = COALESCE(${fields.notes ?? null}, notes),
          updated_at = ${now}
        RETURNING *
      `;
      return this.rowToUserIdentity(rows[0] as Record<string, unknown>);
    }

    const rows = await this.sql`
      INSERT INTO user_identity (name, role, organization, timezone, language, contact, notes, created_at, updated_at)
      VALUES (${fields.name ?? null}, ${fields.role ?? null}, ${fields.organization ?? null},
              ${fields.timezone ?? null}, ${fields.language ?? 'en'},
              ${JSON.stringify(fields.contact ?? {})}::jsonb, ${fields.notes ?? null},
              ${now}, ${now})
      RETURNING *
    `;
    return this.rowToUserIdentity(rows[0] as Record<string, unknown>);
  }

  // ── User Personality ──

  async getUserPersonality(): Promise<UserPersonalityEntry[]> {
    const rows = await this.sql`
      SELECT * FROM user_personality ORDER BY dimension
    `;
    return rows.map((r) => this.rowToUserPersonality(r));
  }

  async observeUserPersonality(
    dimension: UserPersonalityDimension,
    content: string,
    source: PersonalitySource = 'inferred',
  ): Promise<UserPersonalityEntry> {
    const now = Date.now();
    const existing = await this.sql`
      SELECT * FROM user_personality WHERE dimension = ${dimension}
    `;

    if (existing.length > 0) {
      const existingRow = existing[0] as Record<string, unknown>;
      const newConfidence = confirmConfidence(existingRow.confidence as number);
      const rows = await this.sql`
        UPDATE user_personality SET
          content = ${content},
          confidence = ${newConfidence},
          evidence_count = evidence_count + 1,
          source = ${source},
          updated_at = ${now}
        WHERE dimension = ${dimension}
        RETURNING *
      `;
      return this.rowToUserPersonality(rows[0] as Record<string, unknown>);
    }

    const initialConfidence = source === 'declared' || source === 'onboarding' ? 0.7 : 0.3;
    const rows = await this.sql`
      INSERT INTO user_personality (dimension, content, confidence, evidence_count, source, created_at, updated_at)
      VALUES (${dimension}, ${content}, ${initialConfidence}, ${1}, ${source}, ${now}, ${now})
      RETURNING *
    `;
    return this.rowToUserPersonality(rows[0] as Record<string, unknown>);
  }

  async deleteUserPersonality(dimension: UserPersonalityDimension): Promise<boolean> {
    const result = await this.sql`
      DELETE FROM user_personality WHERE dimension = ${dimension}
    `;
    return result.count > 0;
  }

  // ── Identity Proposals (profile-scoped) ──

  async proposeIdentityUpdate(
    profileId: string,
    field: string,
    newValue: string,
    reason: string,
  ): Promise<IdentityProposal> {
    const now = Date.now();
    const id = crypto.randomUUID();
    await this.sql`
      INSERT INTO state (key, value)
      VALUES (${'identity_proposal_' + id}, ${JSON.stringify({ profileId, field, newValue, reason, createdAt: now })})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `;
    return { id, field, newValue, reason, createdAt: now };
  }

  async confirmIdentityUpdate(proposalId: string): Promise<boolean> {
    const key = 'identity_proposal_' + proposalId;
    const rows = await this.sql`SELECT value FROM state WHERE key = ${key}`;
    if (rows.length === 0) return false;

    const row = rows[0] as Record<string, unknown>;
    const proposal = JSON.parse(row.value as string) as {
      profileId: string;
      field: string;
      newValue: string;
    };

    const identity = await this.getAgentIdentity(proposal.profileId);
    if (!identity) return false;

    const now = Date.now();
    if (proposal.field === 'expertise') {
      const expertise = proposal.newValue.split(',').map((s: string) => s.trim());
      await this.sql`
        UPDATE agent_identity SET expertise = ${expertise}, updated_at = ${now}
        WHERE profile_id = ${proposal.profileId}
      `;
    } else {
      await this.sql`
        UPDATE agent_identity SET
          ${this.sql(proposal.field)} = ${proposal.newValue},
          updated_at = ${now}
        WHERE profile_id = ${proposal.profileId}
      `;
    }

    await this.sql`DELETE FROM state WHERE key = ${key}`;
    return true;
  }

  // ── Context Building ──

  async buildIdentityContext(thresholds: IdentityThresholds, profileId: string): Promise<string> {
    const [agentId, agentPersonality, userId, userPersonality] = await Promise.all([
      this.getAgentIdentity(profileId),
      this.getAgentPersonality(profileId),
      this.getUserIdentity(),
      this.getUserPersonality(),
    ]);

    const lines: string[] = ['<identity>'];

    // Agent identity
    if (agentId) {
      const expertise = agentId.expertise.length > 0 ? agentId.expertise.join(', ') : '';
      lines.push(`  <agent role="${escapeXml(agentId.role)}" tone="${escapeXml(agentId.tone)}">`);
      if (expertise) lines.push(`    <expertise>${escapeXml(expertise)}</expertise>`);
      if (agentId.instructions)
        lines.push(`    <instructions>${escapeXml(agentId.instructions)}</instructions>`);
      lines.push('  </agent>');
    }

    // Agent personality (filtered by confidence threshold)
    const filteredAgentP = agentPersonality.filter(
      (p) => p.confidence >= thresholds.personalityConfidenceThreshold,
    );
    if (filteredAgentP.length > 0) {
      lines.push('  <agent_personality>');
      for (const p of filteredAgentP) {
        lines.push(
          `    <dim name="${p.dimension}" confidence="${p.confidence.toFixed(2)}">${escapeXml(p.content)}</dim>`,
        );
      }
      lines.push('  </agent_personality>');
    }

    // User identity
    if (userId) {
      const attrs: string[] = [];
      if (userId.name) attrs.push(`name="${escapeXml(userId.name)}"`);
      if (userId.role) attrs.push(`role="${escapeXml(userId.role)}"`);
      if (userId.organization) attrs.push(`org="${escapeXml(userId.organization)}"`);
      if (userId.timezone) attrs.push(`tz="${escapeXml(userId.timezone)}"`);
      if (userId.language) attrs.push(`lang="${escapeXml(userId.language)}"`);
      lines.push(`  <user ${attrs.join(' ')} />`);
    }

    // User personality (filtered by confidence threshold)
    const filteredUserP = userPersonality.filter(
      (p) => p.confidence >= thresholds.userPersonalityConfidenceThreshold,
    );
    if (filteredUserP.length > 0) {
      lines.push('  <user_personality>');
      for (const p of filteredUserP) {
        lines.push(
          `    <dim name="${p.dimension}" confidence="${p.confidence.toFixed(2)}">${escapeXml(p.content)}</dim>`,
        );
      }
      lines.push('  </user_personality>');
    }

    lines.push('</identity>');
    return lines.join('\n');
  }

  // ── Row Converters ──

  private rowToAgentIdentity(row: Record<string, unknown>): AgentIdentity {
    return {
      role: row.role as string,
      expertise: (row.expertise as string[]) ?? [],
      tone: row.tone as string,
      instructions: (row.instructions as string) ?? undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private rowToAgentPersonality(row: Record<string, unknown>): AgentPersonalityEntry {
    return {
      id: row.id as string,
      dimension: row.dimension as AgentPersonalityDimension,
      content: row.content as string,
      confidence: Number(row.confidence),
      evidenceCount: Number(row.evidence_count),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private rowToUserIdentity(row: Record<string, unknown>): UserIdentity {
    return {
      name: (row.name as string) ?? undefined,
      role: (row.role as string) ?? undefined,
      organization: (row.organization as string) ?? undefined,
      timezone: (row.timezone as string) ?? undefined,
      language: (row.language as string) ?? 'en',
      contact: (row.contact as Record<string, unknown>) ?? {},
      notes: (row.notes as string) ?? undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private rowToUserPersonality(row: Record<string, unknown>): UserPersonalityEntry {
    return {
      id: row.id as string,
      dimension: row.dimension as UserPersonalityDimension,
      content: row.content as string,
      confidence: Number(row.confidence),
      evidenceCount: Number(row.evidence_count),
      source: row.source as PersonalitySource,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
}

// ─── XML Escaping ─────────────────────────────────────────────────────────

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
