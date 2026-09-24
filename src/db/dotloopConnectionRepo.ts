import crypto from "node:crypto";
import { pool } from "./client";
import { DotloopConnectionRow } from "./types";

function toRow(r: any): DotloopConnectionRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    hubspotOwnerId: r.hubspot_owner_id,
    dotloopAccountId: r.dotloop_account_id,
    dotloopProfileId: r.dotloop_profile_id,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Ensures a (tenant, hubspotOwnerId) connection row exists, in PENDING
 * status, without touching an existing row -- called at the top of the
 * Dotloop OAuth callback for a per-agent connect link (see
 * routes/authRoutes.ts) so re-running the OAuth flow (e.g. the agent
 * connected the wrong account and is redoing it) never fails on a unique
 * violation.
 */
export async function createPendingConnection(tenantId: string, hubspotOwnerId: string): Promise<DotloopConnectionRow> {
  await pool.query(
    `INSERT INTO dotloop_connections (id, tenant_id, hubspot_owner_id, status)
     VALUES ($1, $2, $3, 'PENDING')
     ON CONFLICT (tenant_id, hubspot_owner_id) DO NOTHING`,
    [`dlconn_${crypto.randomUUID()}`, tenantId, hubspotOwnerId]
  );
  const existing = await findConnectionByOwner(tenantId, hubspotOwnerId);
  if (!existing) throw new Error(`Failed to create or find Dotloop connection for tenant ${tenantId} / owner ${hubspotOwnerId}`);
  return existing;
}

export async function findConnectionByOwner(tenantId: string, hubspotOwnerId: string): Promise<DotloopConnectionRow | null> {
  const res = await pool.query(`SELECT * FROM dotloop_connections WHERE tenant_id = $1 AND hubspot_owner_id = $2`, [
    tenantId,
    hubspotOwnerId,
  ]);
  return res.rows[0] ? toRow(res.rows[0]) : null;
}

/** Dotloop webhook events carry a profileId, not an accountId -- see
 *  sync/dotloopRouting.ts's resolveTenantAndAccountForProfile(), which
 *  checks the tenant-level single connection first, then falls back here
 *  for brokerage-mode tenants. */
export async function findConnectionByProfileId(profileId: string): Promise<DotloopConnectionRow | null> {
  const res = await pool.query(`SELECT * FROM dotloop_connections WHERE dotloop_profile_id = $1`, [profileId]);
  return res.rows[0] ? toRow(res.rows[0]) : null;
}

export async function listConnectionsForTenant(tenantId: string): Promise<DotloopConnectionRow[]> {
  const res = await pool.query(`SELECT * FROM dotloop_connections WHERE tenant_id = $1 ORDER BY created_at ASC`, [tenantId]);
  return res.rows.map(toRow);
}

/** What sync/dotloopRouting.ts's listDotloopSyncTargets() polls/registers
 *  subscriptions for in brokerage mode. */
export async function listActiveConnectionsForTenant(tenantId: string): Promise<DotloopConnectionRow[]> {
  const res = await pool.query(`SELECT * FROM dotloop_connections WHERE tenant_id = $1 AND status = 'ACTIVE'`, [tenantId]);
  return res.rows.map(toRow);
}

/** Whether this tenant has opted into brokerage/multi-agent mode at all --
 *  see sync/dotloopRouting.ts. */
export async function hasAnyConnections(tenantId: string): Promise<boolean> {
  const res = await pool.query(`SELECT 1 FROM dotloop_connections WHERE tenant_id = $1 LIMIT 1`, [tenantId]);
  return res.rows.length > 0;
}

/** Connected (have an account id) but missing their cached profile id --
 *  mirrors db/tenantRepo.ts's listTenantsMissingDotloopProfileId(); see
 *  sync/reconcile.ts's backfillConnectionProfileIds(). */
export async function listConnectionsMissingProfileId(): Promise<DotloopConnectionRow[]> {
  const res = await pool.query(
    `SELECT * FROM dotloop_connections WHERE dotloop_account_id IS NOT NULL AND dotloop_profile_id IS NULL`
  );
  return res.rows.map(toRow);
}

/** Sets this agent's Dotloop account id and flips the connection to ACTIVE
 *  -- called from the per-agent OAuth callback. The row must already exist
 *  (via createPendingConnection). */
export async function setConnectionAccountId(
  tenantId: string,
  hubspotOwnerId: string,
  accountId: string
): Promise<DotloopConnectionRow> {
  const res = await pool.query(
    `UPDATE dotloop_connections SET dotloop_account_id = $3, status = 'ACTIVE', updated_at = now()
     WHERE tenant_id = $1 AND hubspot_owner_id = $2 RETURNING *`,
    [tenantId, hubspotOwnerId, accountId]
  );
  if (!res.rows[0]) throw new Error(`No pending Dotloop connection for tenant ${tenantId} / owner ${hubspotOwnerId}`);
  return toRow(res.rows[0]);
}

export async function setConnectionProfileId(connectionId: string, profileId: string): Promise<DotloopConnectionRow> {
  const res = await pool.query(
    `UPDATE dotloop_connections SET dotloop_profile_id = $2, updated_at = now() WHERE id = $1 RETURNING *`,
    [connectionId, profileId]
  );
  if (!res.rows[0]) throw new Error(`Unknown Dotloop connection: ${connectionId}`);
  return toRow(res.rows[0]);
}
