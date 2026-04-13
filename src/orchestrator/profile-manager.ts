/**
 * ProfileManager: CRUD for agent profiles.
 *
 * Profiles scope agent identity, personality, and long-term memory
 * (Tier 2, Tier 3, External). Each chat is assigned to exactly one
 * profile. Deep clone supports memory-preserving platform migration.
 *
 * See ADR-034.
 */

import type { Sql } from './connection.js';
import type { AgentProfile, AgentProfileWithStats } from './types.js';

// ─── Options ──────────────────────────────────────────────────────────────

export interface ProfileManagerOptions {
  sql: Sql;
  maxProfilesPerUser: number;
}

// ─── ProfileManager ──────────────────────────────────────────────────────

export class ProfileManager {
  private readonly sql: Sql;
  private readonly maxProfiles: number;

  constructor(options: ProfileManagerOptions) {
    this.sql = options.sql;
    this.maxProfiles = options.maxProfilesPerUser;
  }

  /** Create a new profile. First profile auto-sets is_default = true. */
  async createProfile(name: string, description?: string): Promise<AgentProfile> {
    const now = Date.now();

    // Check limit
    const countResult = await this.sql`
      SELECT COUNT(*)::integer AS cnt FROM agent_profiles
    `;
    const countRow = countResult[0];
    if (!countRow) throw new Error('Failed to query profile count');
    if (Number(countRow.cnt) >= this.maxProfiles) {
      throw new Error(`Profile limit reached (max ${String(this.maxProfiles)})`);
    }

    // Auto-set default if this is the first profile
    const isDefault = Number(countRow.cnt) === 0;

    const rows = await this.sql`
      INSERT INTO agent_profiles (name, description, is_default, created_at, updated_at)
      VALUES (${name}, ${description ?? null}, ${isDefault}, ${now}, ${now})
      RETURNING *
    `;
    const inserted = rows[0];
    if (!inserted) throw new Error('Failed to insert profile');
    return rowToProfile(inserted);
  }

  /**
   * Delete a profile. Fails if:
   * - Any chats reference this profile (must reassign first)
   * - Profile is the default (must set another default first)
   *
   * Cascades to: agent_identity, agent_personality, memory_semantic,
   * memory_meta, memory_external (and their DAG join tables via ON DELETE CASCADE).
   */
  async deleteProfile(profileId: string): Promise<void> {
    // Check if default
    const profile = await this.getProfile(profileId);
    if (!profile) throw new Error('Profile not found');
    if (profile.isDefault)
      throw new Error('Cannot delete the default profile. Set another profile as default first.');

    // Check if chats reference this profile
    const chatCount = await this.sql`
      SELECT COUNT(*)::integer AS cnt FROM chats WHERE profile_id = ${profileId}
    `;
    const chatCountRow = chatCount[0];
    if (!chatCountRow) throw new Error('Failed to query chat count');
    if (Number(chatCountRow.cnt) > 0) {
      throw new Error('Cannot delete profile with assigned chats. Reassign chats first.');
    }

    // Delete in dependency order: DAG joins → memories → identity/personality → profile
    // memory_meta_sources references both memory_meta and memory_semantic
    await this.sql`
      DELETE FROM memory_meta_sources WHERE meta_id IN (
        SELECT id FROM memory_meta WHERE profile_id = ${profileId}
      )
    `;
    await this.sql`
      DELETE FROM memory_meta_sources WHERE semantic_id IN (
        SELECT id FROM memory_semantic WHERE profile_id = ${profileId}
      )
    `;
    // summary_parent_sources and summary_message_sources reference memory_semantic
    await this.sql`
      DELETE FROM summary_parent_sources WHERE parent_id IN (
        SELECT id FROM memory_semantic WHERE profile_id = ${profileId}
      ) OR child_id IN (
        SELECT id FROM memory_semantic WHERE profile_id = ${profileId}
      )
    `;
    await this.sql`
      DELETE FROM summary_message_sources WHERE summary_id IN (
        SELECT id FROM memory_semantic WHERE profile_id = ${profileId}
      )
    `;

    await this.sql`DELETE FROM memory_external WHERE profile_id = ${profileId}`;
    await this.sql`DELETE FROM memory_meta WHERE profile_id = ${profileId}`;
    await this.sql`DELETE FROM memory_semantic WHERE profile_id = ${profileId}`;
    await this.sql`DELETE FROM agent_personality WHERE profile_id = ${profileId}`;
    await this.sql`DELETE FROM agent_identity WHERE profile_id = ${profileId}`;
    await this.sql`DELETE FROM agent_profiles WHERE id = ${profileId}`;
  }

