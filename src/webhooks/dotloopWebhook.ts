import { Router } from "express";
import { config } from "../config";
import { verifyDotloopSignature } from "../utils/crypto";
import { queueContactFromDotloop, queueLoopFromDotloop } from "../sync/syncEngine";
import { getTenantByDotloopProfileId } from "../db/tenantRepo";
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
  const signature = req.header("X-DOTLOOP-SIGNATURE");
  const timestamp = req.header("X-DOTLOOP-TIMESTAMP");
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
      // The old loop id (fromId) is gone; re-point sync at the surviving one.
      if (event.event.toId) void queueLoopFromDotloop(tenant, event.profileId, event.event.toId);
      break;
    default:
      logger.debug({ eventType: event.eventType }, "Ignoring unhandled Dotloop event type");
  }
}
