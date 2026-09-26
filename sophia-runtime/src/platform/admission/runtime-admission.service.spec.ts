import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { RuntimeAdmissionService } from "./runtime-admission.service.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";

describe("RuntimeAdmissionService", () => {
  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    process.env.SOPHIA_RUNTIME_SCHEMA = "sophia_runtime";
    process.env.SOPHIA_MAX_CONCURRENT_SESSIONS = "10";
    process.env.SOPHIA_MAX_TOOL_CALLS_PER_MINUTE = "20";
  });

  it("takes the minimum platform, commercial and tenant ceilings", async () => {
    const query = jest.fn(async () => ({ rows: [limitRow({
      revision: 3, max_concurrent_sessions: 5, max_tool_calls_per_minute: 12,
      entitlements: { concurrentSessions: 7, toolCallsPerMinute: 15 }, plan_key: "growth", plan_version: 2,
    })] }));
    const limits = await service(query).limits(tenantId);
    expect(limits).toMatchObject({
      platformHardCaps: { maxConcurrentSessions: 10, maxToolCallsPerMinute: 20 },
      commercialCeilings: { planKey: "growth", version: 2, maxConcurrentSessions: 7, maxToolCallsPerMinute: 15 },
      tenantGuardrails: { revision: 3, maxConcurrentSessions: 5, maxToolCallsPerMinute: 12 },
      effective: { maxConcurrentSessions: 5, maxToolCallsPerMinute: 12 },
    });
  });

  it("fails closed when a known commercial entitlement has an invalid value", async () => {
    const query = jest.fn(async () => ({ rows: [limitRow({
      entitlements: { concurrentSessions: "unbounded" }, plan_key: "invalid-plan", plan_version: 1,
    })] }));
    const limits = await service(query).limits(tenantId);
    expect(limits.commercialCeilings?.maxConcurrentSessions).toBe(0);
    expect(limits.effective.maxConcurrentSessions).toBe(0);
  });

  it("serializes session admission and counts in-flight provider allocations", async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("LEFT JOIN") && sql.includes("tenant_usage_guardrails")) return { rows: [limitRow({ max_concurrent_sessions: 2 })] };
      if (sql.includes("SELECT status FROM")) return { rows: [{ status: "active" }] };
      if (sql.includes("occupied_count")) return { rows: [{ occupied_count: "1" }] };
      if (sql.includes("INSERT INTO sophia_runtime.provider_session_allocations")) return { rows: [{ allocation_id: "allocation-1" }] };
      throw new Error(`unexpected query: ${sql}`);
    });
    await expect(service(query).reserveProviderSession(tenantId, "native", "essential")).resolves.toMatchObject({
      allocationId: "allocation-1", customerId: tenantId,
    });
    const sql = query.mock.calls.map(([statement]) => String(statement));
    expect(sql.findIndex((item) => item.includes("pg_advisory_xact_lock")))
      .toBeLessThan(sql.findIndex((item) => item.includes("INSERT INTO sophia_runtime.provider_session_allocations")));
  });

  it("enforces the immutable v2 session total separately from the minute rate", async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes("pg_advisory_xact_lock") || sql.includes("DELETE FROM")) return { rows: [] };
      if (sql.includes("LEFT JOIN") && sql.includes("tenant_usage_guardrails")) return { rows: [limitRow({})] };
      if (sql.includes("recent_count")) return { rows: [{ recent_count: "1", total_count: "20" }] };
      throw new Error(`unexpected query: ${sql}`);
    });
    await expect(service(query).reserveToolAttempt({ tenantId, sessionId,
      invocationId: "33333333-3333-4333-8333-333333333333", deduplicationKey: null,
      maximumSessionToolCalls: 20 })).rejects.toThrow("immutable total tool-call limit");
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO sophia_runtime.tool_admission_reservations"))).toBe(false);
  });

  it("does not consume another slot for an already reserved provider event", async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes("pg_advisory_xact_lock") || sql.includes("DELETE FROM")) return { rows: [] };
      if (sql.includes("UNION ALL") && sql.includes("deduplication_key")) return { rows: [{ exists: 1 }] };
      throw new Error(`unexpected query: ${sql}`);
    });
    await expect(service(query).reserveToolAttempt({ tenantId, sessionId,
      invocationId: "33333333-3333-4333-8333-333333333333", deduplicationKey: "provider:event-1",
      maximumSessionToolCalls: 1 })).resolves.toBeUndefined();
  });
});

function service(query: jest.Mock) {
  const run = jest.fn(async (_tenant: string, work: (client: { query: jest.Mock }) => unknown) => work({ query }));
  return new RuntimeAdmissionService({ tenantTransaction: run, tenantReadTransaction: run } as never);
}

function limitRow(overrides: Record<string, unknown>) {
  return { status: "active", revision: null, max_concurrent_sessions: null, max_tool_calls_per_minute: null,
    provider_cost_alert_microunits: null, provider_cost_alert_currency: null, entitlements: null,
    plan_key: null, plan_version: null, ...overrides };
}
