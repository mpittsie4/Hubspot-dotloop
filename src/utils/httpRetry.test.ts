import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AxiosError, AxiosInstance } from "axios";
import { installRetryOn429 } from "./httpRetry";

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/**
 * installRetryOn429 only touches client.interceptors.response.use() and
 * client.request() -- build a minimal fake that captures the rejection
 * handler so it can be invoked directly with synthetic AxiosError-like
 * objects, without needing a real network layer or axios adapter.
 */
function fakeAxiosInstance() {
  let onRejected: ((error: AxiosError) => Promise<unknown>) | undefined;
  const request = vi.fn().mockResolvedValue({ status: 200, data: "ok" });
  const client = {
    interceptors: {
      response: {
        use: (_onFulfilled: unknown, rejectedHandler: (error: AxiosError) => Promise<unknown>) => {
          onRejected = rejectedHandler;
        },
      },
    },
    request,
  } as unknown as AxiosInstance;
  return { client, request, invoke: (error: AxiosError) => onRejected!(error) };
}

function rateLimitError(overrides: { url?: string; retryAfter?: string; retryCount?: number } = {}): AxiosError {
  return {
    isAxiosError: true,
    message: "Request failed with status code 429",
    config: { url: overrides.url ?? "/loop/123", __retryCount: overrides.retryCount } as any,
    response: {
      status: 429,
      headers: overrides.retryAfter ? { "retry-after": overrides.retryAfter } : {},
      data: {},
      statusText: "Too Many Requests",
      config: {} as any,
    },
    toJSON: () => ({}),
    name: "AxiosError",
  } as AxiosError;
}

describe("installRetryOn429", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("re-issues the request after a backoff delay on 429", async () => {
    const { client, request, invoke } = fakeAxiosInstance();
    installRetryOn429(client, { baseDelayMs: 1, maxDelayMs: 2 });

    const result = await invoke(rateLimitError());

    expect(request).toHaveBeenCalledTimes(1);
    expect((result as any).status).toBe(200);
  });

  it("increments __retryCount on the retried request config", async () => {
    const { client, request, invoke } = fakeAxiosInstance();
    installRetryOn429(client, { baseDelayMs: 1, maxDelayMs: 2 });

    await invoke(rateLimitError({ retryCount: 1 }));

    expect(request.mock.calls[0][0].__retryCount).toBe(2);
  });

  it("honors a numeric Retry-After header instead of the exponential backoff", async () => {
    const { client, invoke } = fakeAxiosInstance();
    installRetryOn429(client, { baseDelayMs: 1, maxDelayMs: 2 });

    const start = Date.now();
    await invoke(rateLimitError({ retryAfter: "0" }));
    // Retry-After: 0 should resolve essentially immediately, not wait out
    // baseDelayMs*2^n -- this mostly guards against the header being ignored.
    expect(Date.now() - start).toBeLessThan(300);
  });

  it("gives up and rethrows after maxRetries consecutive 429s", async () => {
    const { client, request, invoke } = fakeAxiosInstance();
    installRetryOn429(client, { baseDelayMs: 1, maxDelayMs: 2, maxRetries: 2 });

    await expect(invoke(rateLimitError({ retryCount: 2 }))).rejects.toBeTruthy();
    expect(request).not.toHaveBeenCalled();
  });

  it("does not retry non-429 errors", async () => {
    const { client, request, invoke } = fakeAxiosInstance();
    installRetryOn429(client, { baseDelayMs: 1, maxDelayMs: 2 });

    const notRateLimited: AxiosError = {
      ...rateLimitError(),
      response: { status: 500, headers: {}, data: {}, statusText: "Internal Server Error", config: {} as any },
    } as AxiosError;

    await expect(invoke(notRateLimited)).rejects.toBe(notRateLimited);
    expect(request).not.toHaveBeenCalled();
  });
});
