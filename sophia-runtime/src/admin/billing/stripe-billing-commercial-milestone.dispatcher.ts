import { Injectable } from "@nestjs/common";
import Stripe from "stripe";
import { runtimeConfig, type RuntimeConfig } from "../../config/runtime-config.js";
import type {
  BillingCommercialMilestoneDispatcher,
  BillingCommercialMilestoneDispatchResult,
  BillingCommercialMilestoneInput,
  BillingCommercialMilestoneReconciliationResult,
} from "./billing-commercial-milestone.port.js";
import { STRIPE_BILLING_API_VERSION, STRIPE_BILLING_PROVIDER_KEY } from "./stripe-billing.constants.js";

type MilestoneClient = {
  prices: { retrieve(id: string): Promise<Stripe.Price> };
  invoices: {
    create(params: Stripe.InvoiceCreateParams, options?: Stripe.RequestOptions): Promise<Stripe.Invoice>;
    finalizeInvoice(id: string, params?: Stripe.InvoiceFinalizeInvoiceParams, options?: Stripe.RequestOptions): Promise<Stripe.Invoice>;
    retrieve(id: string): Promise<Stripe.Invoice>;
    listLineItems(id: string, params: { limit: number }): Promise<{ data: Stripe.InvoiceLineItem[]; has_more: boolean }>;
  };
  invoiceItems: { create(params: Stripe.InvoiceItemCreateParams, options?: Stripe.RequestOptions): Promise<Stripe.InvoiceItem> };
};

@Injectable()
export class StripeBillingCommercialMilestoneDispatcher implements BillingCommercialMilestoneDispatcher {
  private readonly client: MilestoneClient | null;
  constructor(private readonly config: RuntimeConfig["billing"] = runtimeConfig().billing, client?: MilestoneClient) {
    this.client = client ?? (config.stripeSecretKey
      ? new Stripe(config.stripeSecretKey, { apiVersion: STRIPE_BILLING_API_VERSION, maxNetworkRetries: 0 }) : null);
  }

  status() {
    const environment = providerEnvironment(this.config.provider);
    const authorized = environment === "sandbox" || (environment === "live" && this.config.liveMilestoneEnabled);
    const configured = environment !== null && authorized && this.client !== null
      && Object.keys(this.config.stripeMilestonePriceMappings).length > 0;
    return { availability: configured ? "configured" as const : "disabled" as const,
      detail: configured ? `Stripe ${environment} commercial milestone invoicing is configured.`
        : environment === "live" && !this.config.liveMilestoneEnabled
          ? "Live commercial milestone invoicing is implemented but its independent collection switch remains disabled."
          : "Commercial milestone invoicing requires an approved environment, credential, and milestone Price mapping." };
  }

  async submit(input: BillingCommercialMilestoneInput): Promise<BillingCommercialMilestoneDispatchResult> {
    if (!this.inScope(input, true) || !this.client) return failure(false, "commercial_milestone_scope_mismatch",
      "The immutable commercial milestone does not match the configured sandbox adapter scope.");
    const amount = positiveInteger(input.unitPriceMinor);
    if (amount === null || input.quantity !== "1" || input.currency !== input.currency.toUpperCase()) {
      return failure(false, "commercial_milestone_invalid", "The immutable commercial milestone payload is invalid.");
    }
    try {
      const price = await this.client.prices.retrieve(input.oneTimePriceRef);
      const live = input.providerEnvironment === "live";
      if (!price.active || price.livemode !== live || price.type !== "one_time" || price.recurring !== null
        || price.currency.toUpperCase() !== input.currency || price.unit_amount !== amount
        || price.tax_behavior !== "exclusive") {
        return failure(false, "commercial_milestone_price_mismatch",
          "The approved milestone Price no longer matches the immutable commercial obligation.");
      }
      const metadata = { sophiaNamespace: "subscription-v1", sophiaCommercialMilestoneOutboxId: input.milestoneOutboxId,
        sophiaCommercialMilestoneAcceptanceId: input.acceptanceId, sophiaCommercialMilestoneKey: input.milestoneKey,
        sophiaProviderAccountKey: input.providerAccountKey };
      const invoice = await this.client.invoices.create({ customer: input.externalCustomerRef, auto_advance: false,
        collection_method: "charge_automatically", metadata,
        description: `Sophia commercial milestone: ${input.milestoneKey}` },
      { idempotencyKey: `sophia:${input.providerEnvironment}:${input.providerAccountKey}:milestone-invoice:${input.milestoneOutboxId}` });
      const invoiceId = invoice.id;
      if (!invoiceId || invoice.livemode !== live || reference(invoice.customer) !== input.externalCustomerRef || invoice.status !== "draft") {
        return failure(false, "commercial_milestone_invoice_mismatch", "Stripe did not return the exact environment-matched draft invoice.");
      }
      const item = await this.client.invoiceItems.create({ customer: input.externalCustomerRef, invoice: invoiceId,
        pricing: { price: input.oneTimePriceRef }, quantity: 1, discountable: false, metadata },
      { idempotencyKey: `sophia:${input.providerEnvironment}:${input.providerAccountKey}:milestone-item:${input.milestoneOutboxId}` });
      const finalized = await this.client.invoices.finalizeInvoice(invoiceId, {},
        { idempotencyKey: `sophia:${input.providerEnvironment}:${input.providerAccountKey}:milestone-finalize:${input.milestoneOutboxId}` });
      if (finalized.livemode !== live || finalized.status === "draft") {
        return { outcome: "unknown", code: "commercial_milestone_finalize_unknown",
          detail: "Stripe did not provide authoritative finalized milestone invoice evidence." };
      }
      return { outcome: "accepted", externalInvoiceRef: invoiceId, providerInvoiceItemRef: item.id,
        acceptedAt: new Date().toISOString() };
    } catch (error) {
      if (isStripeResponseError(error)) {
        const retryable = error.statusCode === 408 || error.statusCode === 409 || error.statusCode === 429
          || (error.statusCode !== undefined && error.statusCode >= 500);
        return failure(retryable, `stripe_http_${error.statusCode ?? "error"}`, safeMessage(error.message));
      }
      return { outcome: "unknown", code: "stripe_transport_unknown",
        detail: "Stripe milestone invoicing ended without an authoritative provider response; reconciliation is required." };
    }
  }

