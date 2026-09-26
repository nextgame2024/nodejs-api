import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { BusinessPackRegistry } from "../../business-packs/business-pack.registry.js";
import { createRealEstateBusinessPack } from "../../business-packs/real-estate/real-estate.pack.js";
import { MemoryActionReviewStore } from "../../tools/action-review.store.js";
import { AnalyticsService } from "./analytics.service.js";

const tenantId = "11111111-1111-4111-8111-111111111111";

describe("AnalyticsService", () => {
  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    process.env.SOPHIA_RUNTIME_SCHEMA = "sophia_runtime";
  });

  it("keeps the core registry provider-neutral and adds only bounded pack metrics", () => {
    const core = service(jest.fn(), new BusinessPackRegistry()).metricRegistry();
    expect(core.map((item) => item.metricKey)).toContain("conversations.completed");
    expect(core.find((item) => item.metricKey === "conversations.completed")).toMatchObject({
      evidenceClass: "operational_observation",
      denominatorMetricKey: "conversations.started",
    });
    expect(JSON.stringify(core)).not.toMatch(/real-estate|booking\.commit/i);

    const packs = new BusinessPackRegistry([createRealEstateBusinessPack(
      {} as never, new MemoryActionReviewStore(), {} as never,
    )]);
    const extended = service(jest.fn(), packs).metricRegistry();
    expect(extended.find((item) => item.metricKey === "real-estate.inspection-booking.confirmed")).toMatchObject({
      evidenceClass: "source_confirmed",
      source: { canonicalToolId: "booking.commit", outcomeClass: "success" },
    });

    const pack = createRealEstateBusinessPack({} as never, new MemoryActionReviewStore(), {} as never);
    expect(() => new BusinessPackRegistry([{ ...pack, analyticsMetrics: [{
      ...pack.analyticsMetrics[0],
      source: { ...pack.analyticsMetrics[0].source, canonicalToolId: "unowned.commit" },
    }] }])).toThrow("references a tool outside business pack");
  });

  it("aggregates tenant-bounded canonical evidence and falls back from an invalid organisation timezone", async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes("pg_timezone_names")) return { rows: [{ configured_timezone: "Mars/Olympus", timezone: "UTC", valid: false }] };
      if (sql.includes("FROM sophia_runtime.sessions s")) return { rows: [{
        bucket_date: "2026-09-25", agent_id: null, agent_release_id: null, channel: "voice",
        started: 4, completed: 3, failed: 1, latest_at: "2026-09-25T12:00:00.000Z",
      }] };
      if (sql.includes("FROM sophia_runtime.tool_calls t") && sql.includes("canonical_tool_id = ANY")) return { rows: [{
        bucket_date: "2026-09-25", agent_id: null, agent_release_id: null, channel: "voice",
        canonical_tool_id: "booking.commit", successful: 2, latest_at: "2026-09-25T11:00:00.000Z",
      }] };
      if (sql.includes("FROM sophia_runtime.tool_calls t")) return { rows: [{
        bucket_date: "2026-09-25", agent_id: null, agent_release_id: null, channel: "voice",
        attempted: 5, successful: 2, latest_at: "2026-09-25T11:00:00.000Z",
      }] };
      if (sql.includes("workflow_run_references")) return { rows: [] };
      if (sql.includes("escalation_cases")) return { rows: [] };
      if (sql.includes("sum(u.estimated_cost_microunits)")) return { rows: [{
        cost_currency: "USD", cost_table_version: "provider-2026-09", measurement_status: "estimated", microunits: "1200",
      }] };
      if (sql.includes("u.measurement_status")) return { rows: [{ measurement_status: "estimated", event_count: 3, unattributed_count: 1 }] };
      return { rows: [] };
    });
    const packs = new BusinessPackRegistry([createRealEstateBusinessPack(
      {} as never, new MemoryActionReviewStore(), {} as never,
    )]);
    const result = await service(query, packs).dashboard(tenantId, {
      from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z",
    });

    expect(result.range).toMatchObject({ timezone: "UTC", timezoneSource: "fallback_utc" });
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("Mars/Olympus"), expect.stringContaining("not attributed"),
    ]));
    expect(result.series[0]?.metrics).toMatchObject({
      "conversations.started": 4,
      "conversations.completed": 3,
      "tools.attempted": 5,
      "real-estate.inspection-booking.confirmed": 2,
    });
    expect(result.providerCostEstimates[0]).toMatchObject({ currency: "USD", customerCharge: false });
    expect(result.commercialPolicy.currencyConversion).toBe("not_performed");
    expect(query.mock.calls.every((call) => !String(call[0]).includes("CREATE "))).toBe(true);
    expect(query.mock.calls.some((call) => String(call[0]).includes("count(DISTINCT COALESCE(t.command_id, t.invocation_id, t.tool_call_id))"))).toBe(true);
  });

  it("rejects an unbounded analytics range", async () => {
    await expect(service(jest.fn(), new BusinessPackRegistry()).dashboard(tenantId, {
      from: "2024-01-01T00:00:00.000Z", to: "2026-01-02T00:00:00.000Z",
    })).rejects.toThrow("cannot exceed 366 days");
  });

  it("stores only a bounded aggregate export snapshot with digest evidence", async () => {
    let inserted: unknown[] = [];
    const query = jest.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("pg_timezone_names")) return { rows: [{ configured_timezone: "Australia/Brisbane", timezone: "Australia/Brisbane", valid: true }] };
      if (sql.includes("FROM sophia_runtime.sessions s")) return { rows: [{
        bucket_date: "2026-09-26", agent_id: null, agent_release_id: null, channel: "voice",
        started: 1, completed: 1, failed: 0, latest_at: "2026-09-26T00:00:00.000Z",
      }] };
      if (sql.includes("provider_usage_events") || sql.includes("tool_calls") || sql.includes("workflow_run_references") || sql.includes("escalation_cases")) return { rows: [] };
      if (sql.includes("INSERT INTO sophia_runtime.analytics_export_jobs")) {
        inserted = params ?? [];
        return { rows: [{ analytics_export_job_id: params?.[0], status: "ready", point_count: 1,
          as_of: params?.[3], expires_at: "2026-09-27T00:00:00.000Z", document_digest: params?.[7] }] };
      }
      return { rows: [] };
    });
    const result = await service(query, new BusinessPackRegistry()).createExport(tenantId, "owner-1", {
      format: "json", filters: { from: "2026-09-25T00:00:00.000Z", to: "2026-09-27T00:00:00.000Z" }, maxPoints: 10,
    });
    const document = JSON.parse(String(inserted[8]));
    expect(result).toMatchObject({ status: "ready", point_count: 1 });
    expect(document.dashboard.series).toHaveLength(1);
    expect(document.dashboard.metricRegistry).toEqual(expect.arrayContaining([
      expect.objectContaining({ metricKey: "conversations.started" }),
    ]));
    expect(JSON.stringify(document)).not.toMatch(/transcript|tool_name|input|output|email/i);
    expect(inserted[7]).toMatch(/^[a-f0-9]{64}$/);
  });
});

function service(query: jest.Mock, packs: BusinessPackRegistry) {
  const run = jest.fn(async (_tenantId: string, work: (client: { query: jest.Mock }) => unknown) => work({ query }));
  const database = { tenantTransaction: run, tenantReadTransaction: run };
  return new AnalyticsService(database as never, packs, { record: jest.fn() } as never);
}
