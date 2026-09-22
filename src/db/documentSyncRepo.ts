import crypto from "node:crypto";
import { pool } from "./client";

export interface SyncedDocumentRow {
  id: string;
  tenantId: string;
  dotloopLoopId: string;
  dotloopDocumentId: string;
  documentName: string | null;
  folderName: string | null;
  dotloopUpdatedAt: Date | null;
  hubspotDealId: string;
  hubspotNoteId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toRow(r: any): SyncedDocumentRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    dotloopLoopId: r.dotloop_loop_id,
    dotloopDocumentId: r.dotloop_document_id,
    documentName: r.document_name,
    folderName: r.folder_name,
    dotloopUpdatedAt: r.dotloop_updated_at,
    hubspotDealId: r.hubspot_deal_id,
    hubspotNoteId: r.hubspot_note_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function findSyncedDocument(tenantId: string, dotloopDocumentId: string): Promise<SyncedDocumentRow | null> {
  const res = await pool.query(
    `SELECT * FROM synced_documents WHERE tenant_id = $1 AND dotloop_document_id = $2`,
    [tenantId, dotloopDocumentId]
  );
  return res.rows[0] ? toRow(res.rows[0]) : null;
}

/**
 * Documents known for a deal's loop(s), most-recently-updated first -- backs
 * the "Dotloop Sync Status" card's document links (see
 * routes/hubspotProxyRoutes.ts's /deals/:dealId/dotloop-status endpoint).
 * `limit` caps how many the card renders; there's no pagination on the card
 * side, so keep this reasonably small.
 */
export async function listSyncedDocumentsForDeal(
  tenantId: string,
  hubspotDealId: string,
  limit = 10
): Promise<SyncedDocumentRow[]> {
  const res = await pool.query(
    `SELECT * FROM synced_documents
     WHERE tenant_id = $1 AND hubspot_deal_id = $2
     ORDER BY COALESCE(dotloop_updated_at, updated_at) DESC
     LIMIT $3`,
    [tenantId, hubspotDealId, limit]
  );
  return res.rows.map(toRow);
}

export interface UpsertSyncedDocumentInput {
  tenantId: string;
  dotloopLoopId: string;
  dotloopDocumentId: string;
  documentName: string | null;
  folderName: string | null;
  dotloopUpdatedAt: Date | null;
  hubspotDealId: string;
  /**
   * Left over from when new/updated documents got a HubSpot note (see
   * sync/documentSync.ts's doc comment) -- that note is gone in favor of the
   * "Dotloop Sync Status" card listing documents directly, so callers no
   * longer have a note id to pass. Kept nullable rather than dropped so
   * existing rows (and the column) don't need a migration.
   */
  hubspotNoteId?: string | null;
}

/** Records (or updates) the current metadata for one Dotloop loop document, keyed by (tenant, document id). */
export async function upsertSyncedDocument(input: UpsertSyncedDocumentInput): Promise<SyncedDocumentRow> {
  const res = await pool.query(
    `INSERT INTO synced_documents
       (id, tenant_id, dotloop_loop_id, dotloop_document_id, document_name, folder_name, dotloop_updated_at, hubspot_deal_id, hubspot_note_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT (tenant_id, dotloop_document_id) DO UPDATE SET
       document_name = EXCLUDED.document_name,
       folder_name = EXCLUDED.folder_name,
       dotloop_updated_at = EXCLUDED.dotloop_updated_at,
       hubspot_note_id = EXCLUDED.hubspot_note_id,
       updated_at = now()
     RETURNING *`,
    [
      crypto.randomUUID(),
      input.tenantId,
      input.dotloopLoopId,
      input.dotloopDocumentId,
      input.documentName,
      input.folderName,
      input.dotloopUpdatedAt,
      input.hubspotDealId,
      input.hubspotNoteId ?? null,
    ]
  );
  return toRow(res.rows[0]);
}
