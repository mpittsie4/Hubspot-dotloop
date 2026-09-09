import { EntityType } from "../db/types";
import { createSyncLog } from "../db/syncLogRepo";
import { logger } from "../utils/logger";
import { syncContactFromDotloop, syncContactFromHubSpot } from "./contactSync";
import { syncDealFromHubSpot, syncLoopFromDotloop } from "./dealLoopSync";

/**
 * Central entry points used by both the webhook handlers (fire-and-forget,
 * must never throw back into the HTTP response cycle) and the
 * reconciliation poller (which does want to see failures surfaced).
 * Every call is wrapped so one bad record can't take down a whole webhook
 * batch or poll pass.
 */

type SyncJob = { label: string; run: () => Promise<void> };

async function runSafely(job: SyncJob) {
  try {
    await job.run();
  } catch (err: any) {
    logger.error({ err: err?.message ?? err, job: job.label }, "Sync job failed");
    await createSyncLog({
      entityType: EntityType.CONTACT, // best-effort; real type is in the message
      direction: "HUBSPOT_TO_DOTLOOP",
      sourceId: job.label,
      status: "ERROR",
      message: String(err?.message ?? err).slice(0, 1000),
    }).catch(() => undefined);
  }
}

export function queueContactFromHubSpot(hubspotContactId: string) {
  return runSafely({ label: `contact:hubspot:${hubspotContactId}`, run: () => syncContactFromHubSpot(hubspotContactId) });
}

export function queueContactFromDotloop(dotloopContactId: string) {
  return runSafely({ label: `contact:dotloop:${dotloopContactId}`, run: () => syncContactFromDotloop(dotloopContactId) });
}

export function queueDealFromHubSpot(hubspotDealId: string) {
  return runSafely({ label: `deal:hubspot:${hubspotDealId}`, run: () => syncDealFromHubSpot(hubspotDealId) });
}

export function queueLoopFromDotloop(profileId: string, loopId: string) {
  return runSafely({ label: `loop:dotloop:${loopId}`, run: () => syncLoopFromDotloop(profileId, loopId) });
}
