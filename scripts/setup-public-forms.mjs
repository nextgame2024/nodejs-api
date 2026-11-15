import "dotenv/config.js";
import { readFile } from "node:fs/promises";
import pool from "../src/config/db.js";
const files = [
  "132_public_lead_forms.sql",
  "133_lead_form_email_notifications.sql",
];
const db = await pool.connect();
try {
  await db.query("BEGIN");
  await db.query("SELECT pg_advisory_xact_lock(74622133)");
  for (const file of files) {
    const applied = await db.query(
      "SELECT 1 FROM public.sophia_runtime_migrations WHERE id=$1",
      [file],
    );
    if (applied.rowCount) {
      console.log("Already applied:", file);
      continue;
    }
    const sql = await readFile(
      new URL(
        "../sophia-runtime/src/database/migrations/" + file,
        import.meta.url,
      ),
      "utf8",
    );
    await db.query(
      sql.replaceAll("__SOPHIA_RUNTIME_SCHEMA__", "sophia_runtime"),
    );
    await db.query(
      "INSERT INTO public.sophia_runtime_migrations(id) VALUES($1)",
      [file],
    );
    console.log("Applied:", file);
  }
  await db.query("COMMIT");
} catch (e) {
  await db.query("ROLLBACK");
  console.error("Public forms setup rolled back:", e.code || "setup_failed");
  process.exitCode = 1;
} finally {
  db.release();
  await pool.end();
}
