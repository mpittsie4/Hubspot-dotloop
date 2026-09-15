// Plain string-literal enums, replacing what would otherwise be
// Prisma-generated enum types. Values match the CHECK constraints in
// migrations/*.sql exactly.

export const Provider = {
  HUBSPOT: "HUBSPOT",
  DOTLOOP: "DOTLOOP",
} as const;
export type Provider = (typeof Provider)[keyof typeof Provider];

export const EntityType = {
  CONTACT: "CONTACT",
  DEAL_LOOP: "DEAL_LOOP",
} as const;
export type EntityType = (typeof EntityType)[keyof typeof EntityType];

export const SyncOrigin = {
  HUBSPOT: "HUBSPOT",
  DOTLOOP: "DOTLOOP",
} as const;
export type SyncOrigin = (typeof SyncOrigin)[keyof typeof SyncOrigin];

export const TenantStatus = {
  // Created but not yet fully connected (missing a HubSpot and/or Dotloop
  // OAuth grant) -- see db/tenantRepo.ts and routes/authRoutes.ts.
  PENDING: "PENDING",
  ACTIVE: "ACTIVE",
  DISABLED: "DISABLED",
} as const;
export type TenantStatus = (typeof TenantStatus)[keyof typeof TenantStatus];

export interface OAuthTokenRow {
  id: string;
  provider: Provider;
  accountKey: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scope: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A customer's HubSpot pipeline/stage <-> Dotloop transactionType/status
 * mapping. Every tenant gets their own array of these (see
 * TenantRow.pipelinesConfig below) -- this used to be a single hardcoded
 * PIPELINES constant in sync/dealLoopMapping.ts describing Mason's own
 * portal only. That portal's config now lives in the `tenant_default` row
 * seeded by migrations/002_tenants.sql; a new customer's pipelines are
 * added the same way (edit the pipelines_config column directly -- see
 * the "no self-serve wizard yet" decision in the public-distribution
 * roadmap doc).
 *
 * Defined here rather than in dealLoopMapping.ts (which imports client
 * types from clients/hubspotClient.ts and clients/dotloopClient.ts, both
 * of which import auth/tokenStore.ts, which imports this file) so that
 * this file and db/tenantRepo.ts don't need to import the sync layer just
 * for the shape of this config, and so there's no import cycle.
 */
export type DotloopTransactionType =
  | "PURCHASE_OFFER"
  | "LISTING_FOR_SALE"
  | "LISTING_FOR_LEASE"
  | "LEASE_OFFER"
  | "REAL_ESTATE_OTHER";

export interface PipelineStage {
  id: string; // HubSpot dealstage internal ID
  label: string; // HubSpot stage label, for readability only
  status: string; // Dotloop status this stage maps to
}

export interface PipelineConfig {
  key: string;
  pipelineId: string; // HubSpot pipeline internal ID
  transactionType: DotloopTransactionType;
  /** In HubSpot's funnel order -- resolveStageForStatus relies on this order. */
  stages: PipelineStage[];
}

export interface TenantRow {
  id: string;
  name: string | null;
  hubspotPortalId: string | null;
  dotloopAccountId: string | null;
  dotloopProfileId: string | null;
  pipelinesConfig: PipelineConfig[];
  status: TenantStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface ObjectMappingRow {
  id: string;
  tenantId: string;
  entityType: EntityType;
  hubspotId: string;
  dotloopId: string;
  dotloopProfileId: string | null;
  lastSyncedHash: string | null;
  lastSyncedAt: Date | null;
  lastSyncOrigin: SyncOrigin | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SyncLogRow {
  id: string;
  tenantId: string | null;
  entityType: string;
  direction: string;
  sourceId: string;
  targetId: string | null;
  status: string;
  message: string | null;
  createdAt: Date;
}

export interface ReconcileStateRow {
  id: string;
  lastHubspotPollAt: Date | null;
  lastDotloopPollAt: Date | null;
}
