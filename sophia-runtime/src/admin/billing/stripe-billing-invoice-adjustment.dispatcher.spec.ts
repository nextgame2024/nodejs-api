import { describe, expect, it, jest } from "@jest/globals";
import type { RuntimeConfig } from "../../config/runtime-config.js";
import type { BillingInvoiceAdjustmentInput } from "./billing-invoice-adjustment.port.js";
import { StripeBillingInvoiceAdjustmentDispatcher } from "./stripe-billing-invoice-adjustment.dispatcher.js";

const planVersionId = "22222222-2222-4222-8222-222222222222";

describe("StripeBillingInvoiceAdjustmentDispatcher", () => {
  it("attaches the exact sandbox one-time Price to the exact open renewal invoice idempotently", async () => {
    const create = jest.fn(async () => ({ id: "ii_sophia_1" }));
    const dispatcher = new StripeBillingInvoiceAdjustmentDispatcher(config(), client(create));
    await expect(dispatcher.submit(input())).resolves.toMatchObject({ outcome: "accepted",
      providerInvoiceItemRef: "ii_sophia_1" });
    expect(create).toHaveBeenCalledWith({
      customer: "cus_sophia_1", invoice: "in_sophia_1", subscription: "sub_sophia_1",
      pricing: { price: "price_sophiaOverage123" }, quantity: 2, discountable: false,
      period: { start: 1_999_999_000, end: 2_000_098_999 },
      metadata: { sophiaNamespace: "subscription-v1", sophiaBillingAdjustmentId: "adjustment-1",
        sophiaBillingDeliveryId: "adjustment-1",
        sophiaUsageLedgerId: "ledger-1", sophiaProviderAccountKey: "legacy-primary" },
    }, { idempotencyKey: "sophia:sandbox:legacy-primary:invoice-adjustment:adjustment-1" });
  });

  it("refuses a non-draft or wrong-period invoice without creating an invoice item", async () => {
    const create = jest.fn();
    const stripe = client(create);
    stripe.invoices.retrieve = jest.fn(async () => ({ ...invoice(), status: "open" })) as never;
    const dispatcher = new StripeBillingInvoiceAdjustmentDispatcher(config(), stripe as never);
    await expect(dispatcher.submit(input())).resolves.toMatchObject({ outcome: "definite_failure",
      code: "invoice_adjustment_window_missed", retryable: false });
    expect(create).not.toHaveBeenCalled();
  });

  it("carries the original service period onto a later matching draft renewal", async () => {
    const create = jest.fn(async () => ({ id: "ii_recovery_1" }));
    const stripe = client(create);
    stripe.invoices.retrieve = jest.fn(async () => ({ ...invoice(), period_start: 2_000_099_000,
      period_end: 2_000_199_000 })) as never;
    const recovery = { ...input(), deliveryId: "recovery-1",
      targetPeriodStart: "2033-05-19T07:03:20.000Z", targetPeriodEnd: "2033-05-20T10:50:00.000Z" };
    await expect(new StripeBillingInvoiceAdjustmentDispatcher(config(), stripe as never).submit(recovery))
      .resolves.toMatchObject({ outcome: "accepted", providerInvoiceItemRef: "ii_recovery_1" });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      invoice: "in_sophia_1", period: { start: 1_999_999_000, end: 2_000_098_999 },
      metadata: expect.objectContaining({ sophiaBillingAdjustmentId: "adjustment-1",
        sophiaBillingDeliveryId: "recovery-1" }),
    }), { idempotencyKey: "sophia:sandbox:legacy-primary:invoice-adjustment:recovery-1" });
  });

  it("keeps all live invoice adjustment disabled even when mappings exist", async () => {
    const create = jest.fn();
    const dispatcher = new StripeBillingInvoiceAdjustmentDispatcher({ ...config(), provider: "stripe_live",
      stripeSecretKey: "sk_live_sophia" }, client(create));
    await expect(dispatcher.submit({ ...input(), providerEnvironment: "live" }))
      .resolves.toMatchObject({ outcome: "definite_failure", code: "invoice_adjustment_scope_mismatch" });
    expect(create).not.toHaveBeenCalled();
  });

  it("submits an exact live adjustment only when its independent switch is enabled", async () => {
    const create = jest.fn(async () => ({ id: "ii_live_1" }));
    const stripe = client(create);
    stripe.prices.retrieve = jest.fn(async () => ({ id: "price_sophiaOverage123", active: true, livemode: true,
      type: "one_time", recurring: null, currency: "aud", unit_amount: 10, tax_behavior: "exclusive" })) as never;
    stripe.invoices.retrieve = jest.fn(async () => ({ ...invoice(), livemode: true })) as never;
    const dispatcher = new StripeBillingInvoiceAdjustmentDispatcher({ ...config(), provider: "stripe_live",
      liveOverageEnabled: true, stripeSecretKey: "sk_live_sophia" }, stripe as never);
    await expect(dispatcher.submit({ ...input(), providerEnvironment: "live" }))
      .resolves.toMatchObject({ outcome: "accepted", providerInvoiceItemRef: "ii_live_1" });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ invoice: "in_sophia_1", quantity: 2 }),
      { idempotencyKey: "sophia:live:legacy-primary:invoice-adjustment:adjustment-1" });
  });

  it("reads back one exact finalized invoice line before reporting reconciliation", async () => {
    const create = jest.fn();
    const stripe = client(create);
    stripe.invoices.retrieve = jest.fn(async () => ({ ...invoice(), status: "paid",
      status_transitions: { finalized_at: 2_000_099_010 } })) as never;
    stripe.invoices.listLineItems = jest.fn(async () => ({ has_more: false, data: [{
      id: "il_sophia_1", amount: 20, currency: "aud", livemode: false, invoice: "in_sophia_1",
      subscription: null, quantity: 2, metadata: { sophiaBillingAdjustmentId: "adjustment-1",
        sophiaUsageLedgerId: "ledger-1" }, period: { start: 1_999_999_000, end: 2_000_098_999 },
      pricing: { type: "price_details", unit_amount_decimal: "10",
        price_details: { price: "price_sophiaOverage123", product: "prod_sophia" } },
      parent: { type: "invoice_item_details", invoice_item_details: { invoice_item: "ii_sophia_1",
        proration: false, proration_details: null, subscription: "sub_sophia_1" }, subscription_item_details: null },
    }] })) as never;
    const dispatcher = new StripeBillingInvoiceAdjustmentDispatcher(config(), stripe as never);
    await expect(dispatcher.reconcile(input())).resolves.toMatchObject({ outcome: "matched", evidence: {
      providerInvoiceItemRef: "ii_sophia_1", providerInvoiceLineRef: "il_sophia_1", quantity: "2",
      unitPriceMinor: "10", amountMinor: "20", currency: "AUD", invoiceStatus: "paid",
    } });
  });

  it("keeps live reconciliation available after the live submission switch is turned off", async () => {
    const stripe = client(jest.fn());
    stripe.invoices.retrieve = jest.fn(async () => ({ ...invoice(), livemode: true, status: "paid",
      status_transitions: { finalized_at: 2_000_099_010 } })) as never;
    stripe.invoices.listLineItems = jest.fn(async () => ({ has_more: false, data: [{
      id: "il_live_1", amount: 20, currency: "aud", livemode: true, invoice: "in_sophia_1",
      subscription: null, quantity: 2, metadata: { sophiaBillingAdjustmentId: "adjustment-1",
        sophiaUsageLedgerId: "ledger-1" }, period: { start: 1_999_999_000, end: 2_000_098_999 },
      pricing: { type: "price_details", unit_amount_decimal: "10",
        price_details: { price: "price_sophiaOverage123", product: "prod_sophia" } },
      parent: { type: "invoice_item_details", invoice_item_details: { invoice_item: "ii_live_1",
        proration: false, proration_details: null, subscription: "sub_sophia_1" }, subscription_item_details: null },
    }] })) as never;
    await expect(new StripeBillingInvoiceAdjustmentDispatcher({ ...config(), provider: "stripe_live",
      liveOverageEnabled: false, stripeSecretKey: "sk_live_sophia" }, stripe as never)
      .reconcile({ ...input(), providerEnvironment: "live" }))
      .resolves.toMatchObject({ outcome: "matched", evidence: { providerInvoiceItemRef: "ii_live_1" } });
  });

  it("reconciles a later renewal while requiring the carried line to retain its original period", async () => {
    const stripe = client(jest.fn());
    stripe.invoices.retrieve = jest.fn(async () => ({ ...invoice(), status: "paid",
      period_start: 2_000_099_000, period_end: 2_000_199_000,
      status_transitions: { finalized_at: 2_000_199_010 } })) as never;
    stripe.invoices.listLineItems = jest.fn(async () => ({ has_more: false, data: [{
      id: "il_recovery_1", amount: 20, currency: "aud", livemode: false, invoice: "in_sophia_1",
      subscription: null, quantity: 2, metadata: { sophiaBillingAdjustmentId: "adjustment-1",
        sophiaBillingDeliveryId: "recovery-1", sophiaUsageLedgerId: "ledger-1" },
      period: { start: 1_999_999_000, end: 2_000_098_999 },
      pricing: { type: "price_details", unit_amount_decimal: "10",
        price_details: { price: "price_sophiaOverage123", product: "prod_sophia" } },
      parent: { type: "invoice_item_details", invoice_item_details: { invoice_item: "ii_recovery_1",
        proration: false, proration_details: null, subscription: "sub_sophia_1" }, subscription_item_details: null },
    }] })) as never;
    const recovery = { ...input(), deliveryId: "recovery-1",
      targetPeriodStart: "2033-05-19T07:03:20.000Z", targetPeriodEnd: "2033-05-20T10:50:00.000Z" };
    await expect(new StripeBillingInvoiceAdjustmentDispatcher(config(), stripe as never).reconcile(recovery))
      .resolves.toMatchObject({ outcome: "matched", evidence: { providerInvoiceItemRef: "ii_recovery_1",
        periodStart: recovery.periodStart, periodEnd: recovery.periodEnd, amountMinor: "20" } });
  });

  it("rejects a finalized invoice-item line bound to a different parent subscription", async () => {
    const stripe = client(jest.fn());
    stripe.invoices.retrieve = jest.fn(async () => ({ ...invoice(), status: "paid",
      status_transitions: { finalized_at: 2_000_099_010 } })) as never;
    stripe.invoices.listLineItems = jest.fn(async () => ({ has_more: false, data: [{
      id: "il_sophia_1", amount: 20, currency: "aud", livemode: false, invoice: "in_sophia_1",
      subscription: null, quantity: 2, metadata: { sophiaBillingAdjustmentId: "adjustment-1",
        sophiaUsageLedgerId: "ledger-1" }, period: { start: 1_999_999_000, end: 2_000_098_999 },
      pricing: { type: "price_details", unit_amount_decimal: "10",
        price_details: { price: "price_sophiaOverage123", product: "prod_sophia" } },
      parent: { type: "invoice_item_details", invoice_item_details: { invoice_item: "ii_sophia_1",
        proration: false, proration_details: null, subscription: "sub_other" }, subscription_item_details: null },
    }] })) as never;
    await expect(new StripeBillingInvoiceAdjustmentDispatcher(config(), stripe as never).reconcile(input()))
      .resolves.toMatchObject({ outcome: "mismatch" });
  });
});

