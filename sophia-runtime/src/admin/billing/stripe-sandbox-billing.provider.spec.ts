import { describe, expect, it, jest } from "@jest/globals";
import Stripe from "stripe";
import type { RuntimeConfig } from "../../config/runtime-config.js";
import { StripeSandboxBillingProvider } from "./stripe-sandbox-billing.provider.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const planVersionId = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";

describe("StripeSandboxBillingProvider", () => {
  it("stays dormant until every Sophia-specific sandbox setting exists", () => {
    const provider = new StripeSandboxBillingProvider({ ...config(), stripeWebhookSecret: undefined });
    expect(provider.status()).toMatchObject({ availability: "disabled", checkout: false,
      missingConfiguration: expect.arrayContaining(["webhookSigningSecret"]) });
  });

  it("creates hosted subscription Checkout with namespace metadata and idempotency", async () => {
    const create = jest.fn(async () => ({ id: "cs_test_sophia", url: "https://checkout.stripe.com/c/pay/test", expires_at: 2_000_000_000 }));
    const provider = new StripeSandboxBillingProvider(config(), client({ checkoutCreate: create }));
    await expect(provider.createHostedCheckout({ tenantId, planVersionId, requestId, customerRef: null,
      commercial: { currency: "AUD", interval: "month", baseChargeMinor: "1000" } })).resolves.toMatchObject({
      url: "https://checkout.stripe.com/c/pay/test", externalCheckoutRef: "cs_test_sophia",
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ mode: "subscription", client_reference_id: tenantId,
      line_items: [{ price: "price_sophiaSandbox123", quantity: 1 }],
      metadata: { sophiaNamespace: "subscription-v1", sophiaTenantId: tenantId, sophiaPlanVersionId: planVersionId } }),
    { idempotencyKey: `sophia:checkout:${tenantId}:${planVersionId}:${requestId}` });
    expect(JSON.stringify(create.mock.calls[0])).not.toMatch(/card|payment_method/i);
  });

  it("verifies a real Stripe signature locally and rejects live-mode payloads", async () => {
    const secret = "whsec_sophia_test_secret";
    const body = JSON.stringify({ id: "evt_sophia_1", type: "customer.subscription.updated", created: 2_000_000_000,
      livemode: false, data: { object: { id: "sub_1", customer: "cus_1", status: "active",
        metadata: { sophiaNamespace: "subscription-v1", sophiaTenantId: tenantId, sophiaPlanVersionId: planVersionId },
        current_period_start: 1_999_999_000, current_period_end: 2_000_099_000 } } });
    const signature = Stripe.webhooks.generateTestHeaderString({ payload: body, secret, timestamp: Math.floor(Date.now() / 1000) });
    const provider = new StripeSandboxBillingProvider({ ...config(), stripeWebhookSecret: secret });
    const evidence = await provider.verifyWebhook({ "stripe-signature": signature }, Buffer.from(body));
    expect(evidence).toMatchObject({ environment: "sandbox", eventId: "evt_sophia_1", customerRef: "cus_1",
      subscription: { externalRef: "sub_1", status: "active" } });
    expect(evidence.payloadDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(evidence)).not.toContain(body);
  });
});

function config(): RuntimeConfig["billing"] {
  return { provider: "stripe_sandbox", stripeSecretKey: "sk_test_sophia",
    stripeWebhookSecret: "whsec_sophia", checkoutSuccessUrl: "https://example.test/success",
    stripePortalConfigurationId: "bpc_sophiaSandbox123",
    checkoutCancelUrl: "https://example.test/cancel", portalReturnUrl: "https://example.test/return",
    stripePriceMappings: { [planVersionId]: "price_sophiaSandbox123" } };
}
function client(input: { checkoutCreate?: jest.Mock } = {}) {
  return {
    checkout: { sessions: { create: input.checkoutCreate ?? jest.fn() } },
    billingPortal: { sessions: { create: jest.fn() } },
    webhooks: { constructEvent: jest.fn() }, subscriptions: { list: jest.fn() }, invoices: { list: jest.fn() },
    prices: { retrieve: jest.fn(async () => ({ livemode: false, active: true, type: "recurring", currency: "aud",
      unit_amount: 1000, recurring: { interval: "month" } })) },
  } as never;
}
