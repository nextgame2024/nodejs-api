import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { BillingMeterOutboxService } from "./billing-meter-outbox.service.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const outboxId = "22222222-2222-4222-8222-222222222222";

describe("BillingMeterOutboxService", () => {
  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    process.env.SOPHIA_RUNTIME_SCHEMA = "sophia_runtime";
  });

  it("does not claim or submit while no approved provider dispatcher exists", async () => {
    const transaction = jest.fn();
    const dispatcher = { status: () => ({ availability: "disabled" as const, detail: "no meter" }),
      submit: jest.fn() };
    const result = await new BillingMeterOutboxService({ tenantTransaction: transaction } as never, dispatcher, reconciler())
      .dispatchNext(tenantId, "stripe-sophia", "sandbox", "legacy-primary", "worker-1");
    expect(result).toEqual({ status: "disabled", detail: "no meter" });
    expect(transaction).not.toHaveBeenCalled();
    expect(dispatcher.submit).not.toHaveBeenCalled();
  });

  it("uses the durable deterministic payload and records provider acceptance through a fenced lease", async () => {
    const query = queryMock();
    const dispatcher = { status: () => ({ availability: "configured" as const, detail: "test adapter" }),
      submit: jest.fn(async () => ({ outcome: "accepted" as const, providerEventRef: "evt_meter_1",
        acceptedAt: "2026-09-27T06:00:00.000Z" })) };
    const result = await new BillingMeterOutboxService(database(query), dispatcher, reconciler())
      .dispatchNext(tenantId, "stripe-sophia", "sandbox", "legacy-primary", "worker-1");
    expect(result.status).toBe("provider_accepted");
    expect(dispatcher.submit).toHaveBeenCalledWith(expect.objectContaining({
      submissionIdentifier: `sophia-active-minutes-${outboxId}`, quantity: "2", quantityUnit: "whole-minute",
    }));
    const accepted = query.mock.calls.find(([sql]) => String(sql).includes("status='provider_accepted'"));
    expect(accepted?.[1]?.slice(0, 3)).toEqual([outboxId, tenantId, "33333333-3333-4333-8333-333333333333"]);
  });

  it("quarantines an exception after submission as outcome_unknown instead of retrying", async () => {
    const query = queryMock();
    const dispatcher = { status: () => ({ availability: "configured" as const, detail: "test adapter" }),
      submit: jest.fn(async () => { throw new Error("socket closed after write"); }) };
    const result = await new BillingMeterOutboxService(database(query), dispatcher, reconciler())
      .dispatchNext(tenantId, "stripe-sophia", "sandbox", "legacy-primary", "worker-1");
    expect(result.status).toBe("outcome_unknown");
    expect(query.mock.calls.some(([sql]) => String(sql).includes("status='outcome_unknown'"))).toBe(true);
    expect(query.mock.calls.some(([sql]) => /SET\s+status='pending'/.test(String(sql)))).toBe(false);
  });

  it("fails a corrupted durable payload before making a provider call", async () => {
    const query = queryMock("f".repeat(64));
    const dispatcher = { status: () => ({ availability: "configured" as const, detail: "test adapter" }),
      submit: jest.fn() };
    const result = await new BillingMeterOutboxService(database(query), dispatcher, reconciler())
      .dispatchNext(tenantId, "stripe-sophia", "sandbox", "legacy-primary", "worker-1");
    expect(result.status).toBe("terminal_failed");
    expect(dispatcher.submit).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => String(sql).includes("status='terminal_failed'"))).toBe(true);
  });

  it("records immutable dual-source evidence before advancing an accepted event to reconciled", async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes("JOIN sophia_runtime.billing_usage_period_ledgers") && sql.includes("provider_accepted")) {
        return { rows: [{
          billing_meter_event_outbox_id: outboxId, billing_usage_period_ledger_id: outboxId,
          commercial_plan_version_id: "55555555-5555-4555-8555-555555555555",
          submission_identifier: `sophia-active-minutes-${outboxId}`,
          provider_key: "stripe-sophia", provider_environment: "sandbox", provider_account_key: "legacy-primary",
          external_customer_ref: "cus_sandbox", meter_binding_key: "active-overage-minutes",
          period_start: "2026-08-15T00:00:00.000Z", period_end: "2026-09-15T00:00:00.000Z",
          quantity: "2", overage_unit_price_minor: "10", currency: "AUD",
        }], rowCount: 1 };
      }
      if (sql.includes("SELECT evidence_digest")) {
        const insert = query.mock.calls.find(([text]) => String(text).includes("INSERT INTO sophia_runtime.billing_meter_event_reconciliations"));
        return { rows: [{ evidence_digest: insert?.[1]?.[19] }], rowCount: 1 };
      }
      if (sql.includes("RETURNING billing_meter_event_outbox_id")) {
        return { rows: [{ billing_meter_event_outbox_id: outboxId }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const reconciliation = { reconcile: jest.fn(async () => ({ outcome: "matched" as const, evidence: {
      providerEventRef: `sophia-active-minutes-${outboxId}`, meterRef: "mtr_1", meterSummaryRef: "mtrsum_1",
      meterSummaryStart: "2026-08-15T00:00:00.000Z", meterSummaryEnd: "2026-09-15T00:00:00.000Z",
      meterSummaryQuantity: "2", invoiceRef: "in_1", invoiceLineRef: "il_1",
      meteredPriceRef: "price_metered_1", invoiceLineQuantity: "2", invoiceLineAmountMinor: "20",
      currency: "AUD", observedAt: "2026-09-15T01:00:00.000Z",
    } })) };
    const result = await new BillingMeterOutboxService(database(query), {
      status: () => ({ availability: "configured" as const, detail: "test" }), submit: jest.fn(),
    }, reconciliation).reconcileNext(tenantId, "stripe-sophia", "sandbox", "legacy-primary");
    expect(result).toEqual({ status: "reconciled", outboxId });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("billing_meter_event_reconciliations"))).toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("SET status='reconciled'"))).toBe(true);
  });
});

