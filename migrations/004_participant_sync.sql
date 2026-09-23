-- Contacts/Companies/association-label sync (2026-09-23, per Mason: "Can we
-- start to map the information like Price, close date, contacts, companies,
-- association labels and other things"). Price and close date were already
-- synced (see dealLoopMapping.ts) -- this adds the contacts/companies/
-- association-labels piece: pushing a HubSpot deal's labeled contact
-- associations onto its Dotloop loop as participants.
--
-- 1. tenants.contact_role_mapping -- per-tenant HubSpot association-label
--    (typeId+category) -> Dotloop participant role mapping. Per-tenant
--    because association label typeIds are custom per HubSpot portal (see
--    scripts/listAssociationLabels.ts, which looks these up for a given
--    tenant so they can be set the same way pipelines_config is populated
--    -- see db/tenantRepo.ts's updateContactRoleMapping()).
--
-- 2. loop_participants -- tracks which HubSpot deal<->contact associations
--    have already been pushed to Dotloop as a loop participant, so a
--    re-sync never adds the same participant twice. Rows with
--    status = 'SKIPPED_PRE_EXISTING' (written once by
--    scripts/seedExistingParticipantAssociations.ts right after this
--    feature ships for a given tenant) mark associations that already
--    existed before participant sync existed -- per Mason's explicit
--    decision (2026-09-23: "New associations only") those are
--    intentionally never backfilled onto their already-created loops; only
--    a genuinely new association creates a real Dotloop participant.

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS contact_role_mapping JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS loop_participants (
  id                      TEXT PRIMARY KEY,
  tenant_id               TEXT NOT NULL REFERENCES tenants(id),
  hubspot_deal_id         TEXT NOT NULL,
  hubspot_contact_id      TEXT NOT NULL,
  dotloop_role            TEXT NOT NULL,
  dotloop_participant_id  TEXT,
  dotloop_loop_id         TEXT,
  status                  TEXT NOT NULL DEFAULT 'SYNCED' CHECK (status IN ('SYNCED', 'SKIPPED_PRE_EXISTING')),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, hubspot_deal_id, hubspot_contact_id, dotloop_role)
);

CREATE INDEX IF NOT EXISTS loop_participants_tenant_idx ON loop_participants (tenant_id);
