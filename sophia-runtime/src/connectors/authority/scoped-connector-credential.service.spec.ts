import { beforeEach, describe, expect, it } from "@jest/globals";
import { ScopedConnectorCredentialService } from "./scoped-connector-credential.service.js";

const binding = {
  connectorBindingId: "22222222-2222-4222-8222-222222222222",
  tenantId: "11111111-1111-4111-8111-111111111111",
  externalCompanyId: "33333333-3333-4333-8333-333333333333",
  allowedScopes: ["bm:real-estate:read", "bm:real-estate:booking:write"],
};

describe("ScopedConnectorCredentialService", () => {
  beforeEach(() => {
    process.env.SOPHIA_CONNECTOR_SIGNING_SECRET = "test-secret-that-is-at-least-thirty-two-characters";
    process.env.SOPHIA_CONNECTOR_ISSUER = "sophia-runtime";
    process.env.SOPHIA_CONNECTOR_AUDIENCE = "business-manager";
  });

  it("issues short-lived tenant/company/binding scoped credentials", () => {
    const token = new ScopedConnectorCredentialService().issue(binding, ["bm:real-estate:read"]);
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    expect(payload).toEqual(expect.objectContaining({
      tenantId: binding.tenantId,
      companyId: binding.externalCompanyId,
      connectorBindingId: binding.connectorBindingId,
      scopes: ["bm:real-estate:read"],
      iss: "sophia-runtime",
      aud: "business-manager",
    }));
    expect(payload.exp - payload.iat).toBe(120);
  });

  it("cannot elevate beyond binding scopes", () => {
    expect(() => new ScopedConnectorCredentialService().issue(binding, ["bm:real-estate:delivery:write"]))
      .toThrow("not granted");
  });
});
