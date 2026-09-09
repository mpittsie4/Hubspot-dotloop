import cron from "node-cron";
import { getReconcileState, setReconcileTimestamps } from "../db/reconcileRepo";
import { config } from "../config";
import { logger } from "../utils/logger";
import { HubSpotClient } from "../clients/hubspotClient";
import { DotloopClient } from "../clients/dotloopClient";
import { HUBSPOT_CONTACT_PROPERTIES } from "./contactMapping";
import { queueContactFromDotloop, queueContactFromHubSpot, queueDealFromHubSpot, queueLoopFromDotloop } from "./syncEngine";

const HUBSPOT_DEAL_PROPERTIES = ["dealname", "amount", "dealstage", "closedate", "pipeline"];

/**
 * Safety-net poll: webhooks can be missed (app briefly down, delivery
 * exhausted its retries, Dotloop webhook access not yet granted, etc.), so
 * this periodically re-scans anything modified since the last pass and
 * feeds it through the same sync functions the webhooks use. Idempotent —
 * the ObjectMapping hash check in contactSync/dealLoopSync means re-syncing
 * something already up to date is a cheap no-op.
 */
export async function runReconciliation() {
  const state = await getReconcileState();
  const now = new Date();
  const lookbackMs = config.sync.reconcileInitialLookbackMinutes * 60 * 1000;

  const hubspotSince = state.lastHubspotPollAt ?? new Date(Date.now() - lookbackMs);
  const dotloopSince = state.lastDotloopPollAt ?? new Date(Date.now() - lookbackMs);

  logger.info({ hubspotSince, dotloopSince }, "Starting reconciliation pass");

  try {
    const hubspot = await HubSpotClient.create();
    const [contacts, deals] = await Promise.all([
      hubspot.listRecentContacts(hubspotSince, HUBSPOT_CONTACT_PROPERTIES),
      hubspot.listRecentDeals(hubspotSince, HUBSPOT_DEAL_PROPERTIES),
    ]);
    for (const c of contacts) await queueContactFromHubSpot(c.id);
    for (const d of deals) await queueDealFromHubSpot(d.id);
    logger.info({ contacts: contacts.length, deals: deals.length }, "Reconciled from HubSpot");
  } catch (err) {
    logger.error({ err }, "HubSpot reconciliation pass failed");
  }

  try {
    const dotloop = await DotloopClient.create();
    const profileId = await dotloop.resolveProfileId();
    const [contacts, loops] = await Promise.all([
      dotloop.listRecentContacts(dotloopSince),
      dotloop.listRecentLoops(profileId, dotloopSince),
    ]);
    for (const c of contacts) await queueContactFromDotloop(String(c.id));
    for (const l of loops) await queueLoopFromDotloop(profileId, String(l.id));
    logger.info({ contacts: contacts.length, loops: loops.length }, "Reconciled from Dotloop");
  } catch (err) {
    logger.error({ err }, "Dotloop reconciliation pass failed");
  }

  await setReconcileTimestamps(now, now);
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
