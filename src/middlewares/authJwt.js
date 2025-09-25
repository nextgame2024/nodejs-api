import jwt from "jsonwebtoken";
import { config } from "../config/index.js";

function parseAuthHeader(req) {
  const header = req.headers.authorization || "";
  // Accept "Bearer <jwt>" or "Token <jwt>", case-insensitive
  const m = header.match(/^\s*(Bearer|Token)\s+(.+)\s*$/i);
  return m ? m[2] : null;
}

function extractUserFromPayload(payload) {
  // Support either { sub: { id,email,username } } or { id,email,username }
  if (payload?.sub && typeof payload.sub === "object") return payload.sub;
  const { id, email, username } = payload || {};
  if (id || email || username) return { id, email, username };
  return null;
}

export function authRequired(req, res, next) {
  const token = parseAuthHeader(req);
  if (!token) return res.status(401).json({ error: "Authorization required" });

  try {
    const payload = jwt.verify(token, config.jwt.secret);
    req.user = extractUserFromPayload(payload);
    // Even if payload didn’t include user fields, treat as unauthorized
    if (!req.user)
      return res.status(401).json({ error: "Invalid token payload" });
    return next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}
