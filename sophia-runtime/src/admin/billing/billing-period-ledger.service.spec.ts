import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { BillingPeriodLedgerService } from "./billing-period-ledger.service.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const periodId = "22222222-2222-4222-8222-222222222222";

describe("BillingPeriodLedgerService", () => {
  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    process.env.SOPHIA_RUNTIME_SCHEMA = "sophia_runtime";
  });

  it("intersects exact interval time, aggregates once, then applies one ceiling", async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
      if (sql.includes("FROM sophia_runtime.billing_subscription_periods")) return { rows: [{
        billing_subscription_period_id: periodId,
        provider_key: "stripe-sophia", provider_environment: "sandbox", provider_account_key: "legacy-primary",
        billing_provider_customer_id: "77777777-7777-4777-8777-777777777777", external_customer_ref: "cus_sandbox",
        period_start: "2026-08-15T00:00:00.000Z", period_end: "2026-09-15T00:00:00.000Z",
      }], rowCount: 1 };
      if (sql.includes("FROM sophia_runtime.tenant_commercial_assignments")) return { rows: [{
        commercial_assignment_id: "33333333-3333-4333-8333-333333333333",
        assignment_revision: 1, assignment_effective_from: "2026-01-01T00:00:00.000Z", assignment_effective_to: null,
        commercial_plan_version_id: "44444444-4444-4444-8444-444444444444",
        billing_currency: "AUD", manifest_digest: "a".repeat(64),
        seller_legal_entity_version_id: "55555555-5555-4555-8555-555555555555",
        seller_commercial_policy_version_id: "66666666-6666-4666-8666-666666666666",
        rate_card: { dimensions: [{ dimension: "active-seconds", includedQuantity: "120000",
          unitQuantity: "60", unitPriceMinor: "50" }] },
      }], rowCount: 1 };
      if (sql.includes("status='open'")) return { rows: [], rowCount: 0 };
      if (sql.includes("AS active_microseconds")) return { rows: [{ active_microseconds: "120060000001" }], rowCount: 1 };
      if (sql.includes("INSERT INTO sophia_runtime.billing_usage_period_ledgers")) {
        return { rows: [{ billing_usage_period_ledger_id: "ledger-1" }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO sophia_runtime.billing_meter_event_outbox")) return { rows: [], rowCount: 1 };
      if (sql.includes("FROM sophia_runtime.billing_meter_event_outbox")) {
        const insert = query.mock.calls.find(([text]) => String(text).includes("INSERT INTO sophia_runtime.billing_meter_event_outbox"));
        return { rows: [{ payload_digest: insert?.[1]?.[11] }], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const result = await service(query).finaliseEligible(tenantId, "stripe-sophia", "sandbox", "legacy-primary");

    expect(result).toEqual({ observedPeriods: 1, finalised: 1, existing: 0, blocked: [] });
    const measuredSql = String(query.mock.calls.find(([sql]) => String(sql).includes("AS active_microseconds"))?.[0]);
    expect(measuredSql).toContain("LEAST(ended_at,$3::timestamptz)-GREATEST(started_at,$2::timestamptz)");
    expect(measuredSql).toContain("sum(");
    const openCall = query.mock.calls.find(([sql]) => String(sql).includes("status='open'"));
    expect(openCall?.[0]).toContain("started_at<$2::timestamptz");
    expect(openCall?.[1]).toEqual([tenantId, new Date("2026-09-15T00:00:00.000Z")]);
    const periodSql = String(query.mock.calls.find(([sql]) => String(sql).includes("billing_subscription_periods"))?.[0]);
    expect(periodSql).not.toContain("FOR UPDATE");
    const insert = query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO sophia_runtime.billing_usage_period_ledgers"));
    expect(insert?.[1]?.slice(11, 15)).toEqual(["120060000001", "120000", "60000001", "2"]);
    const outbox = query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO sophia_runtime.billing_meter_event_outbox"));
    expect(outbox?.[1]?.[8]).toBe("sophia-active-minutes-ledger-1");
    expect(outbox?.[1]?.[9]).toBe("2026-09-14T23:59:59.000Z");
    expect(outbox?.[1]?.[10]).toBe("2");
  });

  it("fails closed while an interval overlapping the ended period remains open", async () => {
    const query = baseQuery({ open: true });
    const result = await service(query).finaliseEligible(tenantId, "stripe-sophia", "live", "legacy-primary");
    expect(result).toMatchObject({ finalised: 0, blocked: [{ periodId, reason: expect.stringContaining("still open") }] });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO sophia_runtime.billing_usage_period_ledgers"))).toBe(false);
  });

  it("refuses an ambiguous mid-period commercial or seller-policy transition", async () => {
    const query = baseQuery({ commercialRows: 2 });
    const result = await service(query).finaliseEligible(tenantId, "stripe-sophia", "sandbox", "legacy-primary");
    expect(result).toMatchObject({ finalised: 0, blocked: [{ reason: expect.stringContaining("proration is unavailable") }] });
  });

  it("persists a zero-overage ledger without creating a meaningless provider event", async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
      if (sql.includes("FROM sophia_runtime.billing_subscription_periods")) return { rows: [{
        billing_subscription_period_id: periodId,
        provider_key: "stripe-sophia", provider_environment: "sandbox", provider_account_key: "legacy-primary",
        billing_provider_customer_id: "77777777-7777-4777-8777-777777777777", external_customer_ref: "cus_sandbox",
        period_start: "2026-08-15T00:00:00.000Z", period_end: "2026-09-15T00:00:00.000Z",
      }], rowCount: 1 };
      if (sql.includes("FROM sophia_runtime.tenant_commercial_assignments")) return baseCommercial();
      if (sql.includes("status='open'")) return { rows: [], rowCount: 0 };
      if (sql.includes("AS active_microseconds")) return { rows: [{ active_microseconds: "120000000000" }], rowCount: 1 };
      if (sql.includes("INSERT INTO sophia_runtime.billing_usage_period_ledgers")) {
        return { rows: [{ billing_usage_period_ledger_id: "ledger-zero" }], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const result = await service(query).finaliseEligible(tenantId, "stripe-sophia", "sandbox", "legacy-primary");
    expect(result.finalised).toBe(1);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("billing_meter_event_outbox"))).toBe(false);
  });

  it("uses an explicit bounded provider cutoff only for the sandbox test-clock harness", async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
      if (sql.includes("FROM sophia_runtime.billing_subscription_periods")) return { rows: [], rowCount: 0 };
      throw new Error(`unexpected query: ${sql}`);
    });
    const cutoff = new Date(Date.now() + 31 * 24 * 60 * 60 * 1_000).toISOString();
    await expect(service(query).finaliseSandboxTestClock(
      tenantId, "stripe-sophia", "legacy-primary", cutoff,
    )).resolves.toEqual({ observedPeriods: 0, finalised: 0, existing: 0, blocked: [] });
    const periodQuery = query.mock.calls.find(([sql]) => String(sql).includes("billing_subscription_periods"));
    expect(String(periodQuery?.[0])).toContain("COALESCE($5::timestamptz,now())");
    expect(periodQuery?.[1]?.[4]).toBe(cutoff);

    const tooFar = new Date(Date.now() + 63 * 24 * 60 * 60 * 1_000).toISOString();
    await expect(service(query).finaliseSandboxTestClock(
      tenantId, "stripe-sophia", "legacy-primary", tooFar,
    )).rejects.toThrow("exceeds two monthly intervals");
  });
});

