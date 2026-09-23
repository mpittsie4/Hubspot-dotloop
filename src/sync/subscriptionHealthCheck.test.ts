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

import { checkTenantSubscriptionHealth } from "./subscriptionHealthCheck";
import { DotloopClient } from "../clients/dotloopClient";
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

describe("checkTenantSubscriptionHealth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips tenants with no connected Dotloop account", async () => {
    await checkTenantSubscriptionHealth(tenant({ dotloopAccountId: null }));
    expect(DotloopClient.create).not.toHaveBeenCalled();
  });

  it("logs an error when the expected subscription is missing entirely", async () => {
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
    vi.mocked(DotloopClient.create).mockRejectedValue(new Error("network blip"));

    await expect(checkTenantSubscriptionHealth(tenant())).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });
});
