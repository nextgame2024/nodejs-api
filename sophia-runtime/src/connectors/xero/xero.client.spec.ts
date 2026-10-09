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

  it("derives reviewable student candidates from sales invoices and Xero contacts", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        Pagination: { PageNumber: 1, PageSize: 500, PageCount: 1, ItemCount: 3 },
        Invoices: [
          {
            Type: "ACCREC", Status: "PAID", InvoiceID: "invoice-1", InvoiceNumber: "TRUST-001",
            DateString: "2026-09-01T00:00:00", DueDateString: "2026-09-10T00:00:00",
            Total: 1000, AmountPaid: 1000, AmountDue: 0, CurrencyCode: "AUD",
            Contact: { ContactID: "contact-1", Name: "Student One" },
          },
          {
            Type: "ACCREC", Status: "AUTHORISED", InvoiceID: "invoice-2", InvoiceNumber: "TRUST-002",
            DateString: "2099-10-01T00:00:00", DueDateString: "2099-10-20T00:00:00",
            Total: "500", AmountPaid: "100", AmountDue: "400", CurrencyCode: "AUD",
            Contact: { ContactID: "contact-1", Name: "Student One" },
          },
          {
            Type: "ACCPAY", Status: "PAID", InvoiceID: "bill-1", Total: 200,
            Contact: { ContactID: "supplier-1", Name: "College Supplier" },
          },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        Contacts: [{
          ContactID: "contact-1", ContactNumber: "STU-100", Name: "Student One",
          EmailAddress: "student.one@example.invalid",
        }],
      }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await new XeroClient().studentCandidates("access", "tenant-1");

    expect(result).toEqual({
      candidates: [expect.objectContaining({
        xeroContactId: "contact-1",
        legalName: "Student One",
        email: "student.one@example.invalid",
        suggestedStudentReference: "STU-100",
        invoiceCount: 2,
        latestInvoiceNumber: "TRUST-002",
        totalInvoiced: 1500,
        totalPaid: 1100,
        amountDue: 400,
        paymentStatus: "due",
      })],
      invoiceCount: 2,
      truncated: false,
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("summaryOnly=true");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("Contacts");
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ "xero-tenant-id": "tenant-1" });
  });
});
