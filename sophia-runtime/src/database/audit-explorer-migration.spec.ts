import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

describe("audit explorer migration", () => {
  it("forces tenant isolation and append-only audit evidence with bounded exports", async () => {
    const sql = await readFile(resolve(dirname(fileURLToPath(import.meta.url)), "migrations/022_audit_explorer_and_exports.sql"), "utf8");
    expect(sql).toContain("admin_audit_events FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("protect_admin_audit_event BEFORE UPDATE OR DELETE");
    expect(sql).toContain("admin_audit_export_jobs");
    expect(sql).toContain("max_rows BETWEEN 1 AND 5000");
    expect(sql).toContain("protect_admin_audit_export_job_delete BEFORE DELETE");
    expect(sql).toContain("REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.admin_audit_events FROM sophia_runtime_app");
    expect(sql).toContain("GRANT SELECT, INSERT ON __SOPHIA_RUNTIME_SCHEMA__.admin_audit_events TO sophia_runtime_app");
  });
});
