import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { runtimeConfig } from "./runtime-config.js";

const billingKeys = [
  "SOPHIA_RUNTIME_DATABASE_URL",
  "SOPHIA_BILLING_PROVIDER",
  "SOPHIA_BILLING_PROVIDER_ACCOUNT_KEY",
  "SOPHIA_BILLING_LIVE_CHECKOUT_ENABLED",
  "SOPHIA_BILLING_STRIPE_SECRET_KEY",
  "SOPHIA_BILLING_STRIPE_OVERAGE_PRICE_MAPPINGS",
  "SOPHIA_BILLING_STRIPE_INITIAL_PRICE_MAPPINGS",
  "SOPHIA_BILLING_STRIPE_MILESTONE_PRICE_MAPPINGS",
] as const;
const original = new Map<string, string | undefined>();

describe("runtime billing configuration", () => {
  beforeEach(() => {
    for (const key of billingKeys) {
      original.set(key, process.env[key]);
      delete process.env[key];
    }
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
  });

  afterEach(() => {
    for (const key of billingKeys) {
      const value = original.get(key);
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    original.clear();
  });

  it("keeps live Checkout disabled by default in live mode", () => {
    process.env.SOPHIA_BILLING_PROVIDER = "stripe_live";
    process.env.SOPHIA_BILLING_STRIPE_SECRET_KEY = "sk_live_sophia";
    expect(runtimeConfig().billing).toMatchObject({ provider: "stripe_live", liveCheckoutEnabled: false });
  });

  it("rejects a live secret in sandbox mode", () => {
    process.env.SOPHIA_BILLING_PROVIDER = "stripe_sandbox";
    process.env.SOPHIA_BILLING_STRIPE_SECRET_KEY = "sk_live_sophia";
    expect(() => runtimeConfig()).toThrow("sandbox mode requires a test-mode secret key");
  });

  it("rejects charge activation outside live mode", () => {
    process.env.SOPHIA_BILLING_PROVIDER = "stripe_sandbox";
    process.env.SOPHIA_BILLING_LIVE_CHECKOUT_ENABLED = "true";
    expect(() => runtimeConfig()).toThrow("may only be enabled with stripe_live");
  });

  it("requires a stable lowercase provider account key", () => {
    process.env.SOPHIA_BILLING_PROVIDER_ACCOUNT_KEY = "Stripe Account";
    expect(() => runtimeConfig()).toThrow("stable lowercase account key");
  });

  it("parses an approved plan-version to one-time overage Price mapping", () => {
    process.env.SOPHIA_BILLING_STRIPE_OVERAGE_PRICE_MAPPINGS =
      '{"112e2d08-9e8b-4748-a89a-954a28ad43c9":"price_1ULyegGcz4GrZOEBwDHdpzPW"}';
    expect(runtimeConfig().billing.stripeOveragePriceMappings).toEqual({
      "112e2d08-9e8b-4748-a89a-954a28ad43c9": "price_1ULyegGcz4GrZOEBwDHdpzPW",
    });
  });

  it("parses approved plan-version and initial charge-component Price mappings", () => {
    process.env.SOPHIA_BILLING_STRIPE_INITIAL_PRICE_MAPPINGS =
      '{"112e2d08-9e8b-4748-a89a-954a28ad43c9":{"commencement":"price_1FoundingCommencement"}}';
    expect(runtimeConfig().billing.stripeInitialPriceMappings).toEqual({
      "112e2d08-9e8b-4748-a89a-954a28ad43c9": { commencement: "price_1FoundingCommencement" },
    });
  });

  it("parses approved plan-version and milestone charge-component Price mappings", () => {
    process.env.SOPHIA_BILLING_STRIPE_MILESTONE_PRICE_MAPPINGS =
      '{"112e2d08-9e8b-4748-a89a-954a28ad43c9":{"production-deployment":"price_1FoundingDeployment"}}';
    expect(runtimeConfig().billing.stripeMilestonePriceMappings).toEqual({
      "112e2d08-9e8b-4748-a89a-954a28ad43c9": { "production-deployment": "price_1FoundingDeployment" },
    });
  });
});
