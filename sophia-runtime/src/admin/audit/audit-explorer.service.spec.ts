import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { PoolClient } from "pg";
import { AuditExplorerService } from "./audit-explorer.service.js";

describe("AuditExplorerService", () => {
  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    process.env.SOPHIA_RUNTIME_SCHEMA = "sophia_runtime";
  });
  it("deeply redacts historical metadata on read", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{
      audit_event_id: "event-1", created_at: "2026-09-25T00:00:00.000Z",
      metadata: { safe: "ok", nested: { authorization: "Bearer secret", note: "visible" } },
    }] });
    const database = { tenantTransaction: jest.fn(async (_tenant: string, work: (client: PoolClient) => unknown) => work({ query } as never)) };
    const service = new AuditExplorerService(database as never, {} as never);
    const result = await service.list("11111111-1111-4111-8111-111111111111", { limit: 50 });
    expect(result.events[0].metadata).toEqual({ safe: "ok", nested: { authorization: "[REDACTED]", note: "visible" } });
    expect(String(query.mock.calls[0]?.[0])).toContain("customer_id = $1");
  });

  it("does not invent a retention or legal-hold policy", () => {
    const service = new AuditExplorerService({} as never, {} as never);
    expect(service.retentionStatus()).toEqual(expect.objectContaining({
      policyStatus: "unavailable", deletionEnabled: false, legalHoldAutomation: "unavailable",
    }));
  });
});
