import { describe, expect, it } from "@jest/globals";
import { BusinessPackRegistry } from "../business-pack.registry.js";
import {
  OPEN_FOR_AUSTRALIA_PACK_CONTRACT,
  OpenForAustraliaPackContractSchema,
} from "./open-for-australia.pack.js";

describe("Open For Australia business-pack boundary", () => {
  it("declares only the approved workspace and starts fail-closed", () => {
    expect(
      OpenForAustraliaPackContractSchema.parse(
        OPEN_FOR_AUSTRALIA_PACK_CONTRACT,
      ),
    ).toEqual({
      packId: "open-for-australia",
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
    expect(registry.has("open-for-australia")).toBe(false);
    expect(registry.manifests()).toEqual([]);
  });

  it("rejects accidental capability expansion", () => {
    expect(() => OpenForAustraliaPackContractSchema.parse({
      ...OPEN_FOR_AUSTRALIA_PACK_CONTRACT,
      financialExecution: "enabled",
    })).toThrow();
    expect(() => OpenForAustraliaPackContractSchema.parse({
      ...OPEN_FOR_AUSTRALIA_PACK_CONTRACT,
      workspaceRoutes: [
        ...OPEN_FOR_AUSTRALIA_PACK_CONTRACT.workspaceRoutes,
        "marketing-campaigns",
      ],
    })).toThrow();
  });
});
