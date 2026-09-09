-- Schema for the HubSpot <-> Dotloop connector. Plain SQL, applied by
-- src/db/migrate.ts (run automatically on server start, and available
-- standalone via `npm run migrate`). Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id            TEXT PRIMARY KEY,
  provider      TEXT NOT NULL CHECK (provider IN ('HUBSPOT', 'DOTLOOP')),
  account_key   TEXT NOT NULL,
  access_token  TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  scope         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, account_key)
);

CREATE TABLE IF NOT EXISTS object_mappings (
  id                  TEXT PRIMARY KEY,
  entity_type         TEXT NOT NULL CHECK (entity_type IN ('CONTACT', 'DEAL_LOOP')),
  hubspot_id          TEXT NOT NULL,
  dotloop_id          TEXT NOT NULL,
  dotloop_profile_id  TEXT,
  last_synced_hash    TEXT,
  last_synced_at      TIMESTAMPTZ,
  last_sync_origin    TEXT CHECK (last_sync_origin IN ('HUBSPOT', 'DOTLOOP')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (entity_type, hubspot_id),
  UNIQUE (entity_type, dotloop_id)
);

CREATE TABLE IF NOT EXISTS sync_logs (
  id          TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  direction   TEXT NOT NULL,
  source_id   TEXT NOT NULL,
  target_id   TEXT,
  status      TEXT NOT NULL,
  message     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sync_logs_entity_created_idx ON sync_logs (entity_type, created_at);

CREATE TABLE IF NOT EXISTS reconcile_state (
  id                    TEXT PRIMARY KEY DEFAULT 'singleton',
  last_hubspot_poll_at  TIMESTAMPTZ,
  last_dotloop_poll_at  TIMESTAMPTZ
);
