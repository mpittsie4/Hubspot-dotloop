import { EntityType, SyncOrigin } from "../db/types";
import { createMapping, findMappingByDotloopId, findMappingByHubspotId, updateMapping } from "../db/mappingRepo";
import { createSyncLog } from "../db/syncLogRepo";
import { HubSpotClient } from "../clients/hubspotClient";
import { DotloopClient } from "../clients/dotloopClient";
import {
  HUBSPOT_CONTACT_PROPERTIES,
  fromDotloopContact,
  fromHubSpotContact,
  toDotloopContact,
  toHubSpotContact,
} from "./contactMapping";
import { hashSyncPayload } from "../utils/crypto";
import { logger } from "../utils/logger";

async function logSync(
  direction: "HUBSPOT_TO_DOTLOOP" | "DOTLOOP_TO_HUBSPOT",
  sourceId: string,
  targetId: string | null,
  status: "SUCCESS" | "ERROR" | "SKIPPED",
  message?: string
) {
  await createSyncLog({ entityType: EntityType.CONTACT, direction, sourceId, targetId, status, message });
}

/**
 * Syncs a single HubSpot contact -> its Dotloop counterpart (creating the
 * link/record on first sight). Called from the HubSpot webhook handler and
 * from the reconciliation poller.
 */
export async function syncContactFromHubSpot(hubspotContactId: string) {
  const hubspot = await HubSpotClient.create();
  const dotloop = await DotloopClient.create();

  const source = await hubspot.getContact(hubspotContactId, HUBSPOT_CONTACT_PROPERTIES);
  if (!source) {
    logger.warn({ hubspotContactId }, "HubSpot contact not found (possibly deleted); skipping");
    return;
  }
  const canonical = fromHubSpotContact(source.properties);
  const hash = hashSyncPayload(canonical as any);

  const mapping = await findMappingByHubspotId(EntityType.CONTACT, hubspotContactId);

  if (mapping) {
    if (mapping.lastSyncedHash === hash) {
      await logSync("HUBSPOT_TO_DOTLOOP", hubspotContactId, mapping.dotloopId, "SKIPPED", "no-op / echo");
      return;
    }
    await dotloop.updateContact(mapping.dotloopId, toDotloopContact(canonical));
    await updateMapping(mapping.id, { lastSyncedHash: hash, lastSyncedAt: new Date(), lastSyncOrigin: SyncOrigin.HUBSPOT });
    await logSync("HUBSPOT_TO_DOTLOOP", hubspotContactId, mapping.dotloopId, "SUCCESS");
    return;
  }

  // No mapping yet: try to link by email before creating a duplicate.
  let dotloopContact = canonical.email ? await dotloop.findContactByEmail(canonical.email) : null;
  if (dotloopContact) {
    await dotloop.updateContact(dotloopContact.id, toDotloopContact(canonical));
  } else {
    dotloopContact = await dotloop.createContact(toDotloopContact(canonical));
  }

  await createMapping({
    entityType: EntityType.CONTACT,
    hubspotId: hubspotContactId,
    dotloopId: String(dotloopContact.id),
    lastSyncedHash: hash,
    lastSyncedAt: new Date(),
    lastSyncOrigin: SyncOrigin.HUBSPOT,
  });
  await logSync("HUBSPOT_TO_DOTLOOP", hubspotContactId, String(dotloopContact.id), "SUCCESS", "created mapping");
}

/** Syncs a single Dotloop contact -> its HubSpot counterpart. */
export async function syncContactFromDotloop(dotloopContactId: string) {
  const hubspot = await HubSpotClient.create();
  const dotloop = await DotloopClient.create();

  const source = await dotloop.getContact(dotloopContactId);
  if (!source) {
    logger.warn({ dotloopContactId }, "Dotloop contact not found (possibly deleted); skipping");
    return;
  }
  const canonical = fromDotloopContact(source);
  const hash = hashSyncPayload(canonical as any);

  const mapping = await findMappingByDotloopId(EntityType.CONTACT, dotloopContactId);

  if (mapping) {
    if (mapping.lastSyncedHash === hash) {
      await logSync("DOTLOOP_TO_HUBSPOT", dotloopContactId, mapping.hubspotId, "SKIPPED", "no-op / echo");
      return;
    }
    await hubspot.updateContact(mapping.hubspotId, toHubSpotContact(canonical));
    await updateMapping(mapping.id, { lastSyncedHash: hash, lastSyncedAt: new Date(), lastSyncOrigin: SyncOrigin.DOTLOOP });
    await logSync("DOTLOOP_TO_HUBSPOT", dotloopContactId, mapping.hubspotId, "SUCCESS");
    return;
  }

  let hubspotContact = canonical.email
    ? await hubspot.findContactByEmail(canonical.email, HUBSPOT_CONTACT_PROPERTIES)
    : null;
  if (hubspotContact) {
    await hubspot.updateContact(hubspotContact.id, toHubSpotContact(canonical));
  } else {
    hubspotContact = await hubspot.createContact(toHubSpotContact(canonical));
  }

  await createMapping({
    entityType: EntityType.CONTACT,
    hubspotId: hubspotContact.id,
    dotloopId: dotloopContactId,
    lastSyncedHash: hash,
    lastSyncedAt: new Date(),
    lastSyncOrigin: SyncOrigin.DOTLOOP,
  });
  await logSync("DOTLOOP_TO_HUBSPOT", dotloopContactId, hubspotContact.id, "SUCCESS", "created mapping");
}