  async reconcile(input: BillingCommercialMilestoneInput & { externalInvoiceRef: string; providerInvoiceItemRef: string }):
    Promise<BillingCommercialMilestoneReconciliationResult> {
    if (!this.inScope(input, false) || !this.client) return { outcome: "mismatch",
      detail: "The milestone reconciliation does not match the configured sandbox adapter scope." };
    try {
      const [invoice, lines] = await Promise.all([this.client.invoices.retrieve(input.externalInvoiceRef),
        this.client.invoices.listLineItems(input.externalInvoiceRef, { limit: 100 })]);
      if (invoice.status === "draft") return { outcome: "pending", detail: "The exact milestone invoice is still draft." };
      const live = input.providerEnvironment === "live";
      if (invoice.livemode !== live || !invoice.status_transitions?.finalized_at || lines.has_more
        || reference(invoice.customer) !== input.externalCustomerRef
        || invoice.metadata?.sophiaCommercialMilestoneOutboxId !== input.milestoneOutboxId) {
        return { outcome: "mismatch", detail: "The finalized milestone invoice identity or complete line set does not match." };
      }
      const candidates = lines.data.filter((line) =>
        line.metadata.sophiaCommercialMilestoneOutboxId === input.milestoneOutboxId);
      if (candidates.length !== 1) return { outcome: "mismatch",
        detail: "The finalized invoice does not contain exactly one Sophia milestone line." };
      const line = candidates[0];
      const itemDetails = line.parent?.type === "invoice_item_details" ? line.parent.invoice_item_details : null;
      const itemRef = itemDetails?.invoice_item ?? null;
      const priceRef = line.pricing?.price_details?.price ?? null;
      const amount = positiveInteger(input.unitPriceMinor);
      if (!itemRef || itemRef !== input.providerInvoiceItemRef || amount === null
        || line.invoice !== input.externalInvoiceRef || line.livemode !== live
        || priceRef !== input.oneTimePriceRef || line.quantity !== 1 || line.amount !== amount
        || line.currency.toUpperCase() !== input.currency) {
        return { outcome: "mismatch", detail: "The finalized Sophia milestone line does not match immutable values." };
      }
      return { outcome: "matched", evidence: { externalInvoiceRef: input.externalInvoiceRef,
        providerInvoiceItemRef: itemRef, providerInvoiceLineRef: line.id, oneTimePriceRef: priceRef,
        quantity: "1", unitPriceMinor: input.unitPriceMinor, amountMinor: String(amount), currency: input.currency,
        invoiceStatus: invoice.status ?? "unknown", observedAt: new Date().toISOString() } };
    } catch {
      return { outcome: "pending", detail: "Stripe milestone evidence is temporarily unavailable." };
    }
  }

  private inScope(input: BillingCommercialMilestoneInput, requireCollection: boolean) {
    const environment = providerEnvironment(this.config.provider);
    return (!requireCollection || this.status().availability === "configured") && this.client !== null
      && environment !== null
      && input.providerKey === STRIPE_BILLING_PROVIDER_KEY
      && input.providerEnvironment === environment && input.providerAccountKey === this.config.providerAccountKey
      && this.config.stripeMilestonePriceMappings[input.planVersionId]?.[input.componentKey] === input.oneTimePriceRef;
  }
}

function failure(retryable: boolean, code: string, detail: string): BillingCommercialMilestoneDispatchResult {
  return { outcome: "definite_failure", retryable, code, detail };
}
function positiveInteger(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value); return Number.isSafeInteger(parsed) ? parsed : null;
}
function reference(value: string | { id: string } | null): string | null {
  return typeof value === "string" ? value : value?.id ?? null;
}
function isStripeResponseError(error: unknown): error is { statusCode?: number; message: string } {
  return Boolean(error && typeof error === "object" && "message" in error && ("statusCode" in error || "type" in error));
}
function safeMessage(value: string) { return value.slice(0, 500) || "Stripe rejected the milestone invoice."; }
function providerEnvironment(provider: RuntimeConfig["billing"]["provider"]): "sandbox" | "live" | null {
  return provider === "stripe_sandbox" ? "sandbox" : provider === "stripe_live" ? "live" : null;
}
