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

  it("refuses live Checkout before any database or provider I/O when charge activation is off", async () => {
    const provider = providerMock();
    provider.status = jest.fn(() => ({ availability: "live", providerKey: "stripe-sophia",
      providerAccountKey: "legacy-primary", checkout: false,
      portal: true, signedWebhooks: true, reconciliation: true, missingConfiguration: [], detail: "live checkout disabled" }));
    const query = jest.fn();
    const service = lifecycle(provider, query);
    await expect(service.checkout(tenantId, principal, {
      requestId: "33333333-3333-4333-8333-333333333333", planVersionId,
    })).rejects.toThrow("explicit real-charge activation");
    expect(query).not.toHaveBeenCalled();
    expect(provider.createHostedCheckout).not.toHaveBeenCalled();
  });

  it("binds an externally created and provider-verified live Customer without creating a charge", async () => {
    const provider = providerMock();
    provider.status = jest.fn(() => ({ availability: "live", providerKey: "stripe-sophia",
      providerAccountKey: "legacy-primary", checkout: false,
      portal: true, signedWebhooks: true, reconciliation: true, missingConfiguration: [], detail: "live checkout disabled" }));
    provider.verifyCustomerBinding = jest.fn(async () => ({ observedAt: "2026-09-27T00:00:00.000Z" }));
    const query = jest.fn(async (sql: string) => {
      if (sql.includes("resolve_billing_customer_tenant")) return { rows: [{ tenant_id: null }] };
      if (sql.includes("SELECT external_customer_ref")) return { rows: [] };
      return { rows: [], rowCount: 1 };
    });
    const audit = { record: jest.fn() };
    const run = jest.fn(async (_id: string, work: (client: { query: typeof query }) => unknown) => work({ query }));
    const service = new BillingLifecycleService({ query, tenantTransaction: run } as never, provider, audit as never,
      ledger() as never, meterOutbox() as never, invoiceAdjustments() as never);
    const customerRef = "cus_liveSophia123";
    await expect(service.bindCustomer(tenantId, principal, {
      requestId: "33333333-3333-4333-8333-333333333333", customerRef,
    })).resolves.toEqual({ environment: "live", providerCustomerBound: true, alreadyBound: false,
      observedAt: "2026-09-27T00:00:00.000Z", liveCharge: false });
    expect(provider.verifyCustomerBinding).toHaveBeenCalledWith({ tenantId, customerRef });
    expect(query.mock.calls.some((call) => String(call[0]).includes("INSERT INTO sophia_runtime.billing_provider_customers"))).toBe(true);
    expect(provider.createHostedCheckout).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ eventType: "billing.customer.bound",
      permission: "billing.manage", metadata: expect.objectContaining({ environment: "live" }) }));
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(customerRef);
  });

  it("refuses bootstrap binding outside dormant live mode before provider I/O", async () => {
    const provider = providerMock();
    const service = lifecycle(provider, jest.fn());
    await expect(service.bindCustomer(tenantId, principal, {
      requestId: "33333333-3333-4333-8333-333333333333", customerRef: "cus_liveSophia123",
    })).rejects.toThrow("only in live mode while Checkout is disabled");
    expect(provider.verifyCustomerBinding).not.toHaveBeenCalled();
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

  it("passes only the exact aggregate active-minute rate card to base-plus-metered Checkout", async () => {
    const provider = providerMock();
    provider.createHostedCheckout = jest.fn(async () => ({ url: "https://checkout.stripe.com/c/pay/metered",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(), externalCheckoutRef: "cs_test_metered" }));
    let intentStatus = "allocating";
    const query = jest.fn(async (sql: string) => {
      if (sql.includes("FROM sophia_runtime.customers")) return { rows: [{ commercial_plan_version_id: planVersionId,
        external_customer_ref: null, pricing_status: "configured", billing_currency: "AUD", billing_interval: "month",
        base_charge_minor: "75000", tax_mode: "not_applicable", rate_card_dimensions: "1",
        rate_card: { dimensions: [{ dimension: "active-seconds", includedQuantity: "120000",
          unitQuantity: "60", unitPriceMinor: "10" }] } }] };
      if (sql.includes("SET status='created'")) { intentStatus = "created"; return { rows: [], rowCount: 1 }; }
      if (sql.includes("SELECT commercial_plan_version_id") && sql.includes("billing_checkout_intents")) {
        return { rows: [{ commercial_plan_version_id: planVersionId,
          external_checkout_ref: intentStatus === "created" ? "cs_test_metered" : null, status: intentStatus }] };
      }
      return { rows: [], rowCount: 1 };
    });
    await lifecycle(provider, query).checkout(tenantId, principal, {
      requestId: "33333333-3333-4333-8333-333333333333", planVersionId,
    });
    expect(provider.createHostedCheckout).toHaveBeenCalledWith(expect.objectContaining({ commercial: {
      currency: "AUD", interval: "month", baseChargeMinor: "75000",
      meteredOverage: { unitPriceMinor: "10", meterBindingKey: "active-overage-minutes" },
    } }));
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
    const service = new BillingLifecycleService(database as never, provider, { record: jest.fn() } as never,
      ledger() as never, meterOutbox() as never, invoiceAdjustments() as never);
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
    const service = new BillingLifecycleService(database as never, provider, { record: jest.fn() } as never,
      ledger() as never, meterOutbox() as never, invoiceAdjustments() as never);
    await expect(service.webhook({ "stripe-signature": "signed" }, Buffer.from("{}")))
      .resolves.toEqual({ received: true, duplicate: false });
    const invoiceSql = String(clientQuery.mock.calls.find((call) => String(call[0]).includes("billing_invoice_references"))?.[0]);
    expect(invoiceSql).toContain("WHERE EXCLUDED.observed_at>=billing_invoice_references.observed_at");
    expect(invoiceSql).toContain("provider_environment");
    expect(invoiceSql).toContain("ON CONFLICT (provider_key,provider_environment,provider_account_key,external_invoice_ref)");
  });

  it("re-enters duplicate signed draft-invoice delivery and acknowledges only after provider acceptance", async () => {
    const provider = providerMock();
    provider.verifyWebhook = jest.fn(async () => draftInvoiceEvent());
    const clientQuery = jest.fn(async (sql: string) => {
      if (sql.includes("billing_webhook_events") && sql.includes("INSERT")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });
    const database = {
      query: jest.fn(async () => ({ rows: [{ tenant_id: tenantId }] })),
      tenantTransaction: jest.fn(async (_id: string, work: (client: { query: typeof clientQuery }) => unknown) => work({ query: clientQuery })),
    };
    const periods = ledger();
    const adjustments = invoiceAdjustments();
    adjustments.enqueueDraftInvoice = jest.fn(async () => ({ status: "existing" as const, adjustmentId: "adjustment-1" }));
    adjustments.dispatchNext = jest.fn(async () => ({ status: "idle" as const }));
    adjustments.authoritativeAcceptance = jest.fn(async () => ({ status: "provider_accepted" as const,
      existingStatus: "reconciled" as const,
      adjustmentId: "adjustment-1", providerInvoiceItemRef: "ii_1" }));
    const service = new BillingLifecycleService(database as never, provider, { record: jest.fn() } as never,
      periods as never, meterOutbox() as never, adjustments as never);
    await expect(service.webhook({ "stripe-signature": "signed" }, Buffer.from("{}")))
      .resolves.toMatchObject({ received: true, duplicate: true,
        invoiceAdjustment: { status: "provider_accepted", existingStatus: "reconciled",
          providerInvoiceItemRef: "ii_1" } });
    expect(periods.finaliseSandboxTestClock).toHaveBeenCalledWith(tenantId, "stripe-sophia", "legacy-primary",
      "2026-10-28T08:51:05.000Z");
    expect(adjustments.enqueueDraftInvoice).toHaveBeenCalledWith(tenantId, expect.objectContaining({
      externalInvoiceRef: "in_draft_1", externalSubscriptionRef: "sub_1",
      periodStart: "2026-09-28T08:51:05.000Z", periodEnd: "2026-10-28T08:51:05.000Z",
    }));
    expect(adjustments.dispatchNext).toHaveBeenCalledTimes(1);
    expect(adjustments.authoritativeAcceptance).toHaveBeenCalledWith(tenantId, "adjustment-1");
  });

  it("returns a retryable webhook failure while the exact draft-invoice adjustment is not accepted", async () => {
    const provider = providerMock();
    provider.verifyWebhook = jest.fn(async () => draftInvoiceEvent());
    const clientQuery = jest.fn(async (sql: string) => sql.includes("billing_webhook_events") && sql.includes("INSERT")
      ? { rows: [{ billing_webhook_event_id: "event-row" }], rowCount: 1 }
      : { rows: [], rowCount: 1 });
    const database = {
      query: jest.fn(async () => ({ rows: [{ tenant_id: tenantId }] })),
      tenantTransaction: jest.fn(async (_id: string, work: (client: { query: typeof clientQuery }) => unknown) => work({ query: clientQuery })),
    };
    const adjustments = invoiceAdjustments();
    adjustments.enqueueDraftInvoice = jest.fn(async () => ({ status: "enqueued" as const, adjustmentId: "adjustment-1" }));
    adjustments.dispatchNext = jest.fn(async () => ({ status: "retry_scheduled" as const,
      adjustmentId: "adjustment-1", detail: "Stripe unavailable" }));
    const service = new BillingLifecycleService(database as never, provider, { record: jest.fn() } as never,
      ledger() as never, meterOutbox() as never, adjustments as never);
    await expect(service.webhook({ "stripe-signature": "signed" }, Buffer.from("{}")))
      .rejects.toThrow("not authoritatively attached");
  });

  it("acknowledges a draft renewal with an exact zero-overage ledger without dispatch", async () => {
    const provider = providerMock();
    provider.verifyWebhook = jest.fn(async () => draftInvoiceEvent());
    const clientQuery = jest.fn(async (sql: string) => sql.includes("billing_webhook_events") && sql.includes("INSERT")
      ? { rows: [{ billing_webhook_event_id: "event-row" }], rowCount: 1 }
      : { rows: [], rowCount: 1 });
    const database = { query: jest.fn(async () => ({ rows: [{ tenant_id: tenantId }] })),
      tenantTransaction: jest.fn(async (_id: string, work: (client: { query: typeof clientQuery }) => unknown) => work({ query: clientQuery })) };
    const adjustments = invoiceAdjustments();
    adjustments.enqueueDraftInvoice = jest.fn(async () => ({ status: "not_required" as const,
      detail: "no overage" }));
    const service = new BillingLifecycleService(database as never, provider, { record: jest.fn() } as never,
      ledger() as never, meterOutbox() as never, adjustments as never);
    await expect(service.webhook({ "stripe-signature": "signed" }, Buffer.from("{}")))
      .resolves.toMatchObject({ received: true, invoiceAdjustment: { status: "not_required" } });
    expect(adjustments.dispatchNext).not.toHaveBeenCalled();
  });

  it("never dispatches a live Meter event from the read-only live reconciliation path", async () => {
    const provider = providerMock();
    provider.status = jest.fn(() => ({ availability: "live", providerKey: "stripe-sophia",
      providerAccountKey: "legacy-primary", checkout: false, portal: true, signedWebhooks: true,
      reconciliation: true, missingConfiguration: [], detail: "live checkout disabled" }));
    provider.reconcileTenant = jest.fn(async () => ({ status: "observed", observedAt: "2026-09-28T00:00:00.000Z",
      subscriptions: [], invoices: [] }));
    const query = jest.fn(async (sql: string) => sql.includes("FROM sophia_runtime.customers")
      ? { rows: [{ commercial_plan_version_id: planVersionId, external_customer_ref: "cus_live",
        pricing_status: "configured", billing_currency: "AUD", billing_interval: "month",
        base_charge_minor: "75000", tax_mode: "not_applicable", rate_card_dimensions: "1",
        rate_card: { dimensions: [{ dimension: "active-seconds", includedQuantity: "120000",
          unitQuantity: "60", unitPriceMinor: "10" }] } }] }
      : { rows: [], rowCount: 0 });
    const run = jest.fn(async (_id: string, work: (client: { query: typeof query }) => unknown) => work({ query }));
    const outbox = meterOutbox();
    const service = new BillingLifecycleService({ tenantReadTransaction: run, tenantTransaction: run } as never,
      provider, { record: jest.fn() } as never, ledger() as never, outbox as never, invoiceAdjustments() as never);
    await expect(service.reconcile(tenantId, principal, {
      requestId: "33333333-3333-4333-8333-333333333333",
    })).resolves.toMatchObject({ meterEventDispatch: { status: "disabled" }, liveEntitlementMutation: false });
    expect(outbox.dispatchNext).not.toHaveBeenCalled();
    expect(outbox.reconcileNext).toHaveBeenCalled();
  });
});

function lifecycle(provider: ReturnType<typeof providerMock>, query: jest.Mock) {
  const run = jest.fn(async (_id: string, work: (client: { query: jest.Mock }) => unknown) => work({ query }));
  return new BillingLifecycleService({ tenantReadTransaction: run, tenantTransaction: run } as never,
    provider, { record: jest.fn() } as never, ledger() as never, meterOutbox() as never, invoiceAdjustments() as never);
}
function ledger() {
  const result = { observedPeriods: 1, finalised: 1, existing: 0, blocked: [] };
  return { finaliseEligible: jest.fn(async () => result), finaliseSandboxTestClock: jest.fn(async () => result) };
}
function meterOutbox() {
  return { dispatchNext: jest.fn(async () => ({ status: "idle" })),
    reconcileNext: jest.fn(async () => ({ status: "idle" })) };
}
function invoiceAdjustments() {
  return { enqueueDraftInvoice: jest.fn(async () => ({ status: "not_eligible" })),
    dispatchNext: jest.fn(async () => ({ status: "idle" })),
    authoritativeAcceptance: jest.fn(async () => null),
    reconcileInvoice: jest.fn(async () => ({ status: "idle" })) };
}
function providerMock() {
  return {
    status: jest.fn(() => ({ availability: "sandbox", providerKey: "stripe-sophia",
      providerAccountKey: "legacy-primary", checkout: true,
      portal: true, signedWebhooks: true, reconciliation: true, missingConfiguration: [], detail: "configured" })),
    mappedPlanVersionIds: jest.fn(() => new Set([planVersionId])), createHostedCheckout: jest.fn(),
    createHostedPortal: jest.fn(), verifyCustomerBinding: jest.fn(), verifyWebhook: jest.fn(), reconcileTenant: jest.fn(),
  } as unknown as BillingProvider & Record<string, jest.Mock>;
}
function invoiceEvent(): BillingWebhookEvidence {
  return { providerKey: "stripe-sophia", providerAccountKey: "legacy-primary",
    environment: "sandbox", eventId: "evt_1", eventType: "invoice.paid",
    occurredAt: "2026-09-26T00:00:00.000Z", payloadDigest: "a".repeat(64), customerRef: "cus_1",
    checkoutRef: null, tenantHint: null, planVersionHint: null, subscription: null,
    draftRenewalInvoice: null,
    invoice: { externalRef: "in_1", status: "paid", currency: "AUD", amountDueMinor: "100",
      amountPaidMinor: "100", hostedInvoiceUrl: "https://invoice.test/in_1", dueAt: null,
      observedAt: "2026-09-26T00:00:00.000Z" } };
}
function draftInvoiceEvent(): BillingWebhookEvidence {
  return { ...invoiceEvent(), eventId: "evt_draft_1", eventType: "invoice.created",
    occurredAt: "2026-10-28T08:51:05.000Z",
    invoice: { externalRef: "in_draft_1", status: "draft", currency: "AUD", amountDueMinor: "75000",
      amountPaidMinor: "0", hostedInvoiceUrl: null, dueAt: null, observedAt: "2026-10-28T08:51:05.000Z" },
    draftRenewalInvoice: { externalInvoiceRef: "in_draft_1", externalSubscriptionRef: "sub_1",
      periodStart: "2026-09-28T08:51:05.000Z", periodEnd: "2026-10-28T08:51:05.000Z" } };
}
