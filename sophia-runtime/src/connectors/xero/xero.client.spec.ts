import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { XeroClient } from "./xero.client.js";
import type { XeroConfig } from "./xero.config.js";

const config: XeroConfig = {
  clientId: "client-id",
  clientSecret: "client-secret",
  redirectUri: "https://runtime.example/api/connectors/xero/v1/oauth/callback",
  returnUrl: "https://app.example/manager/company",
  stateSecret: "state-secret-that-is-longer-than-thirty-two-characters",
  encryptionKey: Buffer.alloc(32, 1),
};

afterEach(() => jest.restoreAllMocks());

describe("XeroClient", () => {
  it("exchanges an authorization code server-side with PKCE", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      access_token: "access",
      refresh_token: "refresh",
      expires_in: 1800,
      scope: "offline_access accounting.settings.read",
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(new XeroClient().exchangeCode("code", "verifier", config)).resolves.toEqual({
      accessToken: "access",
      refreshToken: "refresh",
      expiresIn: 1800,
      scopes: ["offline_access", "accounting.settings.read"],
    });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`,
    });
    expect(String(init?.body)).toContain("code_verifier=verifier");
  });

  it("passes the explicit Xero tenant and returns only bank accounts", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      Accounts: [
        { AccountID: "bank-1", Name: "Agency bank", Type: "BANK", Status: "ACTIVE" },
        { AccountID: "expense-1", Name: "Expenses", Type: "EXPENSE", Status: "ACTIVE" },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(new XeroClient().bankAccounts("access", "tenant-1")).resolves.toEqual([
      expect.objectContaining({ accountId: "bank-1", name: "Agency bank" }),
    ]);
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.headers).toMatchObject({ "xero-tenant-id": "tenant-1" });
  });

  it("does not expose provider response details when authorization fails", async () => {
    jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      error: "invalid_client",
      client_secret: "must-not-leak",
    }), { status: 401, headers: { "content-type": "application/json" } }));
    await expect(new XeroClient().exchangeCode("code", "verifier", config))
      .rejects.toThrow("Xero authorization could not be completed.");
  });
});
