import jwt from "jsonwebtoken";
import { config } from "../config/index.js";

export function authRequired(req, res, next) {
  const hdr = req.headers.authorization || "";
  // Accept "Token <jwt>" and "Bearer <jwt>"
  const token = hdr.startsWith("Token ")
    ? hdr.slice(6).trim()
    : hdr.startsWith("Bearer ")
      ? hdr.slice(7).trim()
      : null;

  if (!token) return res.status(401).json({ error: "Authorization required" });

  try {
    const payload = jwt.verify(token, config.jwt.secret);
    // we signed as { sub: { id, email, username }, iat, exp }
    req.user = payload.sub;
    return next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid token" });
  }
}
