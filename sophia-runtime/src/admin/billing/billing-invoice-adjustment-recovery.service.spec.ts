import { describe, expect, it, jest } from "@jest/globals";
import { BillingInvoiceAdjustmentRecoveryService } from "./billing-invoice-adjustment-recovery.service.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const attemptId = "33333333-3333-4333-8333-333333333333";
const sourceId = "44444444-4444-4444-8444-444444444444";

describe("BillingInvoiceAdjustmentRecoveryService", () => {
  it("attaches a missed source to a later renewal while retaining its original service period", async () => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    process.env.SOPHIA_RUNTIME_SCHEMA = "sophia_runtime";
    process.env.SOPHIA_BILLING_PROVIDER = "stripe_sandbox";
    process.env.SOPHIA_BILLING_PROVIDER_ACCOUNT_KEY = "legacy-primary";
    let recoveryDigest = "";
    const query = jest.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes("FROM sophia_runtime.billing_invoice_adjustment_outbox source") && sql.includes("LIMIT 51")) {
        return { rows: [{ billing_invoice_adjustment_outbox_id: sourceId, payload_digest: "a".repeat(64) }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO sophia_runtime.billing_invoice_adjustment_recovery_attempts")) {
        recoveryDigest = String(values?.[5]);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("SELECT billing_invoice_adjustment_recovery_attempt_id,payload_digest")) {
        return { rows: [{ billing_invoice_adjustment_recovery_attempt_id: attemptId, payload_digest: recoveryDigest }], rowCount: 1 };
      }
      if (sql.includes("recovery.target_external_invoice_ref=$2")) {
        return { rows: [{ billing_invoice_adjustment_recovery_attempt_id: attemptId }], rowCount: 1 };
      }
      if (sql.includes("FOR UPDATE OF recovery")) return { rows: [row(recoveryDigest)], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    const dispatcher = { status: jest.fn(() => ({ availability: "configured" as const, detail: "sandbox" })),
      reconcile: jest.fn(), submit: jest.fn(async (input) => {
      expect(input).toMatchObject({ adjustmentId: sourceId, deliveryId: attemptId,
        periodStart: "2026-09-01T00:00:00.000Z", periodEnd: "2026-10-01T00:00:00.000Z",
        targetPeriodStart: "2026-10-01T00:00:00.000Z", targetPeriodEnd: "2026-11-01T00:00:00.000Z" });
      return { outcome: "accepted" as const, providerInvoiceItemRef: "ii_recovery_1",
        acceptedAt: "2026-11-01T00:00:01.000Z" };
    }) };
    const service = new BillingInvoiceAdjustmentRecoveryService(database(query), dispatcher as never);
    await expect(service.enqueueAndDispatch(tenantId, draft(), "worker-1")).resolves.toMatchObject({
      status: "provider_accepted", attempts: [{ status: "provider_accepted", attemptId,
        providerInvoiceItemRef: "ii_recovery_1" }],
    });
    expect(dispatcher.submit).toHaveBeenCalledTimes(1);
  });

  it("does not create an out-of-cycle delivery when no missed source is eligible", async () => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    process.env.SOPHIA_BILLING_PROVIDER = "stripe_sandbox";
    process.env.SOPHIA_BILLING_PROVIDER_ACCOUNT_KEY = "legacy-primary";
    const query = jest.fn(async (sql: string) => sql.includes("LIMIT 51")
      || sql.includes("recovery.target_external_invoice_ref=$2")
      ? { rows: [], rowCount: 0 } : { rows: [], rowCount: 1 });
    const dispatcher = { status: jest.fn(() => ({ availability: "configured" as const, detail: "sandbox" })),
      submit: jest.fn(), reconcile: jest.fn() };
    await expect(new BillingInvoiceAdjustmentRecoveryService(database(query), dispatcher as never)
      .enqueueAndDispatch(tenantId, draft(), "worker-1"))
      .resolves.toEqual({ status: "not_required", attempts: [] });
    expect(dispatcher.submit).not.toHaveBeenCalled();
  });
});

function database(query: jest.Mock) {
  const run = jest.fn(async (_tenant: string, work: (client: { query: jest.Mock }) => unknown) => work({ query }));
  return { tenantTransaction: run, tenantReadTransaction: run } as never;
}
function draft() {
  return { providerKey: "stripe-sophia", providerEnvironment: "sandbox" as const,
    providerAccountKey: "legacy-primary", externalCustomerRef: "cus_1", externalSubscriptionRef: "sub_1",
    externalInvoiceRef: "in_next", periodStart: "2026-10-01T00:00:00.000Z",
    periodEnd: "2026-11-01T00:00:00.000Z" };
}
function row(payloadDigest: string) {
  return { billing_invoice_adjustment_recovery_attempt_id: attemptId,
    source_billing_invoice_adjustment_outbox_id: sourceId, billing_usage_period_ledger_id: "ledger-1",
    commercial_plan_version_id: "22222222-2222-4222-8222-222222222222", provider_key: "stripe-sophia",
    provider_environment: "sandbox", provider_account_key: "legacy-primary", external_customer_ref: "cus_1",
    external_subscription_ref: "sub_1", target_external_invoice_ref: "in_next",
    one_time_price_ref: "price_overage", period_start: "2026-09-01T00:00:00.000Z",
    period_end: "2026-10-01T00:00:00.000Z", target_period_start: "2026-10-01T00:00:00.000Z",
    target_period_end: "2026-11-01T00:00:00.000Z", quantity: "2", unit_price_minor: "10",
    currency: "AUD", source_payload_digest: "a".repeat(64), payload_digest: payloadDigest,
    status: "pending", attempt_count: 0, provider_invoice_item_ref: null };
}
