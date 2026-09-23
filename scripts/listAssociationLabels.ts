/**
 * One-off diagnostic: prints every Deal<->Contact and Deal<->Company
 * association label this tenant's HubSpot portal has defined, with each
 * label's real typeId/category -- needed to populate that tenant's
 * contact_role_mapping (see db/types.ts's ContactRoleMapping and
 * db/tenantRepo.ts's updateContactRoleMapping()), since association label
 * typeIds are custom per HubSpot portal, unlike Dotloop's fixed loop-status
 * vocabulary.
 *
 * Usage:
 *   npm run list:association-labels -- --tenantId=<tenant_...>
 */
import "dotenv/config";
import { HubSpotClient } from "../src/clients/hubspotClient";
import { getTenantById } from "../src/db/tenantRepo";

function parseTenantIdArg(): string {
  const arg = process.argv.find((a) => a.startsWith("--tenantId="));
  if (!arg) {
    throw new Error("Missing --tenantId=<tenant_...>. Look it up via the tenants table.");
  }
  return arg.slice("--tenantId=".length);
}

async function main() {
  const tenantId = parseTenantIdArg();
  const tenant = await getTenantById(tenantId);
  if (!tenant) {
    throw new Error(`Unknown tenantId "${tenantId}".`);
  }
  if (!tenant.hubspotPortalId) {
    throw new Error(`Tenant "${tenantId}" has no connected HubSpot portal yet.`);
  }

  const hubspot = await HubSpotClient.create(tenant.hubspotPortalId);

  // eslint-disable-next-line no-console
  console.log(`\nDeal -> Contact association labels (portal ${tenant.hubspotPortalId}):`);
  const contactLabels = await hubspot.listAssociationLabels("deals", "contacts");
  for (const l of contactLabels) {
    // eslint-disable-next-line no-console
    console.log(`  typeId=${l.typeId}\tcategory=${l.category}\tlabel=${l.label ?? "(unlabeled/default)"}`);
  }

  // eslint-disable-next-line no-console
  console.log(`\nDeal -> Company association labels (portal ${tenant.hubspotPortalId}):`);
  const companyLabels = await hubspot.listAssociationLabels("deals", "companies");
  for (const l of companyLabels) {
    // eslint-disable-next-line no-console
    console.log(`  typeId=${l.typeId}\tcategory=${l.category}\tlabel=${l.label ?? "(unlabeled/default)"}`);
  }

  // eslint-disable-next-line no-console
  console.log(
    "\nUse the Deal -> Contact typeId/category values above to build this tenant's contactRoleMapping " +
      "(db/types.ts's ContactRoleMapping[]), then set it with tenantRepo.updateContactRoleMapping(tenantId, mapping)."
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("Failed to list association labels:", err);
    process.exit(1);
  });
