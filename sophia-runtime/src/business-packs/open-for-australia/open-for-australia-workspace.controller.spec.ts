import { describe, expect, it } from "@jest/globals";
import { OpenForAustraliaWorkspaceController } from "./open-for-australia-workspace.controller.js";

describe("OpenForAustraliaWorkspaceController", () => {
  it("returns only fail-closed workspace metadata", () => {
    const result = new OpenForAustraliaWorkspaceController().workspace({
      openForAustraliaPrincipal: {
        identityUserId: "user-1",
        tenantId: "11111111-1111-4111-8111-111111111111",
        externalCompanyId: "22222222-2222-4222-8222-222222222222",
        entitlementId: "33333333-3333-4333-8333-333333333333",
        authorizationRevision: 4,
      },
    });
    expect(result).toEqual(expect.objectContaining({
      packId: "open-for-australia",
      tenantId: "11111111-1111-4111-8111-111111111111",
      authorizationRevision: 4,
      readiness: {
        xero: "not-configured",
        documents: "not-configured",
        assistant: "not-configured",
        financialExecution: "disabled",
      },
    }));
  });
});
