import { EntityType, SyncOrigin, TenantRow } from "../db/types";
import { createMapping, findMappingByDotloopId, findMappingByHubspotId, updateMapping } from "../db/mappingRepo";
import { createSyncLog } from "../db/syncLogRepo";
import { HubSpotClient } from "../clients/hubspotClient";
import { DotloopClient } from "../clients/dotloopClient";
import {
  CanonicalDeal,
  DEFAULT_TRANSACTION_TYPE,
  dotloopSyncStatusProperties,
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
  tenantId: string,
  direction: "HUBSPOT_TO_DOTLOOP" | "DOTLOOP_TO_HUBSPOT",
  sourceId: string,
  targetId: string | null,
  status: "SUCCESS" | "ERROR" | "SKIPPED",
  message?: string
) {
  await createSyncLog({ tenantId, entityType: EntityType.DEAL_LOOP, direction, sourceId, targetId, status, message });
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

/** Syncs a single HubSpot deal -> its Dotloop loop counterpart, for one tenant. */
export async function syncDealFromHubSpot(tenant: TenantRow, hubspotDealId: string) {
  if (!tenant.hubspotPortalId || !tenant.dotloopAccountId) {
    logger.warn({ tenantId: tenant.id }, "Tenant is not fully connected yet; skipping deal sync");
    return;
  }
  const hubspot = await HubSpotClient.create(tenant.hubspotPortalId);
  const dotloop = await DotloopClient.create(tenant.dotloopAccountId);

  const source = await hubspot.getDeal(hubspotDealId, HUBSPOT_DEAL_PROPERTIES);
  if (!source) {
    logger.warn({ tenantId: tenant.id, hubspotDealId }, "HubSpot deal not found (possibly deleted); skipping");
    return;
  }
  const canonical = fromHubSpotDeal(tenant.pipelinesConfig, source.properties);
  const hash = hashSyncPayload(canonical as any);

  const mapping = await findMappingByHubspotId(tenant.id, EntityType.DEAL_LOOP, hubspotDealId);

  if (mapping) {
    if (mapping.lastSyncedHash === hash) {
      await logSync(tenant.id, "HUBSPOT_TO_DOTLOOP", hubspotDealId, mapping.dotloopId, "SKIPPED", "no-op / echo");
      return;
    }
    const profileId = mapping.dotloopProfileId ?? (await dotloop.resolveProfileId());
    await pushCanonicalToDotloop(dotloop, profileId, mapping.dotloopId, canonical);
    await hubspot.updateDeal(hubspotDealId, dotloopSyncStatusProperties({ id: mapping.dotloopId }));
    await updateMapping(mapping.id, { lastSyncedHash: hash, lastSyncedAt: new Date(), lastSyncOrigin: SyncOrigin.HUBSPOT });
    await logSync(tenant.id, "HUBSPOT_TO_DOTLOOP", hubspotDealId, mapping.dotloopId, "SUCCESS");
    return;
  }

  // No mapping: a new deal maps to a brand new loop. (Dotloop has no
  // reliable "find by name" search, so unlike contacts we don't attempt
  // to auto-link an existing loop here — link manually via the mapping
  // table if you need to backfill history.)
  // The loop's transactionType must match the deal's own pipeline (see
  // this tenant's pipelinesConfig) rather than always defaulting to
  // PURCHASE_OFFER, otherwise e.g. a Seller-pipeline deal would create a
  // buy-side loop with the wrong status vocabulary.
  const pipeline = getPipelineById(tenant.pipelinesConfig, source.properties.pipeline);
  const transactionType = pipeline?.transactionType ?? DEFAULT_TRANSACTION_TYPE;
  if (!pipeline) {
    logger.warn(
      { tenantId: tenant.id, hubspotDealId, pipeline: source.properties.pipeline },
      "Deal's pipeline isn't in this tenant's pipelinesConfig; falling back to DEFAULT_TRANSACTION_TYPE for the new loop"
    );
  }
  const profileId = await dotloop.resolveProfileId();
  const loop = await dotloop.createLoop(profileId, {
    name: canonical.name || `HubSpot Deal ${hubspotDealId}`,
    transactionType,
    status: canonical.status || undefined,
  });
  await pushCanonicalToDotloop(dotloop, profileId, String(loop.id), canonical);
  await hubspot.updateDeal(hubspotDealId, dotloopSyncStatusProperties(loop));

  await createMapping({
    tenantId: tenant.id,
    entityType: EntityType.DEAL_LOOP,
    hubspotId: hubspotDealId,
    dotloopId: String(loop.id),
    dotloopProfileId: profileId,
    lastSyncedHash: hash,
    lastSyncedAt: new Date(),
    lastSyncOrigin: SyncOrigin.HUBSPOT,
  });
  await logSync(tenant.id, "HUBSPOT_TO_DOTLOOP", hubspotDealId, String(loop.id), "SUCCESS", "created loop + mapping");
}

/** Syncs a single Dotloop loop -> its HubSpot deal counterpart, for one tenant. */
export async function syncLoopFromDotloop(tenant: TenantRow, profileId: string, loopId: string) {
  if (!tenant.hubspotPortalId || !tenant.dotloopAccountId) {
    logger.warn({ tenantId: tenant.id }, "Tenant is not fully connected yet; skipping loop sync");
    return;
  }
  const hubspot = await HubSpotClient.create(tenant.hubspotPortalId);
  const dotloop = await DotloopClient.create(tenant.dotloopAccountId);

  const summary = await dotloop.getLoop(profileId, loopId);
  if (!summary) {
    logger.warn({ tenantId: tenant.id, profileId, loopId }, "Dotloop loop not found (possibly deleted/merged); skipping");
    return;
  }
  const detail = await dotloop.getLoopDetail(profileId, loopId);
  const canonical = fromDotloopLoop(summary, detail);
  const hash = hashSyncPayload(canonical as any);

  const mapping = await findMappingByDotloopId(tenant.id, EntityType.DEAL_LOOP, loopId);

  if (mapping) {
    if (mapping.lastSyncedHash === hash) {
      await logSync(tenant.id, "DOTLOOP_TO_HUBSPOT", loopId, mapping.hubspotId, "SKIPPED", "no-op / echo");
      return;
    }
    // Which HubSpot stage a Dotloop status maps back to depends on which
    // pipeline the deal is already in (see resolveStageForStatus in
    // dealLoopMapping.ts) — fetch the deal's current pipeline/dealstage
    // first rather than guessing, so a status shared across pipelines
    // (e.g. "Under Contract") doesn't get resolved against the wrong one.
    const existingDeal = await hubspot.getDeal(mapping.hubspotId, ["pipeline", "dealstage"]);
    if (!existingDeal) {
      logger.warn({ tenantId: tenant.id, hubspotDealId: mapping.hubspotId }, "Mapped HubSpot deal not found (possibly deleted); skipping");
      await logSync(tenant.id, "DOTLOOP_TO_HUBSPOT", loopId, mapping.hubspotId, "SKIPPED", "mapped deal not found");
      return;
    }
    await hubspot.updateDeal(mapping.hubspotId, {
      ...toHubSpotDealProperties(tenant.pipelinesConfig, canonical, {
        pipelineId: existingDeal.properties.pipeline,
        currentStageId: existingDeal.properties.dealstage,
      }),
      ...dotloopSyncStatusProperties(summary),
    });
    await updateMapping(mapping.id, { lastSyncedHash: hash, lastSyncedAt: new Date(), lastSyncOrigin: SyncOrigin.DOTLOOP });
    await logSync(tenant.id, "DOTLOOP_TO_HUBSPOT", loopId, mapping.hubspotId, "SUCCESS");
    return;
  }

  // No mapping: this is a brand-new loop, so there's no existing deal to
  // read a pipeline from — derive it from the loop's own transactionType
  // instead (see this tenant's pipelinesConfig). If the transactionType
  // isn't one we recognize (e.g. "Real Estate Other"), toHubSpotDealProperties
  // logs a warning and leaves pipeline/dealstage unset, so the deal still
  // gets created (in HubSpot's default pipeline) rather than being lost.
  const pipeline = getPipelineForTransactionType(tenant.pipelinesConfig, summary.transactionType);
  const deal = await hubspot.createDeal({
    ...toHubSpotDealProperties(tenant.pipelinesConfig, canonical, { pipelineId: pipeline?.pipelineId }),
    ...dotloopSyncStatusProperties(summary),
  });
  await createMapping({
    tenantId: tenant.id,
    entityType: EntityType.DEAL_LOOP,
    hubspotId: deal.id,
    dotloopId: loopId,
    dotloopProfileId: profileId,
    lastSyncedHash: hash,
    lastSyncedAt: new Date(),
    lastSyncOrigin: SyncOrigin.DOTLOOP,
  });
  await logSync(tenant.id, "DOTLOOP_TO_HUBSPOT", loopId, deal.id, "SUCCESS", "created deal + mapping");
}
