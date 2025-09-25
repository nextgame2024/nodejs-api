import jwt from "jsonwebtoken";
import { config } from "../config/index.js";

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

export function authOptional(req, _res, next) {
  const token = parseAuthHeader(req);
  if (!token) return next();

  try {
    const payload = jwt.verify(token, config.jwt.secret);
    const user = extractUserFromPayload(payload);
    if (user) req.user = user;
  } catch {
    // ignore invalid token and continue as anonymous
  }
  next();
}
