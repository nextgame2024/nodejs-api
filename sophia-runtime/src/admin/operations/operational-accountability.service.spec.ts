import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { PoolClient } from "pg";
import { OperationalAccountabilityService } from "./operational-accountability.service.js";

describe("OperationalAccountabilityService", () => {
  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    process.env.SOPHIA_RUNTIME_SCHEMA = "sophia_runtime";
  });

  it("reports tenant-scoped queues, honest retry capability and non-fabricated handoff completion", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{
      sessions_total: 4, sessions_active: 1, sessions_failed: 1, orphan_sessions: 1,
      tools_total: 9, tools_failed: 2, tools_denied: 12, workflow_total: 3, workflow_failed: 1,
      provider_cleanup_queue: 1, workflow_retry_queue: 0, operations_inbox_queue: 2,
      old_provider_cleanup_seconds: 1200, old_workflow_retry_seconds: 0, old_operations_inbox_seconds: 300,
      callback_requested: 2, notification_accepted: 0, live_connected: 0, handoff_failed: 1,
      recent_failures: 4, recent_denials: 12,
    }], rowCount: 1 });
    const transaction = jest.fn(async (_tenant: string, work: (client: PoolClient) => unknown) =>
      work({ query } as unknown as PoolClient));
    const service = new OperationalAccountabilityService({ tenantTransaction: transaction } as never);
    const result = await service.status("11111111-1111-4111-8111-111111111111");

    expect(transaction).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", expect.any(Function));
    expect(String(query.mock.calls[0]?.[0])).toContain("WHERE s.customer_id=$1");
    expect(result.retryCapabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: "tool-call", availability: "unsupported" }),
      expect.objectContaining({ target: "workflow", availability: "owner-dependent" }),
    ]));
    expect(result.handoff.callback).toEqual(expect.objectContaining({ requested: 2, completed: null,
      semantics: "request-is-not-completion" }));
    expect(result.handoff.liveTransfer).toEqual(expect.objectContaining({ availability: "unsupported", connected: 0 }));
    expect(result.alerts).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "queue-age", status: "active" }),
      expect.objectContaining({ key: "denial-spike", status: "active" }),
      expect.objectContaining({ key: "budget-exhaustion", status: "unavailable" }),
    ]));
  });

  it("keeps provider usage, cost estimates and customer charges semantically separate", async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ measurement_status: "measured", event_count: 1 }] })
      .mockResolvedValueOnce({ rows: [{ provider_id: "neutral", adapter_key: "neutral-v1",
        measurement_status: "measured", event_count: 1 }] })
      .mockResolvedValueOnce({ rows: [{ dimension: "input-tokens", measurement_status: "measured", quantity: "12" }] })
      .mockResolvedValueOnce({ rows: [{ cost_currency: "AUD", cost_table_version: "provider-2026-09",
        measurement_status: "estimated", microunits: "150" }] });
    const transaction = jest.fn(async (_tenant: string, work: (client: PoolClient) => unknown) =>
      work({ query } as unknown as PoolClient));
    const service = new OperationalAccountabilityService({ tenantTransaction: transaction } as never);
    const result = await service.usage("11111111-1111-4111-8111-111111111111");

    expect(query).toHaveBeenCalledTimes(4);
    expect(result.dimensionTotals).toEqual([{ dimension: "input-tokens", measurementStatus: "measured", quantity: "12" }]);
    expect(result.providerCostEstimates[0]).toEqual(expect.objectContaining({
      costTableVersion: "provider-2026-09", estimatedMicrounits: "150", customerCharge: false,
    }));
    expect(result.commercialPolicy).toEqual({ status: "not_configured", customerCharges: false });
    expect(result.budgetAlert.status).toBe("unavailable");
  });
});
