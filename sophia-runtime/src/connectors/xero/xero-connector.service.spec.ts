import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import { XeroConnectorService } from "./xero-connector.service.js";
import { XERO_READ_ONLY_SCOPES } from "./xero.config.js";

const originalDatabaseUrl = process.env.SOPHIA_RUNTIME_DATABASE_URL;
beforeAll(() => { process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgresql://example.invalid/runtime"; });
afterAll(() => {
  if (originalDatabaseUrl === undefined) delete process.env.SOPHIA_RUNTIME_DATABASE_URL;
  else process.env.SOPHIA_RUNTIME_DATABASE_URL = originalDatabaseUrl;
});

describe("XeroConnectorService", () => {
  it("requests read-only payments permission for prepayments and overpayments", () => {
    expect(XERO_READ_ONLY_SCOPES).toContain("accounting.payments.read");
    expect(XERO_READ_ONLY_SCOPES).not.toContain("accounting.payments");
  });

  it("requires reconnection for invoice-enabled connections missing payments permission", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{
      xero_connection_id: "44444444-4444-4444-8444-444444444444",
      granted_scopes: ["accounting.settings.read", "accounting.invoices.read", "accounting.contacts.read", "offline_access"],
    }], rowCount: 1 });
    const database = {
      tenantReadTransaction: jest.fn(async (_tenant: string, work: (db: unknown) => Promise<unknown>) => work({ query })),
    };
    const service = new XeroConnectorService(database as never, {} as never, {} as never);
    const result = await service.status("11111111-1111-4111-8111-111111111111");
    expect(result.connections[0]?.missingStudentDiscoveryScopes).toEqual(["accounting.payments.read"]);
  });

  it("reports the granular scopes missing from an existing connection", async () => {
    const query = jest.fn().mockResolvedValue({
      rows: [{
        xero_connection_id: "44444444-4444-4444-8444-444444444444",
        xero_authorization_id: "55555555-5555-4555-8555-555555555555",
        connector_binding_id: "66666666-6666-4666-8666-666666666666",
        provider_connection_id: "provider-1",
        xero_tenant_id: "xero-tenant-1",
        tenant_name: "Example TRUST",
        tenant_type: "ORGANISATION",
        tenant_short_code: null,
        status: "active",
        last_tested_at: null,
        last_error_code: null,
        health_status: "healthy",
        granted_scopes: ["openid", "offline_access", "accounting.settings.read"],
        organisation_role: "trust",
      }],
      rowCount: 1,
    });
    const database = {
      tenantReadTransaction: jest.fn(async (_tenantId: string, work: (db: unknown) => Promise<unknown>) =>
        work({ query })),
    };
    const service = new XeroConnectorService(database as never, {} as never, {} as never);

    const result = await service.status("11111111-1111-4111-8111-111111111111");

    expect(result.connections[0]?.missingStudentDiscoveryScopes).toEqual([
      "accounting.invoices.read",
      "accounting.payments.read",
      "accounting.contacts.read",
    ]);
    expect(result.connections[0]?.organisationRole).toBe("trust");
    expect(query).toHaveBeenCalledWith(expect.stringContaining("a.granted_scopes"), [
      "11111111-1111-4111-8111-111111111111",
    ]);
  });
});
