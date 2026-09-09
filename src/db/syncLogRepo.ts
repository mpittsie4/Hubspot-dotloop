import crypto from "node:crypto";
import { pool } from "./client";

export interface CreateSyncLogInput {
  entityType: string;
  direction: string;
  sourceId: string;
  targetId?: string | null;
  status: "SUCCESS" | "ERROR" | "SKIPPED";
  message?: string;
}

export async function createSyncLog(input: CreateSyncLogInput): Promise<void> {
  await pool.query(
    `INSERT INTO sync_logs (id, entity_type, direction, source_id, target_id, status, message)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      crypto.randomUUID(),
      input.entityType,
      input.direction,
      input.sourceId,
      input.targetId ?? null,
      input.status,
      input.message ?? null,
    ]
  );
}
