import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { BillingInvoiceAdjustmentOutboxService } from "./billing-invoice-adjustment-outbox.service.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const planVersionId = "22222222-2222-4222-8222-222222222222";
const adjustmentId = "33333333-3333-4333-8333-333333333333";

describe("BillingInvoiceAdjustmentOutboxService", () => {
  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    process.env.SOPHIA_RUNTIME_SCHEMA = "sophia_runtime";
    process.env.SOPHIA_BILLING_STRIPE_OVERAGE_PRICE_MAPPINGS =
      JSON.stringify({ [planVersionId]: "price_sophiaOverage123" });
  });

  it("does not claim or submit a live invoice adjustment", async () => {
    const transaction = jest.fn();
    const dispatcher = { status: () => ({ availability: "configured" as const, detail: "sandbox" }), submit: jest.fn(),
      reconcile: jest.fn() };
    const result = await new BillingInvoiceAdjustmentOutboxService({ tenantTransaction: transaction } as never, dispatcher)
      .dispatchNext(tenantId, "stripe-sophia", "live", "legacy-primary", "worker-1");
    expect(result.status).toBe("disabled");
    expect(transaction).not.toHaveBeenCalled();
    expect(dispatcher.submit).not.toHaveBeenCalled();
  });

  it("verifies the durable payload and records provider acceptance through a fenced lease", async () => {
    const query = dispatchQuery();
    const dispatcher = { status: () => ({ availability: "configured" as const, detail: "sandbox" }),
      submit: jest.fn(async () => ({ outcome: "accepted" as const, providerInvoiceItemRef: "ii_1",
        acceptedAt: "2026-10-28T08:51:06.000Z" })), reconcile: jest.fn() };
    const result = await new BillingInvoiceAdjustmentOutboxService(database(query), dispatcher)
      .dispatchNext(tenantId, "stripe-sophia", "sandbox", "legacy-primary", "worker-1");
    expect(result).toMatchObject({ status: "provider_accepted", providerInvoiceItemRef: "ii_1" });
    expect(dispatcher.submit).toHaveBeenCalledWith(expect.objectContaining({
      adjustmentId, externalInvoiceRef: "in_sophia_1", oneTimePriceRef: "price_sophiaOverage123",
      quantity: "2", unitPriceMinor: "10", currency: "AUD",
    }));
    expect(query.mock.calls.some(([sql]) => String(sql).includes("status='provider_accepted'"))).toBe(true);
  });

  it("fails a corrupted durable payload before making any Stripe call", async () => {
    const query = dispatchQuery("f".repeat(64));
    const dispatcher = { status: () => ({ availability: "configured" as const, detail: "sandbox" }), submit: jest.fn(),
      reconcile: jest.fn() };
    const result = await new BillingInvoiceAdjustmentOutboxService(database(query), dispatcher)
      .dispatchNext(tenantId, "stripe-sophia", "sandbox", "legacy-primary", "worker-1");
    expect(result.status).toBe("terminal_failed");
    expect(dispatcher.submit).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => String(sql).includes("payload_digest_mismatch"))).toBe(true);
  });

  it("enqueues exactly one matching positive immutable period and reuses it idempotently", async () => {
    const query = jest.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes("FROM sophia_runtime.billing_usage_period_ledgers")) return { rows: [{
        billing_usage_period_ledger_id: "ledger-1", billing_provider_customer_id: "provider-customer-1",
        commercial_plan_version_id: planVersionId, billable_overage_minutes: "2",
        overage_unit_price_minor: "10", currency: "AUD",
      }], rowCount: 1 };
      if (sql.includes("INSERT INTO sophia_runtime.billing_invoice_adjustment_outbox")) {
        expect(values).toEqual(expect.arrayContaining(["price_sophiaOverage123", "2", "10", "AUD"]));
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("SELECT billing_invoice_adjustment_outbox_id,payload_digest")) {
        const insert = query.mock.calls.find(([text]) => String(text).includes("INSERT INTO sophia_runtime.billing_invoice_adjustment_outbox"));
        return { rows: [{ billing_invoice_adjustment_outbox_id: adjustmentId, payload_digest: insert?.[1]?.[16] }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const service = new BillingInvoiceAdjustmentOutboxService(database(query), {
      status: () => ({ availability: "configured" as const, detail: "sandbox" }), submit: jest.fn(),
      reconcile: jest.fn(),
    });
    await expect(service.enqueueDraftInvoice(tenantId, draftInvoice()))
      .resolves.toEqual({ status: "existing", adjustmentId });
  });

  it("acknowledges an exact zero-overage ledger without creating an adjustment", async () => {
    const query = jest.fn(async (sql: string) => sql.includes("FROM sophia_runtime.billing_usage_period_ledgers")
      ? { rows: [{ billing_usage_period_ledger_id: "ledger-zero",
        billing_provider_customer_id: "provider-customer-1", commercial_plan_version_id: planVersionId,
        billable_overage_minutes: "0", overage_unit_price_minor: "10", currency: "AUD" }], rowCount: 1 }
      : { rows: [], rowCount: 1 });
    const dispatcher = { status: () => ({ availability: "configured" as const, detail: "sandbox" }),
      submit: jest.fn(), reconcile: jest.fn() };
    await expect(new BillingInvoiceAdjustmentOutboxService(database(query), dispatcher)
      .enqueueDraftInvoice(tenantId, draftInvoice())).resolves.toMatchObject({ status: "not_required" });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO sophia_runtime.billing_invoice_adjustment_outbox")))
      .toBe(false);
  });

  it("persists exact finalized invoice-line evidence before marking the adjustment reconciled", async () => {
    const row = dispatchRow();
    const query = jest.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes("SELECT * FROM sophia_runtime.billing_invoice_adjustment_outbox")) {
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO sophia_runtime.billing_invoice_adjustment_reconciliations")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("SELECT evidence_digest")) {
        const insert = query.mock.calls.find(([text]) => String(text).includes("INSERT INTO sophia_runtime.billing_invoice_adjustment_reconciliations"));
        return { rows: [{ evidence_digest: insert?.[1]?.[14] }], rowCount: 1 };
      }
      if (sql.includes("SET status='reconciled'")) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    const dispatcher = { status: () => ({ availability: "configured" as const, detail: "sandbox" }), submit: jest.fn(),
      reconcile: jest.fn(async () => ({ outcome: "matched" as const, evidence: {
        providerInvoiceItemRef: "ii_1", providerInvoiceLineRef: "il_1",
        oneTimePriceRef: "price_sophiaOverage123", periodStart: row.period_start, periodEnd: row.period_end,
        quantity: "2", unitPriceMinor: "10", amountMinor: "20", currency: "AUD", invoiceStatus: "paid",
        observedAt: "2026-10-28T08:52:00.000Z",
      } })) };
    await expect(new BillingInvoiceAdjustmentOutboxService(database(query), dispatcher)
      .reconcileInvoice(tenantId, "stripe-sophia", "sandbox", "legacy-primary", "in_sophia_1"))
      .resolves.toEqual({ status: "reconciled", adjustmentId });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("billing_invoice_adjustment_reconciliations"))).toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("SET status='reconciled'"))).toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("'reconciliation_failed'"))).toBe(true);
  });

  it("safely revalidates a previously failed read-back without resubmitting an invoice item", async () => {
    const row = dispatchRow();
    const query = jest.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes("SELECT * FROM sophia_runtime.billing_invoice_adjustment_outbox")) {
        expect(sql).toContain("'reconciliation_failed'");
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes("SELECT evidence_digest")) {
        const insert = query.mock.calls.find(([text]) => String(text)
          .includes("INSERT INTO sophia_runtime.billing_invoice_adjustment_reconciliations"));
        return { rows: [{ evidence_digest: insert?.[1]?.[14] }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const dispatcher = { status: () => ({ availability: "configured" as const, detail: "sandbox" }),
      submit: jest.fn(), reconcile: jest.fn(async () => ({ outcome: "matched" as const, evidence: {
        providerInvoiceItemRef: "ii_1", providerInvoiceLineRef: "il_1",
        oneTimePriceRef: "price_sophiaOverage123", periodStart: row.period_start, periodEnd: row.period_end,
        quantity: "2", unitPriceMinor: "10", amountMinor: "20", currency: "AUD", invoiceStatus: "paid",
        observedAt: "2026-10-28T08:52:00.000Z",
      } })) };
    await expect(new BillingInvoiceAdjustmentOutboxService(database(query), dispatcher)
      .reconcileInvoice(tenantId, "stripe-sophia", "sandbox", "legacy-primary", "in_sophia_1"))
      .resolves.toEqual({ status: "reconciled", adjustmentId });
    expect(dispatcher.submit).not.toHaveBeenCalled();
  });
});

