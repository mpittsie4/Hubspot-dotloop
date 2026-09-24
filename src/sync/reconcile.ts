import cron from "node-cron";
import { getReconcileState, setReconcileTimestamps } from "../db/reconcileRepo";
import {
  listActiveTenants,
  listTenantsMissingDotloopProfileId,
  setDotloopProfileId,
} from "../db/tenantRepo";
import { listConnectionsMissingProfileId, setConnectionProfileId } from "../db/dotloopConnectionRepo";
import { TenantRow } from "../db/types";
import { config } from "../config";
import { logger } from "../utils/logger";
import { HubSpotClient } from "../clients/hubspotClient";
import { DotloopClient } from "../clients/dotloopClient";
import { HUBSPOT_CONTACT_PROPERTIES } from "./contactMapping";
import { queueContactFromDotloop, queueContactFromHubSpot, queueDealFromHubSpot, queueLoopFromDotloop } from "./syncEngine";
import { listDotloopSyncTargets } from "./dotloopRouting";

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

/** Same self-heal as backfillDotloopProfileIds() above, for brokerage-mode
 *  per-agent connections (db/dotloopConnectionRepo.ts) -- an agent's
 *  connection normally gets its profile id resolved synchronously in the
 *  OAuth callback (routes/authRoutes.ts), so this mainly covers that call
 *  failing transiently. */
export async function backfillConnectionProfileIds() {
  const connections = await listConnectionsMissingProfileId();
  for (const connection of connections) {
    try {
      const dotloop = await DotloopClient.create(connection.dotloopAccountId!);
      const profileId = await dotloop.resolveProfileId();
      await setConnectionProfileId(connection.id, profileId);
      logger.info(
        { tenantId: connection.tenantId, connectionId: connection.id, profileId },
        "Backfilled Dotloop profile id for agent connection"
      );
    } catch (err) {
      logger.error({ err, tenantId: connection.tenantId, connectionId: connection.id }, "Failed to backfill Dotloop profile id for agent connection");
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

  // Dotloop contacts: tenant-level only -- standalone Contact <-> Dotloop
  // Contact sync isn't routed per-agent (see dotloopRouting.ts's doc
  // comment for why), so it only runs at all for a tenant with its own
  // single account. A pure brokerage tenant (no tenant-level account) just
  // skips this, same deliberate gap as the webhook side.
  if (tenant.dotloopAccountId) {
    try {
      const dotloop = await DotloopClient.create(tenant.dotloopAccountId);
      const contacts = await dotloop.listRecentContacts(dotloopSince);
      for (const c of contacts) await queueContactFromDotloop(tenant, String(c.id));
      logger.info({ tenantId: tenant.id, contacts: contacts.length }, "Reconciled contacts from Dotloop");
    } catch (err) {
      logger.error({ err, tenantId: tenant.id }, "Dotloop contact reconciliation pass failed");
    }
  }

  // Dotloop loops: the tenant's own single connection, or one pass per
  // connected agent in brokerage mode -- see dotloopRouting.ts.
  const targets = await listDotloopSyncTargets(tenant);
  for (const target of targets) {
    try {
      const dotloop = await DotloopClient.create(target.dotloopAccountId);
      let profileId = target.dotloopProfileId;
      if (!profileId) {
        profileId = await dotloop.resolveProfileId();
        const persist = target.connectionId
          ? setConnectionProfileId(target.connectionId, profileId)
          : setDotloopProfileId(tenant.id, profileId);
        await persist.catch((err) =>
          logger.error({ err, tenantId: tenant.id, dotloopAccountId: target.dotloopAccountId }, "Failed to persist resolved Dotloop profile id")
        );
      }
      const loops = await dotloop.listRecentLoops(profileId, dotloopSince);
      for (const l of loops) await queueLoopFromDotloop(tenant, target.dotloopAccountId, profileId, String(l.id));
      logger.info(
        { tenantId: tenant.id, dotloopAccountId: target.dotloopAccountId, loops: loops.length },
        "Reconciled loops from Dotloop for this connection"
      );
    } catch (err) {
      logger.error({ err, tenantId: tenant.id, dotloopAccountId: target.dotloopAccountId }, "Dotloop loop reconciliation failed for this connection");
    }
  }

  await setReconcileTimestamps(tenant.id, now, now);
}

/** Runs one reconciliation pass across every fully-connected (ACTIVE) tenant. */
export async function runReconciliation() {
  await backfillDotloopProfileIds();
  await backfillConnectionProfileIds();

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
