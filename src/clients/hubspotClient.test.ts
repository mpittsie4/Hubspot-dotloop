import { describe, it, expect, vi, beforeEach } from "vitest";

// axios.create() is mocked to a controllable fake instance so we can
// capture the response interceptor HubSpotClient installs and invoke it
// directly with a synthetic error -- same approach as dotloopClient.test.ts.
function makeFakeAxiosInstance() {
  const rejectionHandlers: Array<(err: any) => any> = [];
  return {
    defaults: { headers: { common: {} as Record<string, string> } },
    interceptors: {
      response: {
        use: vi.fn((_onFulfilled: any, onRejected: any) => {
          if (onRejected) rejectionHandlers.push(onRejected);
        }),
      },
    },
    request: vi.fn(),
    __rejectionHandlers: rejectionHandlers,
  };
}

let fakeInstance: ReturnType<typeof makeFakeAxiosInstance>;

vi.mock("axios", () => ({
  default: {
    create: vi.fn(() => fakeInstance),
  },
}));

vi.mock("../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../auth/tokenStore", () => ({
  getToken: vi.fn(),
  getSoleToken: vi.fn(),
  saveToken: vi.fn(),
}));

vi.mock("../auth/hubspotOAuth", () => ({
  refreshHubSpotToken: vi.fn(),
}));

import { HubSpotClient } from "./hubspotClient";
import { getToken, saveToken } from "../auth/tokenStore";
import { refreshHubSpotToken } from "../auth/hubspotOAuth";

const FAR_FUTURE = new Date(Date.now() + 6 * 60 * 60 * 1000); // create() shouldn't proactively refresh

function unauthorizedError(url = "/crm/v3/objects/deals/123") {
  return {
    config: { url, headers: {} },
    response: { status: 401, data: { status: "error", category: "EXPIRED_AUTHENTICATION", message: "expired" } },
  };
}

describe("HubSpotClient reactive token refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeInstance = makeFakeAxiosInstance();
    (getToken as any).mockResolvedValue({
      accountKey: "portal_1",
      accessToken: "stale-access-token",
      refreshToken: "still-good-refresh-token",
      expiresAt: FAR_FUTURE, // our own bookkeeping thinks this token is fine
    });
  });

  it("does NOT proactively refresh at create() time when our own expiry tracking says there's plenty of time left", async () => {
    await HubSpotClient.create("portal_1");
    expect(refreshHubSpotToken).not.toHaveBeenCalled();
    expect(saveToken).not.toHaveBeenCalled();
  });

  it("reacts to a live 401 by refreshing immediately and retrying the request once, even though create() saw no reason to refresh", async () => {
    (refreshHubSpotToken as any).mockResolvedValue({
      access_token: "brand-new-access-token",
      refresh_token: "still-good-refresh-token",
      expires_in: 21600,
    });
    const retriedResponse = { status: 200, data: { id: "123" } };
    fakeInstance.request.mockResolvedValue(retriedResponse);

    await HubSpotClient.create("portal_1");

    const reactiveHandler = fakeInstance.__rejectionHandlers[fakeInstance.__rejectionHandlers.length - 1];
    const err = unauthorizedError();

    const result = await reactiveHandler(err);

    expect(refreshHubSpotToken).toHaveBeenCalledWith("still-good-refresh-token");
    expect(saveToken).toHaveBeenCalledWith(
      "HUBSPOT",
      "portal_1",
      expect.objectContaining({ accessToken: "brand-new-access-token" })
    );
    expect(fakeInstance.defaults.headers.common["Authorization"]).toBe("Bearer brand-new-access-token");
    expect(fakeInstance.request).toHaveBeenCalledWith(
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer brand-new-access-token" }) })
    );
    expect(result).toBe(retriedResponse);
  });

  it("only retries once per request -- a second 401 on the already-retried request is rethrown, not looped", async () => {
    await HubSpotClient.create("portal_1");
    const reactiveHandler = fakeInstance.__rejectionHandlers[fakeInstance.__rejectionHandlers.length - 1];
    const err = unauthorizedError();
    err.config = { ...err.config, __hubspotAuthRetried: true } as any;

    await expect(reactiveHandler(err)).rejects.toBe(err);
    expect(refreshHubSpotToken).not.toHaveBeenCalled();
  });

  it("leaves non-401 errors alone (e.g. a 404 or a 500)", async () => {
    await HubSpotClient.create("portal_1");
    const reactiveHandler = fakeInstance.__rejectionHandlers[fakeInstance.__rejectionHandlers.length - 1];

    const notFound = { config: { url: "/x", headers: {} }, response: { status: 404, data: {} } };
    await expect(reactiveHandler(notFound)).rejects.toBe(notFound);

    const serverError = { config: { url: "/x", headers: {} }, response: { status: 500, data: {} } };
    await expect(reactiveHandler(serverError)).rejects.toBe(serverError);

    expect(refreshHubSpotToken).not.toHaveBeenCalled();
  });

  it("forToken() (no refresh token available) leaves a 401 to propagate normally instead of throwing on a missing refresh token", async () => {
    fakeInstance = makeFakeAxiosInstance();
    HubSpotClient.forToken("portal_1", "just-issued-token");
    const reactiveHandler = fakeInstance.__rejectionHandlers[fakeInstance.__rejectionHandlers.length - 1];
    const err = unauthorizedError();

    await expect(reactiveHandler(err)).rejects.toBe(err);
    expect(refreshHubSpotToken).not.toHaveBeenCalled();
  });
});
