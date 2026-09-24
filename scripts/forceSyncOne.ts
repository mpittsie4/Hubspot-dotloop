/**
 * One-off: forces an immediate sync of ONE specific HubSpot deal or Dotloop
 * loop, bypassing the reconciliation poller's lookback window entirely.
 *
 * Why this exists: reconcile.ts advances a tenant's lastHubspotPollAt /
 * lastDotloopPollAt timestamps unconditionally at the end of every pass,
 * even a pass where the actual sync calls inside it failed (see
 * sync/reconcile.ts's reconcileTenant()) -- so an object created during a
 * run of failed passes (like the ones caused by the Dotloop token-expiry
 * bug fixed alongside this script) can end up permanently outside the
 * poller's future lookback windows, even after the underlying bug is
 * fixed. This calls the exact same sync functions the webhooks and
 * reconciliation poller use, directly, for one specific object, so there's
 * no dependency on timing or on Dotloop's webhook subscription being
 * registered/healthy.
 *
 * Usage:
 *   npx tsx scripts/forceSyncOne.ts --tenantId=tenant_default --hubspotDealId=<id>
 *   npx tsx scripts/forceSyncOne.ts --tenantId=tenant_default --dotloopLoopId=<id>
 */
import "dotenv/config";
import { getTenantById } from "../src/db/tenantRepo";
import { syncDealFromHubSpot, syncLoopFromDotloop } from "../src/sync/dealLoopSync";
import { DotloopClient } from "../src/clients/dotloopClient";

function arg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : undefined;
}

async function main() {
  const tenantId = arg("tenantId") ?? "tenant_default";
  const hubspotDealId = arg("hubspotDealId");
  const dotloopLoopId = arg("dotloopLoopId");

  if (!hubspotDealId && !dotloopLoopId) {
    throw new Error("Pass exactly one of --hubspotDealId=<id> or --dotloopLoopId=<id>.");
  }
  if (hubspotDealId && dotloopLoopId) {
    throw new Error("Pass only one of --hubspotDealId or --dotloopLoopId, not both.");
  }

  const tenant = await getTenantById(tenantId);
  if (!tenant) throw new Error(`Unknown tenantId "${tenantId}".`);

  if (hubspotDealId) {
    console.log(`Syncing HubSpot deal ${hubspotDealId} -> Dotloop for tenant ${tenantId}...`);
    await syncDealFromHubSpot(tenant, hubspotDealId);
    console.log("Done. Check the deal's dotloop_* properties and its Deal Sync Status card.");
  } else {
    if (!tenant.dotloopAccountId) throw new Error(`Tenant "${tenantId}" has no connected Dotloop account.`);
    let profileId = tenant.dotloopProfileId;
    if (!profileId) {
      const dotloop = await DotloopClient.create(tenant.dotloopAccountId);
      profileId = await dotloop.resolveProfileId();
    }
    console.log(`Syncing Dotloop loop ${dotloopLoopId} (profile ${profileId}) -> HubSpot for tenant ${tenantId}...`);
    await syncLoopFromDotloop(tenant, tenant.dotloopAccountId, profileId, dotloopLoopId!);
    console.log("Done. Check HubSpot for the new/updated deal.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
