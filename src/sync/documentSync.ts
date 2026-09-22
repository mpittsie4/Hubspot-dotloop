import { TenantRow } from "../db/types";
import { findSyncedDocument, upsertSyncedDocument } from "../db/documentSyncRepo";
import { DotloopClient } from "../clients/dotloopClient";
import { HubSpotClient } from "../clients/hubspotClient";
import { logger } from "../utils/logger";

/**
 * Surfaces Dotloop loop documents on the linked HubSpot deal -- new ones as
 * they're added, and again each time an existing one is updated.
 *
 * This is "Plan A" from the document-sync feature request: Dotloop's
 * public API only exposes document *metadata* (id/name/folder/timestamps),
 * not the actual file bytes -- confirmed against a real loop via
 * scripts/inspectLoopDocuments.ts (the documented endpoint returns JSON
 * metadata only; asking for Accept: application/pdf gets a 403; the one
 * plausible undocumented "legacy" download URL shape returns 404). So
 * instead of attaching the real file to the deal, this posts a HubSpot
 * note linking back to the document's loop, across every folder on the
 * loop (no folder-name filtering -- Mason wants every new/updated
 * document, not just specific folders). If Dotloop ever exposes real file
 * downloads (Plan B -- see the roadmap doc), this is the natural place to
 * swap the note-with-a-link for the upload-file + create-note +
 * associate-to-deal flow HubSpot uses elsewhere for file attachments.
 *
 * Called from sync/dealLoopSync.ts's syncLoopFromDotloop, i.e. on every
 * LOOP_UPDATED webhook and every reconciliation pass that touches this
 * loop -- not its own separate trigger. A document only produces a new
 * note when it's never been seen before, or when Dotloop's own `updated`
 * timestamp on it has moved past what's recorded in synced_documents;
 * anything else is a no-op so an unrelated loop-field change doesn't spam
 * the deal timeline with a note per document per poll.
 */
export async function syncLoopDocuments(
  tenant: TenantRow,
  dotloop: DotloopClient,
  hubspot: HubSpotClient,
  profileId: string,
  loopId: string,
  hubspotDealId: string,
  loopUrl?: string
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
        await syncOneDocument(tenant, hubspot, loopId, folder.name, hubspotDealId, loopUrl, doc);
      } catch (err) {
        logger.error(
          { err, tenantId: tenant.id, loopId, documentId: doc.id },
          "Failed to sync one Dotloop document to HubSpot; continuing with the rest"
        );
      }
    }
  }
}

async function syncOneDocument(
  tenant: TenantRow,
  hubspot: HubSpotClient,
  loopId: string,
  folderName: string,
  hubspotDealId: string,
  loopUrl: string | undefined,
  doc: { id: number; name: string; updated?: string }
): Promise<void> {
  const documentId = String(doc.id);
  const dotloopUpdatedAt = doc.updated ? new Date(doc.updated) : null;

  const existing = await findSyncedDocument(tenant.id, documentId);
  const isNew = !existing;
  const isChanged =
    !isNew && dotloopUpdatedAt && (!existing!.dotloopUpdatedAt || dotloopUpdatedAt.getTime() !== existing!.dotloopUpdatedAt.getTime());

  if (!isNew && !isChanged) {
    return; // already notified HubSpot about this exact version of this document
  }

  const linkLine = loopUrl ? `\n\nView it in Dotloop: ${loopUrl}` : "";
  const noteBody = isNew
    ? `New document added in Dotloop ("${folderName}"): ${doc.name}${linkLine}`
    : `Document updated in Dotloop ("${folderName}"): ${doc.name}${linkLine}`;

  const note = await hubspot.createNote(noteBody, new Date());
  await hubspot.associateNoteWithDeal(note.id, hubspotDealId);

  await upsertSyncedDocument({
    tenantId: tenant.id,
    dotloopLoopId: loopId,
    dotloopDocumentId: documentId,
    documentName: doc.name,
    folderName,
    dotloopUpdatedAt,
    hubspotDealId,
    hubspotNoteId: note.id,
  });

  logger.info(
    { tenantId: tenant.id, loopId, documentId, hubspotDealId, isNew },
    "Notified HubSpot deal of Dotloop document"
  );
}
