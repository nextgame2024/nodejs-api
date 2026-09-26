import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { BillingLifecycleService } from "./billing-lifecycle.service.js";
import type { BillingProvider, BillingWebhookEvidence } from "./billing-provider.port.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const planVersionId = "22222222-2222-4222-8222-222222222222";
const principal = { identityUserId: "billing-operator" } as never;

describe("BillingLifecycleService", () => {
  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    process.env.SOPHIA_RUNTIME_SCHEMA = "sophia_runtime";
  });

  it("refuses checkout for anything except the active mapped plan", async () => {
    const provider = providerMock();
    const query = jest.fn(async () => ({ rows: [{ commercial_plan_version_id: planVersionId, external_customer_ref: null,
      pricing_status: "configured", billing_currency: "AUD", billing_interval: "month", base_charge_minor: "1000",
      tax_mode: "not_applicable", rate_card_dimensions: "0" }] }));
    const service = lifecycle(provider, query);
    await expect(service.checkout(tenantId, principal, {
      requestId: "33333333-3333-4333-8333-333333333333",
      planVersionId: "44444444-4444-4444-8444-444444444444",
    })).rejects.toThrow("current active commercial plan");
    expect(provider.createHostedCheckout).not.toHaveBeenCalled();
  });

  it("reserves one tenant Checkout before provider I/O and attaches the returned session", async () => {
    const provider = providerMock();
    provider.createHostedCheckout = jest.fn(async () => ({ url: "https://checkout.stripe.com/c/pay/test",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(), externalCheckoutRef: "cs_test_issued" }));
    let intentStatus = "allocating"; const query = jest.fn(async (sql: string) => {
      if (sql.includes("FROM sophia_runtime.customers")) return { rows: [{ commercial_plan_version_id: planVersionId,
        external_customer_ref: null, pricing_status: "configured", billing_currency: "AUD", billing_interval: "month",
        base_charge_minor: "1000", tax_mode: "not_applicable", rate_card_dimensions: "0" }] };
      if (sql.includes("UPDATE sophia_runtime.billing_checkout_intents SET status='created'")) { intentStatus = "created"; return { rows: [], rowCount: 1 }; }
      if (sql.includes("SELECT commercial_plan_version_id") && sql.includes("billing_checkout_intents")) {
        return { rows: [{ commercial_plan_version_id: planVersionId, external_checkout_ref: intentStatus === "created" ? "cs_test_issued" : null,
          status: intentStatus }] };
      }
      return { rows: [], rowCount: 1 };
    });
    const service = lifecycle(provider, query); const requestId = "33333333-3333-4333-8333-333333333333";
    await expect(service.checkout(tenantId, principal, { requestId, planVersionId })).resolves.toMatchObject({ liveCharge: false });
    const reservationCall = query.mock.calls.find((call) => String(call[0]).includes("'allocating'"));
    expect(reservationCall).toBeDefined(); expect(provider.createHostedCheckout).toHaveBeenCalledTimes(1);
    expect(query.mock.invocationCallOrder[query.mock.calls.indexOf(reservationCall!)]).toBeLessThan(
      provider.createHostedCheckout.mock.invocationCallOrder[0]);
  });

  it("deduplicates signed provider events before applying observations", async () => {
    const provider = providerMock(); provider.verifyWebhook = jest.fn(async () => invoiceEvent());
    const clientQuery = jest.fn(async (sql: string) => {
      if (sql.includes("billing_webhook_events") && sql.includes("INSERT")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });
    const database = {
      query: jest.fn(async () => ({ rows: [{ tenant_id: tenantId }] })),
      tenantTransaction: jest.fn(async (_id: string, work: (client: { query: typeof clientQuery }) => unknown) => work({ query: clientQuery })),
      tenantReadTransaction: jest.fn(),
    };
    const service = new BillingLifecycleService(database as never, provider, { record: jest.fn() } as never);
    await expect(service.webhook({ "stripe-signature": "signed" }, Buffer.from("{}")))
      .resolves.toEqual({ received: true, duplicate: true });
    expect(clientQuery.mock.calls.some((call) => String(call[0]).includes("billing_invoice_references"))).toBe(false);
  });

  it("applies invoice observations only when they are not older than stored provider state", async () => {
    const provider = providerMock(); provider.verifyWebhook = jest.fn(async () => invoiceEvent());
    const clientQuery = jest.fn(async (sql: string) => {
      if (sql.includes("billing_webhook_events") && sql.includes("INSERT")) return { rows: [{ billing_webhook_event_id: "event-row" }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    const database = {
      query: jest.fn(async () => ({ rows: [{ tenant_id: tenantId }] })),
      tenantTransaction: jest.fn(async (_id: string, work: (client: { query: typeof clientQuery }) => unknown) => work({ query: clientQuery })),
      tenantReadTransaction: jest.fn(),
    };
    const service = new BillingLifecycleService(database as never, provider, { record: jest.fn() } as never);
    await expect(service.webhook({ "stripe-signature": "signed" }, Buffer.from("{}")))
      .resolves.toEqual({ received: true, duplicate: false });
    const invoiceSql = String(clientQuery.mock.calls.find((call) => String(call[0]).includes("billing_invoice_references"))?.[0]);
    expect(invoiceSql).toContain("WHERE EXCLUDED.observed_at>=billing_invoice_references.observed_at");
  });
});

function lifecycle(provider: ReturnType<typeof providerMock>, query: jest.Mock) {
  const run = jest.fn(async (_id: string, work: (client: { query: jest.Mock }) => unknown) => work({ query }));
  return new BillingLifecycleService({ tenantReadTransaction: run, tenantTransaction: run } as never,
    provider, { record: jest.fn() } as never);
}
function providerMock() {
  return {
    status: jest.fn(() => ({ availability: "sandbox", providerKey: "stripe-sophia", checkout: true,
      portal: true, signedWebhooks: true, reconciliation: true, missingConfiguration: [], detail: "configured" })),
    mappedPlanVersionIds: jest.fn(() => new Set([planVersionId])), createHostedCheckout: jest.fn(),
    createHostedPortal: jest.fn(), verifyWebhook: jest.fn(), reconcileTenant: jest.fn(),
  } as unknown as BillingProvider & Record<string, jest.Mock>;
}
function invoiceEvent(): BillingWebhookEvidence {
  return { providerKey: "stripe-sophia", environment: "sandbox", eventId: "evt_1", eventType: "invoice.paid",
    occurredAt: "2026-09-26T00:00:00.000Z", payloadDigest: "a".repeat(64), customerRef: "cus_1",
    checkoutRef: null, tenantHint: null, planVersionHint: null, subscription: null,
    invoice: { externalRef: "in_1", status: "paid", currency: "AUD", amountDueMinor: "100",
      amountPaidMinor: "100", hostedInvoiceUrl: "https://invoice.test/in_1", dueAt: null,
      observedAt: "2026-09-26T00:00:00.000Z" } };
}
