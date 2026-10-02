import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("./migrations/049_billing_invoice_adjustment_outbox.sql", import.meta.url), "utf8");

describe("billing invoice-adjustment outbox migration", () => {
  it("binds one immutable adjustment to one usage ledger and renewal invoice", () => {
    expect(sql).toContain("UNIQUE (billing_usage_period_ledger_id)");
    expect(sql).toContain("external_invoice_ref");
    expect(sql).toContain("one_time_price_ref");
    expect(sql).toContain("provider_environment IN ('sandbox','live')");
    expect(sql).toContain("status IN ('pending','leased','outcome_unknown','provider_accepted','reconciled','reconciliation_failed','terminal_failed','missed_window')");
    expect(sql).toContain("billing_invoice_adjustment_reconciliations");
    expect(sql).toContain("amount_minor = quantity * unit_price_minor");
  });

  it("keeps tenant isolation, least privilege and immutable payload enforcement", () => {
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("sophia.tenant_id");
    expect(sql).toContain("GRANT SELECT,INSERT,UPDATE");
    expect(sql).toContain("identity and payload are immutable");
    expect(sql).toContain("reconciliation evidence is immutable");
    expect(sql).toContain("OLD.status='pending' AND NEW.status='leased'");
  });
});
