import pool from "../config/db.js";

let schemaReady = false;

export async function ensureAiToolkitPaymentSchema() {
  if (schemaReady) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sophia_ai_toolkit_payments (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'aud',
      status TEXT NOT NULL DEFAULT 'created',
      stripe_session_id TEXT UNIQUE,
      stripe_payment_intent TEXT,
      stripe_customer_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      paid_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS idx_sophia_ai_toolkit_payments_user
      ON sophia_ai_toolkit_payments(user_id);

    CREATE INDEX IF NOT EXISTS idx_sophia_ai_toolkit_payments_status
      ON sophia_ai_toolkit_payments(status);
  `);

  schemaReady = true;
}

export async function createAiToolkitPayment({
  id,
  userId,
  amountCents,
  currency,
}) {
  await ensureAiToolkitPaymentSchema();

  const { rows } = await pool.query(
    `INSERT INTO sophia_ai_toolkit_payments (
       id, user_id, amount_cents, currency, status
     )
     VALUES ($1, $2, $3, $4, 'created')
     RETURNING *`,
    [id, userId, amountCents, currency]
  );

  return rows[0];
}

export async function markAiToolkitPaymentAwaitingCheckout({
  id,
  stripeSessionId,
  stripeCustomerId,
}) {
  await ensureAiToolkitPaymentSchema();

  await pool.query(
    `UPDATE sophia_ai_toolkit_payments
     SET status = 'awaiting_payment',
         stripe_session_id = $2,
         stripe_customer_id = $3,
         updated_at = NOW()
     WHERE id = $1`,
    [id, stripeSessionId, stripeCustomerId || null]
  );
}

export async function markAiToolkitPaymentPaidBySession({
  stripeSessionId,
  stripePaymentIntent,
  stripeCustomerId,
}) {
  await ensureAiToolkitPaymentSchema();

  const { rows } = await pool.query(
    `UPDATE sophia_ai_toolkit_payments
     SET status = 'paid',
         stripe_payment_intent = COALESCE($2, stripe_payment_intent),
         stripe_customer_id = COALESCE($3, stripe_customer_id),
         paid_at = COALESCE(paid_at, NOW()),
         updated_at = NOW()
     WHERE stripe_session_id = $1
     RETURNING *`,
    [stripeSessionId, stripePaymentIntent || null, stripeCustomerId || null]
  );

  return rows[0] || null;
}

export async function getAiToolkitPaymentBySession(stripeSessionId) {
  await ensureAiToolkitPaymentSchema();

  const { rows } = await pool.query(
    `SELECT *
     FROM sophia_ai_toolkit_payments
     WHERE stripe_session_id = $1
     LIMIT 1`,
    [stripeSessionId]
  );

  return rows[0] || null;
}

export async function userHasPaidAiToolkit(userId) {
  await ensureAiToolkitPaymentSchema();

  const { rows } = await pool.query(
    `SELECT 1
     FROM sophia_ai_toolkit_payments
     WHERE user_id = $1
       AND status = 'paid'
     LIMIT 1`,
    [userId]
  );

  return rows.length > 0;
}

export async function ensureAiToolkitDashboardNavigationLinkForUser(userId) {
  const { rows } = await pool.query(
    `SELECT company_id
     FROM users
     WHERE id = $1
     LIMIT 1`,
    [userId]
  );

  const companyId = rows[0]?.company_id;
  if (!companyId) return;

  const existing = await pool.query(
    `UPDATE bm_navigation_links
     SET navigation_type = 'header',
         active = true,
         updatedat = NOW()
     WHERE company_id = $1
       AND lower(trim(navigation_label)) = lower(trim('Dashboard'))`,
    [companyId]
  );

  if (existing.rowCount > 0) return;

  await pool.query(
    `INSERT INTO bm_navigation_links (
       navigation_link_id,
       company_id,
       user_id,
       navigation_type,
       navigation_label,
       active
     )
     VALUES (
       gen_random_uuid(),
       $1,
       $2,
       'header',
       'Dashboard',
       true
     )`,
    [companyId, userId]
  );
}
