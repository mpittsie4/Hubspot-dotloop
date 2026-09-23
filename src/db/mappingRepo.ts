import crypto from "node:crypto";
import { pool } from "./client";
import { EntityType, ObjectMappingRow, SyncOrigin } from "./types";

function toRow(r: any): ObjectMappingRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    entityType: r.entity_type,
    hubspotId: r.hubspot_id,
    dotloopId: r.dotloop_id,
    dotloopProfileId: r.dotloop_profile_id,
    lastSyncedHash: r.last_synced_hash,
    lastSyncedAt: r.last_synced_at,
    lastSyncOrigin: r.last_sync_origin,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// hubspot_id/dotloop_id are only unique *within* one tenant's portal/account
// (see migrations/002_tenants.sql), so every lookup and write here is
// scoped by tenantId.

export async function findMappingByHubspotId(
  tenantId: string,
  entityType: EntityType,
  hubspotId: string
): Promise<ObjectMappingRow | null> {
  const res = await pool.query(
    `SELECT * FROM object_mappings WHERE tenant_id = $1 AND entity_type = $2 AND hubspot_id = $3`,
    [tenantId, entityType, hubspotId]
  );
  return res.rows[0] ? toRow(res.rows[0]) : null;
}

export async function findMappingByDotloopId(
  tenantId: string,
  entityType: EntityType,
  dotloopId: string
): Promise<ObjectMappingRow | null> {
  const res = await pool.query(
    `SELECT * FROM object_mappings WHERE tenant_id = $1 AND entity_type = $2 AND dotloop_id = $3`,
    [tenantId, entityType, dotloopId]
  );
  return res.rows[0] ? toRow(res.rows[0]) : null;
}

export interface CreateMappingInput {
  tenantId: string;
  entityType: EntityType;
  hubspotId: string;
  dotloopId: string;
  dotloopProfileId?: string;
  lastSyncedHash: string;
  lastSyncedAt: Date;
  lastSyncOrigin: SyncOrigin;
}

export async function createMapping(input: CreateMappingInput): Promise<ObjectMappingRow> {
  const res = await pool.query(
    `INSERT INTO object_mappings
       (id, tenant_id, entity_type, hubspot_id, dotloop_id, dotloop_profile_id, last_synced_hash, last_synced_at, last_sync_origin, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     RETURNING *`,
    [
      crypto.randomUUID(),
      input.tenantId,
      input.entityType,
      input.hubspotId,
      input.dotloopId,
      input.dotloopProfileId ?? null,
      input.lastSyncedHash,
      input.lastSyncedAt,
      input.lastSyncOrigin,
    ]
  );
  return toRow(res.rows[0]);
}

export interface UpdateMappingInput {
  lastSyncedHash: string;
  lastSyncedAt: Date;
  lastSyncOrigin: SyncOrigin;
}

export async function updateMapping(id: string, input: UpdateMappingInput): Promise<ObjectMappingRow> {
  const res = await pool.query(
    `UPDATE object_mappings
     SET last_synced_hash = $2, last_synced_at = $3, last_sync_origin = $4, updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, input.lastSyncedHash, input.lastSyncedAt, input.lastSyncOrigin]
  );
  return toRow(res.rows[0]);
}

/**
 * Re-points an existing mapping row at a new Dotloop loop id, in place.
 *
 * Needed for Dotloop's LOOP_MERGED event (see webhooks/dotloopWebhook.ts):
 * when two loops merge, the "losing" loop id (fromId) stops resolving and
 * everything continues under the surviving id (toId). Without this, the
 * next sync pass looks up the mapping by the new id, finds nothing (the
 * existing row is still keyed on the old id), and concludes it's a brand
 * new loop -- creating a duplicate HubSpot deal for a transaction that
 * already had one. Repointing the row keeps the existing deal instead.
 */
export async function repointMappingDotloopId(id: string, newDotloopId: string): Promise<ObjectMappingRow> {
  const res = await pool.query(
    `UPDATE object_mappings
     SET dotloop_id = $2, updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, newDotloopId]
  );
  return toRow(res.rows[0]);
}
