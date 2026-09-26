import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import { businessManagerIntegrationAuth, requireBusinessManagerScope, requireExactBusinessManagerScope } from "../src/middlewares/bmIntegrationAuth.js";
import { isSophiaConnectorCredential } from "../src/security/sophiaConnectorCredential.js";

const binding = {
  connectorBindingId: "22222222-2222-4222-8222-222222222222",
  tenantId: "11111111-1111-4111-8111-111111111111",
  companyId: "33333333-3333-4333-8333-333333333333",
  scopes: ["bm:real-estate:read"],
};

function token(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT", kid: "sophia-connector-v1" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: "sophia-runtime", aud: "business-manager", sub: "sophia-runtime",
    jti: "request-1", iat: now, exp: now + 120, ...binding, ...overrides,
  })).toString("base64url");
  const signature = createHmac("sha256", process.env.SOPHIA_CONNECTOR_SIGNING_SECRET)
    .update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

function response() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
}

describe("scoped Sophia connector authority", () => {
  beforeEach(() => {
    process.env.SOPHIA_CONNECTOR_SIGNING_SECRET = "test-secret-that-is-at-least-thirty-two-characters";
    process.env.SOPHIA_CONNECTOR_BINDINGS_JSON = JSON.stringify({
      [binding.connectorBindingId]: {
        tenantId: binding.tenantId,
        companyId: binding.companyId,
        scopes: ["bm:real-estate:read", "bm:real-estate:booking:write"],
      },
    });
  });

  test("binds verified claims to the authoritative company", () => {
    const req = { headers: { authorization: `Bearer ${token()}` } };
    const res = response();
    const next = jest.fn();
    businessManagerIntegrationAuth(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.user).toEqual(expect.objectContaining({ companyId: binding.companyId, tenantId: binding.tenantId }));
  });

  test("rejects a signed token whose company differs from the approved binding", () => {
    const req = { headers: { authorization: `Bearer ${token({ companyId: "44444444-4444-4444-8444-444444444444" })}` } };
    const res = response();
    businessManagerIntegrationAuth(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test("prevents read scope from authorising a booking mutation", () => {
    const req = { user: { scopes: ["bm:real-estate:read"] } };
    const res = response();
    requireBusinessManagerScope("bm:real-estate:booking:write")(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test("does not let the legacy broad scope authorize privacy deletion", () => {
    const req = { user: { scopes: ["bm:real-estate"] } };
    const res = response();
    requireExactBusinessManagerScope("bm:real-estate:privacy:write")(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test("requires the dedicated privacy scope", () => {
    const req = { user: { scopes: ["bm:real-estate:privacy:write"] } };
    const next = jest.fn();
    requireExactBusinessManagerScope("bm:real-estate:privacy:write")(req, response(), next);
    expect(next).toHaveBeenCalled();
  });

  test("leaves ordinary Business Manager JWTs on the existing auth path", () => {
    const ordinaryHeader = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    expect(isSophiaConnectorCredential(`${ordinaryHeader}.payload.signature`)).toBe(false);
  });
});