function service(query: jest.Mock) {
  const transaction = jest.fn(async (_tenant: string, work: (client: { query: jest.Mock }) => unknown) => work({ query }));
  return new BillingPeriodLedgerService({ tenantTransaction: transaction } as never);
}

function baseQuery(options: { open?: boolean; commercialRows?: number }) {
  return jest.fn(async (sql: string) => {
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
    if (sql.includes("FROM sophia_runtime.billing_subscription_periods")) return { rows: [{
      billing_subscription_period_id: periodId,
      provider_key: "stripe-sophia", provider_environment: "sandbox", provider_account_key: "legacy-primary",
      billing_provider_customer_id: "77777777-7777-4777-8777-777777777777", external_customer_ref: "cus_sandbox",
      period_start: "2026-08-15T00:00:00.000Z", period_end: "2026-09-15T00:00:00.000Z",
    }], rowCount: 1 };
    if (sql.includes("FROM sophia_runtime.tenant_commercial_assignments")) {
      const commercial = baseCommercial();
      return {
      rows: Array.from({ length: options.commercialRows ?? 1 }, () => commercial.rows[0]),
      rowCount: options.commercialRows ?? 1,
    };
    }
    if (sql.includes("status='open'")) return { rows: options.open ? [{ exists: 1 }] : [], rowCount: options.open ? 1 : 0 };
    throw new Error(`unexpected query: ${sql}`);
  });
}

function baseCommercial() {
  return { rows: [{
        commercial_assignment_id: "33333333-3333-4333-8333-333333333333",
        assignment_revision: 1, assignment_effective_from: "2026-01-01T00:00:00.000Z", assignment_effective_to: null,
        commercial_plan_version_id: "44444444-4444-4444-8444-444444444444",
        billing_currency: "AUD", manifest_digest: "a".repeat(64),
        seller_legal_entity_version_id: "55555555-5555-4555-8555-555555555555",
        seller_commercial_policy_version_id: "66666666-6666-4666-8666-666666666666",
        rate_card: { dimensions: [{ dimension: "active-seconds", includedQuantity: "120000",
          unitQuantity: "60", unitPriceMinor: "50" }] },
      }], rowCount: 1 };
}
