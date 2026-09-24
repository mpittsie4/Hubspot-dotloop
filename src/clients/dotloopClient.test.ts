import { describe, it, expect, vi, beforeEach } from "vitest";

// axios.create() is mocked to a controllable fake instance so we can
// capture the response interceptor DotloopClient installs and invoke it
// directly with a synthetic error, instead of standing up a real HTTP
// mock server for what is otherwise a thin wrapper.
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

vi.mock("../utils/httpRetry", () => ({
  installRetryOn429: vi.fn(),
}));

vi.mock("../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../auth/tokenStore", () => ({
  getToken: vi.fn(),
  getSoleToken: vi.fn(),
  saveToken: vi.fn(),
}));

vi.mock("../auth/dotloopOAuth", () => ({
  refreshDotloopToken: vi.fn(),
}));

import { DotloopClient } from "./dotloopClient";
import { getToken, saveToken } from "../auth/tokenStore";
import { refreshDotloopToken } from "../auth/dotloopOAuth";

const FAR_FUTURE = new Date(Date.now() + 6 * 60 * 60 * 1000); // 6h out -- create() shouldn't proactively refresh

function invalidTokenError(url = "/account") {
  return {
    config: { url, headers: {} },
    response: { status: 401, data: { error: "invalid_token", error_description: "Access token expired: abc123" } },
  };
}

describe("DotloopClient reactive token refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeInstance = makeFakeAxiosInstance();
    (getToken as any).mockResolvedValue({
      accountKey: "acct_1",
      accessToken: "stale-access-token",
      refreshToken: "still-good-refresh-token",
      expiresAt: FAR_FUTURE, // our own bookkeeping thinks this token is fine
    });
  });

  it("does NOT proactively refresh at create() time when our own expiry tracking says there's plenty of time left", async () => {
    await DotloopClient.create("acct_1");
    expect(refreshDotloopToken).not.toHaveBeenCalled();
    expect(saveToken).not.toHaveBeenCalled();
  });

  it("reacts to a live invalid_token 401 by refreshing immediately and retrying the request once, even though create() saw no reason to refresh", async () => {
    (refreshDotloopToken as any).mockResolvedValue({
      access_token: "brand-new-access-token",
      refresh_token: "still-good-refresh-token",
      expires_in: 43199,
      token_type: "bearer",
    });
    const retriedResponse = { status: 200, data: { id: "acct_1" } };
    fakeInstance.request.mockResolvedValue(retriedResponse);

    await DotloopClient.create("acct_1");

    // installReactiveTokenRefresh() is the second response interceptor
    // registered (after installRetryOn429, which is mocked to a no-op).
    const reactiveHandler = fakeInstance.__rejectionHandlers[fakeInstance.__rejectionHandlers.length - 1];
    const err = invalidTokenError();

    const result = await reactiveHandler(err);

    expect(refreshDotloopToken).toHaveBeenCalledWith("still-good-refresh-token");
    expect(saveToken).toHaveBeenCalledWith(
      "DOTLOOP",
      "acct_1",
      expect.objectContaining({ accessToken: "brand-new-access-token" })
    );
    expect(fakeInstance.defaults.headers.common["Authorization"]).toBe("Bearer brand-new-access-token");
    expect(fakeInstance.request).toHaveBeenCalledWith(
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer brand-new-access-token" }) })
    );
    expect(result).toBe(retriedResponse);
  });

  it("only retries once per request -- a second invalid_token 401 on the already-retried request is rethrown, not looped", async () => {
    await DotloopClient.create("acct_1");
    const reactiveHandler = fakeInstance.__rejectionHandlers[fakeInstance.__rejectionHandlers.length - 1];
    const err = invalidTokenError();
    err.config = { ...err.config, __dotloopAuthRetried: true } as any;

    await expect(reactiveHandler(err)).rejects.toBe(err);
    expect(refreshDotloopToken).not.toHaveBeenCalled();
  });

  it("leaves non-invalid_token errors alone (e.g. a plain 401 with a different error shape, or a 500)", async () => {
    await DotloopClient.create("acct_1");
    const reactiveHandler = fakeInstance.__rejectionHandlers[fakeInstance.__rejectionHandlers.length - 1];

    const unrelated401 = { config: { url: "/x", headers: {} }, response: { status: 401, data: { error: "unauthorized" } } };
    await expect(reactiveHandler(unrelated401)).rejects.toBe(unrelated401);

    const serverError = { config: { url: "/x", headers: {} }, response: { status: 500, data: {} } };
    await expect(reactiveHandler(serverError)).rejects.toBe(serverError);

    expect(refreshDotloopToken).not.toHaveBeenCalled();
  });
});
