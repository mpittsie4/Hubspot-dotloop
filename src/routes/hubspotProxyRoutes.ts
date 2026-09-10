import { Router } from "express";
import { config } from "../config";
import { verifyHubSpotSignature } from "../utils/crypto";
import { HubSpotClient } from "../clients/hubspotClient";
import { logger } from "../utils/logger";

/**
 * Backend proxy for the HubSpot app's Settings-page UI extension
 * (src/app/settings/StageMappingSettings.tsx in the HubSpot Developer
 * Project repo).
 *
 * Why this exists: hubspot.fetch() calling https://api.hubapi.com
 * directly works from a "crm-card" extension (it's tied to a CRM record
 * context, e.g. DealSyncCard.tsx), but a "settings" type extension has
 * no such record context and HubSpot does not attach this app's OAuth
 * grant to a direct hubspot.fetch("https://api.hubapi.com/...") call
 * from it — that call comes back 401 "Authentication credentials not
 * found" even though the app is correctly installed with the right
 * scopes. HubSpot's own docs address this by saying to "use
 * hubspot.fetch to leverage your backend" for settings pages: route the
 * call through the connector's own backend instead, which already holds
 * a valid OAuth token for this portal (see tokenStore/getSoleToken).
 * https://developers.hubspot.com/docs/apps/developer-platform/add-features/ui-extensions/fetching-data
 *
 * hubspot.fetch() signs requests to your own backend the same way
 * HubSpot signs webhooks (X-HubSpot-Signature-v3 / X-HubSpot-Request-
 * Timestamp, HMAC-SHA256 with the app's client secret) so we verify that
 * here with the same verifyHubSpotSignature() used for the webhook
 * routes, rather than leaving this endpoint open to anyone who finds the
 * URL.
 */
export const hubspotProxyRouter = Router();

hubspotProxyRouter.get("/pipelines/deals", async (req, res) => {
  const signature = req.header("X-HubSpot-Signature-v3");
  const timestamp = req.header("X-HubSpot-Request-Timestamp");
  const rawBody: string = (req as any).rawBody ?? "";

  if (!signature || !timestamp) {
    return res.status(401).json({ error: "Missing signature headers." });
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
    logger.warn({ reason }, "Rejected hubspot.fetch proxy request: signature verification failed");
    return res.status(401).json({ error: "Invalid signature." });
  }

  try {
    const client = await HubSpotClient.create();
    const pipelines = await client.listDealPipelines();
    res.json(pipelines);
  } catch (err) {
    logger.error({ err }, "Failed to fetch deal pipelines for settings proxy");
    res.status(502).json({ error: "Failed to fetch deal pipelines from HubSpot." });
  }
});
