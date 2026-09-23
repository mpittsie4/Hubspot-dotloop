import axios, { AxiosInstance } from "axios";
import { Provider } from "../db/types";
import { config } from "../config";
import { getSoleToken, getToken, saveToken } from "../auth/tokenStore";
import { refreshDotloopToken } from "../auth/dotloopOAuth";
import { logger } from "../utils/logger";
import { installRetryOn429 } from "../utils/httpRetry";

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

export interface DotloopFolder {
  id: number;
  name: string;
}

/**
 * Confirmed field shape via Dotloop's public API docs (Subscriptions
 * section): `enabled` is the field that flips to false when Dotloop
 * auto-disables a subscription after repeated delivery failures (or when
 * disabled explicitly) -- see sync/subscriptionHealthCheck.ts, which polls
 * this to catch a subscription going dark before a customer notices their
 * deals stopped updating.
 */
export interface DotloopSubscription {
  id: number | string;
  targetType: "USER" | "PROFILE";
  targetId: number;
  externalId?: string;
  url: string;
  eventTypes: string[];
  enabled: boolean;
}

/**
 * Metadata only -- confirmed against a real loop via scripts/inspectLoopDocuments.ts
 * that Dotloop's public API does not expose the document's actual file
 * bytes (no documented endpoint returns them, and the one plausible
 * undocumented URL shape returns 404). `updated` is what
 * sync/documentSync.ts watches to tell a newly-added document from one
 * that was merely re-touched.
 */
export interface DotloopDocument {
  id: number;
  name: string;
  folderId: number;
  created?: string;
  updated?: string;
}

/**
 * Thin wrapper around the Dotloop Public API v2 with transparent token
 * refresh. Pass the tenant's Dotloop account id as accountKey to operate as
 * that tenant (see TenantRow.dotloopAccountId and the sync layer, which
 * does this for every real sync call); omitting it falls back to
 * tokenStore.getSoleToken for callers that predate multi-tenancy and still
 * assume a single connected account.
 */
/**
 * Dotloop's `updated_min` filter rejects a standard `Date#toISOString()`
 * value ("date string invalid: Unparseable date") because it includes
 * millisecond precision (e.g. "2026-09-15T14:45:00.323Z") -- Dotloop wants
 * whole-second precision. Strips the fractional seconds before the
 * trailing "Z" so listRecentContacts/listRecentLoops (and therefore
 * reconcile.ts's periodic poll, for every tenant) don't 400 on every call.
 */
