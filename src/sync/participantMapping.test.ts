import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { buildCanonicalParticipant, toDotloopParticipant } from "./participantMapping";
import { logger } from "../utils/logger";

function fakeHubspot(overrides: Partial<Record<string, any>> = {}) {
  return {
    getContact: vi.fn().mockResolvedValue({
      id: "contact_1",
      properties: { email: "jane@example.com", firstname: "Jane", lastname: "Buyer" },
    }),
    listAssociationsV4: vi.fn().mockResolvedValue([]),
    getCompany: vi.fn(),
    ...overrides,
  } as any;
}

describe("buildCanonicalParticipant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when the HubSpot contact no longer exists", async () => {
    const hubspot = fakeHubspot({ getContact: vi.fn().mockResolvedValue(null) });
    const result = await buildCanonicalParticipant(hubspot, "contact_1", "BUYER");
    expect(result).toBeNull();
  });

  it("builds a full name from first/last name and leaves companyName blank with no associated company", async () => {
    const hubspot = fakeHubspot();
    const result = await buildCanonicalParticipant(hubspot, "contact_1", "BUYER");
    expect(result).toEqual({ fullName: "Jane Buyer", email: "jane@example.com", role: "BUYER", companyName: "" });
  });

  it("populates companyName from the contact's first associated HubSpot company", async () => {
    const hubspot = fakeHubspot({
      listAssociationsV4: vi.fn().mockResolvedValue([{ toObjectId: "company_1", associationTypes: [] }]),
      getCompany: vi.fn().mockResolvedValue({ id: "company_1", properties: { name: "Acme Title Co" } }),
    });
    const result = await buildCanonicalParticipant(hubspot, "contact_1", "ESCROW_TITLE_REP");
    expect(result?.companyName).toBe("Acme Title Co");
  });

  it("falls back to email, then a placeholder, when the contact has no name", async () => {
    const hubspot = fakeHubspot({
      getContact: vi.fn().mockResolvedValue({ id: "contact_1", properties: { email: "noname@example.com" } }),
    });
    const result = await buildCanonicalParticipant(hubspot, "contact_1", "BUYER");
    expect(result?.fullName).toBe("noname@example.com");

    const hubspotNoEmailEither = fakeHubspot({
      getContact: vi.fn().mockResolvedValue({ id: "contact_1", properties: {} }),
    });
    const result2 = await buildCanonicalParticipant(hubspotNoEmailEither, "contact_1", "BUYER");
    expect(result2?.fullName).toBe("HubSpot Contact contact_1");
  });

  it("leaves companyName blank and logs a warning (without throwing) if the company lookup fails", async () => {
    const hubspot = fakeHubspot({
      listAssociationsV4: vi.fn().mockRejectedValue(new Error("HubSpot 500")),
    });
    const result = await buildCanonicalParticipant(hubspot, "contact_1", "BUYER");
    expect(result?.companyName).toBe("");
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe("toDotloopParticipant", () => {
  it("omits email and Company Name when they're blank", () => {
    const result = toDotloopParticipant({ fullName: "Jane Buyer", email: "", role: "BUYER", companyName: "" });
    expect(result).toEqual({ fullName: "Jane Buyer", role: "BUYER" });
  });

  it("includes Company Name when present", () => {
    const result = toDotloopParticipant({ fullName: "Bob Lender", email: "bob@lender.com", role: "LOAN_OFFICER", companyName: "Acme Lending" });
    expect(result).toEqual({ fullName: "Bob Lender", role: "LOAN_OFFICER", email: "bob@lender.com", "Company Name": "Acme Lending" });
  });
});
