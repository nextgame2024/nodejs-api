import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("billing provider account scope migration", () => {
  const sql = readFileSync(fileURLToPath(new URL("./migrations/039_billing_provider_account_scope.sql", import.meta.url)), "utf8");

  it("scopes every opaque provider identity by account", () => {
    for (const table of ["billing_provider_customers", "billing_webhook_events", "billing_checkout_intents",
      "billing_subscription_references", "billing_invoice_references"]) {
      expect(sql).toMatch(new RegExp(`ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__\\.${table}\\n  ADD COLUMN IF NOT EXISTS provider_account_key`));
    }
    expect(sql).toContain("UNIQUE (provider_key, provider_environment, provider_account_key, external_customer_ref)");
    expect(sql).toContain("UNIQUE (provider_key, provider_environment, provider_account_key, external_subscription_ref)");
    expect(sql).toContain("UNIQUE (provider_key, provider_environment, provider_account_key, external_invoice_ref)");
    expect(sql).toContain("UNIQUE (provider_key, provider_environment, provider_account_key, external_event_ref)");
  });

  it("keeps provider account and reference identities immutable", () => {
    expect(sql).toContain("seller_billing_provider_accounts");
    expect(sql).toContain("seller_legal_entity_id");
    expect(sql).toContain("NEW.provider_account_key <> OLD.provider_account_key");
    expect(sql).toContain("Seller billing provider account identity is immutable");
    expect(sql).toContain("Billing reference tenant/provider/account identity is immutable");
    expect(sql).not.toMatch(/GRANT (INSERT|UPDATE|DELETE).*seller_billing_provider_accounts/);
  });

  it("keeps an expand-phase default for the already deployed writer", () => {
    expect(sql.match(/DEFAULT 'legacy-primary'/g)).toHaveLength(5);
    expect(sql).toContain("resolve_billing_customer_tenant(text, text, text, text)");
  });
});
