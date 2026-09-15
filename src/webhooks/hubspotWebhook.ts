import { Router } from "express";
import { config } from "../config";
import { verifyHubSpotSignature } from "../utils/crypto";
import { queueContactFromHubSpot, queueDealFromHubSpot } from "../sync/syncEngine";
import { getTenantByHubspotPortalId } from "../db/tenantRepo";
import { TenantRow } from "../db/types";
import { logger } from "../utils/logger";

interface HubSpotWebhookEvent {
  eventId: number;
  subscriptionType: string; // e.g. "contact.propertyChange", "deal.creation"
  portalId: number;
  objectId: number;
  occurredAt: number;
}

export const hubspotWebhookRouter = Router();

hubspotWebhookRouter.post("/", (req, res) => {
  const signature = req.header("X-HubSpot-Signature-v3");
  const timestamp = req.header("X-HubSpot-Request-Timestamp");
  const rawBody: string = (req as any).rawBody ?? JSON.stringify(req.body);

  if (!signature || !timestamp) {
    return res.status(400).send("Missing signature headers");
  }

  const fullUrl = `${config.publicBaseUrl}${req.originalUrl}`;
  const { valid, reason } = verifyHubSpotSignature({
    method: req.method,
    uri: fullUrl,
    rawBody,
    timestamp,
    signature,
    clientSecret: config.hubspot.clientSecret,
  });

  if (!valid) {
    logger.warn({ reason }, "Rejected HubSpot webhook: signature verification failed");
    return res.status(401).send("Invalid signature");
  }

  // Ack immediately; HubSpot doesn't require sub-5s responses like Dotloop
  // but there's no reason to hold the connection open while we sync.
  res.status(200).send("ok");

  const events: HubSpotWebhookEvent[] = Array.isArray(req.body) ? req.body : [];
  void handleEvents(events);
});

/**
 * A single delivery batch can span multiple portals (HubSpot may batch
 * several of this app's subscribers together), so tenant resolution
 * happens per event -- cached within the batch to avoid a DB round trip
 * per event when a batch is dominated by one portal.
 */
async function handleEvents(events: HubSpotWebhookEvent[]) {
  const tenantCache = new Map<string, TenantRow | null>();

  for (const event of events) {
    const portalId = String(event.portalId);
    let tenant = tenantCache.get(portalId);
    if (tenant === undefined) {
      tenant = await getTenantByHubspotPortalId(portalId);
      tenantCache.set(portalId, tenant);
    }
    if (!tenant) {
      logger.warn({ portalId }, "Ignoring HubSpot webhook event for an unrecognized/unlinked portal");
      continue;
    }

    const objectId = String(event.objectId);
    if (event.subscriptionType?.startsWith("contact.")) {
      void queueContactFromHubSpot(tenant, objectId);
    } else if (event.subscriptionType?.startsWith("deal.")) {
      void queueDealFromHubSpot(tenant, objectId);
    } else {
      logger.debug({ subscriptionType: event.subscriptionType }, "Ignoring unhandled HubSpot event type");
    }
  }
}
