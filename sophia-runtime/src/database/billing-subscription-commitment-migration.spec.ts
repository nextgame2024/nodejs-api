import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const sql = readFileSync(fileURLToPath(new URL(
  "./migrations/054_billing_subscription_commitments.sql", import.meta.url)), "utf8");

describe("billing subscription commitment migration", () => {
  it("pins the provider subscription to one plan and stores an exact provider-period boundary", () => {
    expect(sql).toContain("commercial_plan_version_id");
    expect(sql).toContain("Billing subscription commercial plan identity is immutable once observed");
    expect(sql).toContain("billing_subscription_commitments");
    expect(sql).toContain("commencement_period_start");
    expect(sql).toContain("commitment_end");
    expect(sql).toContain("periods_observed<=required_periods");
    expect(sql).toContain("Billing subscription commitment boundary is immutable once established");
  });

  it("keeps commitment writes tenant-isolated and excludes delete authority", () => {
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("billing_subscription_commitments_tenant_isolation");
    expect(sql).toMatch(/GRANT SELECT,INSERT,UPDATE ON[^;]*billing_subscription_commitments TO sophia_runtime_app/);
    expect(sql).not.toMatch(/GRANT DELETE ON[^;]*billing_subscription_commitments TO sophia_runtime_app/);
  });
});
