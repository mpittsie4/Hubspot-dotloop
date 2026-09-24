import { Router } from "express";
import crypto from "node:crypto";
import { buildHubSpotAuthorizeUrl, handleHubSpotCallback } from "../auth/hubspotOAuth";
import { buildDotloopAuthorizeUrl, handleDotloopCallback } from "../auth/dotloopOAuth";
import { HubSpotClient } from "../clients/hubspotClient";
import { DotloopAccount, DotloopClient, DotloopProfile } from "../clients/dotloopClient";
import { createTenant, getTenantById, setDotloopAccountId, setDotloopProfileId, setHubspotPortalId } from "../db/tenantRepo";
import {
  createPendingConnection,
  listConnectionsForTenant,
  setConnectionAccountId,
  setConnectionProfileId,
} from "../db/dotloopConnectionRepo";
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
// Each nonce carries the tenant it belongs to (and, for a per-agent Dotloop
// connection, which HubSpot owner it's for -- see the "brokerage mode"
// section below), so the two independent OAuth flows -- HubSpot connect and
// Dotloop connect, normally two separate clicks in this manual-onboarding
// admin flow -- link back to the same tenant row instead of just landing
// wherever getSoleToken() used to assume they both went.
interface PendingState {
  tenantId: string;
  hubspotOwnerId?: string;
}
const pendingStates = new Map<string, PendingState>();

function buildState(state: PendingState): string {
  const nonce = crypto.randomBytes(16).toString("hex");
  pendingStates.set(nonce, state);
  return nonce;
}

function consumeState(nonce: string): PendingState | undefined {
  const state = pendingStates.get(nonce);
  if (state) pendingStates.delete(nonce);
  return state;
}

authRouter.get("/hubspot/start", async (req, res) => {
  const tenantId = typeof req.query.tenantId === "string" ? req.query.tenantId : DEFAULT_TENANT_ID;
  const tenant = await getTenantById(tenantId);
  if (!tenant) {
    return res.status(404).send(`Unknown tenantId "${tenantId}". Create one first via POST /auth/admin/tenants.`);
  }
  res.redirect(buildHubSpotAuthorizeUrl(buildState({ tenantId })));
});

