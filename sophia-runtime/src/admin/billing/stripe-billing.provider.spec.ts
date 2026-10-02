import { describe, expect, it, jest } from "@jest/globals";
import Stripe from "stripe";
import type { RuntimeConfig } from "../../config/runtime-config.js";
import { StripeBillingProvider } from "./stripe-billing.provider.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const planVersionId = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";

describe("StripeBillingProvider", () => {
  it("stays dormant until every Sophia-specific sandbox setting exists", () => {
    const provider = new StripeBillingProvider({ ...config(), stripeWebhookSecret: undefined });
    expect(provider.status()).toMatchObject({ availability: "disabled", checkout: false,
      missingConfiguration: expect.arrayContaining(["webhookSigningSecret"]) });
  });

  it("creates hosted subscription Checkout with namespace metadata and idempotency", async () => {
    const create = jest.fn(async () => ({ id: "cs_test_sophia", url: "https://checkout.stripe.com/c/pay/test", expires_at: 2_000_000_000 }));
    const provider = new StripeBillingProvider(config(), client({ checkoutCreate: create }));
    await expect(provider.createHostedCheckout({ tenantId, planVersionId, requestId, customerRef: null,
      commercial: { currency: "AUD", interval: "month", baseChargeMinor: "1000",
        initialCharges: [], meteredOverage: null } })).resolves.toMatchObject({
      url: "https://checkout.stripe.com/c/pay/test", externalCheckoutRef: "cs_test_sophia",
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ mode: "subscription", client_reference_id: tenantId,
      line_items: [{ price: "price_sophiaSandbox123", quantity: 1 }],
      metadata: { sophiaNamespace: "subscription-v1", sophiaEnvironment: "sandbox",
        sophiaProviderAccountKey: "legacy-primary",
        sophiaTenantId: tenantId, sophiaPlanVersionId: planVersionId } }),
    { idempotencyKey: `sophia:sandbox:legacy-primary:checkout:${tenantId}:${planVersionId}:${requestId}` });
    expect(JSON.stringify(create.mock.calls[0])).not.toMatch(/card|payment_method/i);
  });

  it("verifies a fixed recurring base and separate one-time overage Price but attaches only the base", async () => {
    const create = jest.fn(async () => ({ id: "cs_test_metered", url: "https://checkout.stripe.com/c/pay/metered",
      expires_at: 2_000_000_000 }));
    const retrieve = jest.fn(async (id: string) => id === "price_sophiaSandbox123"
      ? recurringPrice({ unitAmount: 1000, usageType: "licensed", meter: null })
      : oneTimePrice({ unitAmount: 50 }));
    const provider = new StripeBillingProvider(config(), client({ checkoutCreate: create, pricesRetrieve: retrieve }));
    await provider.createHostedCheckout({ tenantId, planVersionId, requestId, customerRef: null,
      commercial: { currency: "AUD", interval: "month", baseChargeMinor: "1000",
        initialCharges: [], meteredOverage: { unitPriceMinor: "50", meterBindingKey: "active-overage-minutes" } } });
    expect(retrieve.mock.calls.map(([id]) => id)).toEqual(["price_sophiaSandbox123", "price_sophiaOverage123"]);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      line_items: [{ price: "price_sophiaSandbox123", quantity: 1 }],
    }), expect.any(Object));
  });

  it("validates and adds a required commencement Price only to the initial subscription invoice", async () => {
    const create = jest.fn(async () => ({ id: "cs_test_founding", url: "https://checkout.stripe.com/c/pay/founding",
      expires_at: 2_000_000_000 }));
    const retrieve = jest.fn(async (id: string) => id === "price_sophiaSandbox123"
      ? recurringPrice({ unitAmount: 19_000, usageType: "licensed", meter: null })
      : oneTimePrice({ unitAmount: 95_000 }));
    const provider = new StripeBillingProvider({ ...config(),
      stripeInitialPriceMappings: { [planVersionId]: { commencement: "price_foundingCommencement123" } } },
    client({ checkoutCreate: create, pricesRetrieve: retrieve }));
    await provider.createHostedCheckout({ tenantId, planVersionId, requestId, customerRef: null,
      commercial: { currency: "AUD", interval: "month", baseChargeMinor: "19000",
        initialCharges: [{ componentKey: "commencement", amountMinor: "95000" }], meteredOverage: null } });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ mode: "subscription", line_items: [
      { price: "price_sophiaSandbox123", quantity: 1 },
      { price: "price_foundingCommencement123", quantity: 1 },
    ] }), expect.any(Object));
  });

  it("extracts an exact draft renewal-invoice window only from a signed invoice.created event", async () => {
    const secret = "whsec_sophia_test_secret";
    const body = JSON.stringify({ id: "evt_invoice_created_1", type: "invoice.created", created: 2_000_000_000,
      livemode: false, data: { object: { id: "in_draft_1", customer: "cus_1", status: "draft",
        billing_reason: "subscription_cycle", period_start: 1_999_999_000, period_end: 2_000_099_000,
        parent: { subscription_details: { subscription: "sub_1" } }, currency: "aud",
        amount_due: 75000, amount_paid: 0 } } });
    const signature = Stripe.webhooks.generateTestHeaderString({ payload: body, secret,
      timestamp: Math.floor(Date.now() / 1000) });
    const provider = new StripeBillingProvider({ ...config(), stripeWebhookSecret: secret });
    await expect(provider.verifyWebhook({ "stripe-signature": signature }, Buffer.from(body)))
      .resolves.toMatchObject({ draftRenewalInvoice: {
        externalInvoiceRef: "in_draft_1", externalSubscriptionRef: "sub_1",
        periodStart: "2033-05-18T03:16:40.000Z", periodEnd: "2033-05-19T07:03:20.000Z",
      } });
  });

  it("verifies a real Stripe signature locally and rejects live-mode payloads", async () => {
    const secret = "whsec_sophia_test_secret";
    const body = JSON.stringify({ id: "evt_sophia_1", type: "customer.subscription.updated", created: 2_000_000_000,
      livemode: false, data: { object: { id: "sub_1", customer: "cus_1", status: "active",
        metadata: { sophiaNamespace: "subscription-v1", sophiaTenantId: tenantId, sophiaPlanVersionId: planVersionId },
        current_period_start: 1_999_999_000, current_period_end: 2_000_099_000 } } });
    const signature = Stripe.webhooks.generateTestHeaderString({ payload: body, secret, timestamp: Math.floor(Date.now() / 1000) });
    const provider = new StripeBillingProvider({ ...config(), stripeWebhookSecret: secret });
    const evidence = await provider.verifyWebhook({ "stripe-signature": signature }, Buffer.from(body));
    expect(evidence).toMatchObject({ environment: "sandbox", eventId: "evt_sophia_1", customerRef: "cus_1",
      subscription: { externalRef: "sub_1", status: "active" } });
    expect(evidence.payloadDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(evidence)).not.toContain(body);
  });

  it("configures live observation paths while keeping real Checkout disabled", async () => {
    const checkoutCreate = jest.fn();
    const provider = new StripeBillingProvider({ ...config(), provider: "stripe_live",
      liveCheckoutEnabled: false, stripeSecretKey: "sk_live_sophia" }, client({ checkoutCreate, liveMode: true }));
    expect(provider.status()).toMatchObject({ availability: "live", checkout: false,
      portal: true, signedWebhooks: true, reconciliation: true });
    await expect(provider.createHostedCheckout({ tenantId, planVersionId, requestId, customerRef: null,
      commercial: { currency: "AUD", interval: "month", baseChargeMinor: "1000",
        initialCharges: [], meteredOverage: null } }))
      .rejects.toThrow("explicit charge activation");
    expect(checkoutCreate).not.toHaveBeenCalled();
  });

  it("does not require an unauthorized live overage mapping for read-only live observation", () => {
    const provider = new StripeBillingProvider({ ...config(), provider: "stripe_live", liveCheckoutEnabled: false,
      stripeSecretKey: "sk_live_sophia", stripeOveragePriceMappings: {} }, client({ liveMode: true }));
    expect(provider.status()).toMatchObject({ availability: "live", checkout: false,
      signedWebhooks: true, reconciliation: true });
  });

  it("rejects sandbox webhook payloads in live mode", async () => {
    const secret = "whsec_sophia_live_secret";
    const body = JSON.stringify({ id: "evt_sophia_live_1", type: "invoice.paid", created: 2_000_000_000,
      livemode: false, data: { object: { id: "in_1", customer: "cus_1" } } });
    const signature = Stripe.webhooks.generateTestHeaderString({ payload: body, secret, timestamp: Math.floor(Date.now() / 1000) });
    const provider = new StripeBillingProvider({ ...config(), provider: "stripe_live", liveCheckoutEnabled: false,
      stripeSecretKey: "sk_live_sophia", stripeWebhookSecret: secret });
    await expect(provider.verifyWebhook({ "stripe-signature": signature }, Buffer.from(body)))
      .rejects.toThrow("sandbox events are rejected by the live adapter");
  });

  it("routes signed Customer update evidence by the Customer object's own ID", async () => {
    const secret = "whsec_sophia_live_secret";
    const body = JSON.stringify({ id: "evt_customer_updated_1", type: "customer.updated", created: 2_000_000_000,
      livemode: true, data: { object: { id: "cus_liveSophia123", metadata: {
        sophiaNamespace: "subscription-v1", sophiaEnvironment: "live",
        sophiaProviderAccountKey: "legacy-primary", sophiaTenantId: tenantId,
      } } } });
    const signature = Stripe.webhooks.generateTestHeaderString({ payload: body, secret, timestamp: Math.floor(Date.now() / 1000) });
    const provider = new StripeBillingProvider({ ...config(), provider: "stripe_live", liveCheckoutEnabled: false,
      stripeSecretKey: "sk_live_sophia", stripeWebhookSecret: secret });
    await expect(provider.verifyWebhook({ "stripe-signature": signature }, Buffer.from(body)))
      .resolves.toMatchObject({ eventType: "customer.updated", environment: "live", customerRef: "cus_liveSophia123" });
  });

  it("verifies an existing live Customer has exact Sophia tenant metadata before binding", async () => {
    const customersRetrieve = jest.fn(async () => ({ id: "cus_liveSophia123", livemode: true,
      metadata: { sophiaNamespace: "subscription-v1", sophiaEnvironment: "live",
        sophiaProviderAccountKey: "legacy-primary", sophiaTenantId: tenantId } }));
    const provider = new StripeBillingProvider({ ...config(), provider: "stripe_live", liveCheckoutEnabled: false,
      stripeSecretKey: "sk_live_sophia" }, client({ liveMode: true, customersRetrieve }));
    await expect(provider.verifyCustomerBinding({ tenantId, customerRef: "cus_liveSophia123" }))
      .resolves.toEqual({ observedAt: expect.any(String) });
    expect(customersRetrieve).toHaveBeenCalledWith("cus_liveSophia123");
  });

  it("rejects a live Customer whose metadata authorizes another tenant", async () => {
    const customersRetrieve = jest.fn(async () => ({ id: "cus_liveSophia123", livemode: true,
      metadata: { sophiaNamespace: "subscription-v1", sophiaEnvironment: "live",
        sophiaTenantId: "44444444-4444-4444-8444-444444444444" } }));
    const provider = new StripeBillingProvider({ ...config(), provider: "stripe_live", liveCheckoutEnabled: false,
      stripeSecretKey: "sk_live_sophia" }, client({ liveMode: true, customersRetrieve }));
    await expect(provider.verifyCustomerBinding({ tenantId, customerRef: "cus_liveSophia123" }))
      .rejects.toThrow("does not authorize this Sophia tenant binding");
  });
});

