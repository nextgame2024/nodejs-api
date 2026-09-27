import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("billing period assignment snapshot migration", () => {
  const sql = readFileSync(fileURLToPath(new URL(
    "./migrations/043_billing_period_assignment_snapshot.sql", import.meta.url,
  )), "utf8");

  it("pins mutable assignment evidence into the immutable ledger", () => {
    expect(sql).toContain("assignment_revision integer NOT NULL");
    expect(sql).toContain("assignment_effective_from timestamptz NOT NULL");
    expect(sql).toContain("assignment_effective_to timestamptz");
    expect(sql).toContain("assignment_effective_from <= period_start");
    expect(sql).toContain("assignment_effective_to >= period_end");
  });
});