authRouter.get("/hubspot/callback", async (req, res) => {
  const { code, state } = req.query;
  const parsed = typeof state === "string" ? consumeState(state) : undefined;
  if (!parsed) {
    return res.status(400).send("Invalid or expired OAuth state.");
  }
  const { tenantId } = parsed;
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

// ---- Dotloop connect -----------------------------------------------------
// Two shapes of this same flow:
//  - Tenant-wide (no hubspotOwnerId): the original single-account model --
//    this tenant's *own* dotloop_account_id/dotloop_profile_id.
//  - Per-agent (hubspotOwnerId present): "brokerage mode" -- see
//    db/dotloopConnectionRepo.ts and sync/dotloopRouting.ts. Minted via
//    POST /auth/admin/tenants/:tenantId/agents below, one link per agent.

authRouter.get("/dotloop/start", async (req, res) => {
  const tenantId = typeof req.query.tenantId === "string" ? req.query.tenantId : DEFAULT_TENANT_ID;
  const hubspotOwnerId = typeof req.query.hubspotOwnerId === "string" ? req.query.hubspotOwnerId : undefined;
  const tenant = await getTenantById(tenantId);
  if (!tenant) {
    return res.status(404).send(`Unknown tenantId "${tenantId}". Create one first via POST /auth/admin/tenants.`);
  }
  res.redirect(buildDotloopAuthorizeUrl(buildState({ tenantId, hubspotOwnerId })));
});

authRouter.get("/dotloop/callback", async (req, res) => {
  const { code, state } = req.query;
  const parsed = typeof state === "string" ? consumeState(state) : undefined;
  if (!parsed) {
    return res.status(400).send("Invalid or expired OAuth state.");
  }
  const { tenantId, hubspotOwnerId } = parsed;
  if (typeof code !== "string") {
    return res.status(400).send("Missing authorization code.");
  }
  try {
    const { accountId } = await handleDotloopCallback(code);
    const dotloop = await DotloopClient.create(accountId);

    // Look up the connected account's own identity *before* anything else,
    // so whoever just clicked through OAuth (and Mason, watching logs) can
    // confirm this is the right Dotloop login before relying on it. Checked
    // against Dotloop's public API docs (2026-09-24): the authorize
    // endpoint has no forced-relogin or account-picker parameter, so if the
    // browser doing this was already signed into a different Dotloop
    // account, OAuth would otherwise silently link that one instead with no
    // warning. Non-fatal if this lookup itself fails -- the connection
    // still completes, it just can't be visually confirmed on this page.
    let account: DotloopAccount | null = null;
    let profile: DotloopProfile | null = null;
    let profileId: string | undefined;
    try {
      account = await dotloop.getAccount();
      profileId = await dotloop.resolveProfileId();
      profile = await dotloop.getProfile(profileId);
    } catch (identityErr) {
      logger.error(
        { err: identityErr, tenantId, hubspotOwnerId, accountId },
        "Connected to Dotloop but failed to look up the account/profile identity to confirm it"
      );
    }

    if (hubspotOwnerId) {
      await createPendingConnection(tenantId, hubspotOwnerId); // idempotent -- safe if they're redoing this
      const connection = await setConnectionAccountId(tenantId, hubspotOwnerId, accountId);
      if (profileId) {
        await setConnectionProfileId(connection.id, profileId).catch((profileErr) => {
          logger.error(
            { err: profileErr, tenantId, hubspotOwnerId, accountId },
            "Failed to store resolved Dotloop profile id for this agent connection"
          );
        });
      }
    } else {
      await setDotloopAccountId(tenantId, accountId);
      if (profileId) {
        await setDotloopProfileId(tenantId, profileId).catch((profileErr) => {
          logger.error({ err: profileErr, tenantId, accountId }, "Failed to store resolved Dotloop profile id for this tenant");
        });
      }
    }

    res.send(renderDotloopConnectedPage({ tenantId, hubspotOwnerId, accountId, account, profile }));
  } catch (err) {
    logger.error({ err, tenantId, hubspotOwnerId }, "Dotloop OAuth callback failed");
    res.status(500).send("Failed to complete Dotloop connection. Check server logs.");
  }
});

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderDotloopConnectedPage(opts: {
  tenantId: string;
  hubspotOwnerId?: string;
  accountId: string;
  account: DotloopAccount | null;
  profile: DotloopProfile | null;
}): string {
  const { tenantId, hubspotOwnerId, accountId, account, profile } = opts;
  const who = account ? `${account.firstName ?? ""} ${account.lastName ?? ""}`.trim() || "(name unavailable)" : "(unable to look up account details)";
  const email = account?.email ?? "(unknown)";
  const profileLabel = profile ? `${profile.name ?? profile.id} (${profile.type ?? "unknown type"})` : "(unable to look up profile details)";
  const reconnectUrl = `/auth/dotloop/start?tenantId=${encodeURIComponent(tenantId)}${
    hubspotOwnerId ? `&hubspotOwnerId=${encodeURIComponent(hubspotOwnerId)}` : ""
  }`;
  const linkedTo = hubspotOwnerId
    ? `Linked to HubSpot owner <code>${escapeHtml(hubspotOwnerId)}</code> on tenant <code>${escapeHtml(tenantId)}</code>.`
    : `Linked to tenant <code>${escapeHtml(tenantId)}</code>.`;

  return `<!doctype html>
<html>
<body style="font-family: sans-serif; max-width: 480px; margin: 40px auto; line-height: 1.5;">
  <h2>Dotloop connected -- please confirm this is the right account</h2>
  <p>You connected: <strong>${escapeHtml(who)}</strong> (${escapeHtml(email)})</p>
  <p>Profile: <strong>${escapeHtml(profileLabel)}</strong></p>
  <p>Account ID: <code>${escapeHtml(accountId)}</code></p>
  <p>${linkedTo}</p>
  <hr/>
  <p>If this is <strong>not</strong> the right Dotloop account, <a href="${reconnectUrl}">reconnect</a> --
  ideally in a private/incognito browser window if you're signed into more than one Dotloop account, since
  Dotloop doesn't support forcing a fresh login from this link.</p>
  <p>Otherwise, you're done -- you can close this tab.</p>
</body>
</html>`;
}

// ---- Minimal admin endpoints for onboarding ------------------------------
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

// ---- Per-agent Dotloop connections (brokerage mode) ----------------------
// See db/dotloopConnectionRepo.ts and sync/dotloopRouting.ts. Mints one
// connect link per HubSpot user (owner) on an already-onboarded tenant;
// the agent visiting it authorizes their *own* Dotloop account, which then
// routes only that agent's own deals (see resolveDotloopTargetForDeal()).
// Find a HubSpot user's owner id via HubSpot's own Settings > Users page,
// or GET /crm/v3/owners on that portal's token -- see
// claude/customer-onboarding-runbook.md for the exact steps.
authRouter.post("/admin/tenants/:tenantId/agents", async (req, res) => {
  if (!config.adminApiKey || req.header("X-Admin-Key") !== config.adminApiKey) {
    return res.status(401).json({ error: "Missing or invalid X-Admin-Key header." });
  }
  const { tenantId } = req.params;
  const tenant = await getTenantById(tenantId);
  if (!tenant) {
    return res.status(404).json({ error: `Unknown tenantId "${tenantId}".` });
  }
  const hubspotOwnerId = typeof req.body?.hubspotOwnerId === "string" ? req.body.hubspotOwnerId : undefined;
  if (!hubspotOwnerId) {
    return res.status(400).json({ error: "hubspotOwnerId is required (the agent's HubSpot user/owner id)." });
  }
  res.status(201).json({
    tenantId,
    hubspotOwnerId,
    connectDotloopUrl: `${config.publicBaseUrl}/auth/dotloop/start?tenantId=${tenantId}&hubspotOwnerId=${encodeURIComponent(
      hubspotOwnerId
    )}`,
  });
});

/** Lists every agent connection for a tenant (any status), so Mason can see
 *  who's connected and who still needs to click their link. */
authRouter.get("/admin/tenants/:tenantId/agents", async (req, res) => {
  if (!config.adminApiKey || req.header("X-Admin-Key") !== config.adminApiKey) {
    return res.status(401).json({ error: "Missing or invalid X-Admin-Key header." });
  }
  const { tenantId } = req.params;
  const tenant = await getTenantById(tenantId);
  if (!tenant) {
    return res.status(404).json({ error: `Unknown tenantId "${tenantId}".` });
  }
  const connections = await listConnectionsForTenant(tenantId);
  res.json({
    tenantId,
    connections: connections.map((c) => ({
      hubspotOwnerId: c.hubspotOwnerId,
      status: c.status,
      dotloopAccountId: c.dotloopAccountId,
      dotloopProfileId: c.dotloopProfileId,
      connectedAt: c.updatedAt,
    })),
  });
});
