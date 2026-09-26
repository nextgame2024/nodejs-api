import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { PoolClient } from "pg";
import { ProviderCatalogProvisioner } from "./provider-catalog-provisioner.js";

describe("ProviderCatalogProvisioner", () => {
  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    process.env.SOPHIA_RUNTIME_SCHEMA = "sophia_runtime";
    process.env.SOPHIA_DEPLOYMENT_ENV = "test";
    process.env.TAVUS_PERSONA_ID = "persona-owned-elsewhere";
    process.env.SOPHIA_PROVIDER_CATALOG_MODE = "legacy";
  });

  it("rejects a provider resource already owned by another tenant before remote mutation", async () => {
    const client = { query: jest.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) } as unknown as PoolClient;
    const database = {
      tenantTransaction: jest.fn(async (_tenant: string, work: (client: PoolClient) => unknown) => work(client)),
    };
    const tools = { listDefinitionsForMode: jest.fn().mockReturnValue([]) };
    const providers = { resolve: jest.fn() };
    const service = new ProviderCatalogProvisioner(database as never, tools as never, providers as never);

    await expect(service.provisionTavus(
      "11111111-1111-4111-8111-111111111111", "catalog-v1",
    )).rejects.toThrow("belongs to another tenant");
    expect(providers.resolve).not.toHaveBeenCalled();
    expect(tools.listDefinitionsForMode).toHaveBeenCalledWith("legacy");
  });
});
