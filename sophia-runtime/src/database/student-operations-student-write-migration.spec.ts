import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@jest/globals";

describe("Student Operations student write migration", () => {
  const sql = readFileSync(resolve(
    dirname(fileURLToPath(import.meta.url)),
    "migrations/064_student_operations_student_writes.sql",
  ), "utf8");

  it("adds optimistic concurrency and idempotent write storage", () => {
    expect(sql).toContain("record_version integer NOT NULL DEFAULT 1");
    expect(sql).toContain("student_operations_write_requests");
    expect(sql).toContain("request_fingerprint");
    expect(sql).toContain("PRIMARY KEY (customer_id, actor_identity_user_id, idempotency_key)");
  });

  it("keeps audit events tenant isolated and append-only", () => {
    expect(sql).toContain("student_operations_student_audit_events");
    expect(sql).toContain("protect_student_operations_student_audit_event");
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).not.toMatch(/GRANT\s+DELETE[^;]*student_operations_student_audit_events/i);
  });
});
