import { Router } from "express";
import { config } from "../config";
import { verifyHubSpotSignature } from "../utils/crypto";
import { queueContactFromHubSpot, queueDealFromHubSpot } from "../sync/syncEngine";
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
  for (const event of events) {
    const objectId = String(event.objectId);
    if (event.subscriptionType?.startsWith("contact.")) {
      void queueContactFromHubSpot(objectId);
    } else if (event.subscriptionType?.startsWith("deal.")) {
      void queueDealFromHubSpot(objectId);
    } else {
      logger.debug({ subscriptionType: event.subscriptionType }, "Ignoring unhandled HubSpot event type");
    }
  }
});
