import jwt from "jsonwebtoken";
import { config } from "../config/index.js";
import pool from "../config/db.js";

function parseAuthHeader(req) {
  const header = req.headers.authorization || "";
  const m = header.match(/^\s*(Bearer|Token)\s+(.+)\s*$/i);
  return m ? m[2] : null;
}

function extractUserFromPayload(payload) {
  if (payload?.sub && typeof payload.sub === "object") return payload.sub;
  const { id, email, username } = payload || {};
  if (id || email || username) return { id, email, username };
  return null;
}

export async function authRequired(req, res, next) {
  const token = parseAuthHeader(req);
  if (!token) return res.status(401).json({ error: "Authorization required" });

  try {
    const payload = jwt.verify(token, config.jwt.secret);
    const user = extractUserFromPayload(payload);

    if (!user?.id)
      return res.status(401).json({ error: "Invalid token payload" });

    // Load company_id from DB (authoritative tenancy)
    const { rows } = await pool.query(
      `SELECT company_id,status FROM users WHERE id = $1 LIMIT 1`,
      [user.id]
    );

    const companyId = rows[0]?.company_id ?? null;
    if (rows[0]?.status !== "active") {
      return res.status(401).json({ error: "User is not active" });
    }
    if (!companyId) {
      return res
        .status(403)
        .json({ error: "User is not assigned to a company" });
    }

    const mfaVerifiedAt = validMfaTimestamp(user.mfaVerifiedAt);
    req.user = { id: user.id, email: user.email, username: user.username, companyId,
      ...(mfaVerifiedAt ? { mfaVerifiedAt } : {}) };
    return next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

function validMfaTimestamp(value) {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && time <= Date.now() + 30_000 ? new Date(time).toISOString() : null;
}
