import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("./provision-founding-sandbox.ts", import.meta.url)), "utf8");

describe("Founding Stripe sandbox provisioner", () => {
  it("is sandbox-only and requires explicit object-creation confirmation", () => {
    expect(source).toContain("I_UNDERSTAND_THIS_CREATES_STRIPE_SANDBOX_OBJECTS");
    expect(source).toContain('config.billing.provider !== "stripe_sandbox"');
    expect(source).toContain('startsWith("sk_test_")');
  });

  it("provisions every approved Price role and a cancellation-disabled portal", () => {
    for (const key of ["monthly", "commencement", "production_deployment", "overage_minute", "meter_evidence"]) {
      expect(source).toContain(`sophia_founding_${key}_sandbox_v1`);
    }
    expect(source).toContain("subscription_cancel: { enabled: false }");
    expect(source).toContain("payment_method_update: { enabled: true }");
  });

  it("discovers existing resources by immutable metadata or lookup key before creation", () => {
    expect(source).toContain("stripe.products.search");
    expect(source).toContain("lookup_keys: [lookupKey]");
    expect(source).toContain("Founding sandbox Product identity is ambiguous");
    expect(source).toContain("liveMutation: false");
  });
});
