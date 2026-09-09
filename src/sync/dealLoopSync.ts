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
  const profileId = await dotloop.resolveProfileId();
  const loop = await dotloop.createLoop(profileId, {
    name: canonical.name || `HubSpot Deal ${hubspotDealId}`,
    transactionType: DEFAULT_TRANSACTION_TYPE,
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
    await hubspot.updateDeal(mapping.hubspotId, toHubSpotDealProperties(canonical));
    await updateMapping(mapping.id, { lastSyncedHash: hash, lastSyncedAt: new Date(), lastSyncOrigin: SyncOrigin.DOTLOOP });
    await logSync("DOTLOOP_TO_HUBSPOT", loopId, mapping.hubspotId, "SUCCESS");
    return;
  }

  const deal = await hubspot.createDeal(toHubSpotDealProperties(canonical));
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
