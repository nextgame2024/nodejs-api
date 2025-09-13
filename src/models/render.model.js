// render.model.js
import pool from "../config/db.js";

export async function createRenderJob({
  id,
  imageKey,
  imageMime,
  amountCents,
  currency,
  userId = null,
  guestEmail = null,
  articleId = null,
}) {
  const { rows } = await pool.query(
    `INSERT INTO render_jobs
       (id, image_key, image_mime, status, amount_cents, currency, user_id, guest_email, article_id)
     VALUES ($1, $2, $3, 'pending-upload', $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      id,
      imageKey,
      imageMime,
      amountCents,
      currency,
      userId,
      guestEmail,
      articleId,
    ]
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

export async function softDeleteJob(id, reason = "expired cleanup") {
  await pool.query(
    `UPDATE render_jobs
         SET deleted_at = NOW(),
             deleted_reason = COALESCE($2, deleted_reason),
             "updatedAt" = NOW()
       WHERE id = $1`,
    [id, reason]
  );
}

export async function markProcessing(id) {
  await pool.query(
    `UPDATE render_jobs SET status='processing', "updatedAt"=NOW() WHERE id=$1`,
    [id]
  );
}

export async function markDone({ id, outputKey, thumbKey, expiresAt }) {
  await pool.query(
    `UPDATE render_jobs
       SET status='done', output_video_key=$2, output_thumb_key=$3, expires_at=$4, "updatedAt"=NOW()
     WHERE id=$1`,
    [id, outputKey, thumbKey || null, expiresAt]
  );
}

export async function markFailed(id, errorMsg = null) {
  await pool.query(
    `UPDATE render_jobs SET status='failed', error=$2, "updatedAt"=NOW() WHERE id=$1`,
    [id, errorMsg]
  );
}

export async function markEmailSent(id) {
  await pool.query(
    `UPDATE render_jobs SET email_sent=TRUE, "updatedAt"=NOW() WHERE id=$1`,
    [id]
  );
}

export async function getJobById(id) {
  const { rows } = await pool.query(`SELECT * FROM render_jobs WHERE id=$1`, [
    id,
  ]);
  return rows[0] || null;
}

export async function findArticleIdBySlug(slug) {
  const { rows } = await pool.query(
    `SELECT id FROM articles WHERE slug=$1 LIMIT 1`,
    [slug]
  );
  return rows[0]?.id || null;
}

export async function getArticlePromptById(articleId) {
  const { rows } = await pool.query(
    `SELECT prompt, title FROM articles WHERE id=$1 LIMIT 1`,
    [articleId]
  );
  return rows[0] || null;
}
