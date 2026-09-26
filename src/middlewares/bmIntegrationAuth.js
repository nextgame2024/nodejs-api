import { timingSafeEqual } from "node:crypto";
import { authRequired } from "./authJwt.js";
import { isSophiaConnectorCredential, verifySophiaConnectorCredential } from "../security/sophiaConnectorCredential.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function businessManagerIntegrationAuth(req, res, next) {
  const configuredToken = String(process.env.SOPHIA_RUNTIME_SERVICE_TOKEN || "");
  const companyId = String(process.env.SOPHIA_RUNTIME_COMPANY_ID || "");
  const suppliedToken = bearerToken(req);

  if (isSophiaConnectorCredential(suppliedToken)) {
    try {
      const claims = verifySophiaConnectorCredential(suppliedToken);
      req.user = {
        id: claims.sub,
        companyId: claims.companyId,
        tenantId: claims.tenantId,
        connectorBindingId: claims.connectorBindingId,
        type: "scoped-service",
        scopes: claims.scopes,
      };
      return next();
    } catch {
      return res.status(401).json({ error: "Invalid or expired Sophia connector credential" });
    }
  }

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

export function requireBusinessManagerScope(scope) {
  return (req, res, next) => {
    const scopes = Array.isArray(req.user?.scopes) ? req.user.scopes : [];
    if (!scopes.includes(scope) && !scopes.includes("bm:real-estate")) {
      return res.status(403).json({ error: "Sophia connector scope is not permitted" });
    }
    return next();
  };
}

export function requireExactBusinessManagerScope(scope) {
  return (req, res, next) => {
    const scopes = Array.isArray(req.user?.scopes) ? req.user.scopes : [];
    if (!scopes.includes(scope)) {
      return res.status(403).json({ error: "A dedicated scoped Sophia credential is required" });
    }
    return next();
  };
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
