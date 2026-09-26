import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { PoolClient } from "pg";
import { ProviderOperationsService, type OperationalSessionRow } from "./provider-operations.service.js";
import { ProviderPartialOpenError } from "./provider-session.interface.js";

describe("ProviderOperationsService", () => {
  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    process.env.SOPHIA_RUNTIME_SCHEMA = "sophia_runtime";
  });

  it("delegates allocation to the shared atomic admission boundary", async () => {
    const gate = { reserveProviderSession: jest.fn().mockResolvedValue({
      allocationId: "allocation-1", customerId: "11111111-1111-4111-8111-111111111111", adapterKey: "native",
    }) };
    const service = new ProviderOperationsService({} as never, {} as never, gate as never);
    await expect(service.begin("11111111-1111-4111-8111-111111111111", "native", "essential"))
      .resolves.toMatchObject({ allocationId: "allocation-1" });
    expect(gate.reserveProviderSession).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111", "native", "essential");
  });

  it("claims provider close once and returns a second close idempotently", async () => {
    const active = session("active");
    const closing = session("closing");
    const closed = { ...session("closed"), ended_at: new Date() };
    const client = { query: jest.fn()
      .mockResolvedValueOnce({ rows: [closing], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [closed], rowCount: 1 }) } as unknown as PoolClient;
    const adapter = { close: jest.fn().mockResolvedValue(undefined) };
    const registry = { resolveStoredSession: jest.fn().mockReturnValue(adapter) };
    const database = {
      tenantTransaction: jest.fn(async (_tenant: string, work: (client: PoolClient) => unknown) => work(client)),
    };
    const service = new ProviderOperationsService(database as never, registry as never, admission());

    const first = await service.close(active);
    const second = await service.close(first);

    expect(first.status).toBe("closed");
    expect(second.status).toBe("closed");
    expect(adapter.close).toHaveBeenCalledTimes(1);
    expect(database.tenantTransaction).toHaveBeenCalledTimes(2);
  });

  it("records a recoverable cleanup state when provider close fails", async () => {
    const client = { query: jest.fn()
      .mockResolvedValueOnce({ rows: [session("closing")], rowCount: 1 })
      .mockResolvedValue({ rows: [], rowCount: 1 }) } as unknown as PoolClient;
    const database = {
      tenantTransaction: jest.fn(async (_tenant: string, work: (client: PoolClient) => unknown) => work(client)),
    };
    const registry = { resolveStoredSession: jest.fn().mockReturnValue({
      close: jest.fn().mockRejectedValue(new Error("provider unavailable")),
    }) };
    const service = new ProviderOperationsService(database as never, registry as never, admission());

    await expect(service.close(session("active"))).rejects.toThrow("cleanup is pending");
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("status = 'cleanup_pending'"))).toBe(true);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("stage = 'cleanup_pending'"))).toBe(true);
  });

  it("persists partial-start resource IDs for reconciliation", async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }) } as unknown as PoolClient;
    const database = {
      tenantTransaction: jest.fn(async (_tenant: string, work: (client: PoolClient) => unknown) => work(client)),
    };
    const service = new ProviderOperationsService(database as never, {} as never, admission());
    const partial = new ProviderPartialOpenError("partial", {
      aiProvider: "openai-realtime", avatarProvider: "liveavatar",
      avatarSessionId: "avatar-orphan", metadata: { lifecycleAdapterKey: "native-realtime-experience-v1" },
    });
    const adapter = { open: jest.fn().mockRejectedValue(partial) };

    await expect(service.open(
      { allocationId: "allocation-1", customerId: "11111111-1111-4111-8111-111111111111", adapterKey: "native" },
      adapter as never,
      { experience: "professional", customerId: "11111111-1111-4111-8111-111111111111", tools: [] },
    )).rejects.toThrow("partial");
    expect(client.query.mock.calls.some(([, params]) => JSON.stringify(params).includes("avatar-orphan"))).toBe(true);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("stage = 'cleanup_pending'"))).toBe(true);
  });
});

function admission() { return { reserveProviderSession: jest.fn() } as never; }

function session(status: string): OperationalSessionRow {
  return {
    session_id: "22222222-2222-4222-8222-222222222222",
    customer_id: "11111111-1111-4111-8111-111111111111",
    status,
    ai_provider: "openai-realtime",
    avatar_provider: "none",
    provider_session_id: "provider-session",
    avatar_session_id: null,
    metadata: { lifecycleAdapterKey: "native-realtime-experience-v1" },
  };
}
