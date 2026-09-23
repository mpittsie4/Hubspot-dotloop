/**
 * One-off: sets a tenant's contact_role_mapping (see db/types.ts's
 * ContactRoleMapping) from a JSON array, the same pattern used for
 * pipelines_config. Run this after scripts/listAssociationLabels.ts has
 * printed the tenant's real typeId/category values.
 *
 * Usage:
 *   npm run set:contact-role-mapping -- --tenantId=<tenant_...> --mapping='[
 *     {"hubspotAssociationTypeId":123,"hubspotAssociationCategory":"USER_DEFINED","hubspotLabel":"Buyer","dotloopRole":"BUYER"},
 *     {"hubspotAssociationTypeId":124,"hubspotAssociationCategory":"USER_DEFINED","hubspotLabel":"Seller","dotloopRole":"SELLER"}
 *   ]'
 *
 * This REPLACES the tenant's entire contact_role_mapping array -- pass the
 * full set every time, not just what's changing.
 */
import "dotenv/config";
import { ContactRoleMapping } from "../src/db/types";
import { getTenantById, updateContactRoleMapping } from "../src/db/tenantRepo";

function parseArg(name: string): string {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!arg) throw new Error(`Missing --${name}=...`);
  return arg.slice(`--${name}=`.length);
}

async function main() {
  const tenantId = parseArg("tenantId");
  const mappingJson = parseArg("mapping");

  const tenant = await getTenantById(tenantId);
  if (!tenant) throw new Error(`Unknown tenantId "${tenantId}".`);

  let mapping: ContactRoleMapping[];
  try {
    mapping = JSON.parse(mappingJson);
  } catch (err) {
    throw new Error(`--mapping wasn't valid JSON: ${err}`);
  }
  if (!Array.isArray(mapping)) throw new Error("--mapping must be a JSON array.");
  for (const m of mapping) {
    if (typeof m.hubspotAssociationTypeId !== "number" || !m.hubspotAssociationCategory || !m.dotloopRole) {
      throw new Error(`Each mapping entry needs hubspotAssociationTypeId (number), hubspotAssociationCategory, and dotloopRole. Got: ${JSON.stringify(m)}`);
    }
  }

  const updated = await updateContactRoleMapping(tenantId, mapping);
  // eslint-disable-next-line no-console
  console.log(`Set contact_role_mapping for tenant ${tenantId} (${updated.contactRoleMapping.length} entries):`);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(updated.contactRoleMapping, null, 2));
  // eslint-disable-next-line no-console
  console.log(
    "\nNext: run `npm run seed:existing-participant-associations -- --tenantId=" +
      tenantId +
      "` ONCE before deploying, so this never backfills already-existing associations onto already-created loops."
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("Failed to set contact role mapping:", err);
    process.exit(1);
  });
