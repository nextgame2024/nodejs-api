import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("billing period ledgers migration", () => {
  const sql = readFileSync(fileURLToPath(new URL(
    "./migrations/042_billing_period_ledgers.sql", import.meta.url,
  )), "utf8");

  it("preserves provider periods instead of assuming calendar months", () => {
    expect(sql).toContain("billing_subscription_periods");
    expect(sql).toContain("capture_billing_subscription_period");
    expect(sql).toContain("period_end > period_start");
    expect(sql).toContain("external_subscription_ref, period_start, period_end");
  });

  it("enforces one immutable aggregate ceiling per period", () => {
    expect(sql).toContain("UNIQUE (billing_subscription_period_id)");
    expect(sql).toContain("included_active_seconds = 120000");
    expect(sql).toContain("active_microseconds - included_active_seconds * 1000000");
    expect(sql).toContain("overage_microseconds + 60000000 - 1");
    expect(sql).toContain("Finalised billing-period evidence is immutable");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).not.toMatch(/GRANT[^;]*(UPDATE|DELETE|TRUNCATE)[^;]*billing_usage_period_ledgers/);
  });
});
