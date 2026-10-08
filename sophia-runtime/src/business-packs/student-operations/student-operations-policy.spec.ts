import { describe, expect, it } from "@jest/globals";
import {
  STUDENT_OPERATIONS_DATA_FLOWS,
  STUDENT_OPERATIONS_FIELD_POLICIES,
  STUDENT_OPERATIONS_PERMISSIONS,
  STUDENT_OPERATIONS_PRIVACY_TARGETS,
  STUDENT_OPERATIONS_RETENTION_TARGETS,
  STUDENT_OPERATIONS_ROLE_PERMISSIONS,
  STUDENT_OPERATIONS_STEP_UP_PERMISSIONS,
  hasStudentOperationsPermission,
  projectStudentOperationsFields,
} from "./student-operations-policy.js";

describe("Student Operations roles and privacy contract", () => {
  it("defines three fixed least-privilege roles from the named registry", () => {
    expect(Object.keys(STUDENT_OPERATIONS_ROLE_PERMISSIONS)).toEqual([
      "chief_executive", "operations", "advisor",
    ]);
    for (const permissions of Object.values(STUDENT_OPERATIONS_ROLE_PERMISSIONS)) {
      expect(permissions.every((item) => STUDENT_OPERATIONS_PERMISSIONS.includes(item))).toBe(true);
    }
    expect(hasStudentOperationsPermission("chief_executive", "payments.approve")).toBe(true);
    expect(hasStudentOperationsPermission("operations", "payments.approve")).toBe(false);
    expect(hasStudentOperationsPermission("advisor", "reports.export")).toBe(false);
    expect(STUDENT_OPERATIONS_STEP_UP_PERMISSIONS).toEqual([
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
    expect(projectStudentOperationsFields(record, "chief_executive", {
      surface: "list", assigned: true,
    })).toEqual({
      values: { studentReference: "OFA-001", legalName: "Example Student" },
      maskedFields: ["passportNumber", "healthOrCharacterInformation", "paymentAmount"],
    });
    expect(projectStudentOperationsFields(record, "advisor", {
      surface: "case", assigned: false,
    })).toEqual({ values: {}, maskedFields: [
      "studentReference", "legalName", "passportNumber",
      "healthOrCharacterInformation", "paymentAmount",
    ] });
  });

  it("allows assigned-case identity access but not financial amounts for advisors", () => {
    const result = projectStudentOperationsFields({
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
    const result = projectStudentOperationsFields({
      legalName: "Example Student",
      unregisteredSecret: "must-not-leave-service",
    } as never, "chief_executive", { surface: "case", assigned: true });
    expect(result).toEqual({ values: { legalName: "Example Student" }, maskedFields: [] });
  });

  it("registers every classified field and privacy target without inventing retention", () => {
    expect(Object.keys(STUDENT_OPERATIONS_FIELD_POLICIES)).toHaveLength(17);
    expect(new Set(STUDENT_OPERATIONS_RETENTION_TARGETS.map((item) => item.datasetKey)))
      .toEqual(new Set(STUDENT_OPERATIONS_PRIVACY_TARGETS));
    for (const target of STUDENT_OPERATIONS_RETENTION_TARGETS) {
      expect(target).toMatchObject({
        retentionDays: null,
        legalReviewRequired: true,
        legalHoldAware: true,
        automaticDeletionEnabled: false,
      });
    }
  });

  it("keeps every external or infrastructure data flow unapproved", () => {
    expect(STUDENT_OPERATIONS_DATA_FLOWS).toHaveLength(4);
    for (const flow of STUDENT_OPERATIONS_DATA_FLOWS) {
      expect(flow.status).not.toBe("approved");
      expect(flow.processingJurisdictions).toEqual([]);
      expect(flow.storageJurisdictions).toEqual([]);
      expect(flow.retentionControl).toBe("unverified");
      expect(flow.deletionControl).toBe("unverified");
    }
  });
});
