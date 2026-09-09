import crypto from "node:crypto";

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
 * proxy that rewrites the path or host.
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

  const base = `${method}${uri}${rawBody}${timestamp}`;
  const expected = crypto.createHmac("sha256", clientSecret).update(base, "utf8").digest("base64");

  const ok = timingSafeEqualStrings(expected, signature);
  return ok ? { valid: true } : { valid: false, reason: "signature_mismatch" };
}

/**
 * Verifies a Dotloop subscription webhook event, signed with HMAC-SHA1 over
 * the raw request body and sent in `X-DOTLOOP-SIGNATURE`, with
 * `X-DOTLOOP-TIMESTAMP` as a freshness check. Dotloop's docs don't publish
 * an exact max-age; we default to 5 minutes to match HubSpot's convention
 * and reject obviously-replayed events. Adjust if Dotloop's docs specify
 * otherwise for your subscription.
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

  const expected = crypto.createHmac("sha1", signingSecret).update(rawBody, "utf8").digest("hex");
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
