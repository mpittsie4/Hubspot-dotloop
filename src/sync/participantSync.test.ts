import { describe, it, expect, vi, beforeEach } from "vitest";
import { ContactRoleMapping, TenantRow } from "../db/types";

vi.mock("../db/participantMappingRepo", () => ({
  findParticipantMapping: vi.fn(),
  createParticipantMapping: vi.fn(),
}));
vi.mock("./participantMapping", () => ({
  buildCanonicalParticipant: vi.fn(),
  toDotloopParticipant: vi.fn((c: any) => ({ fullName: c.fullName, email: c.email, role: c.role })),
}));
vi.mock("../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { syncParticipantsForDeal } from "./participantSync";
import { findParticipantMapping, createParticipantMapping } from "../db/participantMappingRepo";
import { buildCanonicalParticipant } from "./participantMapping";
import { logger } from "../utils/logger";

const BUYER_MAPPING: ContactRoleMapping = {
  hubspotAssociationTypeId: 10,
  hubspotAssociationCategory: "USER_DEFINED",
  hubspotLabel: "Buyer",
  dotloopRole: "BUYER",
};
const SELLER_MAPPING: ContactRoleMapping = {
  hubspotAssociationTypeId: 11,
  hubspotAssociationCategory: "USER_DEFINED",
  hubspotLabel: "Seller",
  dotloopRole: "SELLER",
};

function tenant(overrides: Partial<TenantRow> = {}): TenantRow {
  return {
    id: "tenant_1",
    name: "Test",
    hubspotPortalId: "123",
    dotloopAccountId: "acct_1",
    dotloopProfileId: "profile_1",
    pipelinesConfig: [],
    contactRoleMapping: [BUYER_MAPPING, SELLER_MAPPING],
    status: "ACTIVE" as any,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function fakeHubspot(associations: any[]) {
  return { listAssociationsV4: vi.fn().mockResolvedValue(associations) } as any;
}

function fakeDotloop(participantId: number | string = 999) {
  return { addParticipant: vi.fn().mockResolvedValue({ id: participantId }) } as any;
}

describe("syncParticipantsForDeal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does nothing (and doesn't call HubSpot) when the tenant has no contact role mapping", async () => {
    const hubspot = fakeHubspot([]);
    const dotloop = fakeDotloop();

    await syncParticipantsForDeal(tenant({ contactRoleMapping: [] }), hubspot, dotloop, "deal_1", "profile_1", "loop_1");

    expect(hubspot.listAssociationsV4).not.toHaveBeenCalled();
    expect(dotloop.addParticipant).not.toHaveBeenCalled();
  });

  it("adds a new Dotloop participant for an association matching a role mapping with no existing record", async () => {
    const hubspot = fakeHubspot([
      { toObjectId: "contact_1", associationTypes: [{ category: "USER_DEFINED", typeId: 10, label: "Buyer" }] },
    ]);
    const dotloop = fakeDotloop(555);
    vi.mocked(findParticipantMapping).mockResolvedValue(null);
    vi.mocked(buildCanonicalParticipant).mockResolvedValue({
      fullName: "Jane Buyer",
      email: "jane@example.com",
      role: "BUYER",
      companyName: "",
    });

    await syncParticipantsForDeal(tenant(), hubspot, dotloop, "deal_1", "profile_1", "loop_1");

    expect(dotloop.addParticipant).toHaveBeenCalledWith("profile_1", "loop_1", expect.objectContaining({ role: "BUYER" }));
    expect(createParticipantMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant_1",
        hubspotDealId: "deal_1",
        hubspotContactId: "contact_1",
        dotloopRole: "BUYER",
        dotloopParticipantId: "555",
        status: "SYNCED",
      })
    );
  });

  it("skips an association whose typeId/category don't match any of the tenant's role mappings", async () => {
    const hubspot = fakeHubspot([
      { toObjectId: "contact_1", associationTypes: [{ category: "USER_DEFINED", typeId: 999, label: "Attorney" }] },
    ]);
    const dotloop = fakeDotloop();

    await syncParticipantsForDeal(tenant(), hubspot, dotloop, "deal_1", "profile_1", "loop_1");

    expect(dotloop.addParticipant).not.toHaveBeenCalled();
    expect(findParticipantMapping).not.toHaveBeenCalled();
  });

  it("skips a matching association that already has a mapping row (already synced or deliberately pre-seeded as skipped)", async () => {
    const hubspot = fakeHubspot([
      { toObjectId: "contact_1", associationTypes: [{ category: "USER_DEFINED", typeId: 10, label: "Buyer" }] },
    ]);
    const dotloop = fakeDotloop();
    vi.mocked(findParticipantMapping).mockResolvedValue({
      id: "row_1",
      tenantId: "tenant_1",
      hubspotDealId: "deal_1",
      hubspotContactId: "contact_1",
      dotloopRole: "BUYER",
      dotloopParticipantId: null,
      dotloopLoopId: null,
      status: "SKIPPED_PRE_EXISTING",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await syncParticipantsForDeal(tenant(), hubspot, dotloop, "deal_1", "profile_1", "loop_1");

    expect(dotloop.addParticipant).not.toHaveBeenCalled();
    expect(buildCanonicalParticipant).not.toHaveBeenCalled();
  });

  it("handles one contact matching multiple role mappings and one contact with no HubSpot record left, independently", async () => {
    const hubspot = fakeHubspot([
      {
        toObjectId: "contact_multi",
        associationTypes: [
          { category: "USER_DEFINED", typeId: 10, label: "Buyer" },
          { category: "USER_DEFINED", typeId: 11, label: "Seller" },
        ],
      },
      { toObjectId: "contact_deleted", associationTypes: [{ category: "USER_DEFINED", typeId: 10, label: "Buyer" }] },
    ]);
    const dotloop = fakeDotloop(1);
    vi.mocked(findParticipantMapping).mockResolvedValue(null);
    vi.mocked(buildCanonicalParticipant).mockImplementation(async (_hubspot, contactId, role) =>
      contactId === "contact_deleted" ? null : { fullName: "Multi Role", email: "m@example.com", role, companyName: "" }
    );

    await syncParticipantsForDeal(tenant(), hubspot, dotloop, "deal_1", "profile_1", "loop_1");

    // contact_multi should be added twice, once per matching role.
    expect(dotloop.addParticipant).toHaveBeenCalledTimes(2);
    expect(createParticipantMapping).toHaveBeenCalledTimes(2);
    // contact_deleted has no HubSpot record -- skipped, not thrown.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: "contact_deleted" }),
      expect.stringContaining("not found")
    );
  });

  it("isolates a failure adding one participant so it doesn't block the rest, and logs it", async () => {
    const hubspot = fakeHubspot([
      { toObjectId: "contact_ok", associationTypes: [{ category: "USER_DEFINED", typeId: 10, label: "Buyer" }] },
      { toObjectId: "contact_fails", associationTypes: [{ category: "USER_DEFINED", typeId: 11, label: "Seller" }] },
    ]);
    const dotloop = fakeDotloop(1);
    vi.mocked(findParticipantMapping).mockResolvedValue(null);
    vi.mocked(buildCanonicalParticipant).mockImplementation(async (_hubspot, contactId, role) => {
      if (contactId === "contact_fails") throw new Error("dotloop blew up");
      return { fullName: "OK Contact", email: "ok@example.com", role, companyName: "" };
    });

    await expect(syncParticipantsForDeal(tenant(), hubspot, dotloop, "deal_1", "profile_1", "loop_1")).resolves.toBeUndefined();

    expect(dotloop.addParticipant).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: "contact_fails" }),
      expect.stringContaining("Failed to sync")
    );
  });

  it("logs an error and returns early (without throwing) if reading associations itself fails", async () => {
    const hubspot = { listAssociationsV4: vi.fn().mockRejectedValue(new Error("HubSpot 500")) } as any;
    const dotloop = fakeDotloop();

    await expect(syncParticipantsForDeal(tenant(), hubspot, dotloop, "deal_1", "profile_1", "loop_1")).resolves.toBeUndefined();

    expect(dotloop.addParticipant).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });
});
