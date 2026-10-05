import { describe, expect, it, jest } from "@jest/globals";
import { ForbiddenException } from "@nestjs/common";
import { OpenForAustraliaWorkspaceService } from "./open-for-australia-workspace.service.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const entitlementId = "33333333-3333-4333-8333-333333333333";

function harness(entitled = true) {
  const auditQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 1 });
  const entitlementQuery = jest.fn().mockResolvedValue({
    rows: entitled ? [{
      entitlement_id: entitlementId,
      customer_id: tenantId,
      identity_user_id: "user-1",
      authorization_revision: 3,
    }] : [],
    rowCount: entitled ? 1 : 0,
  });
  const database = {
    query: jest.fn().mockResolvedValue({
      rows: [{ customer_id: tenantId, external_company_id: companyId }],
      rowCount: 1,
    }),
    tenantReadTransaction: jest.fn(async (_tenant: string, work: (client: unknown) => Promise<unknown>) =>
      work({ query: entitlementQuery })),
    tenantTransaction: jest.fn(async (_tenant: string, work: (client: unknown) => Promise<unknown>) =>
      work({ query: auditQuery })),
  };
  return {
    service: new OpenForAustraliaWorkspaceService(database as never),
    database,
    auditQuery,
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
      authorizationRevision: 3,
    });
  });

  it("fails an unentitled identity closed and records the denial", async () => {
    const { service, auditQuery } = harness(false);
    await expect(service.resolvePrincipal({
      userId: "user-1",
      companyId,
      status: "active",
    }, "correlation-2")).rejects.toBeInstanceOf(ForbiddenException);
    expect(auditQuery).toHaveBeenCalledWith(
      expect.stringContaining("business_pack_access_audit_events"),
      expect.arrayContaining([tenantId, "user-1", "open-for-australia", "denied"]),
    );
  });

  it("rejects an absent or ambiguous company-to-tenant binding", async () => {
    const { service, database } = harness();
    database.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(service.resolvePrincipal({
      userId: "user-1",
      companyId,
      status: "active",
    })).rejects.toBeInstanceOf(ForbiddenException);
  });
});
