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

export interface UpsertSyncedDocumentInput {
  tenantId: string;
  dotloopLoopId: string;
  dotloopDocumentId: string;
  documentName: string | null;
  folderName: string | null;
  dotloopUpdatedAt: Date | null;
  hubspotDealId: string;
  hubspotNoteId: string | null;
}

/** Records (or updates) that this exact version of a document has been notified to HubSpot. */
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
      input.hubspotNoteId,
    ]
  );
  return toRow(res.rows[0]);
}