function config(): RuntimeConfig["billing"] {
  return { provider: "stripe_sandbox", providerAccountKey: "legacy-primary",
    liveCheckoutEnabled: false, stripeSecretKey: "sk_test_sophia",
    stripeWebhookSecret: "whsec_sophia", checkoutSuccessUrl: "https://example.test/success",
    stripePortalConfigurationId: "bpc_sophiaSandbox123",
    checkoutCancelUrl: "https://example.test/cancel", portalReturnUrl: "https://example.test/return",
    stripePriceMappings: { [planVersionId]: "price_sophiaSandbox123" },
    stripeInitialPriceMappings: {},
    stripeMeteredPriceMappings: { [planVersionId]: "price_sophiaMetered123" },
    stripeOveragePriceMappings: { [planVersionId]: "price_sophiaOverage123" },
    stripeMeterBindings: { "active-overage-minutes": "sophia_active_overage_minutes" } };
}
function client(input: { checkoutCreate?: jest.Mock; liveMode?: boolean; customersRetrieve?: jest.Mock;
  pricesRetrieve?: jest.Mock } = {}) {
  return {
    checkout: { sessions: { create: input.checkoutCreate ?? jest.fn() } },
    billingPortal: { sessions: { create: jest.fn() } },
    webhooks: { constructEvent: jest.fn() }, subscriptions: { list: jest.fn() }, invoices: { list: jest.fn() },
    prices: { retrieve: input.pricesRetrieve ?? jest.fn(async () => recurringPrice({
      unitAmount: 1000, usageType: "licensed", meter: null, liveMode: input.liveMode })) },
    customers: { retrieve: input.customersRetrieve ?? jest.fn() },
  } as never;
}

function recurringPrice(input: { unitAmount: number; usageType: "licensed" | "metered"; meter: string | null; liveMode?: boolean }) {
  return { livemode: input.liveMode ?? false, active: true, type: "recurring", currency: "aud",
    unit_amount: input.unitAmount, recurring: { interval: "month", usage_type: input.usageType, meter: input.meter } };
}
function oneTimePrice(input: { unitAmount: number; liveMode?: boolean }) {
  return { livemode: input.liveMode ?? false, active: true, type: "one_time", currency: "aud",
    unit_amount: input.unitAmount, recurring: null, tax_behavior: "exclusive" };
}
