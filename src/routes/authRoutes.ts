import { Router } from "express";
import crypto from "node:crypto";
import { buildHubSpotAuthorizeUrl, handleHubSpotCallback } from "../auth/hubspotOAuth";
import { buildDotloopAuthorizeUrl, handleDotloopCallback } from "../auth/dotloopOAuth";
import { HubSpotClient } from "../clients/hubspotClient";
import { logger } from "../utils/logger";

export const authRouter = Router();

// In-memory state nonce store (single-process scaffold). For multi-instance
// deployments, swap this for a signed, expiring cookie or a shared cache.
const pendingStates = new Set<string>();

authRouter.get("/hubspot/start", (_req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  pendingStates.add(state);
  res.redirect(buildHubSpotAuthorizeUrl(state));
});

authRouter.get("/hubspot/callback", async (req, res) => {
  const { code, state } = req.query;
  if (typeof state !== "string" || !pendingStates.delete(state)) {
    return res.status(400).send("Invalid or expired OAuth state.");
  }
  if (typeof code !== "string") {
    return res.status(400).send("Missing authorization code.");
  }
  try {
    const { portalId, accessToken } = await handleHubSpotCallback(code);

    // One-time per-install setup: make sure this portal has the dotloop_*
    // custom properties the connector and the Deal Sync Status card need.
    // Runs on the fresh OAuth token itself (which already has the
    // crm.schemas.deals.write / crm.schemas.contacts.write scopes), so no
    // manually-created private-app token is needed — this is what
    // scripts/create-dotloop-properties.mjs used to require per portal.
    // Non-fatal: the HubSpot connection still succeeds even if this fails
    // (e.g. a scope got misconfigured), it just needs a manual retry.
    try {
      await HubSpotClient.forToken(portalId, accessToken).ensureDotloopProperties();
    } catch (propErr) {
      logger.error({ err: propErr, portalId }, "Failed to auto-create dotloop_* properties for this portal");
    }

    res.send(`HubSpot connected (portal ${portalId}). You can close this tab.`);
  } catch (err) {
    logger.error({ err }, "HubSpot OAuth callback failed");
    res.status(500).send("Failed to complete HubSpot connection. Check server logs.");
  }
});

authRouter.get("/dotloop/start", (_req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  pendingStates.add(state);
  res.redirect(buildDotloopAuthorizeUrl(state));
});

authRouter.get("/dotloop/callback", async (req, res) => {
  const { code, state } = req.query;
  if (typeof state !== "string" || !pendingStates.delete(state)) {
    return res.status(400).send("Invalid or expired OAuth state.");
  }
  if (typeof code !== "string") {
    return res.status(400).send("Missing authorization code.");
  }
  try {
    const { accountId } = await handleDotloopCallback(code);
    res.send(`Dotloop connected (account ${accountId}). You can close this tab.`);
  } catch (err) {
    logger.error({ err }, "Dotloop OAuth callback failed");
    res.status(500).send("Failed to complete Dotloop connection. Check server logs.");
  }
});
