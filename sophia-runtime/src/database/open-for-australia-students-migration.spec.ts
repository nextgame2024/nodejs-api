import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@jest/globals";

describe("Open For Australia students migration", () => {
  it("creates a tenant-isolated read-only student table without fixtures", () => {
    const sql = readFileSync(resolve(
      dirname(fileURLToPath(import.meta.url)),
      "migrations/062_open_for_australia_students.sql",
    ), "utf8");
    expect(sql).toContain("open_for_australia_students");
    expect(sql).toContain("UNIQUE (customer_id, student_reference)");
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("GRANT SELECT ON __SOPHIA_RUNTIME_SCHEMA__.open_for_australia_students");
    expect(sql).not.toMatch(/GRANT\s+(?:INSERT|UPDATE|DELETE)/i);
    expect(sql).not.toMatch(/INSERT\s+INTO\s+__SOPHIA_RUNTIME_SCHEMA__\.open_for_australia_students/i);
  });
});
