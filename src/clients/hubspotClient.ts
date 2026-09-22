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
