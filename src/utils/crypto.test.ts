import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { verifyHubSpotSignature } from "./crypto";

const CLIENT_SECRET = "test-client-secret";

/**
 * Computes the signature the way HubSpot itself does: hashing the URI with
 * the documented set of query-string characters already decoded to their
 * literal form (this is what a real X-HubSpot-Signature-v3 header contains
 * -- see crypto.ts's normalizeHubSpotV3Uri() doc comment for the source).
 */
function signAsHubSpotWould(method: string, decodedUri: string, rawBody: string, timestamp: string): string {
  const base = `${method}${decodedUri}${rawBody}${timestamp}`;
  return crypto.createHmac("sha256", CLIENT_SECRET).update(base, "utf8").digest("base64");
}

describe("verifyHubSpotSignature", () => {
  it("accepts a signature computed the way HubSpot actually computes it -- decoded @ in the query string", () => {
    // What Express hands us: still percent-encoded, e.g. from
    // `viewerEmail=${encodeURIComponent(email)}` in DealSyncCard.tsx.
    const rawUriAsReceived = "https://connect.theatlashub.io/api/hubspot/deals/123/dotloop-status?portalId=51120972&viewerEmail=mason%40theatlashub.io";
    // What HubSpot actually hashed on its side: %40 decoded to a literal @.
    const uriHubSpotSigned = "https://connect.theatlashub.io/api/hubspot/deals/123/dotloop-status?portalId=51120972&viewerEmail=mason@theatlashub.io";
    const timestamp = String(Date.now());
    const signature = signAsHubSpotWould("GET", uriHubSpotSigned, "", timestamp);

    const result = verifyHubSpotSignature({
      method: "GET",
      uri: rawUriAsReceived,
      rawBody: "",
      timestamp,
      signature,
      clientSecret: CLIENT_SECRET,
    });

    expect(result).toEqual({ valid: true });
  });

  it("rejects a signature verified against the raw, un-normalized URI -- the pre-fix bug", () => {
    // Same setup, but simulate the OLD behavior: hashing the raw encoded
    // URI instead of the HubSpot-normalized one. This is what caused the
    // real signature_mismatch on the Deal Sync Status card once its query
    // string first contained an "@" (viewerEmail, added for brokerage
    // self-serve connect) -- every query param before that was numeric.
    const rawUriAsReceived = "https://connect.theatlashub.io/api/hubspot/deals/123/dotloop-status?portalId=51120972&viewerEmail=mason%40theatlashub.io";
    const timestamp = String(Date.now());
    const signatureOverRawUri = signAsHubSpotWould("GET", rawUriAsReceived, "", timestamp);

    const result = verifyHubSpotSignature({
      method: "GET",
      uri: rawUriAsReceived,
      rawBody: "",
      timestamp,
      signature: signatureOverRawUri,
      clientSecret: CLIENT_SECRET,
    });

    // This signature was computed over the raw (not HubSpot-normalized) URI,
    // so it must NOT match what our function now hashes.
    expect(result).toEqual({ valid: false, reason: "signature_mismatch" });
  });

  it("normalizes multiple documented characters (: / ? @ ! $ ' ( ) * , ;), not just @", () => {
    const rawUri = "https://connect.theatlashub.io/api/x?a=%3A%2F%3F%40%21%24%27%28%29%2A%2C%3B";
    const decodedUri = "https://connect.theatlashub.io/api/x?a=:/?@!$'()*,;";
    const timestamp = String(Date.now());
    const signature = signAsHubSpotWould("GET", decodedUri, "", timestamp);

    const result = verifyHubSpotSignature({
      method: "GET",
      uri: rawUri,
      rawBody: "",
      timestamp,
      signature,
      clientSecret: CLIENT_SECRET,
    });

    expect(result).toEqual({ valid: true });
  });

  it("does not touch structural or unlisted encoded characters -- %26 (&), %3D (=), and %20 stay encoded", () => {
    // Decoding these would corrupt query-string parsing (a literal `&` or
    // `=` inside a value looks identical to a delimiter once decoded), so
    // HubSpot's docs list only a specific character set -- confirm ours
    // matches that boundary rather than decoding everything.
    const uriWithUnlistedEncoding = "https://connect.theatlashub.io/api/x?a=%26%3D%20";
    const timestamp = String(Date.now());
    // Signed against the SAME (still-encoded) string, since these characters
    // are never decoded.
    const signature = signAsHubSpotWould("GET", uriWithUnlistedEncoding, "", timestamp);

    const result = verifyHubSpotSignature({
      method: "GET",
      uri: uriWithUnlistedEncoding,
      rawBody: "",
      timestamp,
      signature,
      clientSecret: CLIENT_SECRET,
    });

    expect(result).toEqual({ valid: true });
  });

  it("leaves the path untouched even if it contains characters from the decode table before the '?'", () => {
    // %3A etc. should only ever be normalized in the query string, never in
    // the path -- verify a path segment isn't accidentally mangled.
    const uri = "https://connect.theatlashub.io/api/x%3Ay?a=%40b";
    const timestamp = String(Date.now());
    // Only the query string (after "?") gets normalized: %3A in the path
    // stays as-is, %40 in the query becomes @.
    const decodedForSigning = "https://connect.theatlashub.io/api/x%3Ay?a=@b";
    const signature = signAsHubSpotWould("GET", decodedForSigning, "", timestamp);

    const result = verifyHubSpotSignature({
      method: "GET",
      uri,
      rawBody: "",
      timestamp,
      signature,
      clientSecret: CLIENT_SECRET,
    });

    expect(result).toEqual({ valid: true });
  });

  it("still rejects a stale timestamp", () => {
    const uri = "https://connect.theatlashub.io/api/x";
    const staleTimestamp = String(Date.now() - 10 * 60 * 1000); // 10 minutes old
    const signature = signAsHubSpotWould("GET", uri, "", staleTimestamp);

    const result = verifyHubSpotSignature({
      method: "GET",
      uri,
      rawBody: "",
      timestamp: staleTimestamp,
      signature,
      clientSecret: CLIENT_SECRET,
    });

    expect(result).toEqual({ valid: false, reason: "stale_or_invalid_timestamp" });
  });

  it("still rejects a signature computed with the wrong client secret", () => {
    const uri = "https://connect.theatlashub.io/api/x";
    const timestamp = String(Date.now());
    const base = `GET${uri}${timestamp}`;
    const wrongSignature = crypto.createHmac("sha256", "someone-elses-secret").update(base, "utf8").digest("base64");

    const result = verifyHubSpotSignature({
      method: "GET",
      uri,
      rawBody: "",
      timestamp,
      signature: wrongSignature,
      clientSecret: CLIENT_SECRET,
    });

    expect(result).toEqual({ valid: false, reason: "signature_mismatch" });
  });
});
