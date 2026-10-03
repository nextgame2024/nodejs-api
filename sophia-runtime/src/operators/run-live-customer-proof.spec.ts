import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("./run-live-customer-proof.ts", import.meta.url)), "utf8");

describe("live no-charge Customer proof operator", () => {
  it("requires explicit confirmation and disabled Checkout", () => {
    expect(source).toContain("I_UNDERSTAND_THIS_CREATES_ONE_NO_CHARGE_STRIPE_LIVE_VERIFICATION_CUSTOMER");
    expect(source).toContain("Live Checkout must remain disabled throughout this proof");
    expect(source).toContain('config.billing.provider !== "stripe_live"');
  });

  it("creates only one metadata-bound Customer and one harmless update", () => {
    expect(source).toContain("stripe.customers.create");
    expect(source).toContain("stripe.customers.update");
    expect(source).toContain('expectedWebhookEvent: "customer.updated"');
    expect(source).not.toContain("paymentMethods.create");
    expect(source).not.toContain("subscriptions.create");
    expect(source).not.toContain("invoices.create");
    expect(source).not.toContain("checkout.sessions.create");
    expect(source).not.toContain("charges.create");
  });

  it("requires signed delivery and zero subscriptions and invoices", () => {
    expect(source).toContain("No persisted signed live customer.updated delivery");
    expect(source).toContain("subscriptionCount: 0, invoiceCount: 0");
    expect(source).toContain("entitlementMutation: false");
  });
});