function database(query: jest.Mock) {
  const run = jest.fn(async (_tenant: string, work: (client: { query: jest.Mock }) => unknown) => work({ query }));
  return { tenantTransaction: run, tenantReadTransaction: run } as never;
}

function draftInvoice() {
  return { providerKey: "stripe-sophia", providerEnvironment: "sandbox" as const,
    providerAccountKey: "legacy-primary", externalCustomerRef: "cus_sophia_1",
    externalSubscriptionRef: "sub_sophia_1", externalInvoiceRef: "in_sophia_1",
    periodStart: "2026-09-28T08:51:05.000Z", periodEnd: "2026-10-28T08:51:05.000Z" };
}

function dispatchQuery(digestOverride?: string) {
  const row = dispatchRow(digestOverride);
  return jest.fn(async (sql: string) => {
    if (sql.includes("RETURNING o.*")) return { rows: [row], rowCount: 1 };
    if (sql.includes("RETURNING billing_invoice_adjustment_outbox_id")) {
      return { rows: [{ billing_invoice_adjustment_outbox_id: adjustmentId }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
}

function dispatchRow(digestOverride?: string) {
  const row = {
    billing_invoice_adjustment_outbox_id: adjustmentId, billing_usage_period_ledger_id: "ledger-1",
    commercial_plan_version_id: planVersionId, provider_key: "stripe-sophia",
    provider_environment: "sandbox", provider_account_key: "legacy-primary",
    external_customer_ref: "cus_sophia_1", external_subscription_ref: "sub_sophia_1",
    external_invoice_ref: "in_sophia_1", one_time_price_ref: "price_sophiaOverage123",
    period_start: "2026-09-28T08:51:05.000Z", period_end: "2026-10-28T08:51:05.000Z",
    quantity: "2", unit_price_minor: "10", currency: "AUD",
    lease_token: "44444444-4444-4444-8444-444444444444",
  };
  const payload = { ledgerId: row.billing_usage_period_ledger_id, planVersionId: row.commercial_plan_version_id,
    providerKey: row.provider_key, providerEnvironment: row.provider_environment,
    providerAccountKey: row.provider_account_key, externalCustomerRef: row.external_customer_ref,
    externalSubscriptionRef: row.external_subscription_ref, externalInvoiceRef: row.external_invoice_ref,
    oneTimePriceRef: row.one_time_price_ref, periodStart: row.period_start, periodEnd: row.period_end,
    quantity: row.quantity, unitPriceMinor: row.unit_price_minor, currency: row.currency };
  const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return { ...row, payload_digest: digestOverride ?? digest };
}
