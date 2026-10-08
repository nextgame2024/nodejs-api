import { describe, expect, it } from "@jest/globals";
import { StudentOperationsWorkspaceController } from "./student-operations-workspace.controller.js";

describe("StudentOperationsWorkspaceController", () => {
  it("returns only fail-closed workspace metadata", () => {
    const result = new StudentOperationsWorkspaceController().workspace({
      studentOperationsPrincipal: {
        identityUserId: "user-1",
        tenantId: "11111111-1111-4111-8111-111111111111",
        externalCompanyId: "22222222-2222-4222-8222-222222222222",
        entitlementId: "33333333-3333-4333-8333-333333333333",
        role: "chief_executive",
        authorizationRevision: 4,
      },
    });
    expect(result).toEqual(expect.objectContaining({
      packId: "student-operations",
      tenantId: "11111111-1111-4111-8111-111111111111",
      authorizationRevision: 4,
      role: "chief_executive",
      readiness: {
        xero: "not-configured",
        documents: "not-configured",
        assistant: "not-configured",
        financialExecution: "disabled",
      },
    }));
  });

  it("publishes the fail-closed role and privacy contract", () => {
    const result = new StudentOperationsWorkspaceController().policy();
    expect(result.version).toBe("2026-10-05.1");
    expect(Object.keys(result.roles)).toEqual([
      "chief_executive", "operations", "advisor",
    ]);
    expect(result.dataFlows.every((flow) => flow.status !== "approved")).toBe(true);
    expect(result.retentionTargets.every((target) =>
      target.retentionDays === null && !target.automaticDeletionEnabled)).toBe(true);
  });
});
