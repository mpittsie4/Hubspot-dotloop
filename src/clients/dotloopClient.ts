import axios, { AxiosInstance } from "axios";
import { Provider } from "../db/types";
import { config } from "../config";
import { getSoleToken, saveToken } from "../auth/tokenStore";
import { refreshDotloopToken } from "../auth/dotloopOAuth";
import { logger } from "../utils/logger";

export interface DotloopContact {
  id: number;
  firstName?: string;
  lastName?: string;
  email?: string;
  home?: string;
  office?: string;
  address?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  country?: string;
  updated?: string;
}

export interface DotloopLoopSummary {
  id: number;
  name: string;
  status: string;
  transactionType: string;
  updated: string;
  created: string;
  loopUrl?: string;
}

/**
 * Loop "detail" resource: a flat map of section name -> field name -> value.
 * e.g. { "Financials": { "Purchase/Sale Price": "500000" }, ... }
 * Field/section names are fixed strings defined by Dotloop (not arbitrary),
 * see dealLoopMapping.ts for the subset this connector reads/writes.
 */
export type DotloopLoopDetail = Record<string, Record<string, string>>;

export interface DotloopParticipant {
  id: number;
  fullName?: string;
  email?: string;
  role?: string; // e.g. "BUYER", "SELLER", "BUYING_AGENT", ...
}

/** Thin wrapper around the Dotloop Public API v2 with transparent token refresh. */
export class DotloopClient {
  private http: AxiosInstance;
  private accountKey: string;

  private constructor(accountKey: string, accessToken: string) {
    this.accountKey = accountKey;
    this.http = axios.create({
      baseURL: config.dotloop.apiBaseUrl,
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  }

  static async create(): Promise<DotloopClient> {
    const stored = await getSoleToken(Provider.DOTLOOP);
    const needsRefresh = stored.expiresAt.getTime() - Date.now() < 5 * 60 * 1000;

    let accessToken = stored.accessToken;
    if (needsRefresh) {
      const refreshed = await refreshDotloopToken(stored.refreshToken);
      await saveToken(Provider.DOTLOOP, stored.accountKey, {
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token,
        expiresAt: new Date(Date.now() + refreshed.expires_in * 1000),
      });
      accessToken = refreshed.access_token;
      logger.info({ accountId: stored.accountKey }, "Refreshed Dotloop access token");
    }

    return new DotloopClient(stored.accountKey, accessToken);
  }

  /** Resolves the profile id to operate under: config override, or the first profile on the account. */
  async resolveProfileId(): Promise<string> {
    if (config.dotloop.defaultProfileId) return config.dotloop.defaultProfileId;
    const res = await this.http.get("/profile");
    const profiles = res.data?.data ?? [];
    if (!profiles.length) throw new Error("Dotloop account has no profiles");
    return String(profiles[0].id);
  }

  // ---- Contacts ---------------------------------------------------------

  async getContact(id: string | number): Promise<DotloopContact | null> {
    try {
      const res = await this.http.get(`/contact/${id}`);
      return res.data?.data ?? null;
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 404) return null;
      throw err;
    }
  }

  async findContactByEmail(email: string): Promise<DotloopContact | null> {
    // Dotloop's /contact list endpoint doesn't document an email filter key,
    // so we page through and match client-side. Fine at typical brokerage
    // contact-list sizes; if yours is huge, cache an email->id index instead.
    let batchNumber = 1;
    for (;;) {
      const res = await this.http.get("/contact", { params: { batch_size: 100, batch_number: batchNumber } });
      const contacts: DotloopContact[] = res.data?.data ?? [];
      const match = contacts.find((c) => c.email?.toLowerCase() === email.toLowerCase());
      if (match) return match;
      if (contacts.length < 100) return null;
      batchNumber += 1;
    }
  }

  async createContact(contact: Partial<DotloopContact>): Promise<DotloopContact> {
    const res = await this.http.post("/contact", contact);
    return res.data?.data;
  }

  async updateContact(id: string | number, contact: Partial<DotloopContact>): Promise<DotloopContact> {
    const res = await this.http.patch(`/contact/${id}`, contact);
    return res.data?.data;
  }

  /** Contacts updated since `since`, for reconciliation polling. */
  async listRecentContacts(since: Date): Promise<DotloopContact[]> {
    return this.paginate<DotloopContact>("/contact", { filter: `updated_min=${since.toISOString()}` });
  }

  // ---- Loops --------------------------------------------------------------

  async getLoop(profileId: string, loopId: string | number): Promise<DotloopLoopSummary | null> {
    try {
      const res = await this.http.get(`/profile/${profileId}/loop/${loopId}`);
      return res.data?.data ?? null;
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 404) return null;
      throw err;
    }
  }

