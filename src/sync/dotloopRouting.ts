import { TenantRow } from "../db/types";
import { getTenantByDotloopProfileId, getTenantById } from "../db/tenantRepo";
import {
  findConnectionByOwner,
  findConnectionByProfileId,
  hasAnyConnections,
  listActiveConnectionsForTenant,
} from "../db/dotloopConnectionRepo";

/**
 * Decides which Dotloop account/profile a HubSpot deal should sync into.
 *
 * Two modes, decided per tenant purely by whether any dotloop_connections
 * rows exist for it (see db/dotloopConnectionRepo.ts):
 *  - Single-account tenant (the default -- tenant_default, and any tenant
 *    that hasn't set up per-agent connections): every deal syncs into the
 *    tenant's own tenants.dotloop_account_id/dotloop_profile_id, exactly as
 *    before this feature existed.
 *  - Brokerage/multi-agent tenant: at least one HubSpot user has connected
 *    their own Dotloop account (see routes/authRoutes.ts's per-agent
 *    connect flow), and every deal routes to whichever agent owns it in
 *    HubSpot (the deal's hubspot_owner_id property). Per Mason's explicit
 *    decision (2026-09-24): a deal whose owner hasn't connected their own
 *    Dotloop account yet is skipped and logged -- never silently attributed
 *    to some other agent's or the tenant's own account. See the call site
 *    in sync/dealLoopSync.ts's syncDealFromHubSpot().
 *
 * Deliberately deal/loop-scoped for now. Standalone HubSpot Contact <->
 * Dotloop Contact sync (sync/contactSync.ts) stays tenant-level only --
 * a shared HubSpot contact could plausibly be relevant to more than one
 * agent, and how that should route hasn't come up in practice. Flagged as
 * a known gap in claude/connector-architecture.md rather than guessed at.
 */
export type DotloopTarget =
  | { ok: true; dotloopAccountId: string; dotloopProfileId: string | null; hubspotOwnerId: string | null }
  | { ok: false; reason: string };

export async function resolveDotloopTargetForDeal(
  tenant: TenantRow,
  hubspotOwnerId: string | null | undefined
): Promise<DotloopTarget> {
  const brokerageMode = await hasAnyConnections(tenant.id);

  if (!brokerageMode) {
    if (!tenant.dotloopAccountId) {
      return { ok: false, reason: "Tenant has no connected Dotloop account" };
    }
    return {
      ok: true,
      dotloopAccountId: tenant.dotloopAccountId,
      dotloopProfileId: tenant.dotloopProfileId,
      hubspotOwnerId: null,
    };
  }

  if (!hubspotOwnerId) {
    return { ok: false, reason: "Deal has no HubSpot owner to route to an agent's Dotloop connection" };
  }
  const connection = await findConnectionByOwner(tenant.id, hubspotOwnerId);
  if (!connection || connection.status !== "ACTIVE" || !connection.dotloopAccountId) {
    return { ok: false, reason: `HubSpot owner ${hubspotOwnerId} has not connected their own Dotloop account yet` };
  }
  return {
    ok: true,
    dotloopAccountId: connection.dotloopAccountId,
    dotloopProfileId: connection.dotloopProfileId,
    hubspotOwnerId,
  };
}

/** One Dotloop account/profile a tenant's reverse-direction (Dotloop ->
 *  HubSpot) polling should watch -- either the tenant's own single
 *  connection, or one entry per connected agent in brokerage mode. Used by
 *  sync/reconcile.ts (listing recent loops) and
 *  sync/subscriptionHealthCheck.ts (checking each connection's own
 *  subscription). `connectionId` is set only for a per-agent connection, so
 *  callers know whether to persist a resolved profile id back onto
 *  dotloop_connections vs. tenants. */
export interface DotloopSyncTarget {
  dotloopAccountId: string;
  dotloopProfileId: string | null;
  connectionId?: string;
}

export async function listDotloopSyncTargets(tenant: TenantRow): Promise<DotloopSyncTarget[]> {
  const connections = await listActiveConnectionsForTenant(tenant.id);
  if (connections.length > 0) {
    return connections
      .filter((c): c is typeof c & { dotloopAccountId: string } => !!c.dotloopAccountId)
      .map((c) => ({ dotloopAccountId: c.dotloopAccountId, dotloopProfileId: c.dotloopProfileId, connectionId: c.id }));
  }
  if (tenant.dotloopAccountId) {
    return [{ dotloopAccountId: tenant.dotloopAccountId, dotloopProfileId: tenant.dotloopProfileId }];
  }
  return [];
}

/** Resolves the (tenant, dotloopAccountId) a Dotloop webhook event's
 *  profileId belongs to -- checks the tenant-level single connection first
 *  (the common, non-brokerage case), then per-agent connections. See
 *  webhooks/dotloopWebhook.ts. */
export async function resolveTenantAndAccountForProfile(
  profileId: string
): Promise<{ tenant: TenantRow; dotloopAccountId: string } | null> {
  const tenant = await getTenantByDotloopProfileId(profileId);
  if (tenant?.dotloopAccountId) {
    return { tenant, dotloopAccountId: tenant.dotloopAccountId };
  }
  const connection = await findConnectionByProfileId(profileId);
  if (connection?.dotloopAccountId) {
    const owningTenant = await getTenantById(connection.tenantId);
    if (owningTenant) return { tenant: owningTenant, dotloopAccountId: connection.dotloopAccountId };
  }
  return null;
}

/** externalId Dotloop subscriptions are tagged with -- must stay in sync
 *  between scripts/registerDotloopSubscriptions.ts (which creates them) and
 *  sync/subscriptionHealthCheck.ts (which checks for them). A per-agent
 *  connection gets its own externalId (suffixed with its connection id) so
 *  each agent's PROFILE subscription is tracked independently. */
export function dotloopProfileSubscriptionExternalId(tenantId: string, connectionId?: string): string {
  return connectionId
    ? `hubspot-dotloop-connector:profile:${tenantId}:agent:${connectionId}`
    : `hubspot-dotloop-connector:profile:${tenantId}`;
}