  /** Get a single profile by ID. */
  async getProfile(profileId: string): Promise<AgentProfile | null> {
    const rows = await this.sql`
      SELECT * FROM agent_profiles WHERE id = ${profileId}
    `;
    const row = rows[0];
    return row ? rowToProfile(row) : null;
  }

  /** Get a single profile by name. */
  async getProfileByName(name: string): Promise<AgentProfile | null> {
    const rows = await this.sql`
      SELECT * FROM agent_profiles WHERE name = ${name}
    `;
    const row = rows[0];
    return row ? rowToProfile(row) : null;
  }

  /** List all profiles with stats. */
  async listProfiles(): Promise<AgentProfileWithStats[]> {
    const rows = await this.sql`
      SELECT
        ap.*,
        COALESCE(chat_stats.cnt, 0)::integer AS chat_count,
        COALESCE(semantic_stats.cnt, 0)::integer AS semantic_memory_count,
        COALESCE(meta_stats.cnt, 0)::integer AS meta_memory_count
      FROM agent_profiles ap
      LEFT JOIN (
        SELECT profile_id, COUNT(*)::integer AS cnt FROM chats GROUP BY profile_id
      ) chat_stats ON chat_stats.profile_id = ap.id
      LEFT JOIN (
        SELECT profile_id, COUNT(*)::integer AS cnt FROM memory_semantic GROUP BY profile_id
      ) semantic_stats ON semantic_stats.profile_id = ap.id
      LEFT JOIN (
        SELECT profile_id, COUNT(*)::integer AS cnt FROM memory_meta GROUP BY profile_id
      ) meta_stats ON meta_stats.profile_id = ap.id
      ORDER BY ap.created_at ASC
    `;
    return rows.map(rowToProfileWithStats);
  }

  /** Get the default profile. */
  async getDefaultProfile(): Promise<AgentProfile | null> {
    const rows = await this.sql`
      SELECT * FROM agent_profiles WHERE is_default = true LIMIT 1
    `;
    const row = rows[0];
    return row ? rowToProfile(row) : null;
  }

  /** Set a profile as the default (unsets previous default in one transaction). */
  async setDefaultProfile(profileId: string): Promise<void> {
    const profile = await this.getProfile(profileId);
    if (!profile) throw new Error('Profile not found');
    if (profile.isDefault) return; // Already default

    const now = Date.now();
    await this.sql.begin(async (_tx) => {
      const tx = _tx as unknown as Sql;
      await tx`UPDATE agent_profiles SET is_default = false, updated_at = ${now} WHERE is_default = true`;
      await tx`UPDATE agent_profiles SET is_default = true, updated_at = ${now} WHERE id = ${profileId}`;
    });
  }

  /** Assign a chat to a profile. Returns the previous profile ID. */
  async assignChat(chatId: string, profileId: string): Promise<string> {
    // Verify profile exists
    const profile = await this.getProfile(profileId);
    if (!profile) throw new Error('Target profile not found');

    // Get current profile
    const chatRows = await this.sql`SELECT profile_id FROM chats WHERE id = ${chatId}`;
    const chatRow = chatRows[0];
    if (!chatRow) throw new Error('Chat not found');
    const previousProfileId = chatRow.profile_id as string;

    const now = Date.now();
    await this.sql`
      UPDATE chats SET profile_id = ${profileId}, updated_at = ${now}
      WHERE id = ${chatId}
    `;

    return previousProfileId;
  }

