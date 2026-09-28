import { describe, expect, it, jest } from "@jest/globals";
import { StripeBillingMeterEventDispatcher } from "./stripe-billing-meter-event.dispatcher.js";

describe("StripeBillingMeterEventDispatcher", () => {
  it("maps the provider-neutral whole-minute event to the approved Stripe Meter event name", async () => {
    const create = jest.fn(async () => ({ identifier: "accepted" }));
    const dispatcher = new StripeBillingMeterEventDispatcher(config(), client(create));
    await expect(dispatcher.submit(event())).resolves.toMatchObject({
      outcome: "accepted", providerEventRef: "sophia-active-minutes-ledger-1",
    });
    expect(create).toHaveBeenCalledWith({
      event_name: "sophia_active_overage_minutes",
      identifier: "sophia-active-minutes-ledger-1",
      timestamp: 1_788_652_800,
      payload: { stripe_customer_id: "cus_sandbox", value: "2" },
    });
  });

  it("fails closed when the semantic Meter binding is absent", async () => {
    const create = jest.fn();
    const dispatcher = new StripeBillingMeterEventDispatcher({ ...config(), stripeMeterBindings: {} }, client(create));
    expect(dispatcher.status().availability).toBe("disabled");
    await expect(dispatcher.submit(event())).resolves.toMatchObject({
      outcome: "definite_failure", retryable: false, code: "meter_dispatch_disabled",
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects an event for another environment or account before calling Stripe", async () => {
    const create = jest.fn();
    const dispatcher = new StripeBillingMeterEventDispatcher(config(), client(create));
    await expect(dispatcher.submit({ ...event(), providerAccountKey: "another-account" }))
      .resolves.toMatchObject({ outcome: "definite_failure", code: "meter_scope_mismatch" });
    expect(create).not.toHaveBeenCalled();
  });

  it("quarantines transport ambiguity instead of claiming a safe retry", async () => {
    const dispatcher = new StripeBillingMeterEventDispatcher(config(), client(jest.fn(async () => {
      throw new Error("socket closed after write");
    })));
    await expect(dispatcher.submit(event())).resolves.toMatchObject({
      outcome: "unknown", code: "stripe_transport_unknown",
    });
  });

  it("reconciles only an exact Meter summary and finalized metered invoice line", async () => {
    const periodStart = "2026-08-15T00:00:00.000Z";
    const periodEnd = "2026-09-15T00:00:00.000Z";
    const start = Date.parse(periodStart) / 1000;
    const end = Date.parse(periodEnd) / 1000;
    const stripe = {
      prices: { retrieve: jest.fn(async () => ({ active: true, livemode: false, currency: "aud",
        unit_amount: 10, recurring: { usage_type: "metered", meter: "mtr_1" } })) },
      billing: {
        meterEvents: { create: jest.fn() },
        meters: { listEventSummaries: jest.fn(async () => ({ has_more: false, data: [{
          id: "mtrsum_1", meter: "mtr_1", start_time: start, end_time: end,
          aggregated_value: 2, livemode: false,
        }] })) },
      },
      invoices: {
        list: jest.fn(async () => ({ has_more: false, data: [{ id: "in_1", status: "paid" }] })),
        listLineItems: jest.fn(async () => ({ has_more: false, data: [{
          id: "il_1", amount: 20, currency: "aud", livemode: false, quantity: 2,
          period: { start, end }, pricing: { price_details: { price: "price_metered_1" } },
        }] })),
      },
    };
    const dispatcher = new StripeBillingMeterEventDispatcher({ ...config(),
      stripeMeteredPriceMappings: { "22222222-2222-4222-8222-222222222222": "price_metered_1" } }, stripe as never);
    await expect(dispatcher.reconcile({
      providerKey: "stripe-sophia", providerEnvironment: "sandbox", providerAccountKey: "legacy-primary",
      planVersionId: "22222222-2222-4222-8222-222222222222", externalCustomerRef: "cus_sandbox",
      meterBindingKey: "active-overage-minutes", submissionIdentifier: "sophia-active-minutes-ledger-1",
      periodStart, periodEnd, quantity: "2", unitPriceMinor: "10", currency: "AUD",
    })).resolves.toMatchObject({ outcome: "matched", evidence: {
      meterRef: "mtr_1", meterSummaryRef: "mtrsum_1", invoiceRef: "in_1",
      invoiceLineRef: "il_1", invoiceLineQuantity: "2", invoiceLineAmountMinor: "20",
    } });
  });

  it("does not claim reconciliation while Stripe aggregation is not yet consistent", async () => {
    const stripe = {
      prices: { retrieve: jest.fn(async () => ({ active: true, livemode: false, currency: "aud",
        unit_amount: 10, recurring: { usage_type: "metered", meter: "mtr_1" } })) },
      billing: { meterEvents: { create: jest.fn() }, meters: {
        listEventSummaries: jest.fn(async () => ({ has_more: false, data: [] })),
      } },
      invoices: { list: jest.fn(), listLineItems: jest.fn() },
    };
    const dispatcher = new StripeBillingMeterEventDispatcher({ ...config(),
      stripeMeteredPriceMappings: { "22222222-2222-4222-8222-222222222222": "price_metered_1" } }, stripe as never);
    await expect(dispatcher.reconcile({
      providerKey: "stripe-sophia", providerEnvironment: "sandbox", providerAccountKey: "legacy-primary",
      planVersionId: "22222222-2222-4222-8222-222222222222", externalCustomerRef: "cus_sandbox",
      meterBindingKey: "active-overage-minutes", submissionIdentifier: "sophia-active-minutes-ledger-1",
      periodStart: "2026-08-15T00:00:00.000Z", periodEnd: "2026-09-15T00:00:00.000Z",
      quantity: "2", unitPriceMinor: "10", currency: "AUD",
    })).resolves.toMatchObject({ outcome: "pending" });
    expect(stripe.invoices.list).not.toHaveBeenCalled();
  });
});

function config() {
  return {
    provider: "stripe_sandbox" as const,
    providerAccountKey: "legacy-primary",
    liveCheckoutEnabled: false,
    stripeSecretKey: "sk_test_example",
    stripeWebhookSecret: "whsec_example",
    stripePortalConfigurationId: "bpc_example123",
    checkoutSuccessUrl: "https://example.com/success",
    checkoutCancelUrl: "https://example.com/cancel",
    portalReturnUrl: "https://example.com/return",
    stripePriceMappings: {},
    stripeMeteredPriceMappings: {},
    stripeMeterBindings: { "active-overage-minutes": "sophia_active_overage_minutes" },
  };
}

function client(create: jest.Mock) {
  return { billing: { meterEvents: { create } } } as never;
}

function event() {
  return {
    submissionIdentifier: "sophia-active-minutes-ledger-1",
    providerKey: "stripe-sophia",
    providerEnvironment: "sandbox" as const,
    providerAccountKey: "legacy-primary",
    externalCustomerRef: "cus_sandbox",
    meterBindingKey: "active-overage-minutes",
    eventTimestamp: "2026-09-06T00:00:00.000Z",
    quantity: "2",
    quantityUnit: "whole-minute" as const,
    payloadDigest: "a".repeat(64),
  };
}
