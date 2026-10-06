import { describe, expect, it, jest } from "@jest/globals";
import { OpenForAustraliaCurrentWorkspaceController } from "./open-for-australia-current-workspace.controller.js";

const principal = {
  identityUserId: "user-1",
  tenantId: "11111111-1111-4111-8111-111111111111",
  externalCompanyId: "22222222-2222-4222-8222-222222222222",
  entitlementId: "33333333-3333-4333-8333-333333333333",
  role: "operations" as const,
  authorizationRevision: 2,
};

describe("OpenForAustraliaCurrentWorkspaceController", () => {
  it("returns the identity-derived workspace context", () => {
    const controller = new OpenForAustraliaCurrentWorkspaceController({ list: jest.fn() } as never);
    expect(controller.workspace({ openForAustraliaPrincipal: principal })).toEqual(expect.objectContaining({
      packId: "open-for-australia",
      tenantId: principal.tenantId,
      role: "operations",
      authorizationRevision: 2,
    }));
  });

  it("returns dashboard context and counts through one guarded endpoint", async () => {
    const summary = jest.fn().mockResolvedValue({
      totalStudents: 11,
      activeStudents: 8,
      actionRequired: 2,
      onHold: 1,
    });
    const controller = new OpenForAustraliaCurrentWorkspaceController({ summary } as never);
    await expect(controller.dashboard({ openForAustraliaPrincipal: principal })).resolves.toEqual({
      workspace: expect.objectContaining({ role: "operations", tenantId: principal.tenantId }),
      summary: { totalStudents: 11, activeStudents: 8, actionRequired: 2, onHold: 1 },
    });
    expect(summary).toHaveBeenCalledWith(principal);
  });

  it("passes the authenticated principal to the student list", async () => {
    const list = jest.fn().mockResolvedValue({ students: [], page: 1, limit: 20, total: 0 });
    const controller = new OpenForAustraliaCurrentWorkspaceController({ list } as never);
    await expect(controller.listStudents(
      { openForAustraliaPrincipal: principal }, { q: "synthetic" },
    )).resolves.toEqual({ students: [], page: 1, limit: 20, total: 0 });
    expect(list).toHaveBeenCalledWith(principal, { q: "synthetic" });
  });
});
