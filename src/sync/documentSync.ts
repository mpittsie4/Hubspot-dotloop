import { TenantRow } from "../db/types";
import { findSyncedDocument, upsertSyncedDocument } from "../db/documentSyncRepo";
import { DotloopClient } from "../clients/dotloopClient";
import { logger } from "../utils/logger";

/**
 * Keeps `synced_documents` in sync with the documents actually on a Dotloop
 * loop -- new ones as they're added, and again each time an existing one is
 * updated -- so the "Dotloop Sync Status" CRM card (see
 * routes/hubspotProxyRoutes.ts's /deals/:dealId/dotloop-status endpoint,
 * consumed by src/app/cards/DealSyncCard.tsx in the HubSpot Developer
 * Project) can list them as links on the deal.
 *
 * This used to post a HubSpot note per new/updated document instead (see
 * git history) -- Mason asked to move that onto the card as document links
 * rather than timeline notes, so this module no longer talks to HubSpot at
 * all; it just keeps this table current and the card's proxy endpoint reads
 * it directly.
 *
 * Still "Plan A" from the original document-sync feature request: Dotloop's
 * public API only exposes document *metadata* (id/name/folder/timestamps),
 * not the actual file bytes -- confirmed against a real loop via
 * scripts/inspectLoopDocuments.ts (the documented endpoint returns JSON
 * metadata only; asking for Accept: application/pdf gets a 403; the one
 * plausible undocumented "legacy" download URL shape returns 404) -- and
 * Dotloop's API doesn't expose a per-document view URL either, so every
 * document a deal shows links to that deal's loop as a whole (`loopUrl`),
 * not to the specific document within it. If Dotloop ever exposes a real
 * per-document URL or file download (Plan B -- see the roadmap doc), this
 * is the natural place to start recording that instead.
 *
 * Called from sync/dealLoopSync.ts's syncLoopFromDotloop, i.e. on every
 * LOOP_UPDATED webhook and every reconciliation pass that touches this
 * loop -- not its own separate trigger. A document only writes a new row
 * (or touches an existing one) when it's never been seen before, or when
 * Dotloop's own `updated` timestamp on it has moved past what's recorded;
 * anything else is a no-op so an unrelated loop-field change doesn't
 * rewrite every document row on every poll.
 */
export async function syncLoopDocuments(
  tenant: TenantRow,
  dotloop: DotloopClient,
  profileId: string,
  loopId: string,
  hubspotDealId: string
): Promise<void> {
  let folders;
  try {
    folders = await dotloop.listFolders(profileId, loopId);
  } catch (err) {
    logger.error({ err, tenantId: tenant.id, loopId }, "Failed to list Dotloop folders for document sync; skipping");
    return;
  }

  for (const folder of folders) {
    let documents;
    try {
      documents = await dotloop.listDocuments(profileId, loopId, folder.id);
    } catch (err) {
      logger.error(
        { err, tenantId: tenant.id, loopId, folderId: folder.id },
        "Failed to list documents in Dotloop folder; skipping this folder"
      );
      continue;
    }

    for (const doc of documents) {
      try {
        await syncOneDocument(tenant, loopId, folder.name, hubspotDealId, doc);
      } catch (err) {
        logger.error(
          { err, tenantId: tenant.id, loopId, documentId: doc.id },
          "Failed to record one Dotloop document; continuing with the rest"
        );
      }
    }
  }
}

async function syncOneDocument(
  tenant: TenantRow,
  loopId: string,
  folderName: string,
  hubspotDealId: string,
  doc: { id: number; name: string; updated?: string }
): Promise<void> {
  const documentId = String(doc.id);
  const dotloopUpdatedAt = doc.updated ? new Date(doc.updated) : null;

  const existing = await findSyncedDocument(tenant.id, documentId);
  const isNew = !existing;
  const isChanged =
    !isNew && dotloopUpdatedAt && (!existing!.dotloopUpdatedAt || dotloopUpdatedAt.getTime() !== existing!.dotloopUpdatedAt.getTime());

  if (!isNew && !isChanged) {
    return; // already have this exact version of this document recorded
  }

  await upsertSyncedDocument({
    tenantId: tenant.id,
    dotloopLoopId: loopId,
    dotloopDocumentId: documentId,
    documentName: doc.name,
    folderName,
    dotloopUpdatedAt,
    hubspotDealId,
  });

  logger.info({ tenantId: tenant.id, loopId, documentId, hubspotDealId, isNew }, "Recorded Dotloop document for deal's sync card");
}
