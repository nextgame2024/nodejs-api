import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("billing meter-event outbox migration", () => {
  const sql = readFileSync(fileURLToPath(new URL(
    "./migrations/044_billing_meter_event_outbox.sql", import.meta.url,
  )), "utf8");

  it("pins one positive whole-minute payload to one immutable ledger", () => {
    expect(sql).toContain("UNIQUE (billing_usage_period_ledger_id)");
    expect(sql).toContain("quantity > 0");
    expect(sql).toContain("quantity_unit = 'whole-minute'");
    expect(sql).toContain("submission_identifier");
    expect(sql).toContain("identity and payload are immutable");
  });

  it("forces tenant isolation and fences ambiguous submissions from retry", () => {
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("outcome_unknown");
    expect(sql).not.toContain("OLD.status = 'outcome_unknown' AND NEW.status = 'pending'");
    expect(sql).toContain("lease_token");
  });
});
