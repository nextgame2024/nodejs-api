import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("billing reference trigger routing repair migration", () => {
  const sql = readFileSync(fileURLToPath(new URL("./migrations/035_billing_reference_trigger_routing.sql", import.meta.url)), "utf8");

  it("routes table-specific record fields through nested branches", () => {
    expect(sql).toContain("IF TG_TABLE_NAME = 'billing_subscription_references' THEN");
    expect(sql).toContain("ELSIF TG_TABLE_NAME = 'billing_invoice_references' THEN");
    expect(sql).toContain("NEW.external_subscription_ref <> OLD.external_subscription_ref");
    expect(sql).toContain("NEW.external_invoice_ref <> OLD.external_invoice_ref");
    expect(sql).not.toMatch(/TG_TABLE_NAME = 'billing_(?:subscription|invoice)_references'\s+AND NEW\.external_/);
  });

  it("preserves immutable tenant/provider identity and monotonic observations", () => {
    expect(sql).toContain("NEW.customer_id <> OLD.customer_id");
    expect(sql).toContain("NEW.provider_key <> OLD.provider_key");
    expect(sql).toContain("NEW.revision <> OLD.revision + 1");
    expect(sql).toContain("NEW.observed_at < OLD.observed_at");
  });
});
