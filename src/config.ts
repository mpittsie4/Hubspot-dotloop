import "dotenv/config";

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    // We intentionally don't throw at import time in dev so `tsc --noEmit`
    // and unit tests can run without a full .env. Real usage paths that
    // need a missing var will throw when they try to use it.
    // eslint-disable-next-line no-console
    console.warn(`[config] Missing environment variable: ${name}`);
    return "";
  }
  return value;
}

// Resolves the public HTTPS URL this server is reachable at, in priority
// order:
//   1. PUBLIC_BASE_URL, if you set it explicitly.
//   2. RENDER_EXTERNAL_URL — Render injects this automatically for every
//      web service, so a Blueprint deploy (see render.yaml) needs zero
//      manual URL configuration; the OAuth redirect URIs and webhook
//      target URLs below are correct the moment the service is live.
//   3. localhost, for local dev.
const publicBaseUrl = (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "http://localhost:3000").replace(
  /\/$/,
  ""
);

export const config = {
  port: Number(process.env.PORT ?? 3000),
  publicBaseUrl,
  logLevel: process.env.LOG_LEVEL ?? "info",

  hubspot: {
    clientId: required("HUBSPOT_CLIENT_ID"),
    clientSecret: required("HUBSPOT_CLIENT_SECRET"),
    appId: required("HUBSPOT_APP_ID"),
    scopes: (process.env.HUBSPOT_SCOPES ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    // Override with HUBSPOT_REDIRECT_URI only if it needs to differ from
    // {publicBaseUrl}/auth/hubspot/callback (must exactly match what's
    // registered in the HubSpot app's Auth tab either way).
    redirectUri: process.env.HUBSPOT_REDIRECT_URI || `${publicBaseUrl}/auth/hubspot/callback`,
    webhookSigningSecret: process.env.HUBSPOT_WEBHOOK_SIGNING_SECRET ?? "",
    authorizeUrl: "https://app.hubspot.com/oauth/authorize",
    tokenUrl: "https://api.hubapi.com/oauth/v1/token",
    apiBaseUrl: "https://api.hubapi.com",
  },

  dotloop: {
    clientId: required("DOTLOOP_CLIENT_ID"),
    clientSecret: required("DOTLOOP_CLIENT_SECRET"),
    redirectUri: process.env.DOTLOOP_REDIRECT_URI || `${publicBaseUrl}/auth/dotloop/callback`,
    defaultProfileId: process.env.DOTLOOP_DEFAULT_PROFILE_ID ?? "",
    webhookSigningSecret: process.env.DOTLOOP_WEBHOOK_SIGNING_SECRET ?? "",
    authorizeUrl: "https://auth.dotloop.com/oauth/authorize",
    tokenUrl: "https://auth.dotloop.com/oauth/token",
    revokeUrl: "https://auth.dotloop.com/oauth/token/revoke",
    apiBaseUrl: "https://api-gateway.dotloop.com/public/v2",
  },

  sync: {
    reconcileIntervalMinutes: Number(process.env.RECONCILE_INTERVAL_MINUTES ?? 15),
    reconcileInitialLookbackMinutes: Number(process.env.RECONCILE_INITIAL_LOOKBACK_MINUTES ?? 1440),
  },
};
