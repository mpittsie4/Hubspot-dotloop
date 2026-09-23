/**
 * Run ONCE per tenant, immediately after that tenant's contact_role_mapping
 * is populated (scripts/listAssociationLabels.ts + setContactRoleMapping.ts)
 * and BEFORE deploying the code that starts actively syncing participants.
 *
 * Marks every already-existing deal<->contact association that matches the
 * tenant's role mapping (on deals this connector has already synced to a
 * loop) as SKIPPED_PRE_EXISTING in loop_participants -- purely bookkeeping,
 * makes ZERO Dotloop API calls. This is what makes the live sync path
 * (sync/participantSync.ts) never backfill them onto their already-created
 * loops. Per Mason's explicit decision (2026-09-23): "New associations
 * only" -- only an association created AFTER this script runs will ever
 * get pushed to Dotloop as a real participant.
 *
 * Safe to re-run: already-seeded pairs are skipped.
 *
 * Usage:
 *   npm run seed:existing-participant-associations -- --tenantId=<tenant_...>
 */
import "dotenv/config";
import { HubSpotClient } from "../src/clients/hubspotClient";
import { getTenantById } from "../src/db/tenantRepo";
import { seedSkippedParticipantMappings } from "../src/db/participantMappingRepo";
import { EntityType } from "../src/db/types";
import { pool } from "../src/db/client";

function parseTenantIdArg(): string {
  const arg = process.argv.find((a) => a.startsWith("--tenantId="));
  if (!arg) throw new Error("Missing --tenantId=<tenant_...>.");
  return arg.slice("--tenantId=".length);
}

/** Deals this connector already has a DEAL_LOOP mapping for -- a deal with
 *  no loop yet has nothing to "backfill onto" and gets its participants
 *  synced fresh the normal way the first time it syncs. Script-local
 *  (rather than added to mappingRepo.ts) since nothing in the live sync
 *  path needs "every mapped deal for a tenant" as a bulk operation. */
async function listMappedDealIds(tenantId: string): Promise<string[]> {
  const res = await pool.query(`SELECT hubspot_id FROM object_mappings WHERE tenant_id = $1 AND entity_type = $2`, [
    tenantId,
    EntityType.DEAL_LOOP,
  ]);
  return res.rows.map((r: any) => r.hubspot_id as string);
}

async function main() {
  const tenantId = parseTenantIdArg();
  const tenant = await getTenantById(tenantId);
  if (!tenant) throw new Error(`Unknown tenantId "${tenantId}".`);
  if (!tenant.hubspotPortalId) throw new Error(`Tenant "${tenantId}" has no connected HubSpot portal yet.`);
  if (tenant.contactRoleMapping.length === 0) {
    throw new Error(
      `Tenant "${tenantId}" has no contact_role_mapping configured yet -- run listAssociationLabels + setContactRoleMapping first.`
    );
  }

  const hubspot = await HubSpotClient.create(tenant.hubspotPortalId);
  const dealIds = await listMappedDealIds(tenantId);
  // eslint-disable-next-line no-console
  console.log(`Found ${dealIds.length} already-synced deals for tenant ${tenantId}.`);

  const toSeed: Array<{ tenantId: string; hubspotDealId: string; hubspotContactId: string; dotloopRole: string }> = [];
  for (const dealId of dealIds) {
    let associations;
    try {
      associations = await hubspot.listAssociationsV4("deals", dealId, "contacts");
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`Failed to read associations for deal ${dealId}, skipping it:`, err);
      continue;
    }
    for (const association of associations) {
      for (const roleMapping of tenant.contactRoleMapping) {
        const matches = association.associationTypes.some(
          (t) => t.typeId === roleMapping.hubspotAssociationTypeId && t.category === roleMapping.hubspotAssociationCategory
        );
        if (matches) {
          toSeed.push({
            tenantId,
            hubspotDealId: dealId,
            hubspotContactId: association.toObjectId,
            dotloopRole: roleMapping.dotloopRole,
          });
        }
      }
    }
  }

  const inserted = await seedSkippedParticipantMappings(toSeed);
  // eslint-disable-next-line no-console
  console.log(
    `Seeded ${inserted} pre-existing association(s) as SKIPPED_PRE_EXISTING ` +
      `(${toSeed.length - inserted} were already seeded on a previous run). ` +
      `Only associations created after this point will sync to Dotloop.`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("Failed to seed existing participant associations:", err);
    process.exit(1);
  });
