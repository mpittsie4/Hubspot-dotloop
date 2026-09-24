/**
 * One-time (or re-run-anytime) setup script: registers this connector's
 * webhook endpoint with Dotloop for the events it knows how to handle.
 *
 * Dotloop's push-webhook subscriptions are an "initial release, available
 * by request" feature (per dotloop.github.io/public-api) — if your account
 * doesn't have it enabled yet, this call will fail; reach out to your
 * Dotloop partner/API contact to get subscriptions turned on. Until then,
 * the reconciliation poller (src/sync/reconcile.ts) still keeps things in
 * sync, just on a delay.
 *
 * Usage:
 *   npm run register:dotloop-subscriptions -- --tenantId=<tenant_...>
 *
 * --tenantId is required as of the multi-tenant onboarding work (see
 * claude/connector-architecture.md's onboarding runbook) -- this used to
 * call DotloopClient.create() with no argument, which falls back to
 * tokenStore.getSoleToken() and throws once more than one tenant has a
 * connected Dotloop account. Passing --tenantId looks up that tenant's own
 * dotloopAccountId and registers subscriptions for their account
 * specifically, so this is safe to re-run per new customer.
 *
 * For a brokerage tenant in "multi-agent mode" (see db/dotloopConnectionRepo.ts
 * and sync/dotloopRouting.ts), also pass --hubspotOwnerId=<owner id> to
 * register that specific agent's own PROFILE subscription instead of the
 * tenant-wide one:
 *   npm run register:dotloop-subscriptions -- --tenantId=<tenant_...> --hubspotOwnerId=<owner_...>
 */
import "dotenv/config";
import { config } from "../src/config";
import { DotloopClient } from "../src/clients/dotloopClient";
import { getTenantById } from "../src/db/tenantRepo";
import { findConnectionByOwner } from "../src/db/dotloopConnectionRepo";
import { dotloopProfileSubscriptionExternalId } from "../src/sync/dotloopRouting";
import { logger } from "../src/utils/logger";

function parseTenantIdArg(): string {
  const arg = process.argv.find((a) => a.startsWith("--tenantId="));
  if (!arg) {
    throw new Error(
      "Missing --tenantId=<tenant_...>. Look it up via the tenants table, or from the id returned by " +
        "POST /auth/admin/tenants when you onboarded this customer."
    );
  }
  return arg.slice("--tenantId=".length);
}

function parseHubspotOwnerIdArg(): string | undefined {
  const arg = process.argv.find((a) => a.startsWith("--hubspotOwnerId="));
  return arg ? arg.slice("--hubspotOwnerId=".length) : undefined;
}

async function main() {
  if (!config.dotloop.webhookSigningSecret) {
    throw new Error(
      "Set DOTLOOP_WEBHOOK_SIGNING_SECRET in .env first (generate one with `openssl rand -hex 32`) — " +
        "it gets registered with Dotloop as the subscription's signingKey. This is one shared app-level " +
        "secret used to verify every tenant's incoming Dotloop webhooks, not a per-tenant value."
    );
  }

  const tenantId = parseTenantIdArg();
  const hubspotOwnerId = parseHubspotOwnerIdArg();
  const tenant = await getTenantById(tenantId);
  if (!tenant) {
    throw new Error(`Unknown tenantId "${tenantId}".`);
  }

  let dotloopAccountId: string;
  let externalId: string;
  let logContext: Record<string, unknown> = { tenantId };

  if (hubspotOwnerId) {
    const connection = await findConnectionByOwner(tenantId, hubspotOwnerId);
    if (!connection?.dotloopAccountId) {
      throw new Error(
        `Agent (HubSpot owner ${hubspotOwnerId}) on tenant "${tenantId}" has no connected Dotloop account yet -- ` +
          "send them their connectDotloopUrl first (from POST /auth/admin/tenants/:tenantId/agents) and wait for " +
          "them to complete that OAuth grant."
      );
    }
    dotloopAccountId = connection.dotloopAccountId;
    externalId = dotloopProfileSubscriptionExternalId(tenantId, connection.id);
    logContext = { tenantId, hubspotOwnerId, connectionId: connection.id };
  } else {
    if (!tenant.dotloopAccountId) {
      throw new Error(
        `Tenant "${tenantId}" has no connected Dotloop account yet -- send them their connectDotloopUrl first ` +
          "(from POST /auth/admin/tenants) and wait for them to complete that OAuth grant."
      );
    }
    dotloopAccountId = tenant.dotloopAccountId;
    externalId = dotloopProfileSubscriptionExternalId(tenantId);
  }

  const dotloop = await DotloopClient.create(dotloopAccountId);
  const profileId = await dotloop.resolveProfileId();

  const targetUrl = `${config.publicBaseUrl}/webhooks/dotloop`;

  const profileSub = await dotloop.createSubscription({
    targetType: "PROFILE",
    targetId: Number(profileId),
    eventTypes: ["LOOP_CREATED", "LOOP_UPDATED", "LOOP_MERGED", "LOOP_PARTICIPANT_CREATED", "LOOP_PARTICIPANT_UPDATED"],
    url: targetUrl,
    signingKey: config.dotloop.webhookSigningSecret,
    externalId,
  });
  logger.info({ ...logContext, subscription: profileSub }, "Created Dotloop PROFILE subscription (loops + participants)");

  // CONTACT_* events are subscribed at the USER level; targetId is the
  // Dotloop account/user id captured when this connection was made. Not
  // applicable per-agent -- standalone Contact sync isn't routed per-agent
  // (see sync/dotloopRouting.ts), so this is only meaningful for the
  // tenant-wide connection.
  const existing = await dotloop.listSubscriptions(); // sanity call; also useful to eyeball existing subs
  logger.info({ ...logContext, existingSubscriptionCount: existing.length }, "Existing Dotloop subscriptions for this account");

  if (!hubspotOwnerId) {
    logger.warn(
      logContext,
      "To also subscribe to CONTACT_CREATED/CONTACT_UPDATED, create a second subscription with " +
        "targetType: 'USER' and targetId set to this tenant's Dotloop account id " +
        `(${dotloopAccountId}) -- left as a manual step since the user id isn't otherwise used by this connector.`
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, "Failed to register Dotloop subscriptions");
    process.exit(1);
  });
