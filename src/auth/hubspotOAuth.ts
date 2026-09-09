import axios from "axios";
import { Provider } from "../db/types";
import { config } from "../config";
import { saveToken } from "./tokenStore";
import { logger } from "../utils/logger";

export function buildHubSpotAuthorizeUrl(state: string): string {
  const url = new URL(config.hubspot.authorizeUrl);
  url.searchParams.set("client_id", config.hubspot.clientId);
  url.searchParams.set("redirect_uri", config.hubspot.redirectUri);
  url.searchParams.set("scope", config.hubspot.scopes.join(" "));
  url.searchParams.set("state", state);
  return url.toString();
}

interface HubSpotTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds
}

async function exchange(body: Record<string, string>): Promise<HubSpotTokenResponse> {
  const res = await axios.post<HubSpotTokenResponse>(
    config.hubspot.tokenUrl,
    new URLSearchParams(body).toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  return res.data;
}

/** Exchanges an authorization code for tokens and persists them, keyed by portal (hub) id. */
export async function handleHubSpotCallback(code: string): Promise<{ portalId: string }> {
  const token = await exchange({
    grant_type: "authorization_code",
    client_id: config.hubspot.clientId,
    client_secret: config.hubspot.clientSecret,
    redirect_uri: config.hubspot.redirectUri,
    code,
  });

  // The access token introspection endpoint tells us which portal (hub_id)
  // this install belongs to, which we use as the account key.
  const info = await axios.get(`https://api.hubapi.com/oauth/v1/access-tokens/${token.access_token}`);
  const portalId = String(info.data.hub_id);

  await saveToken(Provider.HUBSPOT, portalId, {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: new Date(Date.now() + token.expires_in * 1000),
  });

  logger.info({ portalId }, "HubSpot account connected");
  return { portalId };
}

export async function refreshHubSpotToken(refreshToken: string): Promise<HubSpotTokenResponse> {
  return exchange({
    grant_type: "refresh_token",
    client_id: config.hubspot.clientId,
    client_secret: config.hubspot.clientSecret,
    refresh_token: refreshToken,
  });
}
