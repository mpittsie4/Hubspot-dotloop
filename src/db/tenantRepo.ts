import crypto from "node:crypto";
import { pool } from "./client";
import { ContactRoleMapping, PipelineConfig, TenantRow } from "./types";

function toRow(r: any): TenantRow {
  return {
    id: r.id,
    name: r.name,
    hubspotPortalId: r.hubspot_portal_id,
    dotloopAccountId: r.dotloop_account_id,
    dotloopProfileId: r.dotloop_profile_id,
    pipelinesConfig: (r.pipelines_config ?? []) as PipelineConfig[],
    contactRoleMapping: (r.contact_role_mapping ?? []) as ContactRoleMapping[],
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Creates a new, not-yet-connected tenant (status PENDING). Connect it to a
 * real customer by sending them /auth/hubspot/start?tenantId=<id> and
 * /auth/dotloop/start?tenantId=<id> -- see routes/authRoutes.ts's
 * POST /auth/admin/tenants, which wraps this and returns both URLs.
 */
export async function createTenant(name?: string): Promise<TenantRow> {
  const res = await pool.query(`INSERT INTO tenants (id, name, status) VALUES ($1, $2, 'PENDING') RETURNING *`, [
    `tenant_${crypto.randomUUID()}`,
    name ?? null,
  ]);
  return toRow(res.rows[0]);
}

export async function getTenantById(id: string): Promise<TenantRow | null> {
  const res = await pool.query(`SELECT * FROM tenants WHERE id = $1`, [id]);
  return res.rows[0] ? toRow(res.rows[0]) : null;
}

export async function getTenantByHubspotPortalId(portalId: string): Promise<TenantRow | null> {
  const res = await pool.query(`SELECT * FROM tenants WHERE hubspot_portal_id = $1`, [portalId]);
  return res.rows[0] ? toRow(res.rows[0]) : null;
}

export async function getTenantByDotloopAccountId(accountId: string): Promise<TenantRow | null> {
  const res = await pool.query(`SELECT * FROM tenants WHERE dotloop_account_id = $1`, [accountId]);
  return res.rows[0] ? toRow(res.rows[0]) : null;
}

/** Dotloop webhook events carry a profileId, not an accountId (an account
 *  can have more than one profile), so webhook tenant-resolution looks up
 *  by profile id -- see webhooks/dotloopWebhook.ts and resolveProfileId()
 *  in clients/dotloopClient.ts. */
export async function getTenantByDotloopProfileId(profileId: string): Promise<TenantRow | null> {
  const res = await pool.query(`SELECT * FROM tenants WHERE dotloop_profile_id = $1`, [profileId]);
  return res.rows[0] ? toRow(res.rows[0]) : null;
}

/** Tenants with both sides connected -- what sync/reconcile.ts loops over. */
export async function listActiveTenants(): Promise<TenantRow[]> {
  const res = await pool.query(
    `SELECT * FROM tenants WHERE status = 'ACTIVE' AND hubspot_portal_id IS NOT NULL AND dotloop_account_id IS NOT NULL`
  );
  return res.rows.map(toRow);
}

/** Connected to Dotloop but missing their cached profile id -- true for the
 *  tenant_default row seeded by migrations/002_tenants.sql (from before this
 *  column existed) until it's backfilled. See sync/reconcile.ts. */
export async function listTenantsMissingDotloopProfileId(): Promise<TenantRow[]> {
  const res = await pool.query(
    `SELECT * FROM tenants WHERE dotloop_account_id IS NOT NULL AND dotloop_profile_id IS NULL`
  );
  return res.rows.map(toRow);
}

async function activateIfBothConnected(tenant: TenantRow): Promise<TenantRow> {
  if (tenant.status === "PENDING" && tenant.hubspotPortalId && tenant.dotloopAccountId) {
    const res = await pool.query(`UPDATE tenants SET status = 'ACTIVE', updated_at = now() WHERE id = $1 RETURNING *`, [
      tenant.id,
    ]);
    return toRow(res.rows[0]);
  }
  return tenant;
}

/** Links this tenant to a HubSpot portal (called from the OAuth callback)
 *  and flips it to ACTIVE once both sides are connected. */
export async function setHubspotPortalId(tenantId: string, portalId: string): Promise<TenantRow> {
  const res = await pool.query(
    `UPDATE tenants SET hubspot_portal_id = $2, updated_at = now() WHERE id = $1 RETURNING *`,
    [tenantId, portalId]
  );
  if (!res.rows[0]) throw new Error(`Unknown tenant: ${tenantId}`);
  return activateIfBothConnected(toRow(res.rows[0]));
}

export async function setDotloopAccountId(tenantId: string, accountId: string): Promise<TenantRow> {
  const res = await pool.query(
    `UPDATE tenants SET dotloop_account_id = $2, updated_at = now() WHERE id = $1 RETURNING *`,
    [tenantId, accountId]
  );
  if (!res.rows[0]) throw new Error(`Unknown tenant: ${tenantId}`);
  return activateIfBothConnected(toRow(res.rows[0]));
}

export async function setDotloopProfileId(tenantId: string, profileId: string): Promise<TenantRow> {
  const res = await pool.query(
    `UPDATE tenants SET dotloop_profile_id = $2, updated_at = now() WHERE id = $1 RETURNING *`,
    [tenantId, profileId]
  );
  if (!res.rows[0]) throw new Error(`Unknown tenant: ${tenantId}`);
  return toRow(res.rows[0]);
}

export async function updatePipelinesConfig(tenantId: string, pipelines: PipelineConfig[]): Promise<TenantRow> {
  const res = await pool.query(
    `UPDATE tenants SET pipelines_config = $2::jsonb, updated_at = now() WHERE id = $1 RETURNING *`,
    [tenantId, JSON.stringify(pipelines)]
  );
  if (!res.rows[0]) throw new Error(`Unknown tenant: ${tenantId}`);
  return toRow(res.rows[0]);
}

/** See ContactRoleMapping's doc comment in db/types.ts and
 *  scripts/listAssociationLabels.ts for how to populate this per tenant. */
export async function updateContactRoleMapping(tenantId: string, mapping: ContactRoleMapping[]): Promise<TenantRow> {
  const res = await pool.query(
    `UPDATE tenants SET contact_role_mapping = $2::jsonb, updated_at = now() WHERE id = $1 RETURNING *`,
    [tenantId, JSON.stringify(mapping)]
  );
  if (!res.rows[0]) throw new Error(`Unknown tenant: ${tenantId}`);
  return toRow(res.rows[0]);
}
