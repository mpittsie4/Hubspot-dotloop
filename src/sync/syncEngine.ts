import { EntityType, TenantRow } from "../db/types";
import { createSyncLog } from "../db/syncLogRepo";
import { logger } from "../utils/logger";
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
  return runSafely(tenant.id, {
    label: `contact:hubspot:${tenant.id}:${hubspotContactId}`,
    run: () => syncContactFromHubSpot(tenant, hubspotContactId),
  });
}

export function queueContactFromDotloop(tenant: TenantRow, dotloopContactId: string) {
  return runSafely(tenant.id, {
    label: `contact:dotloop:${tenant.id}:${dotloopContactId}`,
    run: () => syncContactFromDotloop(tenant, dotloopContactId),
  });
}

export function queueDealFromHubSpot(tenant: TenantRow, hubspotDealId: string) {
  return runSafely(tenant.id, {
    label: `deal:hubspot:${tenant.id}:${hubspotDealId}`,
    run: () => syncDealFromHubSpot(tenant, hubspotDealId),
  });
}

export function queueLoopFromDotloop(tenant: TenantRow, profileId: string, loopId: string) {
  return runSafely(tenant.id, {
    label: `loop:dotloop:${tenant.id}:${loopId}`,
    run: () => syncLoopFromDotloop(tenant, profileId, loopId),
  });
}
