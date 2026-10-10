import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const sql = readFileSync(fileURLToPath(new URL(
  "./migrations/067_xero_student_read_model.sql",
  import.meta.url,
)), "utf8");

describe("067 Xero student read model migration", () => {
  it("creates tenant-isolated durable sync and normalized read models", () => {
    expect(sql).toContain("student_operations_xero_sync_configurations");
    expect(sql).toContain("student_operations_xero_sync_runs");
    expect(sql).toContain("student_operations_xero_contacts");
    expect(sql).toContain("student_operations_xero_invoices");
    expect(sql).toContain("student_operations_xero_candidate_reviews");
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("sophia.tenant_id");
    expect(sql).toContain("REVOKE DELETE");
    expect(sql).toContain("student_operations_xero_one_active_sync");
    expect(sql).toContain("claim_due_student_operations_xero_sync_runs");
    expect(sql).toContain("resolve_student_operations_xero_sync_target");
    expect(sql).toContain("SECURITY DEFINER");
    expect(sql).toContain("provider_correlation_id");
    expect(sql).toContain("lease_expires_at < now()");
  });
});
