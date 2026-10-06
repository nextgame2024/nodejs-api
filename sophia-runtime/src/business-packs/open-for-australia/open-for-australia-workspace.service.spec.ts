import { describe, expect, it, jest } from "@jest/globals";
import { ForbiddenException } from "@nestjs/common";
import { OpenForAustraliaWorkspaceService } from "./open-for-australia-workspace.service.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const entitlementId = "33333333-3333-4333-8333-333333333333";

function harness(entitled = true) {
  const auditQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 1 });
  const clientQuery = jest.fn()
    .mockResolvedValueOnce({
      rows: [{ customer_id: tenantId, external_company_id: companyId }],
      rowCount: 1,
    })
    .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    .mockResolvedValueOnce({
      rows: entitled ? [{
        entitlement_id: entitlementId,
        customer_id: tenantId,
        identity_user_id: "user-1",
        role_key: "chief_executive",
        authorization_revision: 3,
      }] : [],
      rowCount: entitled ? 1 : 0,
    })
    .mockImplementation(auditQuery);
  const database = {
    transaction: jest.fn(async (work: (client: unknown) => Promise<unknown>) =>
      work({ query: clientQuery })),
    tenantTransaction: jest.fn(async (_tenant: string, work: (client: unknown) => Promise<unknown>) =>
      work({ query: auditQuery })),
  };
  return {
    service: new OpenForAustraliaWorkspaceService(database as never),
    database,
    auditQuery,
    clientQuery,
  };
}

describe("OpenForAustraliaWorkspaceService", () => {
  it("resolves one active tenant-bound entitlement", async () => {
    const { service } = harness();
    await expect(service.resolvePrincipal({
      userId: "user-1",
      companyId,
      status: "active",
    }, "correlation-1")).resolves.toEqual({
      identityUserId: "user-1",
      tenantId,
      externalCompanyId: companyId,
      entitlementId,
      role: "chief_executive",
      authorizationRevision: 3,
    });
  });

  it("fails an unentitled identity closed and records the denial", async () => {
    const { service, clientQuery } = harness(false);
    await expect(service.resolvePrincipal({
      userId: "user-1",
      companyId,
      status: "active",
    }, "correlation-2")).rejects.toBeInstanceOf(ForbiddenException);
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining("business_pack_access_audit_events"),
      expect.arrayContaining([tenantId, "user-1", "open-for-australia", "denied"]),
    );
  });

  it("rejects an absent or ambiguous company-to-tenant binding", async () => {
    const { service, database } = harness();
    database.transaction.mockImplementationOnce(async (work: (client: unknown) => Promise<unknown>) =>
      work({ query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) }));
    await expect(service.resolvePrincipal({
      userId: "user-1",
      companyId,
      status: "active",
    })).rejects.toBeInstanceOf(ForbiddenException);
  });
});