function config(): RuntimeConfig["billing"] {
  return { provider: "stripe_sandbox", providerAccountKey: "legacy-primary", liveCheckoutEnabled: false,
    liveOverageEnabled: false, liveMilestoneEnabled: false,
    stripeSecretKey: "sk_test_sophia", stripeWebhookSecret: "whsec_sophia",
    stripePortalConfigurationId: "bpc_sophiaSandbox123", checkoutSuccessUrl: "https://example.test/success",
    checkoutCancelUrl: "https://example.test/cancel", portalReturnUrl: "https://example.test/return",
    stripePriceMappings: { [planVersionId]: "price_sophiaBase123" },
    stripeInitialPriceMappings: {},
    stripeMilestonePriceMappings: {},
    stripeMeteredPriceMappings: { [planVersionId]: "price_sophiaMetered123" },
    stripeOveragePriceMappings: { [planVersionId]: "price_sophiaOverage123" },
    stripeMeterBindings: { "active-overage-minutes": "sophia_active_overage_minutes" } };
}

function client(create: jest.Mock) {
  return {
    prices: { retrieve: jest.fn(async () => ({ id: "price_sophiaOverage123", active: true, livemode: false,
      type: "one_time", recurring: null, currency: "aud", unit_amount: 10, tax_behavior: "exclusive" })) },
    invoices: { retrieve: jest.fn(async () => invoice()), listLineItems: jest.fn() },
    invoiceItems: { create },
  };
}

function invoice() {
  return { id: "in_sophia_1", livemode: false, status: "draft", customer: "cus_sophia_1",
    period_start: 1_999_999_000, period_end: 2_000_099_000,
    parent: { subscription_details: { subscription: "sub_sophia_1" } } };
}

function input(): BillingInvoiceAdjustmentInput {
  return { adjustmentId: "adjustment-1", ledgerId: "ledger-1", planVersionId,
    providerKey: "stripe-sophia", providerEnvironment: "sandbox", providerAccountKey: "legacy-primary",
    externalCustomerRef: "cus_sophia_1", externalSubscriptionRef: "sub_sophia_1",
    externalInvoiceRef: "in_sophia_1", oneTimePriceRef: "price_sophiaOverage123",
    periodStart: "2033-05-18T03:16:40.000Z", periodEnd: "2033-05-19T07:03:20.000Z",
    targetPeriodStart: "2033-05-18T03:16:40.000Z", targetPeriodEnd: "2033-05-19T07:03:20.000Z",
    deliveryId: "adjustment-1", quantity: "2", unitPriceMinor: "10", currency: "AUD", payloadDigest: "a".repeat(64) };
}
