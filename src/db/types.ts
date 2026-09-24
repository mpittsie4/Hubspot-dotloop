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

/**
 * Maps one HubSpot Deal<->Contact association label to the Dotloop
 * participant role a matching contact should be added to the deal's loop
 * as. Per-tenant (like PipelineConfig above) because association-label
 * typeIds are custom per HubSpot portal, not a fixed Dotloop-style
 * vocabulary -- look them up for a given tenant with
 * scripts/listAssociationLabels.ts, then set via
 * tenantRepo.updateContactRoleMapping().
 *
 * Deliberately HubSpot -> Dotloop only (added 2026-09-23, per Mason's
 * "map ... contacts, companies, association labels" request): this pushes
 * a HubSpot deal's labeled contact associations onto the Dotloop loop as
 * participants (sync/participantSync.ts). It does not sync the reverse
 * direction -- a participant added directly in Dotloop does not create or
 * update a HubSpot association -- even though Dotloop's
 * LOOP_PARTICIPANT_CREATED/UPDATED webhook events are already subscribed
 * to (see scripts/registerDotloopSubscriptions.ts) for future use. Flagged
 * as a known gap, not started.
 *
 * Also deliberately scoped to NEW associations only: existing
 * associations from before this feature shipped are pre-seeded as
 * SKIPPED_PRE_EXISTING in the loop_participants table (see
 * scripts/seedExistingParticipantAssociations.ts) so this never backfills
 * a tenant's existing live associations onto their already-created loops.
 */
export interface ContactRoleMapping {
  hubspotAssociationTypeId: number;
  hubspotAssociationCategory: "HUBSPOT_DEFINED" | "USER_DEFINED";
  hubspotLabel: string; // for readability/logging only; typeId+category is what's actually matched on
  dotloopRole: string; // Dotloop participant role enum value, e.g. "BUYER", "LOAN_OFFICER"
}

export const DotloopConnectionStatus = {
  PENDING: "PENDING",
  ACTIVE: "ACTIVE",
} as const;
export type DotloopConnectionStatus = (typeof DotloopConnectionStatus)[keyof typeof DotloopConnectionStatus];

/**
 * One HubSpot user's (agent's) own Dotloop OAuth connection, for a
 * brokerage tenant where many agents share one HubSpot portal but each has
 * their own separate Dotloop account. Added 2026-09-24, per Mason: "what if
 * i sign a brokerage where many agents are using the same hubspot but use
 * their own dotloop accounts."
 *
 * A tenant with zero rows here is a plain single-account tenant (the
 * existing model, e.g. tenant_default) -- every deal syncs into
 * tenants.dotloop_account_id/dotloop_profile_id, unchanged. A tenant with
 * at least one row here is in "brokerage mode": sync/dotloopRouting.ts
 * routes each deal to whichever agent's connection matches its HubSpot
 * Owner property, and (per Mason's explicit decision, 2026-09-24) a deal
 * owned by an agent who hasn't connected their own Dotloop account yet is
 * skipped and logged rather than falling back to any other account.
 *
 * Deliberately deal/loop-scoped for now: standalone HubSpot Contact <->
 * Dotloop Contact sync (sync/contactSync.ts) is NOT routed per-agent --
 * see the doc comment on sync/dotloopRouting.ts for why.
 *
 * Set up via the per-agent connect link (POST /auth/admin/tenants/:id/agents
 * mints it, /auth/dotloop/start?tenantId=...&hubspotOwnerId=... is what the
 * agent actually visits) rather than the tenant-wide /auth/dotloop/start.
 */
export interface DotloopConnectionRow {
  id: string;
  tenantId: string;
  hubspotOwnerId: string;
  dotloopAccountId: string | null;
  dotloopProfileId: string | null;
  status: DotloopConnectionStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface TenantRow {
  id: string;
  name: string | null;
  hubspotPortalId: string | null;
  dotloopAccountId: string | null;
  dotloopProfileId: string | null;
  pipelinesConfig: PipelineConfig[];
  contactRoleMapping: ContactRoleMapping[];
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
