import { timingSafeEqual } from "node:crypto";
import { authRequired } from "./authJwt.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function businessManagerIntegrationAuth(req, res, next) {
  const configuredToken = String(process.env.SOPHIA_RUNTIME_SERVICE_TOKEN || "");
  const companyId = String(process.env.SOPHIA_RUNTIME_COMPANY_ID || "");
  const suppliedToken = bearerToken(req);

  if (configuredToken && suppliedToken && secureEqual(suppliedToken, configuredToken)) {
    if (configuredToken.length < 32 || !UUID_RE.test(companyId)) {
      return res.status(503).json({ error: "Sophia Business Manager integration is not configured safely" });
    }
    req.user = {
      id: "sophia-runtime",
      companyId,
      type: "service",
      scopes: ["bm:real-estate"],
    };
    return next();
  }

  return authRequired(req, res, next);
}

function bearerToken(req) {
  const match = String(req.headers.authorization || "").match(/^\s*Bearer\s+(.+)\s*$/i);
  return match?.[1] || null;
}

function secureEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
