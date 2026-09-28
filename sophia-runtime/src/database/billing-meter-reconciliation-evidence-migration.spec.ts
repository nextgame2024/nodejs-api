import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("billing Meter reconciliation evidence migration", () => {
  const sql = readFileSync(fileURLToPath(new URL(
    "./migrations/047_billing_meter_reconciliation_evidence.sql", import.meta.url,
  )), "utf8");

  it("binds one immutable dual-source reconciliation record to one tenant ledger and outbox item", () => {
    expect(sql).toContain("UNIQUE (billing_meter_event_outbox_id)");
    expect(sql).toContain("meter_summary_quantity = invoice_line_quantity");
    expect(sql).toContain("Billing Meter reconciliation evidence is immutable");
    expect(sql).toContain("evidence_digest");
  });

  it("forces tenant isolation and grants no mutation of recorded evidence", () => {
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("GRANT SELECT, INSERT");
    expect(sql).not.toContain("GRANT SELECT, INSERT, UPDATE");
  });
});
