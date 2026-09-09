import { Pool } from "pg";
import "dotenv/config";

// Plain node-postgres pool — deliberately not an ORM. Prisma's own CLI
// needs to download a native query-engine binary from Prisma's CDN before
// it will do anything (even `--version`), which makes it fail hard in any
// network-restricted environment (locked-down CI, some serverless
// platforms, sandboxes like this one). `pg` is pure JS, ships everything
// it needs in the npm package, and never phones home.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on("error", (err) => {
  // Idle client errors (e.g. connection dropped) shouldn't crash the process.
  // eslint-disable-next-line no-console
  console.error("[db] Unexpected error on idle client", err);
});
