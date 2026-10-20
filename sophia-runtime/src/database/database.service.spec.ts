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
      'BEGIN; SET LOCAL ROLE "sophia_runtime_app"',
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
      `BEGIN; SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL ROLE "sophia_runtime_app"; SET LOCAL sophia.tenant_id = '${tenantId}'`,
      "SELECT count(*) FROM evidence",
      "COMMIT",
    ]);
    expect(client.release).toHaveBeenCalled();
  });

  it("reports connection and setup timings without changing tenant-read SQL", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const client = { query, release: jest.fn() };
    const service = new DatabaseService();
    (service as unknown as { pool: { connect: () => Promise<typeof client> } }).pool = {
      connect: jest.fn().mockResolvedValue(client),
    };
    const timings: Array<Record<string, number | undefined>> = [];
    await service.tenantReadTransaction(
      "11111111-1111-4111-8111-111111111111",
      (scopedClient) => scopedClient.query("SELECT 1"),
      (value) => timings.push(value),
    );

    expect(timings).toEqual([expect.objectContaining({
      poolAcquireMs: expect.any(Number),
      setupMs: expect.any(Number),
      workMs: expect.any(Number),
      commitMs: expect.any(Number),
      totalMs: expect.any(Number),
    })]);
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN; SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL ROLE "sophia_runtime_app"; SET LOCAL sophia.tenant_id = \'11111111-1111-4111-8111-111111111111\'',
      "SELECT 1",
      "COMMIT",
    ]);
  });

  it("reports direct-transaction timing without letting diagnostics alter the result", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const client = { query, release: jest.fn() };
    const service = new DatabaseService();
    (service as unknown as { pool: { connect: () => Promise<typeof client> } }).pool = {
      connect: jest.fn().mockResolvedValue(client),
    };
    await expect(service.transaction(
      () => Promise.resolve("ok"),
      () => { throw new Error("diagnostic failure"); },
    )).resolves.toBe("ok");
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN; SET LOCAL ROLE "sophia_runtime_app"',
      "COMMIT",
    ]);
    expect(client.release).toHaveBeenCalled();
  });

  it("rejects an unsafe database role identifier", () => {
    process.env.SOPHIA_RUNTIME_DATABASE_ROLE = "sophia_runtime_app; reset role";
    expect(() => new DatabaseService()).toThrow("SOPHIA_RUNTIME_DATABASE_ROLE must be a valid PostgreSQL identifier");
  });

  it("assumes the least-privilege runtime role inside direct-query transactions", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ value: 1 }] });
    const client = { query, release: jest.fn() };
    const service = new DatabaseService();
    (service as unknown as { pool: { connect: () => Promise<typeof client> } }).pool = {
      connect: jest.fn().mockResolvedValue(client),
    };
    await expect(service.query("SELECT 1 AS value")).resolves.toEqual({ rows: [{ value: 1 }] });
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN; SET LOCAL ROLE "sophia_runtime_app"',
      "SELECT 1 AS value",
      "COMMIT",
    ]);
    expect(client.release).toHaveBeenCalled();
  });

  it('distinguishes new client acquisition from reuse and records pool queue state', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() };
    const service = new DatabaseService();
    (service as unknown as { pool: unknown }).pool = {
      connect: jest.fn().mockResolvedValue(client), totalCount: 1, idleCount: 1, waitingCount: 0,
    };
    const observations: unknown[] = [];
    await service.transaction(async () => 'first', value => observations.push(value));
    await service.transaction(async () => 'second', value => observations.push(value));
    expect(observations[0]).toMatchObject({ poolNewConnection: 1, poolTotalBefore: 1, poolIdleBefore: 1, poolWaitingBefore: 0 });
    expect(observations[1]).toMatchObject({ poolNewConnection: 0 });
  });

  it('keeps idle connections briefly without changing the configured maximum pool size', async () => {
    const previous = process.env.SOPHIA_RUNTIME_DB_IDLE_TIMEOUT_MS;
    delete process.env.SOPHIA_RUNTIME_DB_IDLE_TIMEOUT_MS;
    const service = new DatabaseService();
    try {
      const pool = (service as unknown as { pool: { options: { idleTimeoutMillis: number; max: number } } }).pool;
      expect(pool.options.idleTimeoutMillis).toBe(60000);
      expect(pool.options.max).toBe(5);
    } finally {
      await service.onModuleDestroy();
      if (previous !== undefined) process.env.SOPHIA_RUNTIME_DB_IDLE_TIMEOUT_MS = previous;
    }
  });
});
