import { EntityType, SyncOrigin, TenantRow } from "../db/types";
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
  tenantId: string,
  direction: "HUBSPOT_TO_DOTLOOP" | "DOTLOOP_TO_HUBSPOT",
  sourceId: string,
  targetId: string | null,
  status: "SUCCESS" | "ERROR" | "SKIPPED",
  message?: string
) {
  await createSyncLog({ tenantId, entityType: EntityType.CONTACT, direction, sourceId, targetId, status, message });
}

/**
 * Syncs a single HubSpot contact -> its Dotloop counterpart (creating the
 * link/record on first sight), for one tenant. Called from the HubSpot
 * webhook handler and from the reconciliation poller.
 */
export async function syncContactFromHubSpot(tenant: TenantRow, hubspotContactId: string) {
  if (!tenant.hubspotPortalId || !tenant.dotloopAccountId) {
    logger.warn({ tenantId: tenant.id }, "Tenant is not fully connected yet; skipping contact sync");
    return;
  }
  const hubspot = await HubSpotClient.create(tenant.hubspotPortalId);
  const dotloop = await DotloopClient.create(tenant.dotloopAccountId);

  const source = await hubspot.getContact(hubspotContactId, HUBSPOT_CONTACT_PROPERTIES);
  if (!source) {
    logger.warn({ tenantId: tenant.id, hubspotContactId }, "HubSpot contact not found (possibly deleted); skipping");
    return;
  }
  const canonical = fromHubSpotContact(source.properties);
  const hash = hashSyncPayload(canonical as any);

  const mapping = await findMappingByHubspotId(tenant.id, EntityType.CONTACT, hubspotContactId);

  if (mapping) {
    if (mapping.lastSyncedHash === hash) {
      await logSync(tenant.id, "HUBSPOT_TO_DOTLOOP", hubspotContactId, mapping.dotloopId, "SKIPPED", "no-op / echo");
      return;
    }
    await dotloop.updateContact(mapping.dotloopId, toDotloopContact(canonical));
    await updateMapping(mapping.id, { lastSyncedHash: hash, lastSyncedAt: new Date(), lastSyncOrigin: SyncOrigin.HUBSPOT });
    await logSync(tenant.id, "HUBSPOT_TO_DOTLOOP", hubspotContactId, mapping.dotloopId, "SUCCESS");
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
    tenantId: tenant.id,
    entityType: EntityType.CONTACT,
    hubspotId: hubspotContactId,
    dotloopId: String(dotloopContact.id),
    lastSyncedHash: hash,
    lastSyncedAt: new Date(),
    lastSyncOrigin: SyncOrigin.HUBSPOT,
  });
  await logSync(tenant.id, "HUBSPOT_TO_DOTLOOP", hubspotContactId, String(dotloopContact.id), "SUCCESS", "created mapping");
}

/** Syncs a single Dotloop contact -> its HubSpot counterpart, for one tenant. */
export async function syncContactFromDotloop(tenant: TenantRow, dotloopContactId: string) {
  if (!tenant.hubspotPortalId || !tenant.dotloopAccountId) {
    logger.warn({ tenantId: tenant.id }, "Tenant is not fully connected yet; skipping contact sync");
    return;
  }
  const hubspot = await HubSpotClient.create(tenant.hubspotPortalId);
  const dotloop = await DotloopClient.create(tenant.dotloopAccountId);

  const source = await dotloop.getContact(dotloopContactId);
  if (!source) {
    logger.warn({ tenantId: tenant.id, dotloopContactId }, "Dotloop contact not found (possibly deleted); skipping");
    return;
  }
  const canonical = fromDotloopContact(source);
  const hash = hashSyncPayload(canonical as any);

  const mapping = await findMappingByDotloopId(tenant.id, EntityType.CONTACT, dotloopContactId);

  if (mapping) {
    if (mapping.lastSyncedHash === hash) {
      await logSync(tenant.id, "DOTLOOP_TO_HUBSPOT", dotloopContactId, mapping.hubspotId, "SKIPPED", "no-op / echo");
      return;
    }
    await hubspot.updateContact(mapping.hubspotId, toHubSpotContact(canonical));
    await updateMapping(mapping.id, { lastSyncedHash: hash, lastSyncedAt: new Date(), lastSyncOrigin: SyncOrigin.DOTLOOP });
    await logSync(tenant.id, "DOTLOOP_TO_HUBSPOT", dotloopContactId, mapping.hubspotId, "SUCCESS");
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
    tenantId: tenant.id,
    entityType: EntityType.CONTACT,
    hubspotId: hubspotContact.id,
    dotloopId: dotloopContactId,
    lastSyncedHash: hash,
    lastSyncedAt: new Date(),
    lastSyncOrigin: SyncOrigin.DOTLOOP,
  });
  await logSync(tenant.id, "DOTLOOP_TO_HUBSPOT", dotloopContactId, hubspotContact.id, "SUCCESS", "created mapping");
}
