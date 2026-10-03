import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("./provision-live-commercial-resources.ts", import.meta.url)), "utf8");

describe("live commercial resource provisioner", () => {
  it("is live-only, explicitly confirmed and keeps Checkout disabled", () => {
    expect(source).toContain("I_UNDERSTAND_THIS_CREATES_STRIPE_LIVE_CATALOG_OBJECTS_NO_CHARGES");
    expect(source).toContain('config.billing.provider !== "stripe_live"');
    expect(source).toContain("Live Checkout must remain disabled during provisioning");
  });

  it("validates every immutable plan and provisions only catalog resources", () => {
    expect(source).toContain("validateCatalog");
    expect(source).toContain("findOrCreateMeter");
    expect(source).toContain("findOrCreateProduct");
    expect(source).toContain("findOrCreatePrice");
    expect(source).toContain("findOrCreatePortal");
    expect(source).toContain("customerCreated: false");
    expect(source).toContain("chargeCreated: false");
    expect(source).not.toContain("stripe.customers.create");
    expect(source).not.toContain("stripe.subscriptions.create");
    expect(source).not.toContain("stripe.checkout.sessions.create");
  });

  it("does not create a webhook or print a signing secret", () => {
    expect(source).toContain("Create in Stripe Dashboard and store its signing secret directly in Render.");
    expect(source).not.toContain("webhookEndpoints.create");
    expect(source).not.toContain("whsec_");
  });
});
