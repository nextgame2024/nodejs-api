import { describe, expect, it, jest } from "@jest/globals";
import { ForbiddenException } from "@nestjs/common";
import { StudentOperationsXeroController } from "./student-operations-xero.controller.js";

const basePrincipal = {
  identityUserId: "user-1",
  tenantId: "11111111-1111-4111-8111-111111111111",
  externalCompanyId: "22222222-2222-4222-8222-222222222222",
  entitlementId: "33333333-3333-4333-8333-333333333333",
  authorizationRevision: 1,
};

describe("StudentOperationsXeroController", () => {
  it("allows the Chief Executive to begin tenant-scoped Xero consent", async () => {
    const beginAuthorization = jest.fn().mockResolvedValue({ authorizationUrl: "https://login.xero.test" });
    const controller = new StudentOperationsXeroController({ beginAuthorization } as never);
    const principal = { ...basePrincipal, role: "chief_executive" as const };
    await expect(controller.authorizeConnection({ studentOperationsPrincipal: principal }))
      .resolves.toEqual({ authorizationUrl: "https://login.xero.test" });
    expect(beginAuthorization).toHaveBeenCalledWith(principal.tenantId, principal.identityUserId);
  });

  it("denies Operations and Advisor roles before connector access", () => {
    const status = jest.fn();
    const controller = new StudentOperationsXeroController({ status } as never);
    for (const role of ["operations", "advisor"] as const) {
      expect(() => controller.status({ studentOperationsPrincipal: { ...basePrincipal, role } }))
        .toThrow(ForbiddenException);
    }
    expect(status).not.toHaveBeenCalled();
  });

  it("loads invoice-derived candidates only for the current Chief Executive tenant", async () => {
    const discoverStudentCandidates = jest.fn().mockResolvedValue({ candidates: [] });
    const controller = new StudentOperationsXeroController({ discoverStudentCandidates } as never);
    const principal = { ...basePrincipal, role: "chief_executive" as const };

    await expect(controller.studentCandidates(
      { studentOperationsPrincipal: principal },
      "44444444-4444-4444-8444-444444444444",
    )).resolves.toEqual({ candidates: [] });
    expect(discoverStudentCandidates).toHaveBeenCalledWith(
      principal.tenantId,
      "44444444-4444-4444-8444-444444444444",
    );
  });
});
