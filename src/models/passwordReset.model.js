import crypto from "node:crypto";
import pool from "../config/db.js";
import { ensureUsersSiteSchema } from "./user.model.js";

let schemaReady = false;

export async function ensurePasswordResetSchema() {
  if (schemaReady) return;

  await ensureUsersSiteSchema();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user
      ON password_reset_tokens(user_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_lookup
      ON password_reset_tokens(token_hash, expires_at, used_at);
  `);

  schemaReady = true;
}

export function hashPasswordResetToken(token) {
  return crypto
    .createHash("sha256")
    .update(String(token || ""))
    .digest("hex");
}

export async function createPasswordResetToken({ userId, ttlMinutes = 60 }) {
  await ensurePasswordResetSchema();

  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashPasswordResetToken(token);

  await pool.query(
    `UPDATE password_reset_tokens
     SET used_at = NOW()
     WHERE user_id = $1
       AND used_at IS NULL`,
    [userId],
  );

  const { rows } = await pool.query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, NOW() + ($3::text || ' minutes')::interval)
     RETURNING id, expires_at AS "expiresAt"`,
    [userId, tokenHash, ttlMinutes],
  );

  return { token, ...rows[0] };
}

export async function findValidPasswordResetToken(token) {
  await ensurePasswordResetSchema();

  const tokenHash = hashPasswordResetToken(token);
  const { rows } = await pool.query(
    `SELECT
       prt.id,
       prt.user_id AS "userId",
       u.email,
       u.username,
       u.name
     FROM password_reset_tokens prt
     JOIN users u ON u.id = prt.user_id
     WHERE prt.token_hash = $1
       AND prt.used_at IS NULL
       AND prt.expires_at > NOW()
     LIMIT 1`,
    [tokenHash],
  );

  return rows[0] || null;
}

export async function markPasswordResetTokenUsed(id) {
  await ensurePasswordResetSchema();

  await pool.query(
    `UPDATE password_reset_tokens
     SET used_at = NOW()
     WHERE id = $1`,
    [id],
  );
}