  /** Get the profile for a given chat. */
  async getChatProfile(chatId: string): Promise<AgentProfile | null> {
    const rows = await this.sql`
      SELECT ap.* FROM agent_profiles ap
      JOIN chats c ON c.profile_id = ap.id
      WHERE c.id = ${chatId}
    `;
    const row = rows[0];
    return row ? rowToProfile(row) : null;
  }

  /**
   * Deep clone a profile: identity, personality, and all memory rows.
   * DAG join tables are remapped to cloned UUIDs.
   * All in one transaction.
   */
  async cloneProfile(
    sourceId: string,
    newName: string,
    newDescription?: string,
  ): Promise<AgentProfile> {
    const source = await this.getProfile(sourceId);
    if (!source) throw new Error('Source profile not found');

    // Check limit
    const countResult = await this.sql`
      SELECT COUNT(*)::integer AS cnt FROM agent_profiles
    `;
    const cloneCountRow = countResult[0];
    if (!cloneCountRow) throw new Error('Failed to query profile count');
    if (Number(cloneCountRow.cnt) >= this.maxProfiles) {
      throw new Error(`Profile limit reached (max ${String(this.maxProfiles)})`);
    }

    const now = Date.now();

    const result = await this.sql.begin(async (_tx) => {
      const tx = _tx as unknown as Sql;
      // 1. Create new profile
      const profileRows = await tx`
        INSERT INTO agent_profiles (name, description, is_default, created_at, updated_at)
        VALUES (${newName}, ${newDescription ?? source.description}, false, ${now}, ${now})
        RETURNING *
      `;
      const insertedProfile = profileRows[0];
      if (!insertedProfile) throw new Error('Failed to insert cloned profile');
      const newProfile = rowToProfile(insertedProfile);
      const newProfileId = newProfile.id;

      // 2. Clone agent_identity
      await tx`
        INSERT INTO agent_identity (profile_id, role, expertise, tone, instructions, created_at, updated_at)
        SELECT ${newProfileId}, role, expertise, tone, instructions, ${now}, ${now}
        FROM agent_identity WHERE profile_id = ${sourceId}
      `;

      // 3. Clone agent_personality
      await tx`
        INSERT INTO agent_personality (profile_id, dimension, content, confidence, evidence_count, created_at, updated_at)
        SELECT ${newProfileId}, dimension, content, confidence, evidence_count, ${now}, ${now}
        FROM agent_personality WHERE profile_id = ${sourceId}
      `;

      // 4. Clone memory_semantic with UUID mapping
      const semanticSources = await tx`
        SELECT id FROM memory_semantic WHERE profile_id = ${sourceId} ORDER BY id
      `;

      const semanticIdMap = new Map<string, string>();
      for (const row of semanticSources) {
        const oldId = row.id as string;
        const newRows = await tx`
          INSERT INTO memory_semantic
            (content, embedding, memory_type, importance, depth, token_count,
             source_session, profile_id, earliest_at, latest_at,
             created_at, updated_at, last_accessed, access_count)
          SELECT content, embedding, memory_type, importance, depth, token_count,
                 source_session, ${newProfileId}, earliest_at, latest_at,
                 ${now}, ${now}, ${now}, 0
          FROM memory_semantic WHERE id = ${oldId}
          RETURNING id
        `;
        const newSemanticRow = newRows[0];
        if (!newSemanticRow) throw new Error('Failed to clone semantic memory');
        semanticIdMap.set(oldId, newSemanticRow.id as string);
      }

      // 5. Clone memory_meta with UUID mapping
      const metaSources = await tx`
        SELECT id FROM memory_meta WHERE profile_id = ${sourceId} ORDER BY id
      `;

      const metaIdMap = new Map<string, string>();
      for (const row of metaSources) {
        const oldId = row.id as string;
        const newRows = await tx`
          INSERT INTO memory_meta
            (content, embedding, reflection_type, confidence, depth, profile_id,
             created_at, updated_at, last_accessed)
          SELECT content, embedding, reflection_type, confidence, depth, ${newProfileId},
                 ${now}, ${now}, ${now}
          FROM memory_meta WHERE id = ${oldId}
          RETURNING id
        `;
        const newMetaRow = newRows[0];
        if (!newMetaRow) throw new Error('Failed to clone meta memory');
        metaIdMap.set(oldId, newMetaRow.id as string);
      }

      // 6. Clone memory_external
      await tx`
        INSERT INTO memory_external
          (content, embedding, source_type, source_ref, profile_id, created_at)
        SELECT content, embedding, source_type, source_ref, ${newProfileId}, ${now}
        FROM memory_external WHERE profile_id = ${sourceId}
      `;

      // 7. Remap DAG join tables

      // summary_message_sources: summary_id is a semantic memory
      const smsRows = await tx`
        SELECT summary_id, message_id, chat_id FROM summary_message_sources
        WHERE summary_id IN (SELECT id FROM memory_semantic WHERE profile_id = ${sourceId})
      `;
      for (const sms of smsRows) {
        const newSummaryId = semanticIdMap.get(sms.summary_id as string);
        if (newSummaryId) {
          await tx`
            INSERT INTO summary_message_sources (summary_id, message_id, chat_id)
            VALUES (${newSummaryId}, ${sms.message_id as string}, ${sms.chat_id as string})
            ON CONFLICT DO NOTHING
          `;
        }
      }

      // summary_parent_sources: both parent_id and child_id are semantic
      const spsRows = await tx`
        SELECT parent_id, child_id FROM summary_parent_sources
        WHERE parent_id IN (SELECT id FROM memory_semantic WHERE profile_id = ${sourceId})
      `;
      for (const sps of spsRows) {
        const newParentId = semanticIdMap.get(sps.parent_id as string);
        const newChildId = semanticIdMap.get(sps.child_id as string);
        if (newParentId && newChildId) {
          await tx`
            INSERT INTO summary_parent_sources (parent_id, child_id)
            VALUES (${newParentId}, ${newChildId})
            ON CONFLICT DO NOTHING
          `;
        }
      }

      // memory_meta_sources: meta_id → meta, semantic_id → semantic
      const mmsRows = await tx`
        SELECT meta_id, semantic_id FROM memory_meta_sources
        WHERE meta_id IN (SELECT id FROM memory_meta WHERE profile_id = ${sourceId})
      `;
      for (const mms of mmsRows) {
        const newMetaId = metaIdMap.get(mms.meta_id as string);
        const newSemanticId = semanticIdMap.get(mms.semantic_id as string);
        if (newMetaId && newSemanticId) {
          await tx`
            INSERT INTO memory_meta_sources (meta_id, semantic_id)
            VALUES (${newMetaId}, ${newSemanticId})
            ON CONFLICT DO NOTHING
          `;
        }
      }

      // meta_parent_sources: T3 internal DAG (d1+ → d0 children)
      const mpsRows = await tx`
        SELECT parent_id, child_id FROM meta_parent_sources
        WHERE parent_id IN (SELECT id FROM memory_meta WHERE profile_id = ${sourceId})
      `;
      for (const mps of mpsRows) {
        const newParentId = metaIdMap.get(mps.parent_id as string);
        const newChildId = metaIdMap.get(mps.child_id as string);
        if (newParentId && newChildId) {
          await tx`
            INSERT INTO meta_parent_sources (parent_id, child_id)
            VALUES (${newParentId}, ${newChildId})
            ON CONFLICT DO NOTHING
          `;
        }
      }

      return newProfile;
    });

    return result;
  }
}

// ─── Row Converters ──────────────────────────────────────────────────────

function rowToProfile(row: Record<string, unknown>): AgentProfile {
  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string) ?? null,
    isDefault: row.is_default as boolean,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowToProfileWithStats(row: Record<string, unknown>): AgentProfileWithStats {
  return {
    ...rowToProfile(row),
    chatCount: Number(row.chat_count),
    semanticMemoryCount: Number(row.semantic_memory_count),
    metaMemoryCount: Number(row.meta_memory_count),
  };
}
