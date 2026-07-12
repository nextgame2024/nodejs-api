import "dotenv/config.js";
import pool from "../src/config/db.js";
import { processDueToolkitEmails } from "../src/services/aiToolkitEmail.service.js";

const LOCK_ID = Number(process.env.AI_TOOLKIT_EMAIL_CRON_LOCK_ID || 74622031);
const BATCH_LIMIT = Number(process.env.AI_TOOLKIT_EMAIL_CRON_LIMIT || 50);

function nowIso() {
  return new Date().toISOString();
}

async function withLock(fn) {
  const { rows } = await pool.query("SELECT pg_try_advisory_lock($1) AS ok", [
    LOCK_ID,
  ]);

  if (!rows[0]?.ok) {
    console.log(`[${nowIso()}] Toolkit email cron lock busy. Skipping.`);
    return;
  }

  try {
    await fn();
  } finally {
    await pool.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]);
  }
}

try {
  await withLock(async () => {
    console.log(`[${nowIso()}] Toolkit email cron started.`);
    const result = await processDueToolkitEmails({ limit: BATCH_LIMIT });
    console.log(`[${nowIso()}] Toolkit email cron result:`, result);
  });
} catch (error) {
  console.error(`[${nowIso()}] Toolkit email cron failed:`, error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
