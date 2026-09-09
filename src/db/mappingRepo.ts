import crypto from "node:crypto";
import { pool } from "./client";
import { EntityType, ObjectMappingRow, SyncOrigin } from "./types";

function toRow(r: any): ObjectMappingRow {
  return {
    id: r.id,
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

export async function findMappingByHubspotId(entityType: EntityType, hubspotId: string): Promise<ObjectMappingRow | null> {
  const res = await pool.query(`SELECT * FROM object_mappings WHERE entity_type = $1 AND hubspot_id = $2`, [
    entityType,
    hubspotId,
  ]);
  return res.rows[0] ? toRow(res.rows[0]) : null;
}

export async function findMappingByDotloopId(entityType: EntityType, dotloopId: string): Promise<ObjectMappingRow | null> {
  const res = await pool.query(`SELECT * FROM object_mappings WHERE entity_type = $1 AND dotloop_id = $2`, [
    entityType,
    dotloopId,
  ]);
  return res.rows[0] ? toRow(res.rows[0]) : null;
}

export interface CreateMappingInput {
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
       (id, entity_type, hubspot_id, dotloop_id, dotloop_profile_id, last_synced_hash, last_synced_at, last_sync_origin, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     RETURNING *`,
    [
      crypto.randomUUID(),
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
