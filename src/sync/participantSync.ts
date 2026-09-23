import { TenantRow } from "../db/types";
import { HubSpotClient } from "../clients/hubspotClient";
import { DotloopClient } from "../clients/dotloopClient";
import { createParticipantMapping, findParticipantMapping } from "../db/participantMappingRepo";
import { buildCanonicalParticipant, toDotloopParticipant } from "./participantMapping";
import { logger } from "../utils/logger";

/**
 * Pushes this deal's HubSpot contact associations onto its Dotloop loop as
 * participants, for every association label this tenant has mapped to a
 * Dotloop role (tenant.contactRoleMapping -- see db/types.ts's doc comment
 * for the full design, including why this is HubSpot -> Dotloop only and
 * why it's scoped to new associations).
 *
 * Every (deal, contact, role) tuple this has already handled -- synced for
 * real, or pre-seeded as a pre-existing association to skip -- has a row in
 * loop_participants, so this is safe to call on every deal/loop sync pass:
 * it only ever adds a participant the first time a matching association is
 * seen with no existing row.
 *
 * Never throws -- a failure syncing one contact's participant record (a bad
 * Dotloop response, a deleted HubSpot contact, etc.) is logged and skipped
 * so it can't take down the rest of this deal's participants or the
 * underlying deal/loop sync that's calling this.
 */
export async function syncParticipantsForDeal(
  tenant: TenantRow,
  hubspot: HubSpotClient,
  dotloop: DotloopClient,
  hubspotDealId: string,
  profileId: string,
  loopId: string
): Promise<void> {
  if (tenant.contactRoleMapping.length === 0) return;

  let associations;
  try {
    associations = await hubspot.listAssociationsV4("deals", hubspotDealId, "contacts");
  } catch (err) {
    logger.error({ err, tenantId: tenant.id, hubspotDealId }, "Failed to read deal<->contact associations; skipping participant sync for this deal");
    return;
  }

  for (const association of associations) {
    const contactId = association.toObjectId;

    for (const roleMapping of tenant.contactRoleMapping) {
      const matches = association.associationTypes.some(
        (t) => t.typeId === roleMapping.hubspotAssociationTypeId && t.category === roleMapping.hubspotAssociationCategory
      );
      if (!matches) continue;

      try {
        const existing = await findParticipantMapping(tenant.id, hubspotDealId, contactId, roleMapping.dotloopRole);
        if (existing) continue; // already synced, or deliberately marked pre-existing/skipped

        const canonical = await buildCanonicalParticipant(hubspot, contactId, roleMapping.dotloopRole);
        if (!canonical) {
          logger.warn({ tenantId: tenant.id, hubspotDealId, contactId }, "Associated HubSpot contact not found (possibly deleted); skipping this participant");
          continue;
        }

        const participant = await dotloop.addParticipant(profileId, loopId, toDotloopParticipant(canonical));
        await createParticipantMapping({
          tenantId: tenant.id,
          hubspotDealId,
          hubspotContactId: contactId,
          dotloopRole: roleMapping.dotloopRole,
          dotloopParticipantId: String(participant.id),
          dotloopLoopId: String(loopId),
          status: "SYNCED",
        });
        logger.info(
          { tenantId: tenant.id, hubspotDealId, contactId, role: roleMapping.dotloopRole, label: roleMapping.hubspotLabel },
          "Added new Dotloop loop participant from a HubSpot deal association"
        );
      } catch (err) {
        logger.error(
          { err, tenantId: tenant.id, hubspotDealId, contactId, role: roleMapping.dotloopRole },
          "Failed to sync this contact/role as a Dotloop loop participant"
        );
      }
    }
  }
}
