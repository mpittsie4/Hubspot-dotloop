import { EntityType, SyncOrigin } from "../db/types";
import { createMapping, findMappingByDotloopId, findMappingByHubspotId, updateMapping } from "../db/mappingRepo";
import { createSyncLog } from "../db/syncLogRepo";
import { HubSpotClient } from "../clients/hubspotClient";
import { DotloopClient } from "../clients/dotloopClient";
import {
  CanonicalDeal,
  DEFAULT_TRANSACTION_TYPE,
  fromDotloopLoop,
  fromHubSpotDeal,
  getPipelineById,
  getPipelineForTransactionType,
  toDotloopLoopDetail,
  toDotloopLoopSummary,
  toHubSpotDealProperties,
} from "./dealLoopMapping";
import { hashSyncPayload } from "../utils/crypto";
import { logger } from "../utils/logger";

const HUBSPOT_DEAL_PROPERTIES = ["dealname", "amount", "dealstage", "closedate", "pipeline"];

async function logSync(
  direction: "HUBSPOT_TO_DOTLOOP" | "DOTLOOP_TO_HUBSPOT",
  sourceId: string,
  targetId: string | null,
  status: "SUCCESS" | "ERROR" | "SKIPPED",
  message?: string
) {
  await createSyncLog({ entityType: EntityType.DEAL_LOOP, direction, sourceId, targetId, status, message });
}

async function pushCanonicalToDotloop(
  dotloop: DotloopClient,
  profileId: string,
  loopId: string,
  canonical: CanonicalDeal
) {
  await dotloop.updateLoop(profileId, loopId, toDotloopLoopSummary(canonical));
  const detailPatch = toDotloopLoopDetail(canonical);
  if (Object.keys(detailPatch).length > 0) {
    await dotloop.updateLoopDetail(profileId, loopId, detailPatch);
  }
}

/** Syncs a single HubSpot deal -> its Dotloop loop counterpart. */
export async function syncDealFromHubSpot(hubspotDealId: string) {
  const hubspot = await HubSpotClient.create();
  const dotloop = await DotloopClient.create();

  const source = await hubspot.getDeal(hubspotDealId, HUBSPOT_DEAL_PROPERTIES);
  if (!source) {
    logger.warn({ hubspotDealId }, "HubSpot deal not found (possibly deleted); skipping");
    return;
  }
  const canonical = fromHubSpotDeal(source.properties);
  const hash = hashSyncPayload(canonical as any);

  const mapping = await findMappingByHubspotId(EntityType.DEAL_LOOP, hubspotDealId);

  if (mapping) {
    if (mapping.lastSyncedHash === hash) {
      await logSync("HUBSPOT_TO_DOTLOOP", hubspotDealId, mapping.dotloopId, "SKIPPED", "no-op / echo");
      return;
    }
    const profileId = mapping.dotloopProfileId ?? (await dotloop.resolveProfileId());
    await pushCanonicalToDotloop(dotloop, profileId, mapping.dotloopId, canonical);
    await updateMapping(mapping.id, { lastSyncedHash: hash, lastSyncedAt: new Date(), lastSyncOrigin: SyncOrigin.HUBSPOT });
    await logSync("HUBSPOT_TO_DOTLOOP", hubspotDealId, mapping.dotloopId, "SUCCESS");
    return;
  }

  // No mapping: a new deal maps to a brand new loop. (Dotloop has no
  // reliable "find by name" search, so unlike contacts we don't attempt
  // to auto-link an existing loop here — link manually via the mapping
  // table if you need to backfill history.)
  // The loop's transactionType must match the deal's own pipeline (Renter
  // -> LEASE_OFFER, Buyer -> PURCHASE_OFFER, Seller -> LISTING_FOR_SALE;
  // see PIPELINES in dealLoopMapping.ts) rather than always defaulting to
  // PURCHASE_OFFER, otherwise e.g. a Seller-pipeline deal would create a
  // buy-side loop with the wrong status vocabulary.
  const pipeline = getPipelineById(source.properties.pipeline);
  const transactionType = pipeline?.transactionType ?? DEFAULT_TRANSACTION_TYPE;
  if (!pipeline) {
    logger.warn(
      { hubspotDealId, pipeline: source.properties.pipeline },
      "Deal's pipeline isn't in PIPELINES; falling back to DEFAULT_TRANSACTION_TYPE for the new loop"
    );
  }
  const profileId = await dotloop.resolveProfileId();
  const loop = await dotloop.createLoop(profileId, {
    name: canonical.name || `HubSpot Deal ${hubspotDealId}`,
    transactionType,
    status: canonical.status || undefined,
  });
  await pushCanonicalToDotloop(dotloop, profileId, String(loop.id), canonical);

  await createMapping({
    entityType: EntityType.DEAL_LOOP,
    hubspotId: hubspotDealId,
    dotloopId: String(loop.id),
    dotloopProfileId: profileId,
    lastSyncedHash: hash,
    lastSyncedAt: new Date(),
    lastSyncOrigin: SyncOrigin.HUBSPOT,
  });
  await logSync("HUBSPOT_TO_DOTLOOP", hubspotDealId, String(loop.id), "SUCCESS", "created loop + mapping");
}

