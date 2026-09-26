import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { UsageGuardrailService } from "./usage-guardrail.service.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const principal = { identityUserId: "billing-operator" } as never;

describe("UsageGuardrailService", () => {
  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    process.env.SOPHIA_RUNTIME_SCHEMA = "sophia_runtime";
  });

  it("rejects a tenant value above the current commercial ceiling", async () => {
    const query = jest.fn(async () => ({ rows: [] }));
    const admission = { limitsWithClient: jest.fn(async () => limits({
      commercialCeilings: { planKey: "growth", version: 1, maxConcurrentSessions: 3, maxToolCallsPerMinute: 10 },
    })) };
    await expect(guardrails(query, admission).update(tenantId, principal, {
      expectedRevision: 0, maxConcurrentSessions: 4, maxToolCallsPerMinute: 10, providerCostAlert: null,
    })).rejects.toThrow("cannot exceed the current ceiling of 3");
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO sophia_runtime.tenant_usage_guardrails"))).toBe(false);
  });

  it("optimistically updates lower guardrails, audits them, and reports a non-enforcing estimate alert", async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("UPDATE sophia_runtime.tenant_usage_guardrails")) return { rows: [{ revision: 2 }], rowCount: 1 };
      if (sql.includes("provider_usage_events")) return { rows: [{
        cost_table_version: "provider-v1", measurement_status: "estimated", microunits: "1200",
      }] };
      return { rows: [] };
    });
    const current = limits({ tenantGuardrails: { revision: 2, maxConcurrentSessions: 2, maxToolCallsPerMinute: 8,
      providerCostAlertMicrounits: "1000", providerCostAlertCurrency: "AUD" },
      effective: { maxConcurrentSessions: 2, maxToolCallsPerMinute: 8 } });
    const admission = { limitsWithClient: jest.fn(async () => limits({})), limits: jest.fn(async () => current) };
    const audit = { record: jest.fn(async () => undefined) };
    const result = await guardrails(query, admission, audit).update(tenantId, principal, {
      expectedRevision: 1, maxConcurrentSessions: 2, maxToolCallsPerMinute: 8,
      providerCostAlert: { thresholdMicrounits: "1000", currency: "AUD" },
    });
    expect(result.providerCostAlert).toMatchObject({ status: "active", estimatedMicrounits: "1200",
      admissionEnforcement: false, customerCharge: false });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "usage.guardrails.updated", permission: "usage.limits.manage",
      metadata: expect.objectContaining({ admissionEffect: "downward-only", providerCostAlertEffect: "estimate-only-non-enforcing" }),
    }), expect.anything());
  });
});

function guardrails(query: jest.Mock, admission: object, audit: object = { record: jest.fn() }) {
  const run = jest.fn(async (_tenant: string, work: (client: { query: jest.Mock }) => unknown) => work({ query }));
  return new UsageGuardrailService({ tenantTransaction: run, tenantReadTransaction: run } as never,
    admission as never, audit as never);
}
function limits(overrides: Record<string, unknown>) {
  return { platformHardCaps: { maxConcurrentSessions: 10, maxToolCallsPerMinute: 20 }, commercialCeilings: null,
    tenantGuardrails: null, effective: { maxConcurrentSessions: 10, maxToolCallsPerMinute: 20 }, ...overrides } as never;
}
