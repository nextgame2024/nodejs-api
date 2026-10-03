import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("./verify-live-commercial-readiness.ts", import.meta.url)), "utf8");

describe("compiled live commercial readiness verifier", () => {
  it("is read-only, live-only and keeps Checkout disabled", () => {
    expect(source).toContain('config.billing.provider !== "stripe_live"');
    expect(source).toContain("Live Checkout must remain disabled during readiness verification");
    expect(source).toContain("verifyLiveStripeResources");
    expect(source).not.toContain(".create(");
    expect(source).not.toContain(".update(");
    expect(source).not.toContain(".del(");
  });

  it("verifies the Founding allowance, one-time Prices and commitment portal", () => {
    expect(source).toContain('included: "60000"');
    expect(source).toContain('minimum_commitment_months !== (plan.id === FOUNDING_ID ? 12 : null)');
    expect(source).toContain('verifyOneTimePrice(initial.commencement, "95000"');
    expect(source).toContain('verifyOneTimePrice(milestone["production-deployment"], "95000"');
    expect(source).toContain("committedPortal.features.subscription_cancel.enabled");
  });

  it("does not expose secrets or infer charge evidence", () => {
    expect(source).toContain("verifiedLocally: true, exposed: false");
    expect(source).toContain("chargeCreated: false");
    expect(source).not.toContain("stripeWebhookSecret:");
  });
});
