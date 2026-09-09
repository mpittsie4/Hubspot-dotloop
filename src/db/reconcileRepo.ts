import { pool } from "./client";
import { ReconcileStateRow } from "./types";

function toRow(r: any): ReconcileStateRow {
  return { id: r.id, lastHubspotPollAt: r.last_hubspot_poll_at, lastDotloopPollAt: r.last_dotloop_poll_at };
}

export async function getReconcileState(): Promise<ReconcileStateRow> {
  const res = await pool.query(
    `INSERT INTO reconcile_state (id) VALUES ('singleton')
     ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
     RETURNING *`
  );
  return toRow(res.rows[0]);
}

export async function setReconcileTimestamps(hubspotAt: Date, dotloopAt: Date): Promise<void> {
  await pool.query(
    `UPDATE reconcile_state SET last_hubspot_poll_at = $1, last_dotloop_poll_at = $2 WHERE id = 'singleton'`,
    [hubspotAt, dotloopAt]
  );
}
