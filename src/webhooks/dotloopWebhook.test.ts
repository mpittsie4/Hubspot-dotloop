import { describe, it, expect, vi, beforeEach } from "vitest";
import { EntityType, ObjectMappingRow, TenantRow } from "../db/types";

// dotloopWebhook.ts pulls in express Router() at module load time, config,
// and the real db pool via mappingRepo/tenantRepo -- mock everything it
// touches so this test only exercises handleLoopMerged's own branching
// logic, with no real network/db/env dependency.
vi.mock("../db/mappingRepo", () => ({
  findMappingByDotloopId: vi.fn(),
  repointMappingDotloopId: vi.fn(),
}));
vi.mock("../sync/syncEngine", () => ({
  queueLoopFromDotloop: vi.fn(),
  queueContactFromDotloop: vi.fn(),
}));
vi.mock("../db/tenantRepo", () => ({
  getTenantByDotloopProfileId: vi.fn(),
}));
vi.mock("../utils/crypto", () => ({
  verifyDotloopSignature: vi.fn(),
}));
vi.mock("../config", () => ({
  config: { dotloop: { webhookSigningSecret: "test" } },
}));
vi.mock("../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { handleLoopMerged } from "./dotloopWebhook";
import { findMappingByDotloopId, repointMappingDotloopId } from "../db/mappingRepo";
import { queueLoopFromDotloop } from "../sync/syncEngine";

const tenant = { id: "tenant_1" } as TenantRow;

function mapping(overrides: Partial<ObjectMappingRow>): ObjectMappingRow {
  return {
    id: "mapping_1",
    tenantId: "tenant_1",
    entityType: EntityType.DEAL_LOOP,
    hubspotId: "deal_1",
    dotloopId: "loop_old",
    dotloopProfileId: "profile_1",
    lastSyncedHash: "hash",
    lastSyncedAt: new Date(),
    lastSyncOrigin: "DOTLOOP" as any,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("handleLoopMerged", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("repoints the existing mapping to the surviving loop id when only the old loop was mapped", async () => {
    const oldMapping = mapping({ id: "mapping_old", dotloopId: "loop_from", hubspotId: "deal_1" });
    vi.mocked(findMappingByDotloopId).mockImplementation(async (_tenantId, _entityType, dotloopId) =>
      dotloopId === "loop_from" ? oldMapping : null
    );

    await handleLoopMerged(tenant, "acct_1", "profile_1", "loop_from", "loop_to");

    expect(repointMappingDotloopId).toHaveBeenCalledWith("mapping_old", "loop_to");
    expect(queueLoopFromDotloop).toHaveBeenCalledWith(tenant, "acct_1", "profile_1", "loop_to");
  });

  it("does not repoint, and does not throw, when both loops already have their own separate deals", async () => {
    const oldMapping = mapping({ id: "mapping_old", dotloopId: "loop_from", hubspotId: "deal_losing" });
    const newSideMapping = mapping({ id: "mapping_new", dotloopId: "loop_to", hubspotId: "deal_surviving" });
    vi.mocked(findMappingByDotloopId).mockImplementation(async (_tenantId, _entityType, dotloopId) => {
      if (dotloopId === "loop_from") return oldMapping;
      if (dotloopId === "loop_to") return newSideMapping;
      return null;
    });

    await handleLoopMerged(tenant, "acct_1", "profile_1", "loop_from", "loop_to");

    expect(repointMappingDotloopId).not.toHaveBeenCalled();
    // Still syncs the surviving loop against its own already-correct mapping.
    expect(queueLoopFromDotloop).toHaveBeenCalledWith(tenant, "acct_1", "profile_1", "loop_to");
  });

  it("is a no-op repoint when the old loop id was never mapped to a deal (brand new loop merged away before it synced)", async () => {
    vi.mocked(findMappingByDotloopId).mockResolvedValue(null);

    await handleLoopMerged(tenant, "acct_1", "profile_1", "loop_from", "loop_to");

    expect(repointMappingDotloopId).not.toHaveBeenCalled();
    expect(queueLoopFromDotloop).toHaveBeenCalledWith(tenant, "acct_1", "profile_1", "loop_to");
  });

  it("does nothing if toId is missing from the event", async () => {
    await handleLoopMerged(tenant, "acct_1", "profile_1", "loop_from", undefined);

    expect(findMappingByDotloopId).not.toHaveBeenCalled();
    expect(queueLoopFromDotloop).not.toHaveBeenCalled();
  });

  it("still syncs the surviving loop even if the mapping lookup throws", async () => {
    vi.mocked(findMappingByDotloopId).mockRejectedValue(new Error("db exploded"));

    await handleLoopMerged(tenant, "acct_1", "profile_1", "loop_from", "loop_to");

    expect(queueLoopFromDotloop).toHaveBeenCalledWith(tenant, "acct_1", "profile_1", "loop_to");
  });
});
