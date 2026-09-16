import { EntityType, TenantRow } from "../db/types";
import { createSyncLog } from "../db/syncLogRepo";
import { logger } from "../utils/logger";
import { withKeyedLock } from "../utils/keyedMutex";
import { syncContactFromDotloop, syncContactFromHubSpot } from "./contactSync";
import { syncDealFromHubSpot, syncLoopFromDotloop } from "./dealLoopSync";

/**
 * Central entry points used by both the webhook handlers (fire-and-forget,
 * must never throw back into the HTTP response cycle) and the
 * reconciliation poller (which does want to see failures surfaced). Every
 * call takes the tenant it's running for -- resolved from a webhook's
 * portalId/profileId or from the reconciliation loop over active tenants,
 * see webhooks/*.ts and sync/reconcile.ts -- and is wrapped so one bad
 * record can't take down a whole webhook batch or poll pass.
 */

type SyncJob = { label: string; run: () => Promise<void> };

async function runSafely(tenantId: string, job: SyncJob) {
  try {
    await job.run();
  } catch (err: any) {
    logger.error({ err: err?.message ?? err, job: job.label, tenantId }, "Sync job failed");
    await createSyncLog({
      tenantId,
      entityType: EntityType.CONTACT, // best-effort; real type is in the message
      direction: "HUBSPOT_TO_DOTLOOP",
      sourceId: job.label,
      status: "ERROR",
      message: String(err?.message ?? err).slice(0, 1000),
    }).catch(() => undefined);
  }
}

export function queueContactFromHubSpot(tenant: TenantRow, hubspotContactId: string) {
  const label = `contact:hubspot:${tenant.id}:${hubspotContactId}`;
  return runSafely(tenant.id, {
    label,
    run: () => withKeyedLock(label, () => syncContactFromHubSpot(tenant, hubspotContactId)),
  });
}

export function queueContactFromDotloop(tenant: TenantRow, dotloopContactId: string) {
  const label = `contact:dotloop:${tenant.id}:${dotloopContactId}`;
  return runSafely(tenant.id, {
    label,
    run: () => withKeyedLock(label, () => syncContactFromDotloop(tenant, dotloopContactId)),
  });
}

export function queueDealFromHubSpot(tenant: TenantRow, hubspotDealId: string) {
  const label = `deal:hubspot:${tenant.id}:${hubspotDealId}`;
  return runSafely(tenant.id, {
    label,
    run: () => withKeyedLock(label, () => syncDealFromHubSpot(tenant, hubspotDealId)),
  });
}

// Note: this locks per (tenant, loopId) -- it guards against two events
// for the *same* loop racing each other (the bug described in
// keyedMutex.ts), which is what's been observed in practice. It does not
// guard against a much rarer cross-direction race -- a HubSpot-side sync
// and a Dotloop-side sync both doing their first-ever sync for what turns
// out to be the same real-world deal/loop pair at the exact same moment,
// before any mapping links them -- since until a mapping exists there's no
// shared key to lock on. Loops/deals also have no dedup-by-lookup fallback
// the way contacts do (findContactByEmail), so that scenario isn't fully
// closed. Worth revisiting if it's ever observed in practice.
export function queueLoopFromDotloop(tenant: TenantRow, profileId: string, loopId: string) {
  const label = `loop:dotloop:${tenant.id}:${loopId}`;
  return runSafely(tenant.id, {
    label,
    run: () => withKeyedLock(label, () => syncLoopFromDotloop(tenant, profileId, loopId)),
  });
}
