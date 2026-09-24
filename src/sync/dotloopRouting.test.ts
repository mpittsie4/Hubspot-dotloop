import { describe, it, expect, vi, beforeEach } from "vitest";
import { TenantRow, TenantStatus, DotloopConnectionRow, DotloopConnectionStatus } from "../db/types";

vi.mock("../db/tenantRepo", () => ({
  getTenantByDotloopProfileId: vi.fn(),
  getTenantById: vi.fn(),
}));
vi.mock("../db/dotloopConnectionRepo", () => ({
  findConnectionByOwner: vi.fn(),
  findConnectionByProfileId: vi.fn(),
  hasAnyConnections: vi.fn(),
  listActiveConnectionsForTenant: vi.fn(),
}));

import {
  dotloopProfileSubscriptionExternalId,
  listDotloopSyncTargets,
  resolveDotloopTargetForDeal,
  resolveTenantAndAccountForProfile,
} from "./dotloopRouting";
import { getTenantByDotloopProfileId, getTenantById } from "../db/tenantRepo";
import {
  findConnectionByOwner,
  findConnectionByProfileId,
  hasAnyConnections,
  listActiveConnectionsForTenant,
} from "../db/dotloopConnectionRepo";

function tenant(overrides: Partial<TenantRow> = {}): TenantRow {
  return {
    id: "tenant_1",
    name: "Test",
    hubspotPortalId: "123",
    dotloopAccountId: "acct_tenant",
    dotloopProfileId: "profile_tenant",
    pipelinesConfig: [],
    contactRoleMapping: [],
    status: TenantStatus.ACTIVE,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function connection(overrides: Partial<DotloopConnectionRow> = {}): DotloopConnectionRow {
  return {
    id: "dlconn_1",
    tenantId: "tenant_1",
    hubspotOwnerId: "owner_1",
    dotloopAccountId: "acct_agent_1",
    dotloopProfileId: "profile_agent_1",
    status: DotloopConnectionStatus.ACTIVE,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("resolveDotloopTargetForDeal", () => {
  beforeEach(() => vi.clearAllMocks());

  it("single-account tenant: uses the tenant's own account/profile regardless of owner", async () => {
    vi.mocked(hasAnyConnections).mockResolvedValue(false);
    const result = await resolveDotloopTargetForDeal(tenant(), "any_owner");
    expect(result).toEqual({ ok: true, dotloopAccountId: "acct_tenant", dotloopProfileId: "profile_tenant", hubspotOwnerId: null });
    expect(findConnectionByOwner).not.toHaveBeenCalled();
  });

  it("single-account tenant with no Dotloop connection at all: not ok", async () => {
    vi.mocked(hasAnyConnections).mockResolvedValue(false);
    const result = await resolveDotloopTargetForDeal(tenant({ dotloopAccountId: null }), "owner_1");
    expect(result.ok).toBe(false);
  });

  it("brokerage mode: routes to the deal owner's own connection", async () => {
    vi.mocked(hasAnyConnections).mockResolvedValue(true);
    vi.mocked(findConnectionByOwner).mockResolvedValue(connection());
    const result = await resolveDotloopTargetForDeal(tenant(), "owner_1");
    expect(result).toEqual({ ok: true, dotloopAccountId: "acct_agent_1", dotloopProfileId: "profile_agent_1", hubspotOwnerId: "owner_1" });
    expect(findConnectionByOwner).toHaveBeenCalledWith("tenant_1", "owner_1");
  });

  it("brokerage mode: skips (not ok) when the deal has no owner", async () => {
    vi.mocked(hasAnyConnections).mockResolvedValue(true);
    const result = await resolveDotloopTargetForDeal(tenant(), null);
    expect(result.ok).toBe(false);
    expect(findConnectionByOwner).not.toHaveBeenCalled();
  });

  it("brokerage mode: skips (not ok) when the owner has no connection yet -- never falls back to the tenant's own account", async () => {
    vi.mocked(hasAnyConnections).mockResolvedValue(true);
    vi.mocked(findConnectionByOwner).mockResolvedValue(null);
    const result = await resolveDotloopTargetForDeal(tenant(), "owner_unconnected");
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("owner_unconnected") });
  });

  it("brokerage mode: skips a PENDING (not yet fully authorized) connection", async () => {
    vi.mocked(hasAnyConnections).mockResolvedValue(true);
    vi.mocked(findConnectionByOwner).mockResolvedValue(connection({ status: DotloopConnectionStatus.PENDING }));
    const result = await resolveDotloopTargetForDeal(tenant(), "owner_1");
    expect(result.ok).toBe(false);
  });
});

describe("listDotloopSyncTargets", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the tenant's own single connection when there are no agent connections", async () => {
    vi.mocked(listActiveConnectionsForTenant).mockResolvedValue([]);
    const targets = await listDotloopSyncTargets(tenant());
    expect(targets).toEqual([{ dotloopAccountId: "acct_tenant", dotloopProfileId: "profile_tenant" }]);
  });

  it("returns nothing for a tenant with neither its own account nor any connections", async () => {
    vi.mocked(listActiveConnectionsForTenant).mockResolvedValue([]);
    const targets = await listDotloopSyncTargets(tenant({ dotloopAccountId: null }));
    expect(targets).toEqual([]);
  });

  it("returns one target per active agent connection in brokerage mode, ignoring the tenant's own account", async () => {
    vi.mocked(listActiveConnectionsForTenant).mockResolvedValue([
      connection({ id: "dlconn_1", dotloopAccountId: "acct_a", dotloopProfileId: "profile_a" }),
      connection({ id: "dlconn_2", dotloopAccountId: "acct_b", dotloopProfileId: null }),
    ]);
    const targets = await listDotloopSyncTargets(tenant());
    expect(targets).toEqual([
      { dotloopAccountId: "acct_a", dotloopProfileId: "profile_a", connectionId: "dlconn_1" },
      { dotloopAccountId: "acct_b", dotloopProfileId: null, connectionId: "dlconn_2" },
    ]);
  });
});

