import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("./audit-live-commercial-activation.ts", import.meta.url)), "utf8");

describe("live commercial activation audit", () => {
  it("is read-only and refuses to run with Checkout enabled", () => {
    expect(source).toContain("Live Checkout must remain disabled during the activation audit");
    expect(source).toContain("externalMutation: false");
    expect(source).toContain("stripeRequest: false");
    expect(source).not.toContain("stripe.customers.create");
    expect(source).not.toContain("checkout.sessions.create");
    expect(source).not.toContain("invoices.create");
  });

  it("reports every unresolved first-customer gate", () => {
    expect(source).toContain('id: "current_tax_attestation"');
    expect(source).toContain('id: "recent_mfa"');
    expect(source).toContain('id: "live_overage_collection"');
    expect(source).toContain('id: "live_founding_milestone"');
    expect(source).toContain('id: "stripe_key_scope"');
    expect(source).toContain('id: "genuine_customer"');
    expect(source).toContain('decision: blockers.length === 0 ? "ready_for_explicit_charge_authority" : "keep_checkout_disabled"');
  });

  it("uses canonical provider scope and durable recent-MFA proof evidence", () => {
    expect(source).toContain("STRIPE_BILLING_PROVIDER_KEY");
    expect(source).toContain("billing.authorization.proved");
    expect(source).toContain("permission_key='billing.manage'");
    expect(source).toContain("created_at>=now()-interval '12 hours'");
    expect(source).not.toContain("account.provider_key='stripe'");
  });

  it("does not expose legal identity or secret values", () => {
    expect(source).not.toContain("legal_name");
    expect(source).not.toContain("registration_identifier_value");
    expect(source).not.toContain("stripeSecretKey:");
  });
});
