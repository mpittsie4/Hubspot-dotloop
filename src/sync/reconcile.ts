import cron from "node-cron";
import { getReconcileState, setReconcileTimestamps } from "../db/reconcileRepo";
import {
  listActiveTenants,
  listTenantsMissingDotloopProfileId,
  setDotloopProfileId,
} from "../db/tenantRepo";
import { TenantRow } from "../db/types";
import { config } from "../config";
import { logger } from "../utils/logger";
import { HubSpotClient } from "../clients/hubspotClient";
import { DotloopClient } from "../clients/dotloopClient";
import { HUBSPOT_CONTACT_PROPERTIES } from "./contactMapping";
import { queueContactFromDotloop, queueContactFromHubSpot, queueDealFromHubSpot, queueLoopFromDotloop } from "./syncEngine";

const HUBSPOT_DEAL_PROPERTIES = ["dealname", "amount", "dealstage", "closedate", "pipeline"];

/**
 * Dotloop webhook events carry a profileId, not an accountId (see
 * webhooks/dotloopWebhook.ts), so every tenant needs its profile id cached
 * to be webhook-reachable. Tenants connected before this column existed
 * (the tenant_default row seeded by migrations/002_tenants.sql) won't have
 * it yet -- this resolves and persists it for any tenant still missing it.
 * Called once at boot (see index.ts) and at the top of every reconciliation
 * pass as a cheap self-heal.
 */
export async function backfillDotloopProfileIds() {
  const tenants = await listTenantsMissingDotloopProfileId();
  for (const tenant of tenants) {
    try {
      const dotloop = await DotloopClient.create(tenant.dotloopAccountId!);
      const profileId = await dotloop.resolveProfileId();
      await setDotloopProfileId(tenant.id, profileId);
      logger.info({ tenantId: tenant.id, profileId }, "Backfilled Dotloop profile id for tenant");
    } catch (err) {
      logger.error({ err, tenantId: tenant.id }, "Failed to backfill Dotloop profile id for tenant");
    }
  }
}

/**
 * Safety-net poll for one tenant: webhooks can be missed (app briefly
 * down, delivery exhausted its retries, Dotloop webhook access not yet
 * granted, etc.), so this periodically re-scans anything modified since
 * the last pass and feeds it through the same sync functions the webhooks
 * use. Idempotent — the ObjectMapping hash check in contactSync/dealLoopSync
 * means re-syncing something already up to date is a cheap no-op.
 */
async function reconcileTenant(tenant: TenantRow) {
  const state = await getReconcileState(tenant.id);
  const now = new Date();
  const lookbackMs = config.sync.reconcileInitialLookbackMinutes * 60 * 1000;

  const hubspotSince = state.lastHubspotPollAt ?? new Date(Date.now() - lookbackMs);
  const dotloopSince = state.lastDotloopPollAt ?? new Date(Date.now() - lookbackMs);

  logger.info({ tenantId: tenant.id, hubspotSince, dotloopSince }, "Starting reconciliation pass");

  try {
    const hubspot = await HubSpotClient.create(tenant.hubspotPortalId!);
    const [contacts, deals] = await Promise.all([
      hubspot.listRecentContacts(hubspotSince, HUBSPOT_CONTACT_PROPERTIES),
      hubspot.listRecentDeals(hubspotSince, HUBSPOT_DEAL_PROPERTIES),
    ]);
    for (const c of contacts) await queueContactFromHubSpot(tenant, c.id);
    for (const d of deals) await queueDealFromHubSpot(tenant, d.id);
    logger.info({ tenantId: tenant.id, contacts: contacts.length, deals: deals.length }, "Reconciled from HubSpot");
  } catch (err) {
    logger.error({ err, tenantId: tenant.id }, "HubSpot reconciliation pass failed");
  }

  try {
    const dotloop = await DotloopClient.create(tenant.dotloopAccountId!);
    let profileId = tenant.dotloopProfileId;
    if (!profileId) {
      profileId = await dotloop.resolveProfileId();
      await setDotloopProfileId(tenant.id, profileId).catch((err) =>
        logger.error({ err, tenantId: tenant.id }, "Failed to persist resolved Dotloop profile id")
      );
    }
    const [contacts, loops] = await Promise.all([
      dotloop.listRecentContacts(dotloopSince),
      dotloop.listRecentLoops(profileId, dotloopSince),
    ]);
    for (const c of contacts) await queueContactFromDotloop(tenant, String(c.id));
    for (const l of loops) await queueLoopFromDotloop(tenant, profileId, String(l.id));
    logger.info({ tenantId: tenant.id, contacts: contacts.length, loops: loops.length }, "Reconciled from Dotloop");
  } catch (err) {
    logger.error({ err, tenantId: tenant.id }, "Dotloop reconciliation pass failed");
  }

  await setReconcileTimestamps(tenant.id, now, now);
}

/** Runs one reconciliation pass across every fully-connected (ACTIVE) tenant. */
export async function runReconciliation() {
  await backfillDotloopProfileIds();

  const tenants = await listActiveTenants();
  if (tenants.length === 0) {
    logger.info("No active tenants to reconcile");
    return;
  }
  for (const tenant of tenants) {
    await reconcileTenant(tenant);
  }
}

/** Schedules the periodic reconciliation pass. Call once at startup. */
export function scheduleReconciliation() {
  const minutes = Math.max(1, config.sync.reconcileIntervalMinutes);
  const expression = `*/${minutes} * * * *`;
  logger.info({ expression }, "Scheduling reconciliation job");
  cron.schedule(expression, () => {
    runReconciliation().catch((err) => logger.error({ err }, "Reconciliation run threw unexpectedly"));
  });
}
