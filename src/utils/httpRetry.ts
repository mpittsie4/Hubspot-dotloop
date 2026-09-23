import { AxiosError, AxiosInstance } from "axios";
import { logger } from "./logger";

export interface RetryOn429Options {
  /** How many times to retry a single request before giving up. Default 4. */
  maxRetries?: number;
  /** Base delay for exponential backoff when the server sends no Retry-After header. Default 500ms. */
  baseDelayMs?: number;
  /** Ceiling for the exponential-backoff delay (Retry-After is honored as-is, uncapped). Default 8000ms. */
  maxDelayMs?: number;
  /** Short tag included in log lines, e.g. "dotloop". */
  label?: string;
}

function parseRetryAfterMs(headerValue: unknown): number | null {
  if (typeof headerValue !== "string" || headerValue.length === 0) return null;
  const seconds = Number(headerValue);
  if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(headerValue);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Installs an axios response interceptor that retries HTTP 429 ("rate
 * limited") responses with exponential backoff -- honoring a `Retry-After`
 * response header when the server sends one -- instead of letting the
 * first 429 fail the whole sync attempt outright.
 *
 * Dotloop's public API docs document 429 rate limiting without specifying
 * exact thresholds, and dotloopClient.ts previously had no handling for it
 * at all (see claude/pre-launch-improvement-research.md, item 2): a burst
 * of calls -- a new tenant's historical backfill, or several tenants'
 * reconciliation polls landing close together as more customers are added
 * -- could get individual calls rate-limited and just fail/log an error,
 * relying on the next 15-minute reconciliation pass to eventually pick it
 * up. This closes that gap for the common transient case without masking
 * a genuinely persistent problem: it gives up after `maxRetries` and lets
 * the error surface normally, so a real outage is still visible in logs.
 *
 * A small random jitter is added to every delay so that if several tenants'
 * calls get rate-limited by the same burst, their retries don't all land on
 * the same next instant and immediately re-trip the limit.
 */
export function installRetryOn429(client: AxiosInstance, options: RetryOn429Options = {}): void {
  const maxRetries = options.maxRetries ?? 4;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 8000;
  const label = options.label ?? "http";

  client.interceptors.response.use(undefined, async (error: AxiosError) => {
    const requestConfig = error.config as (typeof error.config & { __retryCount?: number }) | undefined;

    if (!requestConfig || error.response?.status !== 429) {
      throw error;
    }

    const retryCount = requestConfig.__retryCount ?? 0;
    if (retryCount >= maxRetries) {
      logger.error(
        { label, url: requestConfig.url, retryCount },
        `Giving up on ${label} request after ${retryCount} retries -- still rate limited (429)`
      );
      throw error;
    }

    const retryAfterMs = parseRetryAfterMs(error.response?.headers?.["retry-after"]);
    const backoffMs = Math.min(baseDelayMs * 2 ** retryCount, maxDelayMs);
    const delayMs = (retryAfterMs ?? backoffMs) + Math.floor(Math.random() * 250);

    requestConfig.__retryCount = retryCount + 1;
    logger.warn(
      {
        label,
        url: requestConfig.url,
        attempt: requestConfig.__retryCount,
        maxRetries,
        delayMs,
        honoredRetryAfterHeader: retryAfterMs !== null,
      },
      `Rate limited by ${label} (429); retrying after backoff`
    );

    await sleep(delayMs);
    return client.request(requestConfig);
  });
}
