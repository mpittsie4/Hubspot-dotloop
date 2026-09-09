import { Router } from "express";
import crypto from "node:crypto";
import { buildHubSpotAuthorizeUrl, handleHubSpotCallback } from "../auth/hubspotOAuth";
import { buildDotloopAuthorizeUrl, handleDotloopCallback } from "../auth/dotloopOAuth";
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
    const { portalId } = await handleHubSpotCallback(code);
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
