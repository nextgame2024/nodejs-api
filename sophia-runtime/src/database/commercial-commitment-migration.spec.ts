import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const sql = readFileSync(fileURLToPath(new URL(
  "./migrations/052_commercial_commitment_and_charge_components.sql", import.meta.url)), "utf8");

describe("commercial commitment and charge-component migration", () => {
  it("adds bounded commitment terms and immutable one-time charge components", () => {
    expect(sql).toContain("minimum_commitment_months");
    expect(sql).toContain("commercial_plan_charge_components");
    expect(sql).toContain("initial_checkout");
    expect(sql).toContain("operator_milestone");
    expect(sql).toContain("Published commercial plan charge components are immutable");
    expect(sql).toContain("billing_usage_period_ledgers_included_active_seconds_check");
    expect(sql).toContain("CHECK (included_active_seconds >= 0)");
    expect(sql).not.toContain("CHECK (included_active_seconds = 120000)");
  });

  it("keeps runtime access read-only", () => {
    expect(sql).toMatch(/GRANT SELECT ON[\s\S]*commercial_plan_charge_components TO sophia_runtime_app/);
    expect(sql).not.toMatch(/GRANT (?:INSERT|UPDATE|DELETE)[^;]*commercial_plan_charge_components TO sophia_runtime_app/);
  });
});
