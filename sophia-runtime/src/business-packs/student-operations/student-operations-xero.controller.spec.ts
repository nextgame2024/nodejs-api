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
    const controller = new StudentOperationsXeroController({ beginAuthorization } as never, {} as never);
    const principal = { ...basePrincipal, role: "chief_executive" as const };
    await expect(controller.authorizeConnection({ studentOperationsPrincipal: principal }))
      .resolves.toEqual({ authorizationUrl: "https://login.xero.test" });
    expect(beginAuthorization).toHaveBeenCalledWith(principal.tenantId, principal.identityUserId);
  });

  it("denies Operations and Advisor roles before connector access", () => {
    const status = jest.fn();
    const controller = new StudentOperationsXeroController({ status } as never, {} as never);
    for (const role of ["operations", "advisor"] as const) {
      expect(() => controller.status({ studentOperationsPrincipal: { ...basePrincipal, role } }))
        .toThrow(ForbiddenException);
    }
    expect(status).not.toHaveBeenCalled();
  });

  it("loads invoice-derived candidates only for the current Chief Executive tenant", async () => {
    const candidates = jest.fn().mockResolvedValue({ candidates: [], page: 1, limit: 20, total: 0 });
    const controller = new StudentOperationsXeroController({} as never, { candidates } as never);
    const principal = { ...basePrincipal, role: "chief_executive" as const };

    await expect(controller.studentCandidates(
      { studentOperationsPrincipal: principal },
      "44444444-4444-4444-8444-444444444444",
      { page: "1", limit: "20" },
    )).resolves.toEqual({ candidates: [], page: 1, limit: 20, total: 0 });
    expect(candidates).toHaveBeenCalledWith(
      principal.tenantId,
      "44444444-4444-4444-8444-444444444444",
      { page: "1", limit: "20" },
    );
  });

  it("loads paged invoices and invoice detail only for the current tenant", async () => {
    const invoices = jest.fn().mockResolvedValue({ invoices: [], page: 1, limit: 25, total: 0 });
    const invoice = jest.fn().mockResolvedValue({ xeroInvoiceId: "invoice-1", lineItems: [] });
    const controller = new StudentOperationsXeroController({} as never, { invoices, invoice } as never);
    const principal = { ...basePrincipal, role: "chief_executive" as const };

    await controller.studentInvoices(
      { studentOperationsPrincipal: principal },
      "44444444-4444-4444-8444-444444444444",
      { page: "1", limit: "25" },
    );
    await controller.studentInvoice(
      { studentOperationsPrincipal: principal },
      "44444444-4444-4444-8444-444444444444",
      "77777777-7777-4777-8777-777777777777",
    );

    expect(invoices).toHaveBeenCalledWith(principal.tenantId, expect.any(String), { page: "1", limit: "25" });
    expect(invoice).toHaveBeenCalledWith(
      principal.tenantId,
      "44444444-4444-4444-8444-444444444444",
      "77777777-7777-4777-8777-777777777777",
    );
  });

  it("queues refresh without waiting for Xero and returns the durable run", async () => {
    const enqueueManual = jest.fn().mockResolvedValue({ syncRunId: "run-1", status: "queued" });
    const controller = new StudentOperationsXeroController({} as never, { enqueueManual } as never);
    const principal = { ...basePrincipal, role: "chief_executive" as const };

    await expect(controller.refreshStudents(
      { studentOperationsPrincipal: principal },
      "44444444-4444-4444-8444-444444444444",
    )).resolves.toEqual({ syncRunId: "run-1", status: "queued" });
    expect(enqueueManual).toHaveBeenCalledWith(
      principal,
      "44444444-4444-4444-8444-444444444444",
    );
  });

  it("assigns the TRUST role only inside the current Chief Executive tenant", async () => {
    const configureTrust = jest.fn().mockResolvedValue({
      connectionId: "44444444-4444-4444-8444-444444444444", organisationRole: "trust",
    });
    const controller = new StudentOperationsXeroController({} as never, { configureTrust } as never);
    const principal = { ...basePrincipal, role: "chief_executive" as const };

    await controller.configureTrust(
      { studentOperationsPrincipal: principal },
      "44444444-4444-4444-8444-444444444444",
    );
    expect(configureTrust).toHaveBeenCalledWith(principal, "44444444-4444-4444-8444-444444444444");
  });

});