  async createLoop(profileId: string, body: { name: string; transactionType: string; status?: string }): Promise<DotloopLoopSummary> {
    const res = await this.http.post(`/profile/${profileId}/loop`, body);
    return res.data?.data;
  }

  async updateLoop(profileId: string, loopId: string | number, body: Partial<DotloopLoopSummary>): Promise<DotloopLoopSummary> {
    const res = await this.http.patch(`/profile/${profileId}/loop/${loopId}`, body);
    return res.data?.data;
  }

  async listRecentLoops(profileId: string, since: Date): Promise<DotloopLoopSummary[]> {
    return this.paginate<DotloopLoopSummary>(`/profile/${profileId}/loop`, {
      filter: `updated_min=${since.toISOString()}`,
    });
  }

  async getLoopDetail(profileId: string, loopId: string | number): Promise<DotloopLoopDetail> {
    const res = await this.http.get(`/profile/${profileId}/loop/${loopId}/detail`);
    return res.data?.data ?? {};
  }

  /** Partial update; only include the sections/fields you want to change. */
  async updateLoopDetail(profileId: string, loopId: string | number, patch: DotloopLoopDetail): Promise<DotloopLoopDetail> {
    const res = await this.http.patch(`/profile/${profileId}/loop/${loopId}/detail`, patch);
    return res.data?.data ?? {};
  }

  // ---- Loop participants ---------------------------------------------

  async listParticipants(profileId: string, loopId: string | number): Promise<DotloopParticipant[]> {
    const res = await this.http.get(`/profile/${profileId}/loop/${loopId}/participant`);
    return res.data?.data ?? [];
  }

  async addParticipant(profileId: string, loopId: string | number, participant: Partial<DotloopParticipant>): Promise<DotloopParticipant> {
    const res = await this.http.post(`/profile/${profileId}/loop/${loopId}/participant`, participant);
    return res.data?.data;
  }

  async updateParticipant(
    profileId: string,
    loopId: string | number,
    participantId: string | number,
    participant: Partial<DotloopParticipant>
  ): Promise<DotloopParticipant> {
    const res = await this.http.patch(`/profile/${profileId}/loop/${loopId}/participant/${participantId}`, participant);
    return res.data?.data;
  }

  // ---- Subscriptions (webhooks) ---------------------------------------

  async createSubscription(body: {
    targetType: "USER" | "PROFILE";
    targetId: number;
    eventTypes: string[];
    url: string;
    signingKey: string;
    externalId?: string;
  }): Promise<any> {
    const res = await this.http.post("/subscription", body);
    return res.data?.data ?? res.data;
  }

  async listSubscriptions(): Promise<any[]> {
    const res = await this.http.get("/subscription");
    return res.data?.data ?? [];
  }

  private async paginate<T>(path: string, params: Record<string, string>): Promise<T[]> {
    const results: T[] = [];
    let batchNumber = 1;
    for (;;) {
      const res = await this.http.get(path, { params: { ...params, batch_size: 100, batch_number: batchNumber } });
      const page: T[] = res.data?.data ?? [];
      results.push(...page);
      if (page.length < 100) break;
      batchNumber += 1;
    }
    return results;
  }
}
