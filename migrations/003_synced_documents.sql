-- Tracks which Dotloop loop documents we've already notified HubSpot about
-- (see src/sync/documentSync.ts), so a document only produces one HubSpot
-- note when it first appears and one more each time Dotloop's own
-- `updated` timestamp on it changes -- not a fresh note on every
-- reconciliation poll / LOOP_UPDATED webhook for the same unchanged file.
--
-- This is deliberately a separate table from object_mappings: that table
-- represents a live two-way-syncable record pair (a HubSpot object <->
-- a Dotloop object, kept in sync going forward). A document isn't
-- two-way-synced -- Dotloop's public API only exposes document metadata,
-- not the file bytes (see the roadmap doc's "Document sync to HubSpot"
-- section), so all this table needs to remember is "have we already told
-- HubSpot about this exact version of this document."

CREATE TABLE IF NOT EXISTS synced_documents (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT REFERENCES tenants(id),
  dotloop_loop_id       TEXT NOT NULL,
  dotloop_document_id   TEXT NOT NULL,
  document_name         TEXT,
  folder_name           TEXT,
  -- Dotloop's own `updated` timestamp for this document (not this row's
  -- own updated_at) -- a change here is what triggers a follow-up note.
  dotloop_updated_at    TIMESTAMPTZ,
  hubspot_deal_id       TEXT NOT NULL,
  hubspot_note_id       TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS synced_documents_tenant_doc_key
  ON synced_documents (tenant_id, dotloop_document_id);

CREATE INDEX IF NOT EXISTS synced_documents_loop_idx
  ON synced_documents (tenant_id, dotloop_loop_id);
