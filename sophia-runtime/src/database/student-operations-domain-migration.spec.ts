import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@jest/globals";

describe("Student Operations domain migration", () => {
  it("moves the tenant-neutral pack and student table identifiers forward", () => {
    const sql = readFileSync(resolve(
      dirname(fileURLToPath(import.meta.url)),
      "migrations/063_student_operations_domain.sql",
    ), "utf8");

    expect(sql).toContain("SET pack_id = 'student-operations'");
    expect(sql).toContain("RENAME TO student_operations_students");
    expect(sql).toContain("business_pack_entitlements_student_operations_role_check");
    expect(sql).toContain("student_operations_students_tenant_isolation");
    expect(sql).not.toContain("DELETE FROM");
  });
});