describe("resolveTenantAndAccountForProfile", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves via the tenant-level profile id first", async () => {
    vi.mocked(getTenantByDotloopProfileId).mockResolvedValue(tenant());
    const result = await resolveTenantAndAccountForProfile("profile_tenant");
    expect(result).toEqual({ tenant: tenant(), dotloopAccountId: "acct_tenant" });
    expect(findConnectionByProfileId).not.toHaveBeenCalled();
  });

  it("falls back to an agent connection's profile id when no tenant matches", async () => {
    vi.mocked(getTenantByDotloopProfileId).mockResolvedValue(null);
    vi.mocked(findConnectionByProfileId).mockResolvedValue(connection());
    vi.mocked(getTenantById).mockResolvedValue(tenant());
    const result = await resolveTenantAndAccountForProfile("profile_agent_1");
    expect(result).toEqual({ tenant: tenant(), dotloopAccountId: "acct_agent_1" });
  });

  it("returns null for a completely unrecognized profile id", async () => {
    vi.mocked(getTenantByDotloopProfileId).mockResolvedValue(null);
    vi.mocked(findConnectionByProfileId).mockResolvedValue(null);
    const result = await resolveTenantAndAccountForProfile("profile_unknown");
    expect(result).toBeNull();
  });
});

describe("dotloopProfileSubscriptionExternalId", () => {
  it("is tenant-scoped for the tenant-wide connection", () => {
    expect(dotloopProfileSubscriptionExternalId("tenant_1")).toBe("hubspot-dotloop-connector:profile:tenant_1");
  });

  it("is scoped to the connection for a per-agent connection", () => {
    expect(dotloopProfileSubscriptionExternalId("tenant_1", "dlconn_1")).toBe(
      "hubspot-dotloop-connector:profile:tenant_1:agent:dlconn_1"
    );
  });
});
