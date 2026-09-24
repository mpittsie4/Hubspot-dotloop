import crypto from "node:crypto";

/**
 * HubSpot's v3 signing scheme hashes the request URI with a handful of
 * percent-encoded characters in the *query string* selectively decoded back
 * to their literal form first -- it does NOT hash the raw, fully-encoded
 * URL a framework like Express hands you via `req.originalUrl`, and it does
 * NOT fully decode the query string either (encoded `&`/`=`/space and
 * anything outside this list must stay encoded, since those are structural
 * or would change the string's meaning). Confirmed against HubSpot's own
 * "Validating requests" docs (developers.hubspot.com), 2026-09-24, after a
 * live signature_mismatch on the Deal Sync Status card's proxy call the
 * moment its query string first contained an "@" (the new `viewerEmail=`
 * param added for brokerage self-serve connect) -- every prior query param
 * here was a plain numeric id, so this gap silently never mattered until
 * then. Table per HubSpot's docs:
 *   %3A -> :   %2F -> /   %3F -> ?   %40 -> @   %21 -> !   %24 -> $
 *   %27 -> '   %28 -> (   %29 -> )   %2A -> *   %2C -> ,   %3B -> ;
 * Only the query-string portion (after the first "?") is touched; the path
 * and the "?" delimiter itself are left alone.
 */
const HUBSPOT_V3_QUERY_DECODE_MAP: Record<string, string> = {
  "%3A": ":",
  "%2F": "/",
  "%3F": "?",
  "%40": "@",
  "%21": "!",
  "%24": "$",
  "%27": "'",
  "%28": "(",
  "%29": ")",
  "%2A": "*",
  "%2C": ",",
  "%3B": ";",
};

function normalizeHubSpotV3Uri(uri: string): string {
  const queryIndex = uri.indexOf("?");
  if (queryIndex === -1) return uri;

  const base = uri.slice(0, queryIndex + 1); // keep the "?" itself untouched
  const query = uri.slice(queryIndex + 1);
  const normalizedQuery = query.replace(
    /%3A|%2F|%3F|%40|%21|%24|%27|%28|%29|%2A|%2C|%3B/gi,
    (match) => HUBSPOT_V3_QUERY_DECODE_MAP[match.toUpperCase()] ?? match
  );
  return base + normalizedQuery;
}

/**
 * Verifies a HubSpot webhook request signed with the v3 scheme.
 *
 * HubSpot builds: `${method}${uri}${rawBody}${timestamp}`, HMAC-SHA256s it
 * with the app's client secret, base64-encodes the result, and sends it in
 * the `X-HubSpot-Signature-v3` header alongside `X-HubSpot-Request-Timestamp`.
 * Requests older than 5 minutes must be rejected.
 *
 * `uri` must be the *full* URL HubSpot called (including querystring),
 * exactly as configured for your webhook target — mismatches here are the
 * most common cause of "valid" webhooks failing verification behind a
 * proxy that rewrites the path or host. It's normalized per
 * `normalizeHubSpotV3Uri()` above before hashing, matching what HubSpot
 * itself hashed on its side.
 */
export function verifyHubSpotSignature(params: {
  method: string;
  uri: string;
  rawBody: string;
  timestamp: string;
  signature: string;
  clientSecret: string;
  maxAgeMs?: number;
}): { valid: boolean; reason?: string } {
  const { method, uri, rawBody, timestamp, signature, clientSecret, maxAgeMs = 5 * 60 * 1000 } = params;

  const age = Date.now() - Number(timestamp);
  if (!Number.isFinite(age) || age > maxAgeMs || age < -maxAgeMs) {
    return { valid: false, reason: "stale_or_invalid_timestamp" };
  }

  const normalizedUri = normalizeHubSpotV3Uri(uri);
  const base = `${method}${normalizedUri}${rawBody}${timestamp}`;
  const expected = crypto.createHmac("sha256", clientSecret).update(base, "utf8").digest("base64");

  const ok = timingSafeEqualStrings(expected, signature);
  return ok ? { valid: true } : { valid: false, reason: "signature_mismatch" };
}

/**
 * Verifies a Dotloop subscription webhook event, signed with HMAC-SHA1 over
 * `${timestamp}.${rawBody}` (timestamp and raw request body joined with a
 * literal dot -- NOT the raw body alone; see
 * https://dotloop.github.io/public-api/ webhook signature docs), sent in
 * the `X-Dotloop-Webhook-Signature` header with `X-Dotloop-Webhook-Timestamp`
 * (Unix seconds) as a freshness check. Dotloop's docs don't publish an exact
 * max-age; we default to 5 minutes to match HubSpot's convention and reject
 * obviously-replayed events. Adjust if Dotloop's docs specify otherwise for
 * your subscription.
 */
export function verifyDotloopSignature(params: {
  rawBody: string;
  timestamp: string;
  signature: string;
  signingSecret: string;
  maxAgeMs?: number;
}): { valid: boolean; reason?: string } {
  const { rawBody, timestamp, signature, signingSecret, maxAgeMs = 5 * 60 * 1000 } = params;

  const tsMs = Number(timestamp) > 1e12 ? Number(timestamp) : Number(timestamp) * 1000;
  const age = Date.now() - tsMs;
  if (!Number.isFinite(age) || age > maxAgeMs || age < -maxAgeMs) {
    return { valid: false, reason: "stale_or_invalid_timestamp" };
  }

  const signedContent = `${timestamp}.${rawBody}`;
  const expected = crypto.createHmac("sha1", signingSecret).update(signedContent, "utf8").digest("hex");
  const ok = timingSafeEqualStrings(expected, signature);
  return ok ? { valid: true } : { valid: false, reason: "signature_mismatch" };
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Deterministic hash of the fields we actually sync, used to detect
 * no-op writes and to recognize "this update is just an echo of the one
 * we just pushed" so the two systems don't ping-pong forever.
 */
export function hashSyncPayload(payload: Record<string, unknown>): string {
  const normalized = Object.keys(payload)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      const v = payload[key];
      acc[key] = v === undefined || v === null ? "" : String(v).trim();
      return acc;
    }, {});
  return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}
