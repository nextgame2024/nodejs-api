import { describe, expect, it, jest } from "@jest/globals";
import { StudentOperationsCurrentWorkspaceController } from "./student-operations-current-workspace.controller.js";

const principal = {
  identityUserId: "user-1",
  tenantId: "11111111-1111-4111-8111-111111111111",
  externalCompanyId: "22222222-2222-4222-8222-222222222222",
  entitlementId: "33333333-3333-4333-8333-333333333333",
  role: "operations" as const,
  authorizationRevision: 2,
};

describe("StudentOperationsCurrentWorkspaceController", () => {
  it("returns the identity-derived workspace context", () => {
    const controller = new StudentOperationsCurrentWorkspaceController({ list: jest.fn() } as never, {} as never, {} as never, {} as never);
    expect(controller.workspace({ studentOperationsPrincipal: principal })).toEqual(expect.objectContaining({
      packId: "student-operations",
      tenantId: principal.tenantId,
      role: "operations",
      authorizationRevision: 2,
    }));
  });

  it("returns dashboard context and counts through one guarded endpoint", async () => {
    const summary = {
      totalStudents: 11,
      activeStudents: 8,
      newApplications: 3,
      actionRequired: 2,
      onHold: 1,
    };
    const controller = new StudentOperationsCurrentWorkspaceController({} as never, {} as never, {} as never, {} as never);
    await expect(controller.dashboard({
      studentOperationsPrincipal: principal,
      studentOperationsDashboardSummary: summary,
    })).resolves.toEqual({
      workspace: expect.objectContaining({ role: "operations", tenantId: principal.tenantId }),
      summary,
    });
  });

  it("passes the authenticated principal to the student list", async () => {
    const list = jest.fn().mockResolvedValue({ students: [], page: 1, limit: 20, total: 0 });
    const controller = new StudentOperationsCurrentWorkspaceController({ list } as never, {} as never, {} as never, {} as never);
    await expect(controller.listStudents(
      { studentOperationsPrincipal: principal }, { q: "synthetic" },
    )).resolves.toEqual({ students: [], page: 1, limit: 20, total: 0 });
    expect(list).toHaveBeenCalledWith(principal, { q: "synthetic" });
  });

  it("passes the authenticated principal to the register without taking tenant scope from filters", async () => {
    const list = jest.fn().mockResolvedValue({ students: [], total: 0 });
    const controller = new StudentOperationsCurrentWorkspaceController({} as never, { list } as never, {} as never, {} as never);
    await expect(controller.studentRegister(
      { studentOperationsPrincipal: principal, studentOperationsCorrelationId: "test-correlation" }, { q: "sample" },
    )).resolves.toEqual({ students: [], total: 0,
      workspace: expect.objectContaining({ role: 'operations', tenantId: principal.tenantId }) });
    expect(list).toHaveBeenCalledWith(principal, { q: "sample" }, "test-correlation");
  });

  it('loads the current Trust register through one authenticated principal with unchanged filters', async () => {
    const connection = { connectionId: 'trust-connection', status: 'active', organisationRole: 'trust', missingStudentDiscoveryScopes: [] };
    const status = jest.fn().mockResolvedValue({ connections: [
      { ...connection, connectionId: 'other-connection', organisationRole: null }, connection,
    ] });
    const invoices = jest.fn().mockResolvedValue({ invoices: [{ invoiceNumber: 'INV-1' }], page: 4 });
    const controller = new StudentOperationsCurrentWorkspaceController({} as never, {} as never, { status } as never, { invoices } as never);
    const query = { page: '4', limit: '100', q: 'ATI', status: 'DRAFT', sort: 'date', direction: 'desc' };
    const result = await controller.paymentsRegister({ studentOperationsPrincipal: { ...principal, role: 'chief_executive' }, studentOperationsCorrelationId: 'trace-1' }, query);
    expect(result).toMatchObject({ workspace: { role: 'chief_executive' }, connection, invoices: { page: 4 }, connectionIssue: null });
    expect(status).toHaveBeenCalledWith(principal.tenantId);
    expect(invoices).toHaveBeenCalledWith(principal.tenantId, 'trust-connection', query, 'trace-1');
  });

  it('never reads integration data for operations or advisors', async () => {
    const status = jest.fn(); const invoices = jest.fn();
    const controller = new StudentOperationsCurrentWorkspaceController({} as never, {} as never, { status } as never, { invoices } as never);
    for (const role of ['operations','advisor'] as const) {
      expect(await controller.paymentsRegister({ studentOperationsPrincipal: { ...principal, role } }, {}))
        .toMatchObject({ workspace: { role }, connection: null, invoices: null });
    }
    expect(status).not.toHaveBeenCalled(); expect(invoices).not.toHaveBeenCalled();
  });

  it('does not choose an arbitrary organisation when the Trust selection is ambiguous', async () => {
    const status = jest.fn().mockResolvedValue({ connections: ['one','two'].map(connectionId => ({ connectionId, status: 'active', organisationRole: null })) });
    const invoices = jest.fn();
    const controller = new StudentOperationsCurrentWorkspaceController({} as never, {} as never, { status } as never, { invoices } as never);
    expect(await controller.paymentsRegister({ studentOperationsPrincipal: { ...principal, role: 'chief_executive' } }, {}))
      .toMatchObject({ connectionIssue: 'ambiguous', invoices: null });
    expect(invoices).not.toHaveBeenCalled();
  });
});
