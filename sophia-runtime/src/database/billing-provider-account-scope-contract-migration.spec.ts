import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("billing provider account scope contract migration", () => {
  const sql = readFileSync(fileURLToPath(new URL(
    "./migrations/040_billing_provider_account_scope_contract.sql", import.meta.url)), "utf8");

  it("removes every expand-phase provider account default", () => {
    for (const table of ["billing_provider_customers", "billing_webhook_events", "billing_checkout_intents",
      "billing_subscription_references", "billing_invoice_references"]) {
      expect(sql).toContain(`ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.${table}\n  ALTER COLUMN provider_account_key DROP DEFAULT;`);
    }
  });

  it("removes only the legacy unscoped resolver", () => {
    expect(sql).toContain("DROP FUNCTION IF EXISTS __SOPHIA_RUNTIME_SCHEMA__.resolve_billing_customer_tenant(text, text, text);");
    expect(sql).toContain("resolve_billing_customer_tenant(text, text, text, text)");
    expect(sql).not.toContain("DROP FUNCTION IF EXISTS __SOPHIA_RUNTIME_SCHEMA__.resolve_billing_customer_tenant(text, text, text, text)");
  });
});
