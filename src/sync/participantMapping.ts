import { HubSpotClient } from "../clients/hubspotClient";
import { DotloopParticipant } from "../clients/dotloopClient";
import { logger } from "../utils/logger";

export interface CanonicalParticipant {
  fullName: string;
  email: string;
  role: string;
  companyName: string;
}

/**
 * Builds the canonical participant record for one HubSpot contact,
 * including its Company Name (looked up from the contact's own associated
 * HubSpot Company, if any) -- see db/types.ts's ContactRoleMapping doc
 * comment for why this exists (vendor-type participants like a lender or
 * title/escrow rep, where the firm name matters on the loop participant).
 * A missing/failed company lookup never blocks adding the participant
 * itself -- Company Name is just left blank and a warning is logged.
 */
export async function buildCanonicalParticipant(
  hubspot: HubSpotClient,
  contactId: string,
  role: string
): Promise<CanonicalParticipant | null> {
  const contact = await hubspot.getContact(contactId, ["email", "firstname", "lastname"]);
  if (!contact) return null;

  const fullName = [contact.properties.firstname, contact.properties.lastname].filter(Boolean).join(" ").trim();
  const email = contact.properties.email ?? "";

  let companyName = "";
  try {
    const companyAssociations = await hubspot.listAssociationsV4("contacts", contactId, "companies");
    const firstCompanyId = companyAssociations[0]?.toObjectId;
    if (firstCompanyId) {
      const company = await hubspot.getCompany(firstCompanyId, ["name"]);
      companyName = company?.properties.name ?? "";
    }
  } catch (err) {
    logger.warn({ err, contactId }, "Failed to look up associated HubSpot company for participant's Company Name field; leaving it blank");
  }

  return {
    fullName: fullName || email || `HubSpot Contact ${contactId}`,
    email,
    role,
    companyName,
  };
}

export function toDotloopParticipant(c: CanonicalParticipant): Partial<DotloopParticipant> {
  const participant: Partial<DotloopParticipant> = { fullName: c.fullName, role: c.role };
  if (c.email) participant.email = c.email;
  if (c.companyName) participant["Company Name"] = c.companyName;
  return participant;
}
