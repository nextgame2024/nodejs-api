import pool from "../config/db.js";
import { ensureAiToolkitPaymentSchema } from "./aiToolkitPayment.model.js";
import { ensureUsersSiteSchema } from "./user.model.js";

let schemaReady = false;

export async function ensureAiToolkitEmailScheduleSchema() {
  if (schemaReady) return;

  await ensureAiToolkitPaymentSchema();
  await ensureUsersSiteSchema();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sophia_ai_toolkit_email_schedule (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      payment_id UUID NOT NULL REFERENCES sophia_ai_toolkit_payments(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      email_key TEXT NOT NULL,
      day_offset INTEGER NOT NULL,
      recipient_email TEXT NOT NULL,
      recipient_name TEXT,
      subject TEXT NOT NULL,
      preview_text TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      scheduled_for TIMESTAMPTZ NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TIMESTAMPTZ,
      sent_at TIMESTAMPTZ,
      failed_at TIMESTAMPTZ,
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (payment_id, email_key)
    );

    CREATE INDEX IF NOT EXISTS idx_toolkit_email_schedule_due
      ON sophia_ai_toolkit_email_schedule(status, scheduled_for);

    CREATE INDEX IF NOT EXISTS idx_toolkit_email_schedule_user
      ON sophia_ai_toolkit_email_schedule(user_id, created_at DESC);
  `);

  schemaReady = true;
}

export async function getToolkitPaymentEmailContext(paymentId) {
  await ensureAiToolkitEmailScheduleSchema();

  const { rows } = await pool.query(
    `SELECT
       p.id AS "paymentId",
       p.user_id AS "userId",
       p.paid_at AS "paidAt",
       u.email,
       u.name,
       u.username,
       u.email_subscription_status AS "emailSubscriptionStatus"
     FROM sophia_ai_toolkit_payments p
     JOIN users u ON u.id = p.user_id
     WHERE p.id = $1
       AND p.status = 'paid'
       AND u.email_subscription_status = 'Y'
     LIMIT 1`,
    [paymentId],
  );

  return rows[0] || null;
}

export async function createToolkitEmailScheduleRows(rows) {
  await ensureAiToolkitEmailScheduleSchema();
  if (!rows.length) return [];

  const client = await pool.connect();
  const inserted = [];

  try {
    await client.query("BEGIN");

    for (const row of rows) {
      const { rows: result } = await client.query(
        `INSERT INTO sophia_ai_toolkit_email_schedule (
           payment_id,
           user_id,
           email_key,
           day_offset,
           recipient_email,
           recipient_name,
           subject,
           preview_text,
           scheduled_for
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (payment_id, email_key) DO NOTHING
         RETURNING *`,
        [
          row.paymentId,
          row.userId,
          row.emailKey,
          row.dayOffset,
          row.recipientEmail,
          row.recipientName || null,
          row.subject,
          row.previewText || null,
          row.scheduledFor,
        ],
      );

      if (result[0]) inserted.push(result[0]);
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return inserted;
}

export async function claimDueToolkitEmails({ limit = 25 } = {}) {
  await ensureAiToolkitEmailScheduleSchema();

  const { rows } = await pool.query(
    `WITH due AS (
       SELECT s.id
       FROM sophia_ai_toolkit_email_schedule s
       JOIN users u ON u.id = s.user_id
       WHERE s.status IN ('pending', 'failed')
         AND s.scheduled_for <= NOW()
         AND s.attempts < 5
         AND u.email_subscription_status = 'Y'
       ORDER BY s.scheduled_for ASC, s.created_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE sophia_ai_toolkit_email_schedule s
     SET status = 'sending',
         attempts = attempts + 1,
         last_attempt_at = NOW(),
         updated_at = NOW()
     FROM due
     WHERE s.id = due.id
     RETURNING s.*`,
    [limit],
  );

  return rows;
}

export async function claimToolkitEmailByPaymentAndKey({
  paymentId,
  emailKey,
}) {
  await ensureAiToolkitEmailScheduleSchema();

  const { rows } = await pool.query(
    `WITH due AS (
       SELECT s.id
       FROM sophia_ai_toolkit_email_schedule s
       JOIN users u ON u.id = s.user_id
       WHERE s.payment_id = $1
         AND s.email_key = $2
         AND s.status IN ('pending', 'failed')
         AND s.scheduled_for <= NOW()
         AND s.attempts < 5
         AND u.email_subscription_status = 'Y'
       ORDER BY s.scheduled_for ASC, s.created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE sophia_ai_toolkit_email_schedule s
     SET status = 'sending',
         attempts = attempts + 1,
         last_attempt_at = NOW(),
         updated_at = NOW()
     FROM due
     WHERE s.id = due.id
     RETURNING s.*`,
    [paymentId, emailKey],
  );

  return rows[0] || null;
}

export async function markToolkitEmailSent(id) {
  await ensureAiToolkitEmailScheduleSchema();

  await pool.query(
    `UPDATE sophia_ai_toolkit_email_schedule
     SET status = 'sent',
         sent_at = NOW(),
         failed_at = NULL,
         error_message = NULL,
         updated_at = NOW()
     WHERE id = $1`,
    [id],
  );
}

export async function markToolkitEmailFailed(id, errorMessage) {
  await ensureAiToolkitEmailScheduleSchema();

  await pool.query(
    `UPDATE sophia_ai_toolkit_email_schedule
     SET status = 'failed',
         failed_at = NOW(),
         error_message = $2,
         updated_at = NOW()
     WHERE id = $1`,
    [id, String(errorMessage || "Email send failed").slice(0, 1000)],
  );
}

export async function markPendingToolkitEmailsUnsubscribedForUser(userId) {
  await ensureAiToolkitEmailScheduleSchema();

  const { rowCount } = await pool.query(
    `UPDATE sophia_ai_toolkit_email_schedule
     SET status = 'unsubscribed',
         updated_at = NOW()
     WHERE user_id = $1
       AND status IN ('pending', 'failed')`,
    [userId],
  );

  return rowCount;
}
