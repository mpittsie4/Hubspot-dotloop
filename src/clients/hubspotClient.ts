import axios, { AxiosInstance } from "axios";
import { Provider } from "../db/types";
import { config } from "../config";
import { getSoleToken, getToken, saveToken } from "../auth/tokenStore";
import { refreshHubSpotToken } from "../auth/hubspotOAuth";
import { logger } from "../utils/logger";

export interface HubSpotContactProperties {
  email?: string;
  firstname?: string;
  lastname?: string;
  phone?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  [key: string]: string | undefined;
}

export interface HubSpotDealProperties {
  dealname?: string;
  amount?: string;
  dealstage?: string;
  closedate?: string;
  pipeline?: string;
  [key: string]: string | undefined;
}

export interface HubSpotCompanyProperties {
  name?: string;
  domain?: string;
  [key: string]: string | undefined;
}

/** A HubSpot CRM Owner (a sales rep/user who can be assigned as a deal's
 *  owner) — see hubspotProxyRoutes.ts's dotlop-status endpoint, which uses
 *  this to resolve a deal's owner id to their email so the Deal Sync Status
 *  card can tell whether the person currently viewing the card *is* that
 *  owner before ever showing them a "connect your Dotloop" button (showing
 *  it to the wrong person would let them accidentally link their own
 *  Dotloop account under someone else's brokerage connection slot). */
export interface HubSpotOwner {
  id: string;
  email?: string;
  firstName?: string;
  lastName?: string;
}

/** One HubSpot association-label definition, e.g. a custom "Buyer" label
 *  between deals and contacts. `label` is null for the default/unlabeled
 *  association a pair of object types always has (e.g. deal<->company's
 *  built-in "Primary"). typeId/category together are what you actually
 *  filter/write associations by -- label text is for humans only and can
 *  be renamed without changing typeId. See scripts/listAssociationLabels.ts. */
export interface HubSpotAssociationLabel {
  category: "HUBSPOT_DEFINED" | "USER_DEFINED";
  typeId: number;
  label: string | null;
}

/** One existing labeled association from a source object to a single
 *  target object, as returned by the v4 associations read endpoint. */
export interface HubSpotAssociationV4 {
  toObjectId: string;
  associationTypes: Array<{ category: "HUBSPOT_DEFINED" | "USER_DEFINED"; typeId: number; label: string | null }>;
}

export interface HubSpotObject<P> {
  id: string;
  properties: P;
  createdAt: string;
  updatedAt: string;
  archived?: boolean;
}

export interface HubSpotPropertyDefinition {
  name: string;
  label: string;
  type: "string" | "enumeration" | "datetime" | "number" | "bool";
  fieldType: "text" | "select" | "date" | "number" | "booleancheckbox";
  groupName: string;
  description?: string;
  options?: Array<{ label: string; value: string }>;
}

// Mirrors scripts/create-dotloop-properties.mjs — kept in sync by hand.
// These are created automatically on every HubSpot connect via
// ensureDotloopProperties(); the standalone script remains only as a
// manual fallback (e.g. to backfill a portal connected before this existed).
const DOTLOOP_DEAL_PROPERTIES: HubSpotPropertyDefinition[] = [
  {
    name: "dotloop_loop_id",
    label: "Dotloop Loop ID",
    type: "string",
    fieldType: "text",
    groupName: "dealinformation",
    description: "The Dotloop loop ID this deal is linked to.",
  },
  {
    name: "dotloop_loop_url",
    label: "Dotloop Loop URL",
    type: "string",
    fieldType: "text",
    groupName: "dealinformation",
    description: "Direct link to the loop in Dotloop.",
  },
  {
    name: "dotloop_sync_status",
    label: "Dotloop Sync Status",
    type: "enumeration",
    fieldType: "select",
    groupName: "dealinformation",
    description: "Result of the most recent sync attempt with Dotloop.",
    options: [
      { label: "Success", value: "SUCCESS" },
      { label: "Error", value: "ERROR" },
      { label: "Skipped", value: "SKIPPED" },
      { label: "Pending", value: "PENDING" },
    ],
  },
  {
    name: "dotloop_last_synced_at",
    label: "Dotloop Last Synced At",
    type: "datetime",
    fieldType: "date",
    groupName: "dealinformation",
    description: "Timestamp of the most recent sync attempt with Dotloop.",
  },
];

