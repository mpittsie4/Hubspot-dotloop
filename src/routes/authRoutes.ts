import { Router } from "express";
import crypto from "node:crypto";
import { buildHubSpotAuthorizeUrl, handleHubSpotCallback } from "../auth/hubspotOAuth";
import { buildDotloopAuthorizeUrl, handleDotloopCallback } from "../auth/dotloopOAuth";
import { HubSpotClient } from "../clients/hubspotClient";
import { DotloopClient } from "../clients/dotloopClient";
import { createTenant, getTenantById, setDotloopAccountId, setDotloopProfileId, setHubspotPortalId } from "../db/tenantRepo";
import { config } from "../config";
import { logger } from "../utils/logger";

export const authRouter = Router();

// Pre-multi-tenant sandbox connection, seeded as a real tenant row by
// migrations/002_tenants.sql. Used as the default when /start is hit
// without a tenantId, so Mason's own existing bookmarked connect links
// keep working unchanged.
const DEFAULT_TENANT_ID = "tenant_default";

// In-memory state nonce store (single-process scaffold). For multi-instance
// deployments, swap this for a signed, expiring cookie or a shared cache.
// Each nonce carries the tenant it belongs to, so the two independent
// OAuth flows -- HubSpot connect and Dotloop connect, normally two
// separate clicks in this manual-onboarding admin flow -- link back to the
// same tenant row instead of just landing wherever getSoleToken() used to
// assume they both went.
const pendingStates = new Map<string, string>(); // nonce -> tenantId

function buildState(tenantId: string): string {
  const nonce = crypto.randomBytes(16).toString("hex");
  pendingStates.set(nonce, tenantId);
  return nonce;
}

function consumeState(nonce: string): string | undefined {
  const tenantId = pendingStates.get(nonce);
  if (tenantId) pendingStates.delete(nonce);
  return tenantId;
}

authRouter.get("/hubspot/start", async (req, res) => {
  const tenantId = typeof req.query.tenantId === "string" ? req.query.tenantId : DEFAULT_TENANT_ID;
  const tenant = await getTenantById(tenantId);
  if (!tenant) {
    return res.status(404).send(`Unknown tenantId "${tenantId}". Create one first via POST /auth/admin/tenants.`);
  }
  res.redirect(buildHubSpotAuthorizeUrl(buildState(tenantId)));
});

authRouter.get("/hubspot/callback", async (req, res) => {
  const { code, state } = req.query;
  const tenantId = typeof state === "string" ? consumeState(state) : undefined;
  if (!tenantId) {
    return res.status(400).send("Invalid or expired OAuth state.");
  }
  if (typeof code !== "string") {
    return res.status(400).send("Missing authorization code.");
  }
  try {
    const { portalId, accessToken } = await handleHubSpotCallback(code);
    await setHubspotPortalId(tenantId, portalId);

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
      logger.error({ err: propErr, portalId, tenantId }, "Failed to auto-create dotloop_* properties for this portal");
    }

    res.send(`HubSpot connected (portal ${portalId}, tenant ${tenantId}). You can close this tab.`);
  } catch (err) {
    logger.error({ err, tenantId }, "HubSpot OAuth callback failed");
    res.status(500).send("Failed to complete HubSpot connection. Check server logs.");
  }
});

authRouter.get("/dotloop/start", async (req, res) => {
  const tenantId = typeof req.query.tenantId === "string" ? req.query.tenantId : DEFAULT_TENANT_ID;
  const tenant = await getTenantById(tenantId);
  if (!tenant) {
    return res.status(404).send(`Unknown tenantId "${tenantId}". Create one first via POST /auth/admin/tenants.`);
  }
  res.redirect(buildDotloopAuthorizeUrl(buildState(tenantId)));
});

authRouter.get("/dotloop/callback", async (req, res) => {
  const { code, state } = req.query;
  const tenantId = typeof state === "string" ? consumeState(state) : undefined;
  if (!tenantId) {
    return res.status(400).send("Invalid or expired OAuth state.");
  }
  if (typeof code !== "string") {
    return res.status(400).send("Missing authorization code.");
  }
  try {
    const { accountId } = await handleDotloopCallback(code);
    await setDotloopAccountId(tenantId, accountId);

    // Cache the Dotloop *profile* id too (not just the account id):
    // Dotloop webhook events carry a profileId, and an account can have
    // more than one profile, so webhooks/dotloopWebhook.ts needs this to
    // resolve which tenant an event belongs to. Non-fatal on failure --
    // sync/reconcile.ts's backfillDotloopProfileIds() self-heals this on
    // the next reconciliation pass (or the next server boot) if it fails
    // here.
    try {
      const dotloop = await DotloopClient.create(accountId);
      const profileId = await dotloop.resolveProfileId();
      await setDotloopProfileId(tenantId, profileId);
    } catch (profileErr) {
      logger.error({ err: profileErr, tenantId, accountId }, "Failed to resolve/store Dotloop profile id for this tenant");
    }

    res.send(`Dotloop connected (account ${accountId}, tenant ${tenantId}). You can close this tab.`);
  } catch (err) {
    logger.error({ err, tenantId }, "Dotloop OAuth callback failed");
    res.status(500).send("Failed to complete Dotloop connection. Check server logs.");
  }
});

// ---- Minimal admin endpoint for onboarding a new tenant ----------------
// No self-serve onboarding wizard yet (see the "no self-serve wizard yet"
// decision in the public-distribution roadmap doc) -- Mason creates a
// tenant row here, sends that customer the two connect URLs it returns to
// complete both OAuth grants, then edits that tenant's pipelines_config
// directly in the DB for their real HubSpot pipeline/stage ids. Protected
// by a shared secret (ADMIN_API_KEY) rather than left open, since it
// creates real, billable-later tenant rows.
authRouter.post("/admin/tenants", async (req, res) => {
  if (!config.adminApiKey || req.header("X-Admin-Key") !== config.adminApiKey) {
    return res.status(401).json({ error: "Missing or invalid X-Admin-Key header." });
  }
  const name = typeof req.body?.name === "string" ? req.body.name : undefined;
  const tenant = await createTenant(name);
  res.status(201).json({
    id: tenant.id,
    name: tenant.name,
    connectHubspotUrl: `${config.publicBaseUrl}/auth/hubspot/start?tenantId=${tenant.id}`,
    connectDotloopUrl: `${config.publicBaseUrl}/auth/dotloop/start?tenantId=${tenant.id}`,
  });
});
