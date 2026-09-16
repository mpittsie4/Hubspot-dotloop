import { NextFunction, Request, Response, Router } from "express";
import { config } from "../config";
import { verifyHubSpotSignature } from "../utils/crypto";
import { HubSpotClient } from "../clients/hubspotClient";
import { logger } from "../utils/logger";

/**
 * Backend proxy for this app's UI extensions
 * (src/app/settings/StageMappingSettings.tsx and
 * src/app/cards/DealSyncCard.tsx in the HubSpot Developer Project repo).
 *
 * Why this exists: a direct hubspot.fetch("https://api.hubapi.com/...")
 * call from inside a UI extension comes back 401 "Authentication
 * credentials not found" even though the app is correctly installed
 * with the right scopes. This was originally assumed (per an earlier
 * comment here) to only affect "settings"-type extensions, since they
 * have no CRM record context — but live testing on 2026-09-16 confirmed
 * the identical 401 from DealSyncCard.tsx, a "crm-card" extension with a
 * real record context, calling api.hubapi.com directly to read a deal's
 * dotloop_* properties. So this 401 isn't scoped to extension type; the
 * safe assumption is that hubspot.fetch() never reliably reaches
 * api.hubapi.com directly from a UI extension sandbox, for either kind.
 * HubSpot's own docs address this by saying to "use hubspot.fetch to
 * leverage your backend": route the call through the connector's own
 * backend instead, which already holds a valid OAuth token for this
 * portal (see tokenStore/getSoleToken).
 * https://developers.hubspot.com/docs/apps/developer-platform/add-features/ui-extensions/fetching-data
 *
 * hubspot.fetch() signs requests to your own backend the same way
 * HubSpot signs webhooks (X-HubSpot-Signature-v3 / X-HubSpot-Request-
 * Timestamp, HMAC-SHA256 with the app's client secret) so we verify that
 * here with the same verifyHubSpotSignature() used for the webhook
 * routes, rather than leaving these endpoints open to anyone who finds
 * the URL.
 */
export const hubspotProxyRouter = Router();

function requireHubSpotSignature(req: Request, res: Response, next: NextFunction) {
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
    logger.warn({ reason, path: req.path }, "Rejected hubspot.fetch proxy request: signature verification failed");
    return res.status(401).json({ error: "Invalid signature." });
  }

  next();
}

hubspotProxyRouter.get("/pipelines/deals", requireHubSpotSignature, async (req, res) => {
  try {
    const client = await HubSpotClient.create();
    const pipelines = await client.listDealPipelines();
    res.json(pipelines);
  } catch (err) {
    logger.error({ err }, "Failed to fetch deal pipelines for settings proxy");
    res.status(502).json({ error: "Failed to fetch deal pipelines from HubSpot." });
  }
});

const DOTLOOP_DEAL_PROPERTIES = [
  "dotloop_loop_id",
  "dotloop_loop_url",
  "dotloop_sync_status",
  "dotloop_last_synced_at",
];

hubspotProxyRouter.get("/deals/:dealId/dotloop-status", requireHubSpotSignature, async (req, res) => {
  const { dealId } = req.params;
  try {
    const client = await HubSpotClient.create();
    const deal = await client.getDeal(dealId, DOTLOOP_DEAL_PROPERTIES);
    if (!deal) {
      return res.status(404).json({ error: `Deal ${dealId} not found.` });
    }
    res.json({ properties: deal.properties });
  } catch (err) {
    logger.error({ err, dealId }, "Failed to fetch dotloop sync status for card proxy");
    res.status(502).json({ error: "Failed to fetch Dotloop sync status from HubSpot." });
  }
});
