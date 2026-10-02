import { Injectable } from "@nestjs/common";
import Stripe from "stripe";
import { runtimeConfig, type RuntimeConfig } from "../../config/runtime-config.js";
import type {
  BillingInvoiceAdjustmentDispatcher,
  BillingInvoiceAdjustmentDispatchResult,
  BillingInvoiceAdjustmentInput,
  BillingInvoiceAdjustmentReconciliationResult,
} from "./billing-invoice-adjustment.port.js";
import { STRIPE_BILLING_API_VERSION, STRIPE_BILLING_PROVIDER_KEY } from "./stripe-billing.constants.js";

type AdjustmentClient = {
  prices: { retrieve(id: string): Promise<Stripe.Price> };
  invoices: {
    retrieve(id: string): Promise<Stripe.Invoice>;
    listLineItems(id: string, params: { limit: number }): Promise<{ data: Stripe.InvoiceLineItem[]; has_more: boolean }>;
  };
  invoiceItems: {
    create(params: Stripe.InvoiceItemCreateParams, options?: Stripe.RequestOptions): Promise<Stripe.InvoiceItem>;
  };
};

@Injectable()
export class StripeBillingInvoiceAdjustmentDispatcher implements BillingInvoiceAdjustmentDispatcher {
  private readonly config: RuntimeConfig["billing"];
  private readonly client: AdjustmentClient | null;

  constructor(config: RuntimeConfig["billing"] = runtimeConfig().billing, client?: AdjustmentClient) {
    this.config = config;
    this.client = client ?? (config.stripeSecretKey
      ? new Stripe(config.stripeSecretKey, { apiVersion: STRIPE_BILLING_API_VERSION, maxNetworkRetries: 0 })
      : null);
  }

  status() {
    const configured = this.config.provider === "stripe_sandbox" && this.client !== null
      && Object.keys(this.config.stripeOveragePriceMappings).length > 0;
    return { availability: configured ? "configured" as const : "disabled" as const,
      detail: configured
        ? "Stripe sandbox draft-invoice adjustment is configured for approved one-time Prices."
        : "Draft-invoice adjustment remains sandbox-only and requires an approved one-time overage Price mapping." };
  }

  async submit(input: BillingInvoiceAdjustmentInput): Promise<BillingInvoiceAdjustmentDispatchResult> {
    if (this.status().availability !== "configured" || !this.client
      || input.providerKey !== STRIPE_BILLING_PROVIDER_KEY || input.providerEnvironment !== "sandbox"
      || input.providerAccountKey !== this.config.providerAccountKey
      || this.config.stripeOveragePriceMappings[input.planVersionId] !== input.oneTimePriceRef) {
      return failure(false, "invoice_adjustment_scope_mismatch",
        "The immutable invoice adjustment does not match the configured sandbox adapter scope.");
    }
    const quantity = safePositiveInteger(input.quantity);
    const unitAmount = safePositiveInteger(input.unitPriceMinor);
    const periodStart = unixSecond(input.periodStart);
    const exclusivePeriodEnd = unixSecond(input.periodEnd);
    if (quantity === null || unitAmount === null || periodStart === null || exclusivePeriodEnd === null
      || exclusivePeriodEnd <= periodStart || input.currency !== input.currency.toUpperCase()) {
      return failure(false, "invoice_adjustment_invalid", "The immutable invoice adjustment is invalid.");
    }
    try {
      const [price, invoice] = await Promise.all([
        this.client.prices.retrieve(input.oneTimePriceRef),
        this.client.invoices.retrieve(input.externalInvoiceRef),
      ]);
      const subscriptionRef = invoiceSubscriptionRef(invoice);
      if (!price.active || price.livemode || price.type !== "one_time" || price.recurring !== null
        || price.currency.toUpperCase() !== input.currency || price.unit_amount !== unitAmount
        || price.tax_behavior !== "exclusive") {
        return failure(false, "invoice_adjustment_price_mismatch",
          "The approved one-time overage Price no longer matches the immutable rate.");
      }
      if (invoice.livemode || invoice.status !== "draft" || reference(invoice.customer) !== input.externalCustomerRef
        || subscriptionRef !== input.externalSubscriptionRef || invoice.period_start !== periodStart
        || invoice.period_end !== exclusivePeriodEnd) {
        return failure(false, "invoice_adjustment_window_missed",
          "The target renewal invoice is not the exact open draft for this immutable provider period.");
      }
      const item = await this.client.invoiceItems.create({
        customer: input.externalCustomerRef,
        invoice: input.externalInvoiceRef,
        subscription: input.externalSubscriptionRef,
        pricing: { price: input.oneTimePriceRef },
        quantity,
        discountable: false,
        period: { start: periodStart, end: exclusivePeriodEnd - 1 },
        metadata: {
          sophiaNamespace: "subscription-v1",
          sophiaBillingAdjustmentId: input.adjustmentId,
          sophiaUsageLedgerId: input.ledgerId,
          sophiaProviderAccountKey: input.providerAccountKey,
        },
      }, { idempotencyKey: `sophia:sandbox:${input.providerAccountKey}:invoice-adjustment:${input.adjustmentId}` });
      return { outcome: "accepted", providerInvoiceItemRef: item.id, acceptedAt: new Date().toISOString() };
    } catch (error) {
      if (isStripeResponseError(error)) {
        const retryable = error.statusCode === 408 || error.statusCode === 409 || error.statusCode === 429
          || (error.statusCode !== undefined && error.statusCode >= 500);
        return failure(retryable, `stripe_http_${error.statusCode ?? "error"}`, safeMessage(error.message));
      }
      return { outcome: "unknown", code: "stripe_transport_unknown",
        detail: "Stripe invoice-item submission ended without an authoritative provider response; reconciliation is required." };
    }
  }

