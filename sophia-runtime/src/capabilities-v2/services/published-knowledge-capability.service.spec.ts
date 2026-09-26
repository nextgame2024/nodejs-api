import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { PoolClient } from "pg";
import { PublishedKnowledgeCapabilityService } from "./published-knowledge-capability.service.js";

describe("published knowledge capability", () => {
  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    process.env.SOPHIA_RUNTIME_SCHEMA = "sophia_runtime";
  });

  it("requires a published snapshot grant in the tenant-scoped query", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const client = { query } as unknown as PoolClient;
    const database = { tenantTransaction: jest.fn(async (_tenant: string, work: (client: PoolClient) => unknown) => work(client)) };
    const service = new PublishedKnowledgeCapabilityService(database as never);
    await expect(service.searchPublishedSnapshot({
      tenantId: "11111111-1111-4111-8111-111111111111",
      snapshotId: "22222222-2222-4222-8222-222222222222",
      capabilityBindingId: "33333333-3333-4333-8333-333333333333",
      query: "opening hours",
      limit: 10,
    })).resolves.toEqual({ items: [], page: { hasMore: false } });
    expect(query.mock.calls[0]?.[0]).toEqual(expect.stringContaining("s.status = 'published'"));
    expect(query.mock.calls[0]?.[0]).toEqual(expect.stringContaining("g.capability_binding_id = $3"));
  });

  it("returns no records when a runtime call omits its server-selected snapshot", async () => {
    const database = { tenantTransaction: jest.fn() };
    const service = new PublishedKnowledgeCapabilityService(database as never);
    const result = await service.search({ query: "hours", page: { limit: 10 } }, {
      tenantId: "11111111-1111-4111-8111-111111111111",
      capabilityBindingId: "33333333-3333-4333-8333-333333333333",
      connectorBindingId: "44444444-4444-4444-8444-444444444444",
      actorRef: "session-1", correlationId: "correlation-1", deadline: new Date().toISOString(),
    });
    expect(result.items).toEqual([]);
    expect(database.tenantTransaction).not.toHaveBeenCalled();
  });
});
