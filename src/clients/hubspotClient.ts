import axios, { AxiosInstance } from "axios";
import { Provider } from "../db/types";
import { config } from "../config";
import { getSoleToken, saveToken } from "../auth/tokenStore";
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

/**
 * Thin wrapper around the HubSpot CRM v3 API that transparently refreshes
 * the access token when it's near expiry. Assumes a single connected
 * HubSpot portal (see tokenStore.getSoleToken); pass accountKey explicitly
 * if you extend this to multiple portals.
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

  static async create(): Promise<HubSpotClient> {
    const stored = await getSoleToken(Provider.HUBSPOT);
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

  // ---- Custom properties (used to store the Dotloop id on the record) -

  /** Idempotently ensures a custom property exists on an object type. */
  async ensureProperty(objectType: "contacts" | "deals", name: string, label: string) {
    try {
      await this.http.get(`/crm/v3/properties/${objectType}/${name}`);
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        await this.http.post(`/crm/v3/properties/${objectType}`, {
          name,
          label,
          type: "string",
          fieldType: "text",
          groupName: objectType === "contacts" ? "contactinformation" : "dealinformation",
        });
        logger.info({ objectType, name }, "Created HubSpot custom property");
      } else {
        throw err;
      }
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
