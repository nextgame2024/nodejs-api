import pool from "../config/db.js";

let schemaReady = false;

export async function ensureUserMfaSchema() {
  if (schemaReady) return;
  await pool.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS auth_session_version integer NOT NULL DEFAULT 0;

    CREATE TABLE IF NOT EXISTS user_mfa_factors (
      user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      factor_type text NOT NULL DEFAULT 'totp' CHECK (factor_type = 'totp'),
      status text NOT NULL CHECK (status IN ('pending','active')),
      secret_ciphertext bytea NOT NULL,
      secret_iv bytea NOT NULL CHECK (octet_length(secret_iv) = 12),
      secret_auth_tag bytea NOT NULL CHECK (octet_length(secret_auth_tag) = 16),
      last_verified_counter bigint,
      failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
      locked_until timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      activated_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_user_mfa_factors_status
      ON user_mfa_factors(status, locked_until);

    CREATE TABLE IF NOT EXISTS user_security_audit_events (
      event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      event_type text NOT NULL CHECK (event_type IN ('mfa_disabled')),
      ip_address text,
      user_agent text,
      occurred_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_user_security_audit_events_user
      ON user_security_audit_events(user_id, occurred_at DESC);
  `);
  schemaReady = true;
}

export async function findMfaFactor(userId) {
  await ensureUserMfaSchema();
  const { rows } = await pool.query(
    `SELECT user_id AS "userId",status,secret_ciphertext AS ciphertext,
            secret_iv AS iv,secret_auth_tag AS "authTag",
            last_verified_counter::text AS "lastVerifiedCounter",
            failed_attempts AS "failedAttempts",locked_until AS "lockedUntil",
            activated_at AS "activatedAt"
     FROM user_mfa_factors WHERE user_id=$1`, [userId]);
  return rows[0] ?? null;
}

export async function savePendingMfaFactor(userId, encrypted) {
  await ensureUserMfaSchema();
  const { rows } = await pool.query(
    `INSERT INTO user_mfa_factors
       (user_id,status,secret_ciphertext,secret_iv,secret_auth_tag)
     VALUES ($1,'pending',$2,$3,$4)
     ON CONFLICT (user_id) DO UPDATE SET
       secret_ciphertext=EXCLUDED.secret_ciphertext,secret_iv=EXCLUDED.secret_iv,
       secret_auth_tag=EXCLUDED.secret_auth_tag,last_verified_counter=NULL,
       failed_attempts=0,locked_until=NULL,updated_at=now()
     WHERE user_mfa_factors.status='pending'
     RETURNING user_id`, [userId, encrypted.ciphertext, encrypted.iv, encrypted.authTag]);
  return rows.length === 1;
}

export async function activateMfaFactor(userId, counter) {
  const { rows } = await pool.query(
    `UPDATE user_mfa_factors SET status='active',last_verified_counter=$2,
       failed_attempts=0,locked_until=NULL,activated_at=now(),updated_at=now()
     WHERE user_id=$1 AND status='pending'
       AND (last_verified_counter IS NULL OR last_verified_counter<$2)
     RETURNING activated_at AS "activatedAt"`, [userId, counter]);
  return rows[0] ?? null;
}

export async function consumeMfaCounter(userId, counter) {
  const { rows } = await pool.query(
    `UPDATE user_mfa_factors SET last_verified_counter=$2,failed_attempts=0,
       locked_until=NULL,updated_at=now()
     WHERE user_id=$1 AND status='active' AND (locked_until IS NULL OR locked_until<=now())
       AND (last_verified_counter IS NULL OR last_verified_counter<$2)
     RETURNING now() AS "verifiedAt"`, [userId, counter]);
  return rows[0] ?? null;
}

export async function recordMfaFailure(userId) {
  const { rows } = await pool.query(
    `UPDATE user_mfa_factors SET
       failed_attempts=CASE WHEN failed_attempts+1>=5 THEN 0 ELSE failed_attempts+1 END,
       locked_until=CASE WHEN failed_attempts+1>=5 THEN now()+interval '15 minutes' ELSE locked_until END,
       updated_at=now()
     WHERE user_id=$1 AND status IN ('pending','active')
     RETURNING failed_attempts AS "failedAttempts",locked_until AS "lockedUntil"`, [userId]);
  return rows[0] ?? null;
}

export async function disableMfaFactor(userId, counter, context = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const consumed = await client.query(
      `UPDATE user_mfa_factors SET last_verified_counter=$2,failed_attempts=0,
         locked_until=NULL,updated_at=now()
       WHERE user_id=$1 AND status='active' AND (locked_until IS NULL OR locked_until<=now())
         AND (last_verified_counter IS NULL OR last_verified_counter<$2)
       RETURNING user_id`, [userId, counter]);
    if (consumed.rowCount !== 1) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(
      `UPDATE users SET auth_session_version=auth_session_version+1 WHERE id=$1`,
      [userId]);
    await client.query(`DELETE FROM user_mfa_factors WHERE user_id=$1`, [userId]);
    await client.query(
      `INSERT INTO user_security_audit_events
         (user_id,event_type,ip_address,user_agent)
       VALUES ($1,'mfa_disabled',$2,$3)`,
      [userId, cleanContext(context.ipAddress, 200), cleanContext(context.userAgent, 500)]);
    await client.query("COMMIT");
    return true;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

function cleanContext(value, maximumLength) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, maximumLength) : null;
}
