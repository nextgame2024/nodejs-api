import { createHmac, timingSafeEqual } from "node:crypto";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function verifySophiaConnectorCredential(token, nowSeconds = Math.floor(Date.now() / 1000)) {
  const secret = String(process.env.SOPHIA_CONNECTOR_SIGNING_SECRET || "").trim();
  if (secret.length < 32) throw new Error("Scoped connector verification is not configured safely");
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("Invalid scoped connector credential");
  const [encodedHeader, encodedPayload, suppliedSignature] = parts;
  const expectedSignature = createHmac("sha256", secret)
    .update(`${encodedHeader}.${encodedPayload}`).digest("base64url");
  if (!secureEqual(suppliedSignature, expectedSignature)) throw new Error("Invalid scoped connector signature");
  const header = parse(encodedHeader);
  const payload = parse(encodedPayload);
  if (header.alg !== "HS256" || header.typ !== "JWT" || header.kid !== "sophia-connector-v1") throw new Error("Unsupported scoped connector algorithm");
  if (payload.iss !== (process.env.SOPHIA_CONNECTOR_ISSUER || "sophia-runtime")) throw new Error("Invalid scoped connector issuer");
  if (payload.aud !== (process.env.SOPHIA_CONNECTOR_AUDIENCE || "business-manager")) throw new Error("Invalid scoped connector audience");
  if (!Number.isInteger(payload.iat) || !Number.isInteger(payload.exp) || payload.exp <= nowSeconds || payload.exp > nowSeconds + 300 || payload.iat > nowSeconds + 30) throw new Error("Scoped connector credential is expired or has invalid timing");
  if (!UUID_RE.test(payload.tenantId) || !UUID_RE.test(payload.companyId) || !UUID_RE.test(payload.connectorBindingId)) throw new Error("Scoped connector binding claims are invalid");
  if (!Array.isArray(payload.scopes) || !payload.scopes.length || payload.scopes.some((scope) => typeof scope !== "string")) throw new Error("Scoped connector scopes are invalid");

  const configured = configuredBindings()[payload.connectorBindingId];
  if (!configured || configured.tenantId !== payload.tenantId || configured.companyId !== payload.companyId) throw new Error("Scoped connector binding is not approved");
  if (payload.scopes.some((scope) => !configured.scopes.includes(scope))) throw new Error("Scoped connector scope is not approved");
  return payload;
}

export function isSophiaConnectorCredential(token) {
  const [encodedHeader] = String(token || "").split(".");
  if (!encodedHeader) return false;
  try {
    const header = parse(encodedHeader);
    return header.kid === "sophia-connector-v1";
  } catch {
    return false;
  }
}

function configuredBindings() {
  try {
    const value = JSON.parse(process.env.SOPHIA_CONNECTOR_BINDINGS_JSON || "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    throw new Error("Scoped connector bindings are not valid JSON");
  }
}

function parse(value) {
  try { return JSON.parse(Buffer.from(value, "base64url").toString("utf8")); }
  catch { throw new Error("Invalid scoped connector credential payload"); }
}

function secureEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}
