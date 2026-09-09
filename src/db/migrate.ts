import fs from "node:fs";
import path from "node:path";
import { pool } from "./client";

/**
 * Applies migrations/*.sql in order. Every statement uses IF NOT EXISTS /
 * is otherwise safe to re-run, so this can run on every boot (see
 * src/index.ts) without needing a separate migration-tracking table.
 */
export async function migrate() {
  const dir = path.join(__dirname, "..", "..", "migrations");
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    await pool.query(sql);
  }
}

if (require.main === module) {
  migrate()
    .then(() => {
      // eslint-disable-next-line no-console
      console.log("Migrations applied.");
      process.exit(0);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error("Migration failed:", err);
      process.exit(1);
    });
}
