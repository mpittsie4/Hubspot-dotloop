/**
 * DIAGNOSTIC / READ-ONLY -- not part of the sync path, makes GET requests
 * only, never uploads/deletes/modifies anything in Dotloop or HubSpot.
 *
 * Investigates whether Dotloop's public API can actually deliver a
 * document's binary content (e.g. a signed PDF's real bytes) -- something
 * the official docs (dotloop.github.io/public-api) do not describe. The
 * documented "Get Document" endpoint (GET .../folder/:folderId/document/:id)
 * returns only { id, name, created, updated } as JSON, with no field for
 * e-signature/signed status and no documented way to fetch the file's
 * bytes. An older, likely-outdated unofficial Node client
 * (github.com/bshamblen/dotloop) claims a working binary-download URL
 * shaped like GET /profile/:id/loop/:id/document/:id/:name.pdf (skipping
 * the /folder/:id/ segment the current v2 docs require), returned as a raw
 * PDF buffer with no special Accept header. This script checks, against a
 * real loop in this account, what actually comes back for a few candidate
 * approaches -- rather than build the "sync signed documents to HubSpot"
 * feature on an assumption either way. See the roadmap doc for what
 * happens with the results.
 *
 * Usage: npm run inspect:loop-documents -- <loopId> [profileId]
 *   (profileId defaults to resolveProfileId() if omitted -- pass one
 *   explicitly if this account has more than one profile)
 *
 * Pick a loop you know has at least one uploaded document in it.
 */
import "dotenv/config";
import { DotloopClient } from "../src/clients/dotloopClient";
import { logger } from "../src/utils/logger";

function summarize(label: string, result: { status: number; headers: Record<string, any>; data: any }) {
  const contentType = result.headers?.["content-type"] ?? result.headers?.["Content-Type"];
  const isBuffer = Buffer.isBuffer(result.data);
  const byteLength = isBuffer ? result.data.length : undefined;
  const preview = isBuffer
    ? result.data.slice(0, 8).toString("hex") // "%PDF" in ASCII is hex 25504446
    : typeof result.data === "string"
      ? result.data.slice(0, 200)
      : JSON.stringify(result.data).slice(0, 300);
  logger.info({ label, status: result.status, contentType, byteLength, preview }, `Result: ${label}`);
}

async function main() {
  const loopId = process.argv[2];
  if (!loopId) {
    throw new Error("Usage: npm run inspect:loop-documents -- <loopId> [profileId]");
  }

  const dotloop = await DotloopClient.create();
  const profileId = process.argv[3] ?? (await dotloop.resolveProfileId());

  logger.info({ profileId, loopId }, "Listing folders for loop");
  const foldersRes = await dotloop.rawRequest(`/profile/${profileId}/loop/${loopId}/folder`);
  summarize("list folders", foldersRes);
  const folders: any[] = foldersRes.data?.data ?? [];

  if (folders.length === 0) {
    logger.warn("No folders found on this loop -- pick a loop that actually has documents in it, then re-run.");
    return;
  }

  for (const folder of folders) {
    logger.info({ folderId: folder.id, folderName: folder.name }, "Listing documents in folder");
    const docsRes = await dotloop.rawRequest(`/profile/${profileId}/loop/${loopId}/folder/${folder.id}/document`);
    summarize(`list documents in folder ${folder.id} (${folder.name})`, docsRes);
    const documents: any[] = docsRes.data?.data ?? [];

    // Only probe the first document per folder -- enough to answer the
    // question without hammering the API once per document.
    for (const doc of documents.slice(0, 1)) {
      logger.info({ documentId: doc.id, documentName: doc.name }, "Probing document content endpoints");

      const jsonRes = await dotloop.rawRequest(
        `/profile/${profileId}/loop/${loopId}/folder/${folder.id}/document/${doc.id}`,
        { headers: { Accept: "application/json" } }
      );
      summarize(`GET .../document/${doc.id} (Accept: application/json) -- the documented endpoint`, jsonRes);

      const pdfAcceptRes = await dotloop.rawRequest(
        `/profile/${profileId}/loop/${loopId}/folder/${folder.id}/document/${doc.id}`,
        { headers: { Accept: "application/pdf" }, responseType: "arraybuffer" }
      );
      summarize(`GET .../document/${doc.id} (Accept: application/pdf) -- content negotiation guess`, pdfAcceptRes);

      const nameNoExt = String(doc.name ?? "document").replace(/\.[^/.]+$/, "");
      const legacyPathRes = await dotloop.rawRequest(
        `/profile/${profileId}/loop/${loopId}/document/${doc.id}/${encodeURIComponent(nameNoExt)}.pdf`,
        { responseType: "arraybuffer" }
      );
      summarize(
        `GET .../loop/${loopId}/document/${doc.id}/${nameNoExt}.pdf -- unofficial-client-style path (no /folder/ segment)`,
        legacyPathRes
      );
    }
  }

  logger.info(
    'Done. A result with status 200, a PDF-like content-type, and a preview starting with hex "25504446" (the ASCII bytes "%PDF") means that path actually returns real document bytes today. Anything else (404, JSON body, non-PDF content-type) means that approach does not work on this account.'
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, "inspectLoopDocuments failed");
    process.exit(1);
  });