  async reconcile(input: BillingInvoiceAdjustmentInput): Promise<BillingInvoiceAdjustmentReconciliationResult> {
    if (this.status().availability !== "configured" || !this.client
      || input.providerKey !== STRIPE_BILLING_PROVIDER_KEY || input.providerEnvironment !== "sandbox"
      || input.providerAccountKey !== this.config.providerAccountKey
      || this.config.stripeOveragePriceMappings[input.planVersionId] !== input.oneTimePriceRef) {
      return { outcome: "mismatch", detail: "The reconciliation request does not match the configured sandbox scope." };
    }
    const quantity = safePositiveInteger(input.quantity);
    const unitAmount = safePositiveInteger(input.unitPriceMinor);
    const periodStart = unixSecond(input.periodStart);
    const exclusivePeriodEnd = unixSecond(input.periodEnd);
    if (quantity === null || unitAmount === null || periodStart === null || exclusivePeriodEnd === null) {
      return { outcome: "mismatch", detail: "The immutable reconciliation payload is invalid." };
    }
    try {
      const [invoice, lines] = await Promise.all([
        this.client.invoices.retrieve(input.externalInvoiceRef),
        this.client.invoices.listLineItems(input.externalInvoiceRef, { limit: 100 }),
      ]);
      if (invoice.status === "draft") {
        return { outcome: "pending", detail: "The exact invoice is still draft." };
      }
      if (invoice.livemode || !invoice.status_transitions?.finalized_at || lines.has_more
        || reference(invoice.customer) !== input.externalCustomerRef
        || invoiceSubscriptionRef(invoice) !== input.externalSubscriptionRef
        || invoice.period_start !== periodStart || invoice.period_end !== exclusivePeriodEnd) {
        return { outcome: "mismatch", detail: "The finalized invoice identity, period, or complete line set does not match." };
      }
      const candidates = lines.data.filter((line) => line.metadata.sophiaBillingAdjustmentId === input.adjustmentId);
      if (candidates.length !== 1) {
        return { outcome: "mismatch", detail: "The finalized invoice does not contain exactly one Sophia adjustment line." };
      }
      const line = candidates[0];
      const priceRef = line.pricing?.price_details?.price ?? null;
      const invoiceItemDetails = line.parent?.type === "invoice_item_details"
        ? line.parent.invoice_item_details : null;
      const providerInvoiceItemRef = invoiceItemDetails?.invoice_item ?? null;
      const lineSubscriptionRef = invoiceItemDetails?.subscription ?? reference(line.subscription);
      const amount = quantity * unitAmount;
      if (!Number.isSafeInteger(amount) || !providerInvoiceItemRef
        || line.metadata.sophiaUsageLedgerId !== input.ledgerId
        || line.invoice !== input.externalInvoiceRef || line.livemode
        || lineSubscriptionRef !== input.externalSubscriptionRef
        || priceRef !== input.oneTimePriceRef || line.quantity !== quantity || line.amount !== amount
        || line.currency.toUpperCase() !== input.currency
        || !sameIntegerDecimal(line.pricing?.unit_amount_decimal, unitAmount)
        || line.period.start !== periodStart || line.period.end !== exclusivePeriodEnd - 1) {
        return { outcome: "mismatch", detail: "The finalized Sophia adjustment line does not match immutable ledger values." };
      }
      return { outcome: "matched", evidence: { providerInvoiceItemRef, providerInvoiceLineRef: line.id,
        oneTimePriceRef: priceRef, periodStart: input.periodStart, periodEnd: input.periodEnd,
        quantity: input.quantity, unitPriceMinor: input.unitPriceMinor, amountMinor: String(amount),
        currency: input.currency, invoiceStatus: invoice.status ?? "unknown", observedAt: new Date().toISOString() } };
    } catch {
      return { outcome: "pending", detail: "Stripe adjustment evidence is temporarily unavailable." };
    }
  }
}

function failure(retryable: boolean, code: string, detail: string): BillingInvoiceAdjustmentDispatchResult {
  return { outcome: "definite_failure", retryable, code, detail };
}
function safePositiveInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
function unixSecond(value: string): number | null {
  const milliseconds = Date.parse(value);
  return Number.isSafeInteger(milliseconds) && milliseconds >= 0 && milliseconds % 1_000 === 0
    ? milliseconds / 1_000 : null;
}
function sameIntegerDecimal(value: string | null | undefined, expected: number): boolean {
  return typeof value === "string" && /^\d+(?:\.0+)?$/.test(value) && Number(value) === expected;
}
function reference(value: string | { id: string } | null): string | null {
  return typeof value === "string" ? value : value?.id ?? null;
}
function invoiceSubscriptionRef(invoice: Stripe.Invoice): string | null {
  return reference(invoice.parent?.subscription_details?.subscription ?? null);
}
function isStripeResponseError(error: unknown): error is { statusCode?: number; message: string } {
  return Boolean(error && typeof error === "object" && "message" in error
    && ("statusCode" in error || "type" in error));
}
function safeMessage(value: string) { return value.slice(0, 500) || "Stripe rejected the invoice adjustment."; }
