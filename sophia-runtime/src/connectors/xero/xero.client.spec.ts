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

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

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

  it("classifies a non-JSON provider failure before attempting to parse it", async () => {
    jest.useFakeTimers();
    jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response("upstream gateway", {
      status: 502,
      headers: { "content-type": "text/html", "xero-correlation-id": "correlation-1" },
    }));

    const request = new XeroClient().invoicePage("access", "tenant-1", 1);
    const expectation = expect(request)
      .rejects.toMatchObject({ response: expect.objectContaining({
        errorCode: "xero_unavailable",
        providerStatus: 502,
        correlationId: "correlation-1",
      }) });
    await jest.runAllTimersAsync();
    await expectation;
  });

  it("retries a transient Xero invoice failure and uses bounded invoice pages", async () => {
    jest.useFakeTimers();
    const fetchMock = jest.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("temporary Xero failure", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ Invoices: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));

    const request = new XeroClient().invoicePage("access", "tenant-1", 1);
    await jest.runAllTimersAsync();

    await expect(request).resolves.toEqual({ items: [], page: 1, pageCount: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const requestUrl = String(fetchMock.mock.calls[1]?.[0]);
    expect(requestUrl).toContain("pageSize=100");
    expect(requestUrl).not.toContain("summaryOnly=");
    expect(requestUrl).not.toContain("where=");
    expect(requestUrl).not.toContain("Statuses=");
    expect(requestUrl).not.toContain("order=");
  });

  it("filters the unfiltered invoice page locally", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      Invoices: [
        {
          Type: "ACCREC", Status: "AUTHORISED", InvoiceID: "invoice-1",
          Contact: { ContactID: "contact-1" }, InvoiceNumber: "INV-1", Reference: "STUDENT-REF",
          LineItems: [{
            Description: "Diploma tuition",
            Tracking: [
              { Name: "Advisor", Option: "Maria Lopez" },
              { Name: "College", Option: "Example College" },
            ],
          }],
          Total: 100,
        },
        {
          Type: "ACCPAY", Status: "AUTHORISED", InvoiceID: "invoice-2",
          Contact: { ContactID: "contact-1" }, Total: 50,
        },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await new XeroClient().invoicePage("access", "tenant-1", 1);

    const requestUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(requestUrl).toContain("page=1");
    expect(requestUrl).not.toContain("where=");
    expect(requestUrl).not.toContain("Statuses=");
    expect(requestUrl).toContain("pageSize=100");
    expect(requestUrl).not.toContain("summaryOnly=");
    expect(result.items).toEqual([expect.objectContaining({
      invoiceId: "invoice-1",
      type: "ACCREC",
      invoiceReference: "STUDENT-REF",
      concept: "Diploma tuition",
      advisorName: "Maria Lopez",
      collegeName: "Example College",
    })]);
  });

  it("uses incremental headers and stable paging for contacts", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      pagination: { page: 2, pageSize: 100, pageCount: 2, itemCount: 200 },
      Contacts: [{ ContactID: "44444444-4444-4444-8444-444444444444", Name: "Student One" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(new XeroClient().contactPage(
      "access", "tenant-1", 2, new Date("2026-10-10T00:00:00Z"),
    )).resolves.toEqual(expect.objectContaining({ page: 2, pageCount: 2 }));
    const requestUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(requestUrl).toContain("page=2");
    expect(requestUrl).toContain("pageSize=100");
    expect(requestUrl).toContain("summaryOnly=true");
    expect(requestUrl).not.toContain("order=");
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      "If-Modified-Since": "Sat, 10 Oct 2026 00:00:00 GMT",
    });
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
