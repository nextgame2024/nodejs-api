import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { ForbiddenException } from "@nestjs/common";
import { AdminAuthorizationService } from "./admin-authorization.service.js";

describe("AdminAuthorizationService", () => {
  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    process.env.SOPHIA_RUNTIME_SCHEMA = "sophia_runtime";
  });

  it("resolves a fixed role through the external company and active membership", async () => {
    const membership = {
      membership_id: "22222222-2222-4222-8222-222222222222",
      customer_id: "11111111-1111-4111-8111-111111111111",
      external_company_id: "33333333-3333-4333-8333-333333333333",
      role_key: "configuration_editor",
      permission_overrides: { allow: [], deny: ["connectors.manage"] },
      authorization_revision: 3,
    };
    const client = { query: jest.fn().mockResolvedValue({ rows: [membership] }) };
    const database = {
      query: jest.fn().mockResolvedValue({ rows: [{
        customer_id: membership.customer_id,
        external_company_id: membership.external_company_id,
      }] }),
      tenantTransaction: jest.fn(async (_tenant: string, work: (client: typeof client) => unknown) => work(client)),
    };
    const service = new AdminAuthorizationService(database as never);

    const principal = await service.resolvePrincipal({
      userId: "business-manager-user",
      companyId: "33333333-3333-4333-8333-333333333333",
      status: "active",
    });

    expect(database.tenantTransaction).toHaveBeenCalledWith(membership.customer_id, expect.any(Function));
    expect(client.query.mock.calls[0]?.[0]).not.toContain("c.status = 'active'");
    expect(principal.permissions).toContain("agents.edit");
    expect(principal.permissions).not.toContain("agents.publish");
    expect(principal.permissions).not.toContain("connectors.manage");
  });

  it("rejects membership permission elevation overrides", async () => {
    const membership = {
      membership_id: "22222222-2222-4222-8222-222222222222",
      customer_id: "11111111-1111-4111-8111-111111111111",
      external_company_id: "33333333-3333-4333-8333-333333333333",
      role_key: "read_only_auditor",
      permission_overrides: { allow: ["billing.manage"], deny: [] },
      authorization_revision: 1,
    };
    const client = { query: jest.fn().mockResolvedValue({ rows: [membership] }) };
    const database = {
      query: jest.fn().mockResolvedValue({ rows: [{
        customer_id: membership.customer_id,
        external_company_id: membership.external_company_id,
      }] }),
      tenantTransaction: jest.fn(async (_tenant: string, work: (client: typeof client) => unknown) => work(client)),
    };
    const service = new AdminAuthorizationService(database as never);

    await expect(service.resolvePrincipal({
      userId: "user-1",
      companyId: "33333333-3333-4333-8333-333333333333",
      status: "active",
    })).rejects.toBeInstanceOf(ForbiddenException);
  });
});
