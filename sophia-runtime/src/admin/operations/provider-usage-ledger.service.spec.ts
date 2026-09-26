import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { ConflictException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { ProviderUsageLedgerService } from "./provider-usage-ledger.service.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";

describe("ProviderUsageLedgerService", () => {
  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    process.env.SOPHIA_RUNTIME_SCHEMA = "sophia_runtime";
  });

  it("deduplicates an identical provider source event without double counting", async () => {
    const evidence = row();
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [evidence], rowCount: 1 });
    const { service, transaction } = setup(query);
    const result = await service.record(input());

    expect(result.replayed).toBe(true);
    expect(result.measurementStatus).toBe("measured");
    expect(transaction).toHaveBeenCalledWith(tenantId, expect.any(Function));
    expect(String(query.mock.calls[0]?.[0])).toContain("ON CONFLICT (customer_id, source_event_id) DO NOTHING");
  });

  it("rejects a reused source identity with different usage evidence", async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [row({ source_digest: "different".padEnd(64, "0") })], rowCount: 1 });
    const { service } = setup(query);
    await expect(service.record(input())).rejects.toBeInstanceOf(ConflictException);
  });

  it("reconciles incomplete evidence forward with an optimistic revision", async () => {
    const incomplete = row({ measurement_status: "incomplete", usage_dimensions: {}, revision: 1, source_digest: "a".repeat(64) });
    const measured = row({ revision: 2, reconciled_at: new Date(), source_digest: "b".repeat(64) });
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [incomplete], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [measured], rowCount: 1 });
    const { service } = setup(query);
    const result = await service.reconcile(tenantId, "response:1", {
      expectedRevision: 1, measurementStatus: "measured",
      usageDimensions: { "input-tokens": 10, "output-tokens": 4, "total-tokens": 14 },
    });

    expect(result.revision).toBe(2);
    expect(result.replayed).toBe(false);
    expect(String(query.mock.calls[1]?.[0])).toContain("revision = revision + 1");
  });
});

function input() {
  return { tenantId, sessionId, sourceEventId: "response:1", providerId: "openai-reasoning",
    adapterKey: "openai-reasoning-v1", measurementStatus: "measured" as const,
    usageDimensions: { "input-tokens": 10, "output-tokens": 4, "total-tokens": 14 },
    occurredAt: new Date("2026-09-25T00:00:00Z") };
}

function row(changes: Record<string, unknown> = {}) {
  return { usage_event_id: "usage-1", customer_id: tenantId, session_id: sessionId,
    source_event_id: "response:1", provider_id: "openai-reasoning", adapter_key: "openai-reasoning-v1",
    measurement_status: "measured", usage_dimensions: input().usageDimensions,
    estimated_cost_microunits: null, cost_currency: null, cost_table_version: null,
    source_digest: "470bcaa6ed4de6c6bc35661263da3db279bf83c61db0848d3295fdc758e4eb28",
    revision: 1, occurred_at: new Date("2026-09-25T00:00:00Z"), recorded_at: new Date(), reconciled_at: null,
    ...changes };
}

function setup(query: jest.Mock) {
  const client = { query } as unknown as PoolClient;
  const transaction = jest.fn(async (_tenantId: string, work: (value: PoolClient) => unknown) => work(client));
  return { service: new ProviderUsageLedgerService({ tenantTransaction: transaction } as never), transaction };
}
