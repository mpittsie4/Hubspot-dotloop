/**
 * One-off, read-only diagnostic for the "tenant_default's Dotloop access
 * token appears expired" issue first flagged in this deploy's boot logs
 * (2026-09-24) and confirmed 2026-09-24 (later the same day) to be actively
 * breaking real sync: a brand-new HubSpot deal never creates a Dotloop
 * loop, and a brand-new Dotloop loop never gets picked up by reconciliation
 * -- both paths call DotloopClient.create(), which is supposed to
 * transparently refresh a token within 5 minutes of expiry, but every real
 * Dotloop API call has still been getting a live 401
 * "invalid_token: Access token expired" from Dotloop itself.
 *
 * If DotloopClient.create()'s refresh logic were working, that 401 should
 * never reach a resource call -- so either (a) the stored `expires_at` is
 * wrong (making the client think a dead token still has time left), or
 * (b) the refresh call itself is failing/being skipped somehow. This
 * script inspects the stored token row directly and then exercises the
 * exact same create()-time refresh logic DotloopClient uses, so we see
 * precisely which of those it is -- without ever printing a usable secret.
 *
 * Usage:
 *   npx tsx scripts/diagnoseDotloopToken.ts --tenantId=tenant_default
 */
import "dotenv/config";
import { getTenantById } from "../src/db/tenantRepo";
import { getToken } from "../src/auth/tokenStore";
import { refreshDotloopToken } from "../src/auth/dotloopOAuth";
import { Provider } from "../src/db/types";
import { DotloopClient } from "../src/clients/dotloopClient";

function parseTenantIdArg(): string {
  const arg = process.argv.find((a) => a.startsWith("--tenantId="));
  return arg ? arg.slice("--tenantId=".length) : "tenant_default";
}

function mask(secret: string): string {
  if (!secret) return "(empty)";
  return `${secret.slice(0, 6)}...${secret.slice(-4)} (len ${secret.length})`;
}

async function main() {
  const tenantId = parseTenantIdArg();
  const tenant = await getTenantById(tenantId);
  if (!tenant) throw new Error(`Unknown tenantId "${tenantId}".`);
  if (!tenant.dotloopAccountId) throw new Error(`Tenant "${tenantId}" has no connected Dotloop account.`);

  console.log(`\n=== Tenant ${tenantId} — Dotloop account ${tenant.dotloopAccountId} ===\n`);

  const stored = await getToken(Provider.DOTLOOP, tenant.dotloopAccountId);
  if (!stored) throw new Error(`No oauth_tokens row for DOTLOOP / ${tenant.dotloopAccountId}.`);

  const now = new Date();
  const expiresAt = stored.expiresAt;
  const msUntilExpiry = expiresAt.getTime() - now.getTime();

  console.log("--- Stored token row ---");
  console.log(`  access_token:  ${mask(stored.accessToken)}`);
  console.log(`  refresh_token: ${mask(stored.refreshToken)}`);
  console.log(`  expires_at:    ${expiresAt.toISOString()}  (valid Date: ${!Number.isNaN(expiresAt.getTime())})`);
  console.log(`  now:           ${now.toISOString()}`);
  console.log(`  ms until expiry: ${msUntilExpiry}  (${(msUntilExpiry / 60000).toFixed(1)} minutes)`);
  console.log(`  updated_at:    ${stored.updatedAt?.toISOString?.() ?? stored.updatedAt}`);
  console.log(`  DotloopClient.create()'s needsRefresh would evaluate to: ${msUntilExpiry < 5 * 60 * 1000}`);

  console.log("\n--- Exercising the actual refresh call (same as DotloopClient.create()) ---");
  try {
    const refreshed = await refreshDotloopToken(stored.refreshToken);
    console.log("  refreshDotloopToken() SUCCEEDED:");
    console.log(`    new access_token:  ${mask(refreshed.access_token)}`);
    console.log(`    new refresh_token: ${mask(refreshed.refresh_token)}`);
    console.log(`    expires_in:        ${refreshed.expires_in}  (type: ${typeof refreshed.expires_in})`);
    const newExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000);
    console.log(`    computed new expires_at: ${newExpiresAt.toISOString()}  (valid Date: ${!Number.isNaN(newExpiresAt.getTime())})`);
    console.log(
      "\n  NOTE: this script does NOT persist this refreshed token (read-only diagnostic) -- " +
        "the next real DotloopClient.create() call will do its own refresh-and-save if it still thinks it needs to."
    );
  } catch (err: any) {
    console.log("  refreshDotloopToken() FAILED:");
    console.log(`    status: ${err?.response?.status}`);
    console.log(`    data:   ${JSON.stringify(err?.response?.data)}`);
    console.log(`    message: ${err?.message}`);
  }

  console.log("\n--- Exercising DotloopClient.create() + a real read-only call (GET /account) ---");
  try {
    const dotloop = await DotloopClient.create(tenant.dotloopAccountId);
    const account = await (dotloop as any).http.get("/account");
    console.log(`  SUCCESS -- account id ${account.data?.data?.id ?? account.data?.id}, status ${account.status}`);
  } catch (err: any) {
    console.log("  FAILED:");
    console.log(`    status: ${err?.response?.status}`);
    console.log(`    data:   ${JSON.stringify(err?.response?.data)}`);
    console.log(`    message: ${err?.message}`);
  }

  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
