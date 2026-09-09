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
 * Usage: npm run register:dotloop-subscriptions
 */
import "dotenv/config";
import { config } from "../src/config";
import { DotloopClient } from "../src/clients/dotloopClient";
import { logger } from "../src/utils/logger";

async function main() {
  if (!config.dotloop.webhookSigningSecret) {
    throw new Error(
      "Set DOTLOOP_WEBHOOK_SIGNING_SECRET in .env first (generate one with `openssl rand -hex 32`) — " +
        "it gets registered with Dotloop as the subscription's signingKey."
    );
  }

  const dotloop = await DotloopClient.create();
  const profileId = await dotloop.resolveProfileId();

  const targetUrl = `${config.publicBaseUrl}/webhooks/dotloop`;

  const profileSub = await dotloop.createSubscription({
    targetType: "PROFILE",
    targetId: Number(profileId),
    eventTypes: ["LOOP_CREATED", "LOOP_UPDATED", "LOOP_MERGED", "LOOP_PARTICIPANT_CREATED", "LOOP_PARTICIPANT_UPDATED"],
    url: targetUrl,
    signingKey: config.dotloop.webhookSigningSecret,
    externalId: "hubspot-dotloop-connector:profile",
  });
  logger.info({ subscription: profileSub }, "Created Dotloop PROFILE subscription (loops + participants)");

  // CONTACT_* events are subscribed at the USER level; targetId is the
  // Dotloop account/user id captured when you connected via /auth/dotloop/start.
  const account = await dotloop.listSubscriptions(); // sanity call; also useful to eyeball existing subs
  logger.info({ existingSubscriptionCount: account.length }, "Existing Dotloop subscriptions");

  logger.warn(
    "To also subscribe to CONTACT_CREATED/CONTACT_UPDATED, create a second subscription with " +
      "targetType: 'USER' and targetId set to your Dotloop user id (see the accountId logged when " +
      "you connected at /auth/dotloop/start) — left as a manual step since the user id isn't otherwise " +
      "used by this connector."
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, "Failed to register Dotloop subscriptions");
    process.exit(1);
  });
