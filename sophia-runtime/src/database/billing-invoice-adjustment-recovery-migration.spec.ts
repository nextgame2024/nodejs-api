import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL(
  "./migrations/050_billing_invoice_adjustment_reconciliation_recovery.sql", import.meta.url,
), "utf8");

describe("billing invoice-adjustment reconciliation recovery migration", () => {
  it("allows only evidence-backed failed-to-reconciled recovery", () => {
    expect(sql).toContain("OLD.status='reconciliation_failed' AND NEW.status='reconciled'");
    expect(sql).toContain("billing_invoice_adjustment_reconciliations evidence");
    expect(sql).toContain("evidence.customer_id=OLD.customer_id");
    expect(sql).toContain("evidence.billing_invoice_adjustment_outbox_id=OLD.billing_invoice_adjustment_outbox_id");
  });

  it("retains immutable payload, monotonic evidence and original dispatch transitions", () => {
    expect(sql).toContain("identity and payload are immutable");
    expect(sql).toContain("evidence must advance monotonically");
    expect(sql).toContain("OLD.status='pending' AND NEW.status='leased'");
    expect(sql).toContain("OLD.status IN ('outcome_unknown','provider_accepted')");
    expect(sql).toContain("invalid transition");
  });
});