const DOTLOOP_CONTACT_PROPERTIES: HubSpotPropertyDefinition[] = [
  {
    name: "dotloop_contact_id",
    label: "Dotloop Contact ID",
    type: "string",
    fieldType: "text",
    groupName: "contactinformation",
    description: "The Dotloop loop-contact ID this contact is linked to.",
  },
  {
    name: "dotloop_sync_status",
    label: "Dotloop Sync Status",
    type: "enumeration",
    fieldType: "select",
    groupName: "contactinformation",
    description: "Result of the most recent sync attempt with Dotloop.",
    options: [
      { label: "Success", value: "SUCCESS" },
      { label: "Error", value: "ERROR" },
      { label: "Skipped", value: "SKIPPED" },
      { label: "Pending", value: "PENDING" },
    ],
  },
  {
    name: "dotloop_last_synced_at",
    label: "Dotloop Last Synced At",
    type: "datetime",
    fieldType: "date",
    groupName: "contactinformation",
    description: "Timestamp of the most recent sync attempt with Dotloop.",
  },
];

/**
 * Thin wrapper around the HubSpot CRM v3 API that transparently refreshes
 * the access token when it's near expiry. Pass the tenant's HubSpot portal
 * id as accountKey to operate as that tenant (see TenantRow.hubspotPortalId
 * and the sync layer, which does this for every real sync call); omitting
 * it falls back to tokenStore.getSoleToken for callers that predate
 * multi-tenancy and still assume a single connected portal (e.g. the
 * Settings-page proxy in routes/hubspotProxyRoutes.ts).
 */
export class HubSpotClient {
  private http: AxiosInstance;
  private accountKey: string;

  private constructor(accountKey: string, accessToken: string) {
    this.accountKey = accountKey;
    this.http = axios.create({
      baseURL: config.hubspot.apiBaseUrl,
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  }

  static async create(accountKey?: string): Promise<HubSpotClient> {
    const stored = accountKey ? await getToken(Provider.HUBSPOT, accountKey) : await getSoleToken(Provider.HUBSPOT);
    if (!stored) {
      throw new Error(`No connected HubSpot token found for portal ${accountKey}.`);
    }
    const needsRefresh = stored.expiresAt.getTime() - Date.now() < 5 * 60 * 1000;

    let accessToken = stored.accessToken;
    if (needsRefresh) {
      const refreshed = await refreshHubSpotToken(stored.refreshToken);
      await saveToken(Provider.HUBSPOT, stored.accountKey, {
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token,
        expiresAt: new Date(Date.now() + refreshed.expires_in * 1000),
      });
      accessToken = refreshed.access_token;
      logger.info({ portalId: stored.accountKey }, "Refreshed HubSpot access token");
    }

    return new HubSpotClient(stored.accountKey, accessToken);
  }

  /**
   * Builds a client directly from an access token you already have on hand
   * (e.g. immediately after an OAuth callback, before/without a DB round
   * trip). Bypasses getSoleToken/getToken entirely -- used by
   * routes/authRoutes.ts right after a HubSpot connect, before the tenant
   * row has even been updated with its portal id.
   */
  static forToken(accountKey: string, accessToken: string): HubSpotClient {
    return new HubSpotClient(accountKey, accessToken);
  }

  get portalId() {
    return this.accountKey;
  }

  // ---- Pipelines (used by the app's Settings UI extension, via the
  // hubspotProxyRoutes backend proxy — see that file for why this can't
  // be called directly from a "settings" type UI extension with
  // hubspot.fetch()) --------------------------------------------------

  async listDealPipelines(): Promise<{ results: Array<{ label: string; stages: Array<{ id: string; label: string }> }> }> {
    const res = await this.http.get(`/crm/v3/pipelines/deals`);
    return res.data;
  }

  // ---- Contacts -----------------------------------------------------

  async getContact(id: string, properties: string[]): Promise<HubSpotObject<HubSpotContactProperties> | null> {
    try {
      const res = await this.http.get(`/crm/v3/objects/contacts/${id}`, {
        params: { properties: properties.join(",") },
      });
      return res.data;
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 404) return null;
      throw err;
    }
  }

  async findContactByEmail(email: string, properties: string[]): Promise<HubSpotObject<HubSpotContactProperties> | null> {
    const res = await this.http.post(`/crm/v3/objects/contacts/search`, {
      filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
      properties,
      limit: 1,
    });
    return res.data.results?.[0] ?? null;
  }

  async createContact(properties: HubSpotContactProperties): Promise<HubSpotObject<HubSpotContactProperties>> {
    const res = await this.http.post(`/crm/v3/objects/contacts`, { properties });
    return res.data;
  }

  async updateContact(id: string, properties: HubSpotContactProperties): Promise<HubSpotObject<HubSpotContactProperties>> {
    const res = await this.http.patch(`/crm/v3/objects/contacts/${id}`, { properties });
    return res.data;
  }

  /** Contacts created/updated since `since` (ISO string), for reconciliation polling. */
  async listRecentContacts(since: Date, properties: string[]): Promise<HubSpotObject<HubSpotContactProperties>[]> {
    return this.searchByLastModified("contacts", since, properties);
  }

  // ---- Deals ----------------------------------------------------------

  async getDeal(id: string, properties: string[]): Promise<HubSpotObject<HubSpotDealProperties> | null> {
    try {
      const res = await this.http.get(`/crm/v3/objects/deals/${id}`, {
        params: { properties: properties.join(",") },
      });
      return res.data;
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 404) return null;
      throw err;
    }
  }