/** Syncs a single Dotloop loop -> its HubSpot deal counterpart. */
export async function syncLoopFromDotloop(profileId: string, loopId: string) {
  const hubspot = await HubSpotClient.create();
  const dotloop = await DotloopClient.create();

  const summary = await dotloop.getLoop(profileId, loopId);
  if (!summary) {
    logger.warn({ profileId, loopId }, "Dotloop loop not found (possibly deleted/merged); skipping");
    return;
  }
  const detail = await dotloop.getLoopDetail(profileId, loopId);
  const canonical = fromDotloopLoop(summary, detail);
  const hash = hashSyncPayload(canonical as any);

  const mapping = await findMappingByDotloopId(EntityType.DEAL_LOOP, loopId);

  if (mapping) {
    if (mapping.lastSyncedHash === hash) {
      await logSync("DOTLOOP_TO_HUBSPOT", loopId, mapping.hubspotId, "SKIPPED", "no-op / echo");
      return;
    }
    // Which HubSpot stage a Dotloop status maps back to depends on which
    // pipeline the deal is already in (see resolveStageForStatus in
    // dealLoopMapping.ts) — fetch the deal's current pipeline/dealstage
    // first rather than guessing, so a status shared across pipelines
    // (e.g. "Under Contract") doesn't get resolved against the wrong one.
    const existingDeal = await hubspot.getDeal(mapping.hubspotId, ["pipeline", "dealstage"]);
    if (!existingDeal) {
      logger.warn({ hubspotDealId: mapping.hubspotId }, "Mapped HubSpot deal not found (possibly deleted); skipping");
      await logSync("DOTLOOP_TO_HUBSPOT", loopId, mapping.hubspotId, "SKIPPED", "mapped deal not found");
      return;
    }
    await hubspot.updateDeal(
      mapping.hubspotId,
      toHubSpotDealProperties(canonical, {
        pipelineId: existingDeal.properties.pipeline,
        currentStageId: existingDeal.properties.dealstage,
      })
    );
    await updateMapping(mapping.id, { lastSyncedHash: hash, lastSyncedAt: new Date(), lastSyncOrigin: SyncOrigin.DOTLOOP });
    await logSync("DOTLOOP_TO_HUBSPOT", loopId, mapping.hubspotId, "SUCCESS");
    return;
  }

  // No mapping: this is a brand-new loop, so there's no existing deal to
  // read a pipeline from — derive it from the loop's own transactionType
  // instead (see PIPELINES in dealLoopMapping.ts). If the transactionType
  // isn't one we recognize (e.g. "Real Estate Other"), toHubSpotDealProperties
  // logs a warning and leaves pipeline/dealstage unset, so the deal still
  // gets created (in HubSpot's default pipeline) rather than being lost.
  const pipeline = getPipelineForTransactionType(summary.transactionType);
  const deal = await hubspot.createDeal(
    toHubSpotDealProperties(canonical, { pipelineId: pipeline?.pipelineId })
  );
  await createMapping({
    entityType: EntityType.DEAL_LOOP,
    hubspotId: deal.id,
    dotloopId: loopId,
    dotloopProfileId: profileId,
    lastSyncedHash: hash,
    lastSyncedAt: new Date(),
    lastSyncOrigin: SyncOrigin.DOTLOOP,
  });
  await logSync("DOTLOOP_TO_HUBSPOT", loopId, deal.id, "SUCCESS", "created deal + mapping");
}
