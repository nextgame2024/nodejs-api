import pool from "../config/db.js";

export async function createRenderJob({
  id,
  imageKey,
  imageMime,
  amountCents,
  currency,
}) {
  const { rows } = await pool.query(
    `INSERT INTO render_jobs (id, image_key, image_mime, status, amount_cents, currency)
     VALUES ($1,$2,$3,'pending-upload',$4,$5)
     RETURNING *`,
    [id, imageKey, imageMime, amountCents, currency]
  );
  return rows[0];
}

export async function setJobAwaitingPayment(id, stripeSessionId) {
  await pool.query(
    `UPDATE render_jobs
       SET status='awaiting_payment', stripe_session_id=$2, "updatedAt"=NOW()
     WHERE id=$1`,
    [id, stripeSessionId]
  );
}

export async function markJobPaid(id, paymentIntent) {
  await pool.query(
    `UPDATE render_jobs
       SET status='paid', stripe_payment_intent=$2, "updatedAt"=NOW()
     WHERE id=$1`,
    [id, paymentIntent]
  );
}

export async function getJobById(id) {
  const { rows } = await pool.query(`SELECT * FROM render_jobs WHERE id=$1`, [
    id,
  ]);
  return rows[0] || null;
}
