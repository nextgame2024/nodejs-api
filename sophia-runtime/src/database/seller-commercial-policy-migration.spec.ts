import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("seller legal entity and commercial policy migration", () => {
  const sql = readFileSync(fileURLToPath(new URL("./migrations/038_seller_legal_and_commercial_policy.sql", import.meta.url)), "utf8");

  it("versions legal identity and B2B/B2C policy independently from plans and usage", () => {
    expect(sql).toContain("seller_legal_entities");
    expect(sql).toContain("seller_legal_entity_versions");
    expect(sql).toContain("seller_commercial_policy_versions");
    expect(sql).toContain("customer_scope IN ('business_only', 'consumer_only', 'mixed')");
    expect(sql).toContain("legal_form IN ('sole_trader', 'company', 'partnership', 'trust', 'other')");
    expect(sql).toContain("commercial_plan_versions");
    expect(sql).toContain("tax_category");
    expect(sql).not.toMatch(/ALTER TABLE .*provider_usage_events[\s\S]*seller_legal_entity/i);
  });

  it("makes a non-GST policy incapable of collecting or displaying tax", () => {
    expect(sql).toContain("gst_registered = false AND tax_calculation_mode = 'none'");
    expect(sql).toContain("tax_rate_basis_points IS NULL AND price_display_mode = 'no_tax' AND tax_label IS NULL");
    expect(sql).toContain("provider_automatic");
  });

  it("pins issued billing evidence to immutable seller and policy versions", () => {
    expect(sql).toMatch(/billing_subscription_references[\s\S]*seller_legal_entity_id/);
    expect(sql).toMatch(/billing_invoice_references[\s\S]*seller_legal_entity_version_id/);
    expect(sql).toMatch(/billing_invoice_references[\s\S]*seller_commercial_policy_version_id/);
    expect(sql).toContain("Published seller versions are immutable");
    expect(sql).not.toMatch(/GRANT (INSERT|UPDATE|DELETE).*seller_/);
  });
});
