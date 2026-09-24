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

import { resolveDealDotloopConnectionForViewer, validatePipelineConfig } from "./hubspotProxyRoutes";
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

describe("validatePipelineConfig", () => {
  function validPipeline(overrides: Record<string, unknown> = {}) {
    return {
      key: "buyer-pipeline",
      pipelineId: "default",
      transactionType: "PURCHASE_OFFER",
      stages: [{ id: "stage_1", label: "Engaging", status: "Pre-Offer" }],
      ...overrides,
    };
  }

  it("accepts a well-formed pipeline mapping and passes stage fields through unchanged", () => {
    const result = validatePipelineConfig([validPipeline()]);
    expect(result).toEqual([
      {
        key: "buyer-pipeline",
        pipelineId: "default",
        transactionType: "PURCHASE_OFFER",
        stages: [{ id: "stage_1", label: "Engaging", status: "Pre-Offer" }],
      },
    ]);
  });

  it("accepts multiple pipelines with different transaction types", () => {
    const result = validatePipelineConfig([
      validPipeline(),
      validPipeline({ key: "listing-pipeline", pipelineId: "p2", transactionType: "LISTING_FOR_SALE" }),
    ]);
    expect(result).toHaveLength(2);
  });

  it("rejects a non-array body", () => {
    expect(() => validatePipelineConfig({ not: "an array" })).toThrow(/expected pipelines to be an array/i);
    expect(() => validatePipelineConfig(null)).toThrow();
    expect(() => validatePipelineConfig("nope")).toThrow();
  });

  it("rejects an empty array -- saving nothing isn't a valid mapping", () => {
    expect(() => validatePipelineConfig([])).toThrow(/at least one pipeline/i);
  });

  it("rejects a pipeline missing a key or pipelineId", () => {
    expect(() => validatePipelineConfig([validPipeline({ key: "" })])).toThrow(/missing a "key"/i);
    expect(() => validatePipelineConfig([validPipeline({ pipelineId: undefined })])).toThrow(/missing a "pipelineId"/i);
  });

  it("rejects a transactionType outside Dotloop's real enum -- e.g. a typo or a tampered request", () => {
    expect(() => validatePipelineConfig([validPipeline({ transactionType: "NOT_A_REAL_TYPE" })])).toThrow(
      /invalid transactionType/i
    );
    expect(() => validatePipelineConfig([validPipeline({ transactionType: undefined })])).toThrow(
      /invalid transactionType/i
    );
  });

  it("rejects a pipeline with no mapped stages", () => {
    expect(() => validatePipelineConfig([validPipeline({ stages: [] })])).toThrow(/at least one mapped stage/i);
    expect(() => validatePipelineConfig([validPipeline({ stages: undefined })])).toThrow(/at least one mapped stage/i);
  });

  it("rejects a stage missing an id, label, or status", () => {
    expect(() =>
      validatePipelineConfig([validPipeline({ stages: [{ label: "Engaging", status: "Pre-Offer" }] })])
    ).toThrow(/missing an "id"/i);
    expect(() =>
      validatePipelineConfig([validPipeline({ stages: [{ id: "s1", status: "Pre-Offer" }] })])
    ).toThrow(/missing a "label"/i);
    expect(() =>
      validatePipelineConfig([validPipeline({ stages: [{ id: "s1", label: "Engaging" }] })])
    ).toThrow(/missing a "status"/i);
  });

  it("accepts REAL_ESTATE_OTHER, the catch-all transaction type", () => {
    expect(() => validatePipelineConfig([validPipeline({ transactionType: "REAL_ESTATE_OTHER" })])).not.toThrow();
  });
});