function toDotloopFilterDate(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export class DotloopClient {
  private http: AxiosInstance;
  private accountKey: string;

  private constructor(accountKey: string, accessToken: string) {
    this.accountKey = accountKey;
    this.http = axios.create({
      baseURL: config.dotloop.apiBaseUrl,
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    // Dotloop's API is documented as rate-limited (429) without published
    // thresholds; retry transient 429s with backoff rather than failing the
    // sync attempt outright. See claude/pre-launch-improvement-research.md
    // item 2 and utils/httpRetry.ts.
    installRetryOn429(this.http, { label: "dotloop" });
  }

  static async create(accountKey?: string): Promise<DotloopClient> {
    const stored = accountKey ? await getToken(Provider.DOTLOOP, accountKey) : await getSoleToken(Provider.DOTLOOP);
    if (!stored) {
      throw new Error(`No connected Dotloop token found for account ${accountKey}.`);
    }
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

  /**
   * Resolves the profile id to operate under: config override, or the best
   * guess among the account's own profiles.
   *
   * Dotloop's API docs state loop access is "currently restricted to
   * INDIVIDUAL profiles only" -- an account can also have TEAM, OFFICE,
   * COMPANY, ASSOCIATION, or NATIONAL_PARTNER profiles (GET /profile's
   * `type` field), and nothing guarantees an INDIVIDUAL one comes back
   * first. Picking `profiles[0]` blindly (the old behavior) would silently
   * select a non-individual profile for an account structured that way --
   * no error, just zero loops ever visible through it. Found during
   * pre-launch research ahead of onboarding a second real customer
   * (2026-09-23) -- see claude/pre-launch-improvement-research.md.
   *
   * Prefers an INDIVIDUAL profile (the one marked `default` if more than
   * one qualifies), and falls back to the account's own default profile --
   * or the first one -- with a loud warning if no INDIVIDUAL profile exists
   * at all, so a tenant stuck in that situation shows up in the logs
   * instead of just mysteriously never syncing anything.
   */
  async resolveProfileId(): Promise<string> {
    if (config.dotloop.defaultProfileId) return config.dotloop.defaultProfileId;
    const res = await this.http.get("/profile");
    const profiles: Array<{ id: number | string; name?: string; type?: string; default?: boolean }> =
      res.data?.data ?? [];
    if (!profiles.length) throw new Error("Dotloop account has no profiles");

    const individualProfiles = profiles.filter((p) => p.type === "INDIVIDUAL");
    if (individualProfiles.length > 0) {
      const chosen = individualProfiles.find((p) => p.default) ?? individualProfiles[0];
      if (individualProfiles.length > 1) {
        logger.info(
          { accountId: this.accountKey, profiles: individualProfiles.map((p) => ({ id: p.id, name: p.name })), chosenId: chosen.id },
          "Multiple INDIVIDUAL Dotloop profiles found; chose the default one (or the first)"
        );
      }
      return String(chosen.id);
    }

    const fallback = profiles.find((p) => p.default) ?? profiles[0];
    logger.warn(
      {
        accountId: this.accountKey,
        profiles: profiles.map((p) => ({ id: p.id, name: p.name, type: p.type, default: p.default })),
        chosenId: fallback.id,
        chosenType: fallback.type,
      },
      "No INDIVIDUAL Dotloop profile found on this account -- Dotloop's API restricts loop access to " +
        "INDIVIDUAL profiles, so syncing under this profile type will likely see zero loops. Falling back " +
        "to the account's default (or first) profile, but this needs a human to check the account's actual " +
        "Dotloop profile setup."
    );
    return String(fallback.id);
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
    return this.paginate<DotloopContact>("/contact", { filter: `updated_min=${toDotloopFilterDate(since)}` });
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
      filter: `updated_min=${toDotloopFilterDate(since)}`,
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

  async listSubscriptions(): Promise<DotloopSubscription[]> {
    const res = await this.http.get("/subscription");
    return res.data?.data ?? [];
  }

  // ---- Documents (metadata only -- see DotloopDocument's doc comment) --

  async listFolders(profileId: string, loopId: string | number): Promise<DotloopFolder[]> {
    const res = await this.http.get(`/profile/${profileId}/loop/${loopId}/folder`);
    return res.data?.data ?? [];
  }

  async listDocuments(profileId: string, loopId: string | number, folderId: string | number): Promise<DotloopDocument[]> {
    const res = await this.http.get(`/profile/${profileId}/loop/${loopId}/folder/${folderId}/document`);
    return res.data?.data ?? [];
  }

  /**
   * Low-level escape hatch for one-off exploration scripts (see
   * scripts/inspectLoopDocuments.ts) against endpoints/response shapes this
   * client doesn't have a typed method for yet -- e.g. checking whether an
   * endpoint the official docs only describe as JSON-metadata actually
   * returns binary content for a different Accept header or path. GET only.
   * Not meant to be called from the sync path -- add a proper typed method
   * above once behavior against the real API is confirmed, the same way
   * every other method on this class came to exist.
   */
  async rawRequest(
    path: string,
    opts: { headers?: Record<string, string>; responseType?: "json" | "arraybuffer" } = {}
  ): Promise<{ status: number; headers: Record<string, any>; data: any }> {
    try {
      const res = await this.http.get(path, {
        headers: opts.headers,
        responseType: opts.responseType === "arraybuffer" ? "arraybuffer" : "json",
        validateStatus: () => true, // inspect error responses too, instead of throwing
      });
      return { status: res.status, headers: res.headers as any, data: res.data };
    } catch (err) {
      if (axios.isAxiosError(err) && err.response) {
        return { status: err.response.status, headers: err.response.headers as any, data: err.response.data };
      }
      throw err;
    }
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
