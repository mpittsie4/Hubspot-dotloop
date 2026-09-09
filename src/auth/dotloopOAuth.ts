import axios from "axios";
import { Provider } from "../db/types";
import { config } from "../config";
import { saveToken } from "./tokenStore";
import { logger } from "../utils/logger";

export function buildDotloopAuthorizeUrl(state: string): string {
  const url = new URL(config.dotloop.authorizeUrl);
  url.searchParams.set("client_id", config.dotloop.clientId);
  url.searchParams.set("redirect_uri", config.dotloop.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  return url.toString();
}

interface DotloopTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds, ~12h per the docs
  token_type: string;
}

async function exchange(body: Record<string, string>): Promise<DotloopTokenResponse> {
  const res = await axios.post<DotloopTokenResponse>(config.dotloop.tokenUrl, new URLSearchParams(body).toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    auth: { username: config.dotloop.clientId, password: config.dotloop.clientSecret },
  });
  return res.data;
}

/** Exchanges an authorization code for tokens and persists them, keyed by dotloop account id. */
export async function handleDotloopCallback(code: string): Promise<{ accountId: string }> {
  const token = await exchange({
    grant_type: "authorization_code",
    redirect_uri: config.dotloop.redirectUri,
    code,
  });

  const account = await axios.get("https://api-gateway.dotloop.com/public/v2/account", {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  const accountId = String(account.data?.data?.id ?? account.data?.id ?? "default");

  await saveToken(Provider.DOTLOOP, accountId, {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: new Date(Date.now() + token.expires_in * 1000),
  });

  logger.info({ accountId }, "Dotloop account connected");
  return { accountId };
}

export async function refreshDotloopToken(refreshToken: string): Promise<DotloopTokenResponse> {
  return exchange({ grant_type: "refresh_token", refresh_token: refreshToken });
}
