import { describe, expect, it } from "@jest/globals";
import {
  OPEN_FOR_AUSTRALIA_DATA_FLOWS,
  OPEN_FOR_AUSTRALIA_FIELD_POLICIES,
  OPEN_FOR_AUSTRALIA_PERMISSIONS,
  OPEN_FOR_AUSTRALIA_PRIVACY_TARGETS,
  OPEN_FOR_AUSTRALIA_RETENTION_TARGETS,
  OPEN_FOR_AUSTRALIA_ROLE_PERMISSIONS,
  OPEN_FOR_AUSTRALIA_STEP_UP_PERMISSIONS,
  hasOpenForAustraliaPermission,
  projectOpenForAustraliaFields,
} from "./open-for-australia-policy.js";

describe("Open For Australia roles and privacy contract", () => {
  it("defines three fixed least-privilege roles from the named registry", () => {
    expect(Object.keys(OPEN_FOR_AUSTRALIA_ROLE_PERMISSIONS)).toEqual([
      "chief_executive", "operations", "advisor",
    ]);
    for (const permissions of Object.values(OPEN_FOR_AUSTRALIA_ROLE_PERMISSIONS)) {
      expect(permissions.every((item) => OPEN_FOR_AUSTRALIA_PERMISSIONS.includes(item))).toBe(true);
    }
    expect(hasOpenForAustraliaPermission("chief_executive", "payments.approve")).toBe(true);
    expect(hasOpenForAustraliaPermission("operations", "payments.approve")).toBe(false);
    expect(hasOpenForAustraliaPermission("advisor", "reports.export")).toBe(false);
    expect(OPEN_FOR_AUSTRALIA_STEP_UP_PERMISSIONS).toEqual([
      "payments.approve", "reports.export", "privacy.manage",
    ]);
  });

  it("masks restricted fields on list views and for unassigned advisors", () => {
    const record = {
      studentReference: "OFA-001",
      legalName: "Example Student",
      passportNumber: "P1234567",
      healthOrCharacterInformation: "restricted case note",
      paymentAmount: 4500,
    };
    expect(projectOpenForAustraliaFields(record, "chief_executive", {
      surface: "list", assigned: true,
    })).toEqual({
      values: { studentReference: "OFA-001", legalName: "Example Student" },
      maskedFields: ["passportNumber", "healthOrCharacterInformation", "paymentAmount"],
    });
    expect(projectOpenForAustraliaFields(record, "advisor", {
      surface: "case", assigned: false,
    })).toEqual({ values: {}, maskedFields: [
      "studentReference", "legalName", "passportNumber",
      "healthOrCharacterInformation", "paymentAmount",
    ] });
  });

  it("allows assigned-case identity access but not financial amounts for advisors", () => {
    const result = projectOpenForAustraliaFields({
      legalName: "Example Student",
      passportNumber: "P1234567",
      paymentAmount: 4500,
    }, "advisor", { surface: "case", assigned: true });
    expect(result.values).toEqual({
      legalName: "Example Student",
      passportNumber: "P1234567",
    });
    expect(result.maskedFields).toEqual(["paymentAmount"]);
  });

  it("does not project fields absent from the approved registry", () => {
    const result = projectOpenForAustraliaFields({
      legalName: "Example Student",
      unregisteredSecret: "must-not-leave-service",
    } as never, "chief_executive", { surface: "case", assigned: true });
    expect(result).toEqual({ values: { legalName: "Example Student" }, maskedFields: [] });
  });

  it("registers every classified field and privacy target without inventing retention", () => {
    expect(Object.keys(OPEN_FOR_AUSTRALIA_FIELD_POLICIES)).toHaveLength(17);
    expect(new Set(OPEN_FOR_AUSTRALIA_RETENTION_TARGETS.map((item) => item.datasetKey)))
      .toEqual(new Set(OPEN_FOR_AUSTRALIA_PRIVACY_TARGETS));
    for (const target of OPEN_FOR_AUSTRALIA_RETENTION_TARGETS) {
      expect(target).toMatchObject({
        retentionDays: null,
        legalReviewRequired: true,
        legalHoldAware: true,
        automaticDeletionEnabled: false,
      });
    }
  });

  it("keeps every external or infrastructure data flow unapproved", () => {
    expect(OPEN_FOR_AUSTRALIA_DATA_FLOWS).toHaveLength(4);
    for (const flow of OPEN_FOR_AUSTRALIA_DATA_FLOWS) {
      expect(flow.status).not.toBe("approved");
      expect(flow.processingJurisdictions).toEqual([]);
      expect(flow.storageJurisdictions).toEqual([]);
      expect(flow.retentionControl).toBe("unverified");
      expect(flow.deletionControl).toBe("unverified");
    }
  });
});
