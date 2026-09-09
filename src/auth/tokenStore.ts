import crypto from "node:crypto";
import { pool } from "../db/client";
import { Provider, OAuthTokenRow } from "../db/types";

export interface StoredToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scope?: string;
}

function toRow(r: any): OAuthTokenRow {
  return {
    id: r.id,
    provider: r.provider,
    accountKey: r.account_key,
    accessToken: r.access_token,
    refreshToken: r.refresh_token,
    expiresAt: r.expires_at,
    scope: r.scope,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Upsert the token row for a given provider + account (portal id / profile id). */
export async function saveToken(provider: Provider, accountKey: string, token: StoredToken): Promise<OAuthTokenRow> {
  const res = await pool.query(
    `INSERT INTO oauth_tokens (id, provider, account_key, access_token, refresh_token, expires_at, scope, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (provider, account_key) DO UPDATE SET
       access_token = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token,
       expires_at = EXCLUDED.expires_at,
       scope = EXCLUDED.scope,
       updated_at = now()
     RETURNING *`,
    [crypto.randomUUID(), provider, accountKey, token.accessToken, token.refreshToken, token.expiresAt, token.scope ?? null]
  );
  return toRow(res.rows[0]);
}

export async function getToken(provider: Provider, accountKey: string): Promise<OAuthTokenRow | null> {
  const res = await pool.query(`SELECT * FROM oauth_tokens WHERE provider = $1 AND account_key = $2`, [
    provider,
    accountKey,
  ]);
  return res.rows[0] ? toRow(res.rows[0]) : null;
}

/**
 * Returns the single connected account for a provider, for setups (the
 * common case) where exactly one HubSpot portal and one Dotloop profile
 * are connected. Throws a descriptive error if zero or multiple are found
 * so callers don't silently sync against the wrong account.
 */
export async function getSoleToken(provider: Provider): Promise<OAuthTokenRow> {
  const res = await pool.query(`SELECT * FROM oauth_tokens WHERE provider = $1`, [provider]);
  const tokens = res.rows.map(toRow);
  if (tokens.length === 0) {
    throw new Error(
      `No connected ${provider} account found. Visit /auth/${provider.toLowerCase()}/start to connect one.`
    );
  }
  if (tokens.length > 1) {
    throw new Error(
      `Multiple connected ${provider} accounts found (${tokens
        .map((t) => t.accountKey)
        .join(", ")}). This scaffold assumes a single account per provider — ` +
        `pass accountKey explicitly if you need multi-account support.`
    );
  }
  return tokens[0];
}
