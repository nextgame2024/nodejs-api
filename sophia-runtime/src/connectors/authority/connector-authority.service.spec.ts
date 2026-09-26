import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { ConnectorAuthorityService } from "./connector-authority.service.js";

describe("ConnectorAuthorityService", () => {
  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    process.env.SOPHIA_RUNTIME_SCHEMA = "sophia_runtime";
  });

  it("derives company authority only from the tenant-scoped binding", async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [{
      connector_binding_id: "22222222-2222-4222-8222-222222222222",
      customer_id: "11111111-1111-4111-8111-111111111111",
      external_account_id: "33333333-3333-4333-8333-333333333333",
      allowed_scopes: ["bm:real-estate:read"],
      status: "active",
    }] }) };
    const database = { tenantTransaction: jest.fn(async (_tenant: string, work: (value: never) => unknown) => work(client as never)) };
    const credentials = { issue: jest.fn().mockReturnValue("scoped-token") };
    const service = new ConnectorAuthorityService(database as never, credentials as never);

    const result = await service.issueCredential(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      ["bm:real-estate:read"],
    );
    expect(result).toEqual({
      authorization: "Bearer scoped-token",
      externalAccountId: "33333333-3333-4333-8333-333333333333",
    });
    expect(credentials.issue).toHaveBeenCalledWith(expect.objectContaining({
      externalCompanyId: "33333333-3333-4333-8333-333333333333",
    }), ["bm:real-estate:read"]);
  });

  it("cannot resolve another tenant's overlapping binding identifier", async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const database = { tenantTransaction: jest.fn(async (_tenant: string, work: (value: never) => unknown) => work(client as never)) };
    const service = new ConnectorAuthorityService(database as never, { issue: jest.fn() } as never);
    await expect(service.issueCredential(
      "99999999-9999-4999-8999-999999999999",
      "22222222-2222-4222-8222-222222222222",
      ["bm:real-estate:read"],
    )).rejects.toBeInstanceOf(NotFoundException);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("customer_id = $2"), [
      "22222222-2222-4222-8222-222222222222",
      "99999999-9999-4999-8999-999999999999",
    ]);
  });

  it("allows only reconciliation-safe reads while disconnecting", async () => {
    const binding = {
      connector_binding_id: "22222222-2222-4222-8222-222222222222",
      customer_id: "11111111-1111-4111-8111-111111111111",
      external_account_id: "33333333-3333-4333-8333-333333333333",
      allowed_scopes: ["bm:real-estate:read", "bm:real-estate:booking:write"], status: "disconnecting",
    };
    const client = { query: jest.fn().mockResolvedValue({ rows: [binding] }) };
    const database = { tenantTransaction: jest.fn(async (_tenant: string, work: (value: never) => unknown) => work(client as never)) };
    const credentials = { issue: jest.fn().mockReturnValue("scoped-token") };
    const service = new ConnectorAuthorityService(database as never, credentials as never);
    await expect(service.issueCredential(binding.customer_id, binding.connector_binding_id,
      ["bm:real-estate:read"])).resolves.toMatchObject({ authorization: "Bearer scoped-token" });
    await expect(service.issueCredential(binding.customer_id, binding.connector_binding_id,
      ["bm:real-estate:booking:write"])).rejects.toBeInstanceOf(ForbiddenException);
  });
});
