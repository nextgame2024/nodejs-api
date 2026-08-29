import "dotenv/config";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { runtimeConfig } from "../config/runtime-config.js";

async function migrate() {
  const config = runtimeConfig();
  const migrationsDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "migrations",
  );
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 1,
    ssl: config.databaseSsl ? { rejectUnauthorized: true } : undefined,
  });

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.sophia_runtime_migrations (
        id text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = (await fs.readdir(migrationsDir))
      .filter((file) => file.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const alreadyApplied = await pool.query(
        "SELECT 1 FROM public.sophia_runtime_migrations WHERE id = $1",
        [file],
      );
      if (alreadyApplied.rowCount) continue;

      const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
      await pool.query("BEGIN");
      try {
        await pool.query(sql.replaceAll("__SOPHIA_RUNTIME_SCHEMA__", config.schema));
        await pool.query(
          "INSERT INTO public.sophia_runtime_migrations (id) VALUES ($1)",
          [file],
        );
        await pool.query("COMMIT");
        console.log(`Applied ${file}`);
      } catch (error) {
        await pool.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await pool.end();
  }
}

void migrate().catch((error) => {
  console.error(error);
  process.exit(1);
});
