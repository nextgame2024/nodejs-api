import "dotenv/config.js";
import pool from "../src/config/db.js";
import { processFormEmail } from "../src/services/leads/form-email.service.js";
import { uuid } from "../src/services/leads/lead-records.contracts.js";
// Explicit runtime tenant IDs keep the worker scoped without bypassing RLS.
try {
  const tenants = (process.env.FORM_EMAIL_TENANT_IDS || "")
    .split(",")
    .filter(Boolean)
    .map((v) => uuid(v.trim()));
  if (!tenants.length) throw new Error("Configure FORM_EMAIL_TENANT_IDS");
  const db = await pool.connect();
  try {
    for (const tenant of tenants)
      for (let i = 0; i < 25; i++)
        if ((await processFormEmail(db, tenant)) === "idle") break;
  } finally {
    db.release();
  }
} catch {
  console.error(
    "Form email worker failed. Check tenant IDs, migrations and email provider configuration.",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
