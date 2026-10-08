import { describe, expect, it } from "@jest/globals";
import { BusinessPackRegistry } from "../business-pack.registry.js";
import {
  STUDENT_OPERATIONS_PACK_CONTRACT,
  StudentOperationsPackContractSchema,
} from "./student-operations.pack.js";

describe("Student Operations business-pack boundary", () => {
  it("declares only the approved workspace and starts fail-closed", () => {
    expect(
      StudentOperationsPackContractSchema.parse(
        STUDENT_OPERATIONS_PACK_CONTRACT,
      ),
    ).toEqual({
      packId: "student-operations",
      version: "0.1.0",
      enabledByDefault: false,
      workspaceRoutes: [
        "dashboard",
        "students",
        "student-case",
        "payments-controls",
        "sophia-assistant",
      ],
      externalIntegrations: {
        xeroTrust: "not-configured",
        xeroPty: "not-configured",
      },
      documentStorage: "not-configured",
      assistantTools: "not-configured",
      financialExecution: "disabled",
    });
  });

  it("is not registered in the active runtime before authorization exists", () => {
    const registry = new BusinessPackRegistry();
    expect(registry.has("student-operations")).toBe(false);
    expect(registry.manifests()).toEqual([]);
  });

  it("rejects accidental capability expansion", () => {
    expect(() => StudentOperationsPackContractSchema.parse({
      ...STUDENT_OPERATIONS_PACK_CONTRACT,
      financialExecution: "enabled",
    })).toThrow();
    expect(() => StudentOperationsPackContractSchema.parse({
      ...STUDENT_OPERATIONS_PACK_CONTRACT,
      workspaceRoutes: [
        ...STUDENT_OPERATIONS_PACK_CONTRACT.workspaceRoutes,
        "marketing-campaigns",
      ],
    })).toThrow();
  });
});
