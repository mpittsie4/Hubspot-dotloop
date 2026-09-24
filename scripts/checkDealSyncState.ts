/**
 * Read-only diagnostic: dumps the current object_mappings row (if any) and
 * the most recent sync_logs rows for one specific HubSpot deal ID, plus the
 * deal's own dotloop_* properties straight from HubSpot. Written to
 * investigate why a specific new test deal ("Testing after resync",
 * HubSpot deal id 65211286183) wasn't showing as synced on its Deal Sync
 * Status card even after the Dotloop reactive-token-refresh fix was
 * deployed and verified working for other calls.
 *
 * Usage:
 *   npx tsx scripts/checkDealSyncState.ts --tenantId=tenant_default --hubspotDealId=65211286183
 */
import "dotenv/config";
import { pool } from "../src/db/client";
import { getTenantById } from "../src/db/tenantRepo";
import { findMappingByHubspotId } from "../src/db/mappingRepo";
import { EntityType } from "../src/db/types";
import { HubSpotClient } from "../src/clients/hubspotClient";

function arg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : undefined;
}

async function main() {
  const tenantId = arg("tenantId") ?? "tenant_default";
  const hubspotDealId = arg("hubspotDealId");
  if (!hubspotDealId) throw new Error("Pass --hubspotDealId=<id>");

  const tenant = await getTenantById(tenantId);
  if (!tenant) throw new Error(`Unknown tenantId "${tenantId}".`);

  console.log("=== Tenant ===");
  console.log({
    id: tenant.id,
    hubspotPortalId: tenant.hubspotPortalId,
    dotloopAccountId: tenant.dotloopAccountId,
    dotloopProfileId: tenant.dotloopProfileId,
    pipelinesConfig: tenant.pipelinesConfig,
  });

  console.log("\n=== object_mappings row for this deal (DEAL_LOOP) ===");
  const mapping = await findMappingByHubspotId(tenantId, EntityType.DEAL_LOOP, hubspotDealId);
  console.log(mapping ?? "(none found -- no mapping exists for this hubspotDealId)");

  console.log("\n=== Recent sync_logs mentioning this deal id (source_id or target_id) ===");
  const logs = await pool.query(
    `SELECT id, tenant_id, entity_type, direction, source_id, target_id, status, message, created_at
     FROM sync_logs
     WHERE source_id = $1 OR target_id = $1
     ORDER BY created_at DESC
     LIMIT 20`,
    [hubspotDealId]
  );
  console.log(logs.rows.length ? logs.rows : "(no sync_logs rows reference this id at all)");

  console.log("\n=== Most recent 15 sync_logs for this tenant overall (any entity) ===");
  const recent = await pool.query(
    `SELECT id, entity_type, direction, source_id, target_id, status, message, created_at
     FROM sync_logs
     WHERE tenant_id = $1
     ORDER BY created_at DESC
     LIMIT 15`,
    [tenantId]
  );
  console.log(recent.rows);

  console.log("\n=== Live HubSpot deal properties (pipeline/dealstage/dotloop_*) ===");
  if (tenant.hubspotPortalId) {
    const hubspot = await HubSpotClient.create(tenant.hubspotPortalId);
    const deal = await hubspot.getDeal(hubspotDealId, [
      "dealname",
      "pipeline",
      "dealstage",
      "hubspot_owner_id",
      "dotloop_loop_id",
    ]);
    console.log(deal ? deal.properties : "(HubSpot returned no deal for this id)");
  } else {
    console.log("(tenant has no hubspotPortalId -- skipping)");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => pool.end());