  async createDeal(properties: HubSpotDealProperties): Promise<HubSpotObject<HubSpotDealProperties>> {
    const res = await this.http.post(`/crm/v3/objects/deals`, { properties });
    return res.data;
  }

  async updateDeal(id: string, properties: HubSpotDealProperties): Promise<HubSpotObject<HubSpotDealProperties>> {
    const res = await this.http.patch(`/crm/v3/objects/deals/${id}`, { properties });
    return res.data;
  }

  async associateDealWithContact(dealId: string, contactId: string): Promise<void> {
    await this.http.put(
      `/crm/v3/objects/deals/${dealId}/associations/contacts/${contactId}/deal_to_contact`
    );
  }

  async listRecentDeals(since: Date, properties: string[]): Promise<HubSpotObject<HubSpotDealProperties>[]> {
    return this.searchByLastModified("deals", since, properties);
  }

  // ---- Owners (used by hubspotProxyRoutes.ts to resolve a deal's
  // hubspot_owner_id to that owner's email — needs the crm.objects.owners.read
  // scope, added alongside the brokerage self-serve-connect feature; existing
  // installs need to re-consent once this scope is added, same as the
  // crm.objects.companies.read rollout) -------------------------------------

  async getOwner(ownerId: string): Promise<HubSpotOwner | null> {
    try {
      const res = await this.http.get(`/crm/v3/owners/${ownerId}`);
      return { id: String(res.data.id), email: res.data.email, firstName: res.data.firstName, lastName: res.data.lastName };
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 404) return null;
      throw err;
    }
  }

  // ---- Companies --------------------------------------------------------

  async getCompany(id: string, properties: string[]): Promise<HubSpotObject<HubSpotCompanyProperties> | null> {
    try {
      const res = await this.http.get(`/crm/v3/objects/companies/${id}`, {
        params: { properties: properties.join(",") },
      });
      return res.data;
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 404) return null;
      throw err;
    }
  }

  // ---- Labeled associations (v4) -- used by sync/participantSync.ts to
  // read which HubSpot deal<->contact association (e.g. "Buyer", "Seller",
  // the custom vendor-contact labels) a given contact carries on a deal,
  // and by scripts/listAssociationLabels.ts to discover each portal's own
  // label typeIds (custom per-portal, unlike Dotloop's fixed loop-status
  // vocabulary -- see db/types.ts's ContactRoleMapping doc comment). -----

  /** All association-label definitions (built-in + custom) between two object types. */
  async listAssociationLabels(fromObjectType: string, toObjectType: string): Promise<HubSpotAssociationLabel[]> {
    const res = await this.http.get(`/crm/v4/associations/${fromObjectType}/${toObjectType}/labels`);
    return res.data?.results ?? [];
  }

  /** Every labeled association from one object to every object of `toObjectType` it's linked to. */
  async listAssociationsV4(
    fromObjectType: string,
    objectId: string,
    toObjectType: string
  ): Promise<HubSpotAssociationV4[]> {
    const results: HubSpotAssociationV4[] = [];
    let after: string | undefined;
    do {
      const res: any = await this.http.get(
        `/crm/v4/objects/${fromObjectType}/${objectId}/associations/${toObjectType}`,
        { params: after ? { after } : undefined }
      );
      for (const r of res.data?.results ?? []) {
        results.push({ toObjectId: String(r.toObjectId), associationTypes: r.associationTypes ?? [] });
      }
      after = res.data?.paging?.next?.after;
    } while (after);
    return results;
  }

  /**
   * Creates a single labeled association between two specific records.
   * `category`/`typeId` come from listAssociationLabels (or a tenant's
   * stored ContactRoleMapping) -- HubSpot rejects an unknown/mismatched
   * pair with a 400, it does not silently create an unlabeled association.
   */
  async associateWithLabel(
    fromObjectType: string,
    fromObjectId: string,
    toObjectType: string,
    toObjectId: string,
    category: "HUBSPOT_DEFINED" | "USER_DEFINED",
    typeId: number
  ): Promise<void> {
    await this.http.put(
      `/crm/v4/objects/${fromObjectType}/${fromObjectId}/associations/${toObjectType}/${toObjectId}`,
      [{ associationCategory: category, associationTypeId: typeId }]
    );
  }

  // ---- Notes (used by sync/documentSync.ts to surface new/updated Dotloop
  // documents on the deal timeline -- see that file's doc comment for why
  // this links out to Dotloop rather than attaching the actual file) -----

  async createNote(body: string, timestamp: Date): Promise<HubSpotObject<any>> {
    const res = await this.http.post(`/crm/v3/objects/notes`, {
      properties: { hs_note_body: body, hs_timestamp: timestamp.toISOString() },
    });
    return res.data;
  }

  /**
   * 214 is HubSpot's default v3 association type id for note -> deal.
   *
   * This PUT has no request body, and axios' default Content-Type for a
   * body-less request is application/x-www-form-urlencoded -- HubSpot's v3
   * associations endpoint rejects that with 415 Unsupported Media Type
   * (confirmed live against a real note/deal pair). Every other call on
   * this client sends a JSON object as the body, so axios sets
   * Content-Type: application/json for them automatically and never hits
   * this; forcing it explicitly here is what fixes it.
   */
  async associateNoteWithDeal(noteId: string, dealId: string): Promise<void> {
    await this.http.put(`/crm/v3/objects/notes/${noteId}/associations/deal/${dealId}/214`, null, {
      headers: { "Content-Type": "application/json" },
    });
  }

  // ---- Custom properties (used to store Dotloop sync state on the record) -

  /**
   * Idempotently ensures a custom property exists on an object type,
   * from a full property definition (type/fieldType/options, not just a
   * text field). Safe to call repeatedly — an existing property is left
   * untouched, not overwritten.
   */
  async ensureProperty(objectType: "contacts" | "deals", property: HubSpotPropertyDefinition) {
    try {
      await this.http.get(`/crm/v3/properties/${objectType}/${property.name}`);
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        await this.http.post(`/crm/v3/properties/${objectType}`, property);
        logger.info({ objectType, name: property.name }, "Created HubSpot custom property");
      } else {
        throw err;
      }
    }
  }

  /**
   * Creates (idempotently) the full set of dotloop_* deal and contact
   * properties the connector and the Deal Sync Status card rely on. Call
   * this right after an install connects HubSpot (see hubspotOAuth.ts) so
   * every portal gets these automatically — this is what
   * scripts/create-dotloop-properties.mjs used to require a manually
   * created private-app token for, which doesn't scale past a single
   * portal you administer yourself.
   */
  async ensureDotloopProperties(): Promise<void> {
    for (const property of DOTLOOP_DEAL_PROPERTIES) {
      await this.ensureProperty("deals", property);
    }
    for (const property of DOTLOOP_CONTACT_PROPERTIES) {
      await this.ensureProperty("contacts", property);
    }
  }

  // ---- Webhooks (classic push API, scoped to the app, not the portal) --

  /** Sets/updates the single target URL HubSpot posts webhook events to for this app. */
  async setWebhookTargetUrl(appId: string, targetUrl: string, maxConcurrentRequests = 10): Promise<void> {
    await this.http.put(`/webhooks/v3/${appId}/settings`, { targetUrl, maxConcurrentRequests });
  }

  async upsertWebhookSubscription(appId: string, eventType: string): Promise<void> {
    const existing = await this.http.get(`/webhooks/v3/${appId}/subscriptions`);
    const match = (existing.data?.results ?? []).find((s: any) => s.eventType === eventType);
    if (match) {
      if (!match.active) {
        await this.http.patch(`/webhooks/v3/${appId}/subscriptions/${match.id}`, { active: true });
      }
      return;
    }
    await this.http.post(`/webhooks/v3/${appId}/subscriptions`, { eventType, active: true });
  }

  private async searchByLastModified(
    objectType: "contacts" | "deals",
    since: Date,
    properties: string[]
  ): Promise<HubSpotObject<any>[]> {
    const results: HubSpotObject<any>[] = [];
    let after: string | undefined;
    do {
      const res: any = await this.http.post(`/crm/v3/objects/${objectType}/search`, {
        filterGroups: [
          { filters: [{ propertyName: "hs_lastmodifieddate", operator: "GTE", value: since.getTime() }] },
        ],
        sorts: [{ propertyName: "hs_lastmodifieddate", direction: "ASCENDING" }],
        properties,
        limit: 100,
        after,
      });
      results.push(...(res.data.results ?? []));
      after = res.data.paging?.next?.after;
    } while (after);
    return results;
  }
}
