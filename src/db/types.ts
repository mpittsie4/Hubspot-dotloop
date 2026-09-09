// Plain string-literal enums, replacing what would otherwise be
// Prisma-generated enum types. Values match the CHECK constraints in
// migrations/001_init.sql exactly.

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

export interface ObjectMappingRow {
  id: string;
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
