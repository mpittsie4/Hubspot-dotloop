import { pool } from "./client";
import { ReconcileStateRow } from "./types";

function toRow(r: any): ReconcileStateRow {
  return { id: r.id, lastHubspotPollAt: r.last_hubspot_poll_at, lastDotloopPollAt: r.last_dotloop_poll_at };
}

/**
 * Per-tenant reconciliation watermarks, keyed by tenant id (each tenant is
 * scanned independently by sync/reconcile.ts). Used to be a single
 * hardcoded 'singleton' row for the whole server; migrations/002_tenants.sql
 * repoints that old row at the seeded default tenant so its watermark
 * isn't lost, and every row from here on is just keyed by whatever tenant
 * id is passed in.
 */
export async function getReconcileState(tenantId: string): Promise<ReconcileStateRow> {
  const res = await pool.query(
    `INSERT INTO reconcile_state (id) VALUES ($1)
     ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
     RETURNING *`,
    [tenantId]
  );
  return toRow(res.rows[0]);
}

export async function setReconcileTimestamps(tenantId: string, hubspotAt: Date, dotloopAt: Date): Promise<void> {
  await pool.query(`UPDATE reconcile_state SET last_hubspot_poll_at = $2, last_dotloop_poll_at = $3 WHERE id = $1`, [
    tenantId,
    hubspotAt,
    dotloopAt,
  ]);
}
