import { describe, expect, it } from "@jest/globals";
import { buildStudentRegisterCohortSql } from "./student-operations-register.service.js";

describe("Student Operations register query", () => {
  it("materializes the tenant advisor roster once before joining student rows", () => {
    const sql = buildStudentRegisterCohortSql("sophia_runtime");
    expect(sql).toContain("advisor_roster AS MATERIALIZED");
    expect(sql).toContain("FROM sophia_runtime.student_operations_advisor_roster ar");
    expect(sql).toContain("WHERE ar.customer_id = $1");
    expect(sql).toContain("LEFT JOIN advisor_roster ar");
    expect(sql).not.toContain("LEFT JOIN sophia_runtime.student_operations_advisor_roster ar");
  });

  it("projects the latest case workflow status without treating active pre-sale and payment cases as closed", () => {
    const sql = buildStudentRegisterCohortSql("sophia_runtime");
    expect(sql).toContain("WHEN d.lifecycle_status = 'completed' THEN 'closed'");
    expect(sql).toContain("bool_or(v.lifecycle_status NOT IN ('closed', 'completed', 'cancelled'))");
    expect(sql).toContain("v.current_stage = 'documents_requested'");
    expect(sql).toContain("d.lifecycle_status = 'collections' THEN 'In collections'");
  });
});
