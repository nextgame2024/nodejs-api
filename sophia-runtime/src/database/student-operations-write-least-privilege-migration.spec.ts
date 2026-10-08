import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@jest/globals";

describe("Student Operations write least-privilege migration", () => {
  const sql = readFileSync(resolve(
    dirname(fileURLToPath(import.meta.url)),
    "migrations/065_student_operations_write_least_privilege.sql",
  ), "utf8");

  it("removes destructive runtime privileges and keeps only required writes", () => {
    expect(sql).toContain("REVOKE DELETE ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_students");
    expect(sql).toContain("REVOKE UPDATE, DELETE ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_student_audit_events");
    expect(sql).toContain("REVOKE DELETE ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_write_requests");
    expect(sql).toContain("GRANT SELECT, INSERT ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_student_audit_events");
  });
});
