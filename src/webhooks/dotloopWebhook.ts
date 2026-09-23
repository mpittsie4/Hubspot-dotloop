import { Router } from "express";
import { config } from "../config";
import { verifyDotloopSignature } from "../utils/crypto";
import { queueContactFromDotloop, queueLoopFromDotloop } from "../sync/syncEngine";
import { getTenantByDotloopProfileId } from "../db/tenantRepo";
import { findMappingByDotloopId, repointMappingDotloopId } from "../db/mappingRepo";
import { EntityType } from "../db/types";
import { logger } from "../utils/logger";

interface DotloopWebhookEvent {
  eventId: string;
  createdOn: string;
  subscriptionId: string;
  profileId: string;
  eventType: string;
  event: { id: string; participantId?: string; fromId?: string; toId?: string };
}

export const dotloopWebhookRouter = Router();

// Dotloop requires a response within 5 seconds, so we verify synchronously
// and respond before kicking off any sync work.
dotloopWebhookRouter.post("/", (req, res) => {
  const signature = req.header("X-DOTLOOP-WEBHOOK-SIGNATURE");
  const timestamp = req.header("X-DOTLOOP-WEBHOOK-TIMESTAMP");
  const rawBody: string = (req as any).rawBody ?? JSON.stringify(req.body);

  if (!signature || !timestamp) {
    return res.status(400).send("Missing signature headers");
  }

  const { valid, reason } = verifyDotloopSignature({
    rawBody,
    timestamp,
    signature,
    signingSecret: config.dotloop.webhookSigningSecret,
  });

  if (!valid) {
    logger.warn({ reason }, "Rejected Dotloop webhook: signature verification failed");
    return res.status(401).send("Invalid signature");
  }

  res.status(200).send("ok");

  void handleEvent(req.body as DotloopWebhookEvent);
});

/**
 * Dotloop events carry a profileId, not an accountId (an account can have
 * more than one profile), so tenant resolution looks up by cached profile
 * id -- see db/tenantRepo.ts's getTenantByDotloopProfileId and
 * sync/reconcile.ts's backfillDotloopProfileIds for tenants connected
 * before that column existed.
 */
async function handleEvent(event: DotloopWebhookEvent) {
  const tenant = await getTenantByDotloopProfileId(event.profileId);
  if (!tenant) {
    logger.warn({ profileId: event.profileId }, "Ignoring Dotloop webhook event for an unrecognized/unlinked profile");
    return;
  }

  switch (event.eventType) {
    case "LOOP_CREATED":
    case "LOOP_UPDATED":
      void queueLoopFromDotloop(tenant, event.profileId, event.event.id);
      break;
    case "LOOP_PARTICIPANT_CREATED":
    case "LOOP_PARTICIPANT_UPDATED":
      // Participants roll up into the loop's synced state; re-sync the loop.
      void queueLoopFromDotloop(tenant, event.profileId, event.event.id);
      break;
    case "CONTACT_CREATED":
    case "CONTACT_UPDATED":
      void queueContactFromDotloop(tenant, event.event.id);
      break;
    case "LOOP_MERGED":
      void handleLoopMerged(tenant, event.profileId, event.event.fromId, event.event.toId);
      break;
    default:
      logger.debug({ eventType: event.eventType }, "Ignoring unhandled Dotloop event type");
  }
}

/**
 * Dotloop's docs describe loop merges as returning a 301 when the old loop
 * id is requested directly -- but our own sync never re-requests a loop by
 * a stale id we already resolved, so that redirect never comes into play
 * here. The real risk is on our side of the merge: LOOP_MERGED delivers
 * `fromId` (the id that stops resolving) and `toId` (the surviving id), and
 * without this, syncLoopFromDotloop(tenant, profileId, toId) would look up
 * a mapping keyed on toId, find none (the existing row is still keyed on
 * fromId), and create a brand-new duplicate HubSpot deal for a transaction
 * that already had one.
 *
 * Fix: if fromId has an existing mapping and toId doesn't, repoint that
 * mapping's dotloop_id to toId in place before syncing, so the existing
 * deal gets updated instead of a duplicate being created. If toId *also*
 * already has its own mapping (both sides of the merge already had
 * separate HubSpot deals), that's a genuine "which deal wins" business
 * decision this connector shouldn't guess at -- log it loudly for a human
 * to reconcile manually, and otherwise proceed with the normal sync
 * against the surviving loop's existing mapping (a safe no-op for the
 * fromId side, not a data-destroying one).
 */
export async function handleLoopMerged(tenant: Awaited<ReturnType<typeof getTenantByDotloopProfileId>>, profileId: string, fromId: string | undefined, toId: string | undefined) {
  if (!tenant || !toId) {
    logger.warn({ tenantId: tenant?.id, fromId, toId }, "LOOP_MERGED event missing toId (or tenant); nothing to sync");
    return;
  }

  if (fromId) {
    try {
      const [oldMapping, newSideMapping] = await Promise.all([
        findMappingByDotloopId(tenant.id, EntityType.DEAL_LOOP, fromId),
        findMappingByDotloopId(tenant.id, EntityType.DEAL_LOOP, toId),
      ]);

      if (oldMapping && !newSideMapping) {
        await repointMappingDotloopId(oldMapping.id, toId);
        logger.info(
          { tenantId: tenant.id, fromId, toId, hubspotDealId: oldMapping.hubspotId },
          "Dotloop LOOP_MERGED: repointed existing mapping to the surviving loop id"
        );
      } else if (oldMapping && newSideMapping && oldMapping.id !== newSideMapping.id) {
        logger.error(
          {
            tenantId: tenant.id,
            fromId,
            toId,
            hubspotDealIdFromLosingLoop: oldMapping.hubspotId,
            hubspotDealIdOnSurvivingLoop: newSideMapping.hubspotId,
          },
          "Dotloop LOOP_MERGED: both loops already mapped to separate HubSpot deals -- needs manual reconciliation, " +
            "not auto-merging. Continuing sync against the surviving loop's existing deal only."
        );
      }
    } catch (err) {
      logger.error({ err, tenantId: tenant.id, fromId, toId }, "Failed while repointing mapping for Dotloop LOOP_MERGED; continuing with sync anyway");
    }
  }

  void queueLoopFromDotloop(tenant, profileId, toId);
}