function database(query: jest.Mock) {
  const run = jest.fn(async (_tenant: string, work: (client: { query: jest.Mock }) => unknown) => work({ query }));
  return { tenantTransaction: run, tenantReadTransaction: run } as never;
}

function reconciler() {
  return { reconcile: jest.fn(async () => ({ outcome: "pending" as const, detail: "not ready" })) };
}

function queryMock(payloadDigestOverride?: string) {
  const providerCustomerId = "44444444-4444-4444-8444-444444444444";
  const eventTimestamp = "2026-09-15T00:00:00.000Z";
  const digest = createHash("sha256").update(JSON.stringify({
    ledgerId: outboxId, ledgerDigest: "b".repeat(64), providerKey: "stripe-sophia",
    providerEnvironment: "sandbox", providerAccountKey: "legacy-primary",
    billingProviderCustomerId: providerCustomerId, meterBindingKey: "active-overage-minutes",
    externalCustomerRef: "cus_sandbox", submissionIdentifier: `sophia-active-minutes-${outboxId}`,
    eventTimestamp, quantity: "2", quantityUnit: "whole-minute",
  })).digest("hex");
  return jest.fn(async (sql: string) => {
    if (sql.includes("RETURNING o.*")) return { rows: [{
      billing_meter_event_outbox_id: outboxId,
      billing_usage_period_ledger_id: outboxId,
      billing_provider_customer_id: providerCustomerId,
      ledger_digest: "b".repeat(64),
      submission_identifier: `sophia-active-minutes-${outboxId}`,
      provider_key: "stripe-sophia", provider_environment: "sandbox", provider_account_key: "legacy-primary",
      external_customer_ref: "cus_sandbox", meter_binding_key: "active-overage-minutes",
      event_timestamp: eventTimestamp, quantity: "2", quantity_unit: "whole-minute",
      payload_digest: payloadDigestOverride ?? digest, attempt_count: 1, max_attempts: 6,
      lease_token: "33333333-3333-4333-8333-333333333333",
    }], rowCount: 1 };
    if (sql.includes("RETURNING billing_meter_event_outbox_id")) return { rows: [{ billing_meter_event_outbox_id: outboxId }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
}
