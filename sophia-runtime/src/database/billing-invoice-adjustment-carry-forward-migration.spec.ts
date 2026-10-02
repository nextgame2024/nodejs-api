import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL(
  "./migrations/051_billing_invoice_adjustment_carry_forward.sql", import.meta.url,
), "utf8");

describe("billing invoice-adjustment carry-forward migration", () => {
  it("keeps source evidence immutable and permits only one reconciled recovery", () => {
    expect(sql).toContain("source_billing_invoice_adjustment_outbox_id uuid NOT NULL");
    expect(sql).toContain("Billing invoice-adjustment recovery identity and payload are immutable");
    expect(sql).toContain("WHERE status='reconciled'");
    expect(sql).toContain("WHERE status<>'missed_window'");
    expect(sql).toContain("source_billing_invoice_adjustment_outbox_id,target_external_invoice_ref");
  });

  it("requires immutable evidence before failed reconciliation can recover", () => {
    expect(sql).toContain("OLD.status IN ('outcome_unknown','provider_accepted','reconciliation_failed') AND NEW.status='reconciled'");
    expect(sql).toContain("billing_invoice_adjustment_recovery_reconciliations evidence");
    expect(sql).toContain("evidence.billing_invoice_adjustment_recovery_attempt_id=OLD.billing_invoice_adjustment_recovery_attempt_id");
  });

  it("enforces tenant isolation and non-owner grants on both recovery tables", () => {
    expect(sql.match(/FORCE ROW LEVEL SECURITY/g)).toHaveLength(2);
    expect(sql).toContain("GRANT SELECT,INSERT,UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_adjustment_recovery_attempts");
    expect(sql).toContain("GRANT SELECT,INSERT ON __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_adjustment_recovery_reconciliations");
  });
});
