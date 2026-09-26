import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("billing observation hardening migration", () => {
  const sql = readFileSync(fileURLToPath(new URL("./migrations/032_billing_observation_hardening.sql", import.meta.url)), "utf8");

  it("makes provider, event, subscription and invoice identities immutable", () => {
    expect(sql).toContain("protect_billing_provider_customer_identity");
    expect(sql).toContain("protect_billing_webhook_evidence");
    expect(sql).toContain("protect_billing_reference_identity");
    expect(sql).toContain("external_subscription_ref <> OLD.external_subscription_ref");
    expect(sql).toContain("external_invoice_ref <> OLD.external_invoice_ref");
    expect(sql).toContain("ELSIF TG_TABLE_NAME = 'billing_invoice_references' THEN");
    expect(sql).not.toContain("TG_TABLE_NAME = 'billing_subscription_references'\n    AND NEW.external_subscription_ref");
  });

  it("permits only monotonic observation revisions and one final webhook transition", () => {
    expect(sql).toContain("NEW.revision <> OLD.revision + 1");
    expect(sql).toContain("NEW.observed_at < OLD.observed_at");
    expect(sql).toContain("OLD.processing_status <> 'received'");
    expect(sql).toContain("NEW.processing_status NOT IN ('processed', 'ignored', 'failed')");
  });
});
