import { NextFunction, Request, Response, Router } from "express";
import { config } from "../config";
import { verifyHubSpotSignature } from "../utils/crypto";
import { HubSpotClient } from "../clients/hubspotClient";
import { listActiveTenants, getTenantByHubspotPortalId } from "../db/tenantRepo";
import { TenantRow } from "../db/types";
import { listSyncedDocumentsForDeal } from "../db/documentSyncRepo";
import { findConnectionByOwner, hasAnyConnections } from "../db/dotloopConnectionRepo";
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

/**
 * Resolves which tenant a UI-extension proxy call belongs to.
 *
 * HubSpot's UI Extensions SDK gives every extension component a `context`
 * prop that includes `context.portal.id` (see `@hubspot/ui-extensions`'
 * PortalContext) -- both DealSyncCard.tsx and StageMappingSettings.tsx now
 * pass that through as a `?portalId=` query param on their hubspot.fetch()
 * calls. requireHubSpotSignature has already verified this exact request
 * (method + full URI, including this query string, + body) was signed by
 * HubSpot with this app's client secret, so the portalId can't be tampered
 * with in transit without invalidating the signature -- the same guarantee
 * webhooks/hubspotWebhook.ts relies on for the portalId in its payload.
 *
 * Falls back to the old single-tenant assumption when portalId is absent,
 * so an not-yet-redeployed extension build doesn't hard-break -- but logs a
 * warning, since that fallback silently breaks the moment a second tenant
 * goes active (see the "Multiple active tenants" error it already throws).
 */
async function resolveTenantForRequest(req: Request): Promise<TenantRow> {
  const portalId = typeof req.query.portalId === "string" ? req.query.portalId : undefined;
  if (portalId) {
    const tenant = await getTenantByHubspotPortalId(portalId);
    if (!tenant) {
      throw new Error(`No tenant found for HubSpot portal ${portalId}.`);
    }
    return tenant;
  }

  logger.warn(
    { path: req.path },
    "Proxy request had no portalId query param (stale extension build?); falling back to sole-tenant lookup"
  );
  const tenants = await listActiveTenants();
  if (tenants.length === 0) {
    throw new Error("No active tenant found.");
  }
  if (tenants.length > 1) {
    throw new Error(
      `Multiple active tenants found (${tenants.map((t) => t.id).join(", ")}) and no portalId was sent; ` +
        "the calling UI extension needs to be redeployed with the portalId query param."
    );
  }
  return tenants[0];
}

hubspotProxyRouter.get("/pipelines/deals", requireHubSpotSignature, async (req, res) => {
  try {
    const tenant = await resolveTenantForRequest(req);
    const client = await HubSpotClient.create(tenant.hubspotPortalId ?? undefined);
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
  "hubspot_owner_id",
];

/**
 * Brokerage self-serve connect: tells the Deal Sync Status card whether
 * *this specific deal* is stuck waiting on its owner to connect their own
 * Dotloop account (see sync/dotloopRouting.ts's skip-not-fallback
 * behavior), and if so, whether the person currently looking at the card
 * *is* that owner.
 *
 * Deliberately never returns a connectUrl to anyone but the matching owner
 * -- resolveDotloopTargetForDeal() routes strictly by hubspot_owner_id, so
 * if a teammate or admin viewing the same deal could click a "connect"
 * button here, they'd silently link *their own* Dotloop account into the
 * real owner's connection slot, which is exactly the wrong-account problem
 * the whole account-confirmation feature exists to prevent. Only the deal
 * card knows who's asking (via the viewerEmail it sends from
 * context.user.email), so that gating has to happen here, not client-side.
 *
 * Returns null (nothing to show) for a single-account tenant, a deal with
 * no owner, or an owner who's already ACTIVE.
 */
export async function resolveDealDotloopConnectionForViewer(
  tenant: TenantRow,
  client: HubSpotClient,
  ownerId: string | undefined,
  viewerEmail: string | undefined
): Promise<{
  status: "NOT_CONNECTED" | "PENDING";
  ownerLabel: string;
  isViewerTheOwner: boolean;
  connectUrl: string | null;
} | null> {
  if (!ownerId) return null;
  if (!(await hasAnyConnections(tenant.id))) return null; // not a brokerage tenant

  const connection = await findConnectionByOwner(tenant.id, ownerId);
  if (connection?.status === "ACTIVE") return null; // already connected, nothing to show

  let owner: Awaited<ReturnType<HubSpotClient["getOwner"]>> = null;
  try {
    owner = await client.getOwner(ownerId);
  } catch (err) {
    logger.error({ err, ownerId }, "Failed to look up deal owner for brokerage self-serve connect prompt");
  }
  const ownerLabel = owner ? `${owner.firstName ?? ""} ${owner.lastName ?? ""}`.trim() || owner.email || ownerId : ownerId;
  const isViewerTheOwner = Boolean(
    viewerEmail && owner?.email && viewerEmail.toLowerCase() === owner.email.toLowerCase()
  );

  return {
    status: connection?.status === "PENDING" ? "PENDING" : "NOT_CONNECTED",
    ownerLabel,
    isViewerTheOwner,
    connectUrl: isViewerTheOwner
      ? `${config.publicBaseUrl}/auth/dotloop/start?tenantId=${tenant.id}&hubspotOwnerId=${encodeURIComponent(ownerId)}`
      : null,
  };
}

hubspotProxyRouter.get("/deals/:dealId/dotloop-status", requireHubSpotSignature, async (req, res) => {
  const { dealId } = req.params;
  try {
    const tenant = await resolveTenantForRequest(req);
    const client = await HubSpotClient.create(tenant.hubspotPortalId ?? undefined);
    const deal = await client.getDeal(dealId, DOTLOOP_DEAL_PROPERTIES);
    if (!deal) {
      return res.status(404).json({ error: `Deal ${dealId} not found.` });
    }

    // Document links are best-effort: a lookup failure here shouldn't hide
    // the sync status the card already has data for.
    let documents: Array<{
      documentName: string | null;
      folderName: string | null;
      dotloopUpdatedAt: string | null;
      loopUrl: string | null;
    }> = [];
    try {
      const rows = await listSyncedDocumentsForDeal(tenant.id, dealId);
      documents = rows.map((row) => ({
        documentName: row.documentName,
        folderName: row.folderName,
        dotloopUpdatedAt: row.dotloopUpdatedAt ? row.dotloopUpdatedAt.toISOString() : null,
        loopUrl: deal.properties.dotloop_loop_url ?? null,
      }));
    } catch (err) {
      logger.error({ err, dealId }, "Failed to fetch synced documents for card proxy; returning sync status without them");
    }

    let dotloopConnection = null;
    try {
      const viewerEmail = typeof req.query.viewerEmail === "string" ? req.query.viewerEmail : undefined;
      dotloopConnection = await resolveDealDotloopConnectionForViewer(
        tenant,
        client,
        deal.properties.hubspot_owner_id,
        viewerEmail
      );
    } catch (err) {
      logger.error({ err, dealId }, "Failed to resolve brokerage self-serve connect status; omitting it from the response");
    }

    res.json({ properties: deal.properties, documents, dotloopConnection });
  } catch (err) {
    logger.error({ err, dealId }, "Failed to fetch dotloop sync status for card proxy");
    res.status(502).json({ error: "Failed to fetch Dotloop sync status from HubSpot." });
  }
});
