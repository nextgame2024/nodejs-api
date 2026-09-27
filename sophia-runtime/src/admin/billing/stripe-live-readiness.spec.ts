import { describe, expect, it, jest } from "@jest/globals";
import { STRIPE_BILLING_API_VERSION, STRIPE_BILLING_WEBHOOK_EVENT_TYPES } from "./stripe-billing.constants.js";
import { verifyLiveStripeResources } from "./stripe-live-readiness.js";

const plan = { planVersionId: "22222222-2222-4222-8222-222222222222", priceId: "price_live_sophia",
  currency: "AUD", interval: "month" as const, baseChargeMinor: "1000" };

describe("live Stripe resource readiness", () => {
  it("verifies live fixed Prices, portal features and the exact signed webhook destination read-only", async () => {
    const client = validClient();
    await expect(verifyLiveStripeResources({ client: client as never, plans: [plan],
      portalConfigurationId: "bpc_live_sophia", webhookUrl: "https://runtime.example/api/billing/v1/webhooks/stripe" }))
      .resolves.toMatchObject({ environment: "live", checkoutEnabled: false, prices: { verified: 1 },
        webhook: { requiredEventCount: STRIPE_BILLING_WEBHOOK_EVENT_TYPES.length } });
    expect(client.prices.retrieve).toHaveBeenCalledWith(plan.priceId);
    expect(client.webhookEndpoints.list).toHaveBeenCalledWith({ limit: 100 });
  });

  it("rejects a test-mode Price before inspecting later resources", async () => {
    const client = validClient();
    client.prices.retrieve.mockResolvedValue({ ...livePrice(), livemode: false });
    await expect(verifyLiveStripeResources({ client: client as never, plans: [plan],
      portalConfigurationId: "bpc_live_sophia", webhookUrl: "https://runtime.example/api/billing/v1/webhooks/stripe" }))
      .rejects.toThrow("does not match approved fixed plan");
    expect(client.billingPortal.configurations.retrieve).not.toHaveBeenCalled();
  });

  it("rejects a webhook destination with incomplete event coverage", async () => {
    const client = validClient();
    client.webhookEndpoints.list.mockResolvedValue({ object: "list", url: "/v1/webhook_endpoints", has_more: false,
      data: [{ ...liveWebhook(), enabled_events: ["invoice.paid"] }] });
    await expect(verifyLiveStripeResources({ client: client as never, plans: [plan],
      portalConfigurationId: "bpc_live_sophia", webhookUrl: "https://runtime.example/api/billing/v1/webhooks/stripe" }))
      .rejects.toThrow("missing 12 required event type");
  });
});

function validClient() {
  return {
    prices: { retrieve: jest.fn(async () => livePrice()) },
    billingPortal: { configurations: { retrieve: jest.fn(async () => ({ livemode: true, active: true,
      features: { invoice_history: { enabled: true }, payment_method_update: { enabled: true },
        subscription_cancel: { enabled: true } } })) } },
    webhookEndpoints: { list: jest.fn(async () => ({ object: "list", url: "/v1/webhook_endpoints", has_more: false,
      data: [liveWebhook()] })) },
  };
}
function livePrice() { return { livemode: true, active: true, type: "recurring", currency: "aud",
  unit_amount: 1000, recurring: { interval: "month" } }; }
function liveWebhook() { return { livemode: true, status: "enabled", url: "https://runtime.example/api/billing/v1/webhooks/stripe",
  api_version: STRIPE_BILLING_API_VERSION, enabled_events: [...STRIPE_BILLING_WEBHOOK_EVENT_TYPES] }; }
