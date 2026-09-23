import crypto from "node:crypto";
import { pool } from "./client";

export type LoopParticipantStatus = "SYNCED" | "SKIPPED_PRE_EXISTING";

export interface LoopParticipantRow {
  id: string;
  tenantId: string;
  hubspotDealId: string;
  hubspotContactId: string;
  dotloopRole: string;
  dotloopParticipantId: string | null;
  dotloopLoopId: string | null;
  status: LoopParticipantStatus;
  createdAt: Date;
  updatedAt: Date;
}

function toRow(r: any): LoopParticipantRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    hubspotDealId: r.hubspot_deal_id,
    hubspotContactId: r.hubspot_contact_id,
    dotloopRole: r.dotloop_role,
    dotloopParticipantId: r.dotloop_participant_id,
    dotloopLoopId: r.dotloop_loop_id,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Whether this exact (deal, contact, role) tuple has already been handled
 * -- either synced for real (status SYNCED) or deliberately skipped as a
 * pre-existing association (status SKIPPED_PRE_EXISTING, see
 * scripts/seedExistingParticipantAssociations.ts). Either way, a hit here
 * means sync/participantSync.ts should not act on it again.
 */
export async function findParticipantMapping(
  tenantId: string,
  hubspotDealId: string,
  hubspotContactId: string,
  dotloopRole: string
): Promise<LoopParticipantRow | null> {
  const res = await pool.query(
    `SELECT * FROM loop_participants
     WHERE tenant_id = $1 AND hubspot_deal_id = $2 AND hubspot_contact_id = $3 AND dotloop_role = $4`,
    [tenantId, hubspotDealId, hubspotContactId, dotloopRole]
  );
  return res.rows[0] ? toRow(res.rows[0]) : null;
}

export interface CreateParticipantMappingInput {
  tenantId: string;
  hubspotDealId: string;
  hubspotContactId: string;
  dotloopRole: string;
  dotloopParticipantId?: string | null;
  dotloopLoopId?: string | null;
  status?: LoopParticipantStatus;
}

export async function createParticipantMapping(input: CreateParticipantMappingInput): Promise<LoopParticipantRow> {
  const res = await pool.query(
    `INSERT INTO loop_participants
       (id, tenant_id, hubspot_deal_id, hubspot_contact_id, dotloop_role, dotloop_participant_id, dotloop_loop_id, status, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (tenant_id, hubspot_deal_id, hubspot_contact_id, dotloop_role) DO NOTHING
     RETURNING *`,
    [
      crypto.randomUUID(),
      input.tenantId,
      input.hubspotDealId,
      input.hubspotContactId,
      input.dotloopRole,
      input.dotloopParticipantId ?? null,
      input.dotloopLoopId ?? null,
      input.status ?? "SYNCED",
    ]
  );
  // ON CONFLICT DO NOTHING returns no row if a concurrent sync pass won the
  // race to create this exact mapping first (same class of race
  // utils/keyedMutex.ts guards against elsewhere) -- re-read it so callers
  // always get a row back instead of dereferencing an empty result.
  if (res.rows[0]) return toRow(res.rows[0]);
  const existing = await findParticipantMapping(input.tenantId, input.hubspotDealId, input.hubspotContactId, input.dotloopRole);
  if (!existing) throw new Error("Failed to create or find participant mapping after conflict");
  return existing;
}

/** Bulk-seeds SKIPPED_PRE_EXISTING rows -- see
 *  scripts/seedExistingParticipantAssociations.ts. Returns how many rows
 *  were actually newly inserted (already-seeded pairs are silently
 *  skipped, so this is safe to re-run). */
export async function seedSkippedParticipantMappings(
  rows: Array<{ tenantId: string; hubspotDealId: string; hubspotContactId: string; dotloopRole: string }>
): Promise<number> {
  let count = 0;
  for (const row of rows) {
    const res = await pool.query(
      `INSERT INTO loop_participants (id, tenant_id, hubspot_deal_id, hubspot_contact_id, dotloop_role, status, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'SKIPPED_PRE_EXISTING', now())
       ON CONFLICT (tenant_id, hubspot_deal_id, hubspot_contact_id, dotloop_role) DO NOTHING
       RETURNING id`,
      [crypto.randomUUID(), row.tenantId, row.hubspotDealId, row.hubspotContactId, row.dotloopRole]
    );
    if (res.rows[0]) count += 1;
  }
  return count;
}
