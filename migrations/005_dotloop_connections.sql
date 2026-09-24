-- Per-agent Dotloop connections, for a brokerage tenant where many HubSpot
-- users each have their own independent Dotloop login (as opposed to the
-- one-Dotloop-account-per-tenant model tenants.dotloop_account_id already
-- supports). Requested by Mason 2026-09-24: "what if i sign a brokerage
-- where many agents are using the same hubspot but use their own dotloop
-- accounts."
--
-- Confirmed against Dotloop's own public API docs before building this:
-- loop access is restricted to INDIVIDUAL-type Dotloop profiles only (the
-- same constraint behind dotloopClient.ts's resolveProfileId() fix), so a
-- shared COMPANY/OFFICE profile can't be used as a shortcut here -- each
-- agent genuinely needs their own OAuth grant for this connector to sync
-- their deals. See claude/connector-architecture.md for the full writeup.
--
-- A tenant with no rows here behaves exactly as before (single account on
-- tenants.dotloop_account_id/dotloop_profile_id) -- this table only comes
-- into play once at least one agent connection exists for a tenant, see
-- sync/dotloopRouting.ts.
CREATE TABLE IF NOT EXISTS dotloop_connections (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  -- The HubSpot user (deal owner) this Dotloop account belongs to. This is
  -- how sync/dotloopRouting.ts decides which agent's Dotloop account a
  -- given deal should sync into -- see resolveDotloopTargetForDeal().
  hubspot_owner_id    TEXT NOT NULL,
  dotloop_account_id  TEXT,
  -- Cached separately for the same reason as tenants.dotloop_profile_id:
  -- Dotloop webhook events carry a profileId, not an accountId.
  dotloop_profile_id  TEXT,
  status              TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACTIVE')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, hubspot_owner_id)
);

CREATE INDEX IF NOT EXISTS dotloop_connections_profile_idx ON dotloop_connections (dotloop_profile_id);
CREATE INDEX IF NOT EXISTS dotloop_connections_tenant_idx ON dotloop_connections (tenant_id);
