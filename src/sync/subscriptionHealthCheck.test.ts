import { describe, it, expect, vi, beforeEach } from "vitest";
import { TenantRow, TenantStatus } from "../db/types";

vi.mock("../clients/dotloopClient", () => ({
  DotloopClient: { create: vi.fn() },
}));
vi.mock("../db/tenantRepo", () => ({
  listActiveTenants: vi.fn(),
}));
vi.mock("../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../config", () => ({
  config: { sync: { subscriptionHealthCheckIntervalHours: 24 } },
}));
// subscriptionHealthCheck.ts iterates whatever dotloopRouting.ts says this
// tenant's Dotloop targets are (its own single account, or one per
// connected agent in brokerage mode) -- mock that resolution directly
// rather than the db/dotloopConnectionRepo.ts it's built on, so these tests
// don't need a real Postgres pool.
vi.mock("./dotloopRouting", () => ({
  listDotloopSyncTargets: vi.fn(),
  dotloopProfileSubscriptionExternalId: (tenantId: string, connectionId?: string) =>
    connectionId ? `hubspot-dotloop-connector:profile:${tenantId}:agent:${connectionId}` : `hubspot-dotloop-connector:profile:${tenantId}`,
}));

import { checkTenantSubscriptionHealth } from "./subscriptionHealthCheck";
import { DotloopClient } from "../clients/dotloopClient";
import { listDotloopSyncTargets } from "./dotloopRouting";
import { logger } from "../utils/logger";

function tenant(overrides: Partial<TenantRow> = {}): TenantRow {
  return {
    id: "tenant_1",
    name: "Test Tenant",
    hubspotPortalId: "123",
    dotloopAccountId: "acct_1",
    dotloopProfileId: "profile_1",
    pipelinesConfig: [],
    contactRoleMapping: [],
    status: TenantStatus.ACTIVE,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const SINGLE_TARGET = [{ dotloopAccountId: "acct_1", dotloopProfileId: "profile_1" }];

describe("checkTenantSubscriptionHealth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does nothing for a tenant with no Dotloop targets at all (not connected, no agent connections either)", async () => {
    vi.mocked(listDotloopSyncTargets).mockResolvedValue([]);
    await checkTenantSubscriptionHealth(tenant({ dotloopAccountId: null }));
    expect(DotloopClient.create).not.toHaveBeenCalled();
  });

  it("logs an error when the expected subscription is missing entirely", async () => {
    vi.mocked(listDotloopSyncTargets).mockResolvedValue(SINGLE_TARGET);
    vi.mocked(DotloopClient.create).mockResolvedValue({
      listSubscriptions: vi.fn().mockResolvedValue([]),
    } as any);

    await checkTenantSubscriptionHealth(tenant());

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant_1" }),
      expect.stringContaining("is missing")
    );
  });

  it("logs an error when the expected subscription exists but is disabled", async () => {
    vi.mocked(listDotloopSyncTargets).mockResolvedValue(SINGLE_TARGET);
    vi.mocked(DotloopClient.create).mockResolvedValue({
      listSubscriptions: vi.fn().mockResolvedValue([
        {
          id: "sub_1",
          externalId: "hubspot-dotloop-connector:profile:tenant_1",
          enabled: false,
          targetType: "PROFILE",
          targetId: 1,
          url: "https://connect.theatlashub.io/webhooks/dotloop",
          eventTypes: ["LOOP_UPDATED"],
        },
      ]),
    } as any);

    await checkTenantSubscriptionHealth(tenant());

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant_1", subscriptionId: "sub_1" }),
      expect.stringContaining("DISABLED")
    );
  });

  it("logs info (no error) when the expected subscription is present and enabled", async () => {
    vi.mocked(listDotloopSyncTargets).mockResolvedValue(SINGLE_TARGET);
    vi.mocked(DotloopClient.create).mockResolvedValue({
      listSubscriptions: vi.fn().mockResolvedValue([
        {
          id: "sub_1",
          externalId: "hubspot-dotloop-connector:profile:tenant_1",
          enabled: true,
          targetType: "PROFILE",
          targetId: 1,
          url: "https://connect.theatlashub.io/webhooks/dotloop",
          eventTypes: ["LOOP_UPDATED"],
        },
      ]),
    } as any);

    await checkTenantSubscriptionHealth(tenant());

    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "tenant_1" }), expect.stringContaining("OK"));
  });

  it("does not throw if the Dotloop call itself fails, and logs an error instead", async () => {
    vi.mocked(listDotloopSyncTargets).mockResolvedValue(SINGLE_TARGET);
    vi.mocked(DotloopClient.create).mockRejectedValue(new Error("network blip"));

    await expect(checkTenantSubscriptionHealth(tenant())).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });

  it("checks each connected agent's subscription independently in brokerage mode", async () => {
    vi.mocked(listDotloopSyncTargets).mockResolvedValue([
      { dotloopAccountId: "agent_acct_1", dotloopProfileId: "agent_profile_1", connectionId: "dlconn_1" },
      { dotloopAccountId: "agent_acct_2", dotloopProfileId: "agent_profile_2", connectionId: "dlconn_2" },
    ]);
    vi.mocked(DotloopClient.create).mockImplementation(async (accountId?: string) => {
      // agent_acct_1's subscription is healthy; agent_acct_2's is missing.
      const subs =
        accountId === "agent_acct_1"
          ? [
              {
                id: "sub_agent_1",
                externalId: "hubspot-dotloop-connector:profile:tenant_1:agent:dlconn_1",
                enabled: true,
                targetType: "PROFILE",
                targetId: 1,
                url: "https://connect.theatlashub.io/webhooks/dotloop",
                eventTypes: ["LOOP_UPDATED"],
              },
            ]
          : [];
      return { listSubscriptions: vi.fn().mockResolvedValue(subs) } as any;
    });

    await checkTenantSubscriptionHealth(tenant());

    expect(DotloopClient.create).toHaveBeenCalledWith("agent_acct_1");
    expect(DotloopClient.create).toHaveBeenCalledWith("agent_acct_2");
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ connectionId: "dlconn_1" }), expect.stringContaining("OK"));
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ connectionId: "dlconn_2" }), expect.stringContaining("is missing"));
  });
});
