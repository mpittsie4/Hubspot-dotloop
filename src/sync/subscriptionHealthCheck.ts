import cron from "node-cron";
import { listActiveTenants } from "../db/tenantRepo";
import { TenantRow } from "../db/types";
import { config } from "../config";
import { logger } from "../utils/logger";
import { DotloopClient } from "../clients/dotloopClient";

// Must match the externalId this connector registers subscriptions under --
// see scripts/registerDotloopSubscriptions.ts.
const EXTERNAL_ID_PREFIX = "hubspot-dotloop-connector:profile:";

/**
 * Dotloop auto-disables a webhook subscription after enough consecutive
 * delivery failures and, per its own docs, never re-enables it on its own.
 * Before this, nothing in this connector ever re-checked subscription
 * health after the one-time registerDotloopSubscriptions.ts run -- so a
 * subscription could go dark (e.g. a burst of failed deliveries during a
 * Render redeploy at the wrong moment) with the only symptom being a
 * tenant's deals quietly no longer updating from Dotloop's side, which
 * looks identical to "nothing changed" until someone happens to notice.
 * This is the same failure class already hit once in this project (the
 * "webhook subscription never registered" bug) -- see
 * claude/pre-launch-improvement-research.md item 3.
 *
 * This deliberately does not auto-recreate a missing/disabled subscription.
 * Re-registering blindly could paper over a real, worth-investigating
 * problem (e.g. this connector's own webhook endpoint being unreachable) --
 * a human re-running registerDotloopSubscriptions.ts after checking what
 * actually happened is the safer path. This is a monitor, not a self-healer.
 */
export async function checkTenantSubscriptionHealth(tenant: TenantRow): Promise<void> {
  if (!tenant.dotloopAccountId) return;

  try {
    const dotloop = await DotloopClient.create(tenant.dotloopAccountId);
    const subscriptions = await dotloop.listSubscriptions();
    const expectedExternalId = `${EXTERNAL_ID_PREFIX}${tenant.id}`;
    const ours = subscriptions.find((s) => s.externalId === expectedExternalId);

    if (!ours) {
      logger.error(
        { tenantId: tenant.id, expectedExternalId, subscriptionCount: subscriptions.length },
        `Dotloop subscription health check: this tenant's expected PROFILE subscription is missing -- webhooks ` +
          `won't be delivered until it's re-registered (npm run register:dotloop-subscriptions -- --tenantId=${tenant.id})`
      );
      return;
    }

    if (!ours.enabled) {
      logger.error(
        { tenantId: tenant.id, subscriptionId: ours.id },
        `Dotloop subscription health check: this tenant's subscription is DISABLED (most likely auto-disabled ` +
          `after repeated delivery failures) -- Dotloop does not re-enable it automatically. Confirm the webhook ` +
          `endpoint is healthy, then re-register: npm run register:dotloop-subscriptions -- --tenantId=${tenant.id}`
      );
      return;
    }

    logger.info({ tenantId: tenant.id, subscriptionId: ours.id }, "Dotloop subscription health check: OK");
  } catch (err) {
    logger.error({ err, tenantId: tenant.id }, "Dotloop subscription health check failed to run for this tenant");
  }
}

/** Runs one health-check pass across every fully-connected (ACTIVE) tenant. */
export async function runSubscriptionHealthCheck(): Promise<void> {
  const tenants = await listActiveTenants();
  for (const tenant of tenants) {
    await checkTenantSubscriptionHealth(tenant);
  }
}

/** Schedules the periodic subscription health check. Call once at startup. */
export function scheduleSubscriptionHealthCheck(): void {
  const hours = Math.max(1, config.sync.subscriptionHealthCheckIntervalHours);
  const expression = `0 */${hours} * * *`;
  logger.info({ expression }, "Scheduling Dotloop subscription health check job");
  cron.schedule(expression, () => {
    runSubscriptionHealthCheck().catch((err) => logger.error({ err }, "Subscription health check run threw unexpectedly"));
  });
}
