import { describe, expect, it, jest } from "@jest/globals";
import type { RuntimeConfig } from "../../config/runtime-config.js";
import type { BillingCommercialMilestoneInput } from "./billing-commercial-milestone.port.js";
import { StripeBillingCommercialMilestoneDispatcher } from "./stripe-billing-commercial-milestone.dispatcher.js";

const planVersionId = "22222222-2222-4222-8222-222222222222";

describe("StripeBillingCommercialMilestoneDispatcher", () => {
  it("creates, attaches, and finalizes one exact sandbox milestone invoice idempotently", async () => {
    const stripe = client();
    const dispatcher = new StripeBillingCommercialMilestoneDispatcher(config(), stripe as never);
    await expect(dispatcher.submit(input())).resolves.toMatchObject({ outcome: "accepted",
      externalInvoiceRef: "in_milestone_1", providerInvoiceItemRef: "ii_milestone_1" });
    expect(stripe.invoices.create).toHaveBeenCalledWith(expect.objectContaining({ customer: "cus_sophia_1",
      auto_advance: false, collection_method: "charge_automatically",
      metadata: expect.objectContaining({ sophiaCommercialMilestoneOutboxId: "outbox-1" }) }),
    { idempotencyKey: "sophia:sandbox:legacy-primary:milestone-invoice:outbox-1" });
    expect(stripe.invoiceItems.create).toHaveBeenCalledWith(expect.objectContaining({ invoice: "in_milestone_1",
      pricing: { price: "price_foundingDeployment123" }, quantity: 1, discountable: false }),
    { idempotencyKey: "sophia:sandbox:legacy-primary:milestone-item:outbox-1" });
    expect(stripe.invoices.finalizeInvoice).toHaveBeenCalledWith("in_milestone_1", {},
      { idempotencyKey: "sophia:sandbox:legacy-primary:milestone-finalize:outbox-1" });
  });

  it("keeps milestone submission disabled in live mode", async () => {
    const stripe = client();
    const dispatcher = new StripeBillingCommercialMilestoneDispatcher({ ...config(), provider: "stripe_live",
      stripeSecretKey: "sk_live_sophia" }, stripe as never);
    await expect(dispatcher.submit({ ...input(), providerEnvironment: "live" }))
      .resolves.toMatchObject({ outcome: "definite_failure", code: "commercial_milestone_scope_mismatch" });
    expect(stripe.invoices.create).not.toHaveBeenCalled();
  });

  it("reconciles exactly one finalized digest-bound milestone line", async () => {
    const stripe = client();
    stripe.invoices.retrieve = jest.fn(async () => ({ ...invoice(), status: "paid",
      metadata: { sophiaCommercialMilestoneOutboxId: "outbox-1" },
      status_transitions: { finalized_at: 2_000_000_000 } }));
    stripe.invoices.listLineItems = jest.fn(async () => ({ has_more: false, data: [{
      id: "il_milestone_1", amount: 95000, currency: "aud", livemode: false, invoice: "in_milestone_1",
      quantity: 1, metadata: { sophiaCommercialMilestoneOutboxId: "outbox-1" },
      pricing: { type: "price_details", unit_amount_decimal: "95000",
        price_details: { price: "price_foundingDeployment123", product: "prod_sophia" } },
      parent: { type: "invoice_item_details", invoice_item_details: { invoice_item: "ii_milestone_1",
        proration: false, proration_details: null, subscription: null }, subscription_item_details: null },
    }] }));
    const dispatcher = new StripeBillingCommercialMilestoneDispatcher(config(), stripe as never);
    await expect(dispatcher.reconcile({ ...input(), externalInvoiceRef: "in_milestone_1",
      providerInvoiceItemRef: "ii_milestone_1" }))
      .resolves.toMatchObject({ outcome: "matched", evidence: { amountMinor: "95000", quantity: "1",
        providerInvoiceLineRef: "il_milestone_1", invoiceStatus: "paid" } });
  });
});

function config(): RuntimeConfig["billing"] {
  return { provider: "stripe_sandbox", providerAccountKey: "legacy-primary", liveCheckoutEnabled: false,
    stripeSecretKey: "sk_test_sophia", stripeWebhookSecret: "whsec_sophia",
    stripePriceMappings: {}, stripeInitialPriceMappings: {},
    stripeMilestonePriceMappings: { [planVersionId]: { "production-deployment": "price_foundingDeployment123" } },
    stripeMeteredPriceMappings: {}, stripeOveragePriceMappings: {}, stripeMeterBindings: {} };
}

function client() {
  return {
    prices: { retrieve: jest.fn(async () => ({ id: "price_foundingDeployment123", active: true, livemode: false,
      type: "one_time", recurring: null, currency: "aud", unit_amount: 95000, tax_behavior: "exclusive" })) },
    invoices: {
      create: jest.fn(async () => invoice()),
      finalizeInvoice: jest.fn(async () => ({ ...invoice(), status: "open" })),
      retrieve: jest.fn(async () => invoice()),
      listLineItems: jest.fn(async () => ({ has_more: false, data: [] })),
    },
    invoiceItems: { create: jest.fn(async () => ({ id: "ii_milestone_1" })) },
  };
}
function invoice() {
  return { id: "in_milestone_1", livemode: false, status: "draft", customer: "cus_sophia_1",
    metadata: {}, status_transitions: { finalized_at: null } };
}
function input(): BillingCommercialMilestoneInput {
  return { milestoneOutboxId: "outbox-1", acceptanceId: "acceptance-1", planVersionId,
    componentKey: "production-deployment", milestoneKey: "production-deployment",
    providerKey: "stripe-sophia", providerEnvironment: "sandbox", providerAccountKey: "legacy-primary",
    externalCustomerRef: "cus_sophia_1", oneTimePriceRef: "price_foundingDeployment123",
    quantity: "1", unitPriceMinor: "95000", currency: "AUD", payloadDigest: "a".repeat(64) };
}
