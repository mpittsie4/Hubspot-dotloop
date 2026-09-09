/**
 * One-time (or re-run-anytime) setup script: points HubSpot's classic
 * webhooks v3 API at this connector and subscribes to contact/deal
 * create + property-change events.
 *
 * Requires HUBSPOT_APP_ID to be set (the numeric app id shown on your
 * app's "Auth" tab in the HubSpot developer account, not the portal id).
 *
 * Usage: npm run register:hubspot-webhooks
 */
import "dotenv/config";
import { config } from "../src/config";
import { HubSpotClient } from "../src/clients/hubspotClient";
import { logger } from "../src/utils/logger";

const EVENT_TYPES = ["contact.creation", "contact.propertyChange", "deal.creation", "deal.propertyChange"];

async function main() {
  if (!config.hubspot.appId) {
    throw new Error("Set HUBSPOT_APP_ID in .env first (found on the app's Auth tab in your developer account).");
  }

  const hubspot = await HubSpotClient.create();
  const targetUrl = `${config.publicBaseUrl}/webhooks/hubspot`;

  await hubspot.setWebhookTargetUrl(config.hubspot.appId, targetUrl);
  logger.info({ targetUrl }, "Set HubSpot webhook target URL");

  for (const eventType of EVENT_TYPES) {
    await hubspot.upsertWebhookSubscription(config.hubspot.appId, eventType);
    logger.info({ eventType }, "Subscribed HubSpot webhook event");
  }

  // Custom properties used to keep a human-visible pointer back to Dotloop
  // on the HubSpot record (handy in list views / workflows); the actual
  // link lives in the connector's own database (ObjectMapping table).
  await hubspot.ensureProperty("contacts", "dotloop_contact_id", "Dotloop Contact ID");
  await hubspot.ensureProperty("deals", "dotloop_loop_id", "Dotloop Loop ID");

  logger.info("HubSpot webhook registration complete.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, "Failed to register HubSpot webhooks");
    process.exit(1);
  });
