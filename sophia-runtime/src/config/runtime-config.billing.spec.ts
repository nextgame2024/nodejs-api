import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { isStripeLiveCredential, isStripeTestCredential, LIVE_CHECKOUT_ACTIVATION_CONFIRMATION,
  runtimeConfig } from "./runtime-config.js";

const billingKeys = [
  "SOPHIA_RUNTIME_DATABASE_URL",
  "SOPHIA_BILLING_PROVIDER",
  "SOPHIA_BILLING_PROVIDER_ACCOUNT_KEY",
  "SOPHIA_BILLING_LIVE_CHECKOUT_ENABLED",
  "SOPHIA_BILLING_LIVE_OVERAGE_ENABLED",
  "SOPHIA_BILLING_LIVE_MILESTONE_ENABLED",
  "SOPHIA_BILLING_LIVE_ACTIVATION_CONFIRM",
  "SOPHIA_BILLING_STRIPE_SECRET_KEY",
  "SOPHIA_BILLING_STRIPE_OVERAGE_PRICE_MAPPINGS",
  "SOPHIA_BILLING_STRIPE_INITIAL_PRICE_MAPPINGS",
  "SOPHIA_BILLING_STRIPE_MILESTONE_PRICE_MAPPINGS",
  "SOPHIA_BILLING_STRIPE_PORTAL_CONFIGURATION_ID",
  "SOPHIA_BILLING_STRIPE_COMMITTED_PORTAL_CONFIGURATION_ID",
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
    expect(runtimeConfig().billing).toMatchObject({ provider: "stripe_live", liveCheckoutEnabled: false,
      liveOverageEnabled: false, liveMilestoneEnabled: false });
  });

  it("accepts mode-matched restricted keys and rejects cross-mode restricted keys", () => {
    expect(isStripeLiveCredential("rk_live_sophia")).toBe(true);
    expect(isStripeTestCredential("rk_test_sophia")).toBe(true);
    process.env.SOPHIA_BILLING_PROVIDER = "stripe_live";
    process.env.SOPHIA_BILLING_STRIPE_SECRET_KEY = "rk_live_sophia";
    expect(runtimeConfig().billing.stripeSecretKey).toBe("rk_live_sophia");
    process.env.SOPHIA_BILLING_STRIPE_SECRET_KEY = "rk_test_sophia";
    expect(() => runtimeConfig()).toThrow("live mode requires a live-mode secret or restricted key");
  });

  it("rejects a live secret in sandbox mode", () => {
    process.env.SOPHIA_BILLING_PROVIDER = "stripe_sandbox";
    process.env.SOPHIA_BILLING_STRIPE_SECRET_KEY = "sk_live_sophia";
    expect(() => runtimeConfig()).toThrow("sandbox mode requires a test-mode secret or restricted key");
  });

  it("rejects charge activation outside live mode", () => {
    process.env.SOPHIA_BILLING_PROVIDER = "stripe_sandbox";
    process.env.SOPHIA_BILLING_LIVE_CHECKOUT_ENABLED = "true";
    expect(() => runtimeConfig()).toThrow("may only be enabled with stripe_live");
  });

  it("requires a restricted key before live charge activation", () => {
    process.env.SOPHIA_BILLING_PROVIDER = "stripe_live";
    process.env.SOPHIA_BILLING_STRIPE_SECRET_KEY = "sk_live_sophia";
    process.env.SOPHIA_BILLING_LIVE_CHECKOUT_ENABLED = "true";
    expect(() => runtimeConfig()).toThrow("requires a least-privilege rk_live restricted key");
  });

  it("requires overage collection and a separate confirmation for live charge activation", () => {
    process.env.SOPHIA_BILLING_PROVIDER = "stripe_live";
    process.env.SOPHIA_BILLING_STRIPE_SECRET_KEY = "rk_live_sophia";
    process.env.SOPHIA_BILLING_LIVE_CHECKOUT_ENABLED = "true";
    expect(() => runtimeConfig()).toThrow("requires live overage collection");
    process.env.SOPHIA_BILLING_LIVE_OVERAGE_ENABLED = "true";
    expect(() => runtimeConfig()).toThrow("requires the separate explicit production activation confirmation");
    process.env.SOPHIA_BILLING_LIVE_ACTIVATION_CONFIRM = LIVE_CHECKOUT_ACTIVATION_CONFIRMATION;
    expect(runtimeConfig().billing).toMatchObject({ liveCheckoutEnabled: true, liveOverageEnabled: true,
      liveMilestoneEnabled: false });
  });

  it("requires a stable lowercase provider account key", () => {
    process.env.SOPHIA_BILLING_PROVIDER_ACCOUNT_KEY = "Stripe Account";
    expect(() => runtimeConfig()).toThrow("stable lowercase account key");
  });

  it("rejects live collection switches outside live mode", () => {
    process.env.SOPHIA_BILLING_PROVIDER = "stripe_sandbox";
    process.env.SOPHIA_BILLING_LIVE_OVERAGE_ENABLED = "true";
    expect(() => runtimeConfig()).toThrow("Live billing collection switches may only be enabled with stripe_live");
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

  it("requires committed and standard portal configurations to be distinct", () => {
    process.env.SOPHIA_BILLING_STRIPE_PORTAL_CONFIGURATION_ID = "bpc_sophiaPortal123";
    process.env.SOPHIA_BILLING_STRIPE_COMMITTED_PORTAL_CONFIGURATION_ID = "bpc_sophiaPortal123";
    expect(() => runtimeConfig()).toThrow("must be different");
  });
});
