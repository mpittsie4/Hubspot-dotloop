-- Multi-tenant support: Phase 1 of the public-distribution roadmap (see
-- claude/public-distribution-roadmap.md in the Claude Project). Adds a
-- tenants table linking each customer's HubSpot portal + Dotloop account
-- plus their own pipeline/stage mapping. No self-serve onboarding wizard
-- yet (see "Decisions made" in the roadmap doc) -- Mason creates a tenant
-- row via POST /auth/admin/tenants, sends the customer the two connect
-- URLs it returns, then edits pipelines_config directly for that
-- customer's real HubSpot pipeline/stage ids.

CREATE TABLE IF NOT EXISTS tenants (
  id                  TEXT PRIMARY KEY,
  name                TEXT,
  hubspot_portal_id   TEXT UNIQUE,
  dotloop_account_id  TEXT UNIQUE,
  -- Cached separately from dotloop_account_id because Dotloop webhook
  -- events carry a profileId, not an accountId, and one account can have
  -- more than one profile -- see resolveProfileId() in dotloopClient.ts
  -- and the backfill helpers in sync/reconcile.ts / db/tenantRepo.ts.
  dotloop_profile_id  TEXT UNIQUE,
  pipelines_config    JSONB NOT NULL DEFAULT '[]'::jsonb,
  status              TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACTIVE', 'DISABLED')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Backward-compatible seed: turn whatever's already connected (the
-- pre-tenant sandbox setup) into tenant #1, with Mason's real
-- pipeline/stage config (previously the hardcoded PIPELINES constant in
-- src/sync/dealLoopMapping.ts), so existing sync keeps working unchanged
-- the moment this migration runs. No-op after the first run.
INSERT INTO tenants (id, name, hubspot_portal_id, dotloop_account_id, pipelines_config, status)
SELECT
  'tenant_default',
  'Atlas (seeded from pre-tenant setup)',
  (SELECT account_key FROM oauth_tokens WHERE provider = 'HUBSPOT' ORDER BY created_at ASC LIMIT 1),
  (SELECT account_key FROM oauth_tokens WHERE provider = 'DOTLOOP' ORDER BY created_at ASC LIMIT 1),
  '[
    {
      "key": "renter",
      "pipelineId": "t_eb9a14cb632386c0af1109197b394aeb",
      "transactionType": "LEASE_OFFER",
      "stages": [
        { "id": "3232443112", "label": "New Lead", "status": "Pre-Offer" },
        { "id": "3232443113", "label": "Viewing", "status": "Pre-Offer" },
        { "id": "3232443114", "label": "Security Deposit Paid", "status": "Under Contract" },
        { "id": "3232443115", "label": "Closed Won", "status": "Leased" },
        { "id": "3232443116", "label": "Closed Lost", "status": "Terminated" }
      ]
    },
    {
      "key": "buyer",
      "pipelineId": "t_8253aef829fecc1d752892a47a66112a",
      "transactionType": "PURCHASE_OFFER",
      "stages": [
        { "id": "3232431837", "label": "Engaging", "status": "Pre-Offer" },
        { "id": "3232431838", "label": "Qualified", "status": "Pre-Offer" },
        { "id": "3232431839", "label": "Preview Properties", "status": "Pre-Offer" },
        { "id": "3232431840", "label": "Offer to Purchase", "status": "Pre-Offer" },
        { "id": "3232431841", "label": "Negotiations", "status": "Pre-Offer" },
        { "id": "3232431842", "label": "Accepted Offer", "status": "Under Contract" },
        { "id": "3251013337", "label": "Active Closing", "status": "Under Contract" },
        { "id": "3251013338", "label": "Closing Sceduled", "status": "Under Contract" },
        { "id": "3232431843", "label": "Closed Won", "status": "Sold" },
        { "id": "3232431844", "label": "Closed Lost", "status": "Terminated" }
      ]
    },
    {
      "key": "seller",
      "pipelineId": "t_a5d44b5aaea04682e5441ad22e52f824",
      "transactionType": "LISTING_FOR_SALE",
      "stages": [
        { "id": "3232320228", "label": "Engaging", "status": "Pre-Listing" },
        { "id": "3232320229", "label": "Qualified", "status": "Pre-Listing" },
        { "id": "3232320230", "label": "Listing Agreement Signed", "status": "Pre-Listing" },
        { "id": "3232320231", "label": "Listed in MLS", "status": "Active Listing" },
        { "id": "3232320232", "label": "Offer Made", "status": "Active Listing" },
        { "id": "3232320233", "label": "Offer Accepted", "status": "Under Contract" },
        { "id": "3232320234", "label": "Active Closing", "status": "Under Contract" },
        { "id": "3232320235", "label": "Closing Scheduled", "status": "Under Contract" },
        { "id": "3232320236", "label": "Closed Won", "status": "Sold" },
        { "id": "3232320237", "label": "Closed Lost", "status": "Terminated" }
      ]
    }
  ]'::jsonb,
  'ACTIVE'
WHERE
  NOT EXISTS (SELECT 1 FROM tenants)
  AND EXISTS (SELECT 1 FROM oauth_tokens WHERE provider = 'HUBSPOT')
ON CONFLICT (id) DO NOTHING;

-- object_mappings / sync_logs need to know which tenant they belong to:
-- hubspot_id and dotloop_id are only unique *within* one HubSpot portal /
-- Dotloop account, not globally, so two different tenants' portals could
-- otherwise collide on the same id.
ALTER TABLE object_mappings ADD COLUMN IF NOT EXISTS tenant_id TEXT REFERENCES tenants(id);
UPDATE object_mappings SET tenant_id = 'tenant_default'
WHERE tenant_id IS NULL AND EXISTS (SELECT 1 FROM tenants WHERE id = 'tenant_default');

ALTER TABLE object_mappings DROP CONSTRAINT IF EXISTS object_mappings_entity_type_hubspot_id_key;
ALTER TABLE object_mappings DROP CONSTRAINT IF EXISTS object_mappings_entity_type_dotloop_id_key;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'object_mappings_tenant_entity_hubspot_key') THEN
    ALTER TABLE object_mappings
      ADD CONSTRAINT object_mappings_tenant_entity_hubspot_key UNIQUE (tenant_id, entity_type, hubspot_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'object_mappings_tenant_entity_dotloop_key') THEN
    ALTER TABLE object_mappings
      ADD CONSTRAINT object_mappings_tenant_entity_dotloop_key UNIQUE (tenant_id, entity_type, dotloop_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS object_mappings_tenant_idx ON object_mappings (tenant_id);

ALTER TABLE sync_logs ADD COLUMN IF NOT EXISTS tenant_id TEXT REFERENCES tenants(id);
UPDATE sync_logs SET tenant_id = 'tenant_default'
WHERE tenant_id IS NULL AND EXISTS (SELECT 1 FROM tenants WHERE id = 'tenant_default');
CREATE INDEX IF NOT EXISTS sync_logs_tenant_idx ON sync_logs (tenant_id);

-- reconcile_state was a hardcoded single 'singleton' row (one set of
-- watermarks for the whole server). Repoint it at the default tenant so
-- reconcileRepo.ts can use tenant id directly as the row key going
-- forward -- one row per tenant -- without losing the existing poll
-- timestamps.
UPDATE reconcile_state SET id = 'tenant_default'
WHERE id = 'singleton' AND EXISTS (SELECT 1 FROM tenants WHERE id = 'tenant_default');
