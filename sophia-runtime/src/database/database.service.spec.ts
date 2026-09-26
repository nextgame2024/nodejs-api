import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { DatabaseService } from "./database.service.js";

describe("DatabaseService tenant transactions", () => {
  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    process.env.SOPHIA_RUNTIME_DB_SSL = "false";
    delete process.env.SOPHIA_RUNTIME_DATABASE_ROLE;
  });

  it("sets transaction-local tenant context on the same pooled client", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const client = { query, release: jest.fn() };
    const service = new DatabaseService();
    (service as unknown as { pool: { connect: () => Promise<typeof client> } }).pool = {
      connect: jest.fn().mockResolvedValue(client),
    };
    const tenantId = "11111111-1111-4111-8111-111111111111";
    await service.tenantTransaction(tenantId, async (scopedClient) => {
      expect(scopedClient).toBe(client);
      await scopedClient.query("SELECT 1");
    });

    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN",
      "SELECT set_config('sophia.tenant_id', $1, true)",
      "SELECT 1",
      "COMMIT",
    ]);
    expect(query.mock.calls[1]?.[1]).toEqual([tenantId]);
    expect(client.release).toHaveBeenCalled();
  });

  it("starts analytics-style tenant reads at repeatable-read before setting RLS context", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const client = { query, release: jest.fn() };
    const service = new DatabaseService();
    (service as unknown as { pool: { connect: () => Promise<typeof client> } }).pool = {
      connect: jest.fn().mockResolvedValue(client),
    };
    const tenantId = "11111111-1111-4111-8111-111111111111";
    await service.tenantReadTransaction(tenantId, (scopedClient) => scopedClient.query("SELECT count(*) FROM evidence"));

    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN",
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      "SELECT set_config('sophia.tenant_id', $1, true)",
      "SELECT count(*) FROM evidence",
      "COMMIT",
    ]);
    expect(query.mock.calls[2]?.[1]).toEqual([tenantId]);
    expect(client.release).toHaveBeenCalled();
  });

  it("rejects an unsafe database role identifier", () => {
    process.env.SOPHIA_RUNTIME_DATABASE_ROLE = "sophia_runtime_app; reset role";
    expect(() => new DatabaseService()).toThrow("SOPHIA_RUNTIME_DATABASE_ROLE must be a valid PostgreSQL identifier");
  });

  it("assumes the least-privilege runtime role by default", async () => {
    const service = new DatabaseService();
    const poolOptions = (service as unknown as { pool: { options: { verify?: unknown } } }).pool.options;
    expect(poolOptions.verify).toEqual(expect.any(Function));
    await service.onModuleDestroy();
  });
});
