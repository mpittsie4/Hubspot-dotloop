import { describe, it, expect, vi, beforeEach } from "vitest";
import { TenantRow, TenantStatus } from "../db/types";
import { HubSpotClient, HubSpotOwner } from "../clients/hubspotClient";

vi.mock("../db/dotloopConnectionRepo", () => ({
  findConnectionByOwner: vi.fn(),
  hasAnyConnections: vi.fn(),
}));
vi.mock("../config", () => ({
  config: { publicBaseUrl: "https://connect.theatlashub.io" },
}));
vi.mock("../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { resolveDealDotloopConnectionForViewer } from "./hubspotProxyRoutes";
import { findConnectionByOwner, hasAnyConnections } from "../db/dotloopConnectionRepo";

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

function fakeClient(owner: HubSpotOwner | null): HubSpotClient {
  return { getOwner: vi.fn().mockResolvedValue(owner) } as unknown as HubSpotClient;
}

describe("resolveDealDotloopConnectionForViewer", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns null for a single-account tenant (not in brokerage mode)", async () => {
    vi.mocked(hasAnyConnections).mockResolvedValue(false);
    const result = await resolveDealDotloopConnectionForViewer(tenant(), fakeClient(null), "owner_1", "a@b.com");
    expect(result).toBeNull();
    expect(findConnectionByOwner).not.toHaveBeenCalled();
  });

  it("returns null for a deal with no owner", async () => {
    const result = await resolveDealDotloopConnectionForViewer(tenant(), fakeClient(null), undefined, "a@b.com");
    expect(result).toBeNull();
    expect(hasAnyConnections).not.toHaveBeenCalled();
  });

  it("returns null once the owner's connection is ACTIVE -- nothing left to prompt", async () => {
    vi.mocked(hasAnyConnections).mockResolvedValue(true);
    vi.mocked(findConnectionByOwner).mockResolvedValue({
      id: "c1",
      tenantId: "tenant_1",
      hubspotOwnerId: "owner_1",
      dotloopAccountId: "acct_a",
      dotloopProfileId: "profile_a",
      status: "ACTIVE",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const result = await resolveDealDotloopConnectionForViewer(tenant(), fakeClient(null), "owner_1", "a@b.com");
    expect(result).toBeNull();
  });

  it("only includes a connectUrl when the viewer's email matches the owner's own email", async () => {
    vi.mocked(hasAnyConnections).mockResolvedValue(true);
    vi.mocked(findConnectionByOwner).mockResolvedValue(null);
    const client = fakeClient({ id: "owner_1", email: "Agent@Example.com", firstName: "Amy", lastName: "Agent" });

    const asOwner = await resolveDealDotloopConnectionForViewer(tenant(), client, "owner_1", "agent@example.com");
    expect(asOwner).toEqual({
      status: "NOT_CONNECTED",
      ownerLabel: "Amy Agent",
      isViewerTheOwner: true,
      connectUrl: "https://connect.theatlashub.io/auth/dotloop/start?tenantId=tenant_1&hubspotOwnerId=owner_1",
    });

    const asTeammate = await resolveDealDotloopConnectionForViewer(tenant(), client, "owner_1", "someone-else@example.com");
    expect(asTeammate).toEqual({
      status: "NOT_CONNECTED",
      ownerLabel: "Amy Agent",
      isViewerTheOwner: false,
      connectUrl: null,
    });
  });

  it("reports PENDING (not NOT_CONNECTED) once the owner has started but not finished connecting", async () => {
    vi.mocked(hasAnyConnections).mockResolvedValue(true);
    vi.mocked(findConnectionByOwner).mockResolvedValue({
      id: "c1",
      tenantId: "tenant_1",
      hubspotOwnerId: "owner_1",
      dotloopAccountId: null,
      dotloopProfileId: null,
      status: "PENDING",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const client = fakeClient({ id: "owner_1", email: "agent@example.com" });
    const result = await resolveDealDotloopConnectionForViewer(tenant(), client, "owner_1", "agent@example.com");
    expect(result?.status).toBe("PENDING");
    expect(result?.connectUrl).not.toBeNull();
  });

  it("never exposes a connectUrl if the owner lookup fails -- degrades to informational-only", async () => {
    vi.mocked(hasAnyConnections).mockResolvedValue(true);
    vi.mocked(findConnectionByOwner).mockResolvedValue(null);
    const client = { getOwner: vi.fn().mockRejectedValue(new Error("boom")) } as unknown as HubSpotClient;
    const result = await resolveDealDotloopConnectionForViewer(tenant(), client, "owner_1", "agent@example.com");
    expect(result?.isViewerTheOwner).toBe(false);
    expect(result?.connectUrl).toBeNull();
    expect(result?.ownerLabel).toBe("owner_1");
  });
});
