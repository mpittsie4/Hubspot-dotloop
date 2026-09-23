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
 */
import "dotenv/config";
import { config } from "../src/config";
import { DotloopClient } from "../src/clients/dotloopClient";
import { getTenantById } from "../src/db/tenantRepo";
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

async function main() {
  if (!config.dotloop.webhookSigningSecret) {
    throw new Error(
      "Set DOTLOOP_WEBHOOK_SIGNING_SECRET in .env first (generate one with `openssl rand -hex 32`) — " +
        "it gets registered with Dotloop as the subscription's signingKey. This is one shared app-level " +
        "secret used to verify every tenant's incoming Dotloop webhooks, not a per-tenant value."
    );
  }

  const tenantId = parseTenantIdArg();
  const tenant = await getTenantById(tenantId);
  if (!tenant) {
    throw new Error(`Unknown tenantId "${tenantId}".`);
  }
  if (!tenant.dotloopAccountId) {
    throw new Error(
      `Tenant "${tenantId}" has no connected Dotloop account yet -- send them their connectDotloopUrl first ` +
        "(from POST /auth/admin/tenants) and wait for them to complete that OAuth grant."
    );
  }

  const dotloop = await DotloopClient.create(tenant.dotloopAccountId);
  const profileId = await dotloop.resolveProfileId();

  const targetUrl = `${config.publicBaseUrl}/webhooks/dotloop`;

  const profileSub = await dotloop.createSubscription({
    targetType: "PROFILE",
    targetId: Number(profileId),
    eventTypes: ["LOOP_CREATED", "LOOP_UPDATED", "LOOP_MERGED", "LOOP_PARTICIPANT_CREATED", "LOOP_PARTICIPANT_UPDATED"],
    url: targetUrl,
    signingKey: config.dotloop.webhookSigningSecret,
    externalId: `hubspot-dotloop-connector:profile:${tenantId}`,
  });
  logger.info({ tenantId, subscription: profileSub }, "Created Dotloop PROFILE subscription (loops + participants)");

  // CONTACT_* events are subscribed at the USER level; targetId is the
  // Dotloop account/user id captured when this tenant connected via
  // /auth/dotloop/start.
  const account = await dotloop.listSubscriptions(); // sanity call; also useful to eyeball existing subs
  logger.info({ tenantId, existingSubscriptionCount: account.length }, "Existing Dotloop subscriptions for this account");

  logger.warn(
    { tenantId },
    "To also subscribe to CONTACT_CREATED/CONTACT_UPDATED, create a second subscription with " +
      "targetType: 'USER' and targetId set to this tenant's Dotloop account id " +
      `(${tenant.dotloopAccountId}) -- left as a manual step since the user id isn't otherwise used by this connector.`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, "Failed to register Dotloop subscriptions");
    process.exit(1);
  });
