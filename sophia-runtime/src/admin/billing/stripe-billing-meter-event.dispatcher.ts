import { Injectable } from "@nestjs/common";
import Stripe from "stripe";
import { runtimeConfig, type RuntimeConfig } from "../../config/runtime-config.js";
import type {
  BillingMeterEventDispatcher,
  BillingMeterEventDispatchResult,
  BillingMeterEventInput,
  BillingMeterEventReconciler,
  BillingMeterEventReconciliationInput,
  BillingMeterEventReconciliationResult,
} from "./billing-meter-event.port.js";
import { STRIPE_BILLING_API_VERSION, STRIPE_BILLING_PROVIDER_KEY } from "./stripe-billing.constants.js";

type MeterEventClient = {
  prices: {
    retrieve(id: string): Promise<Stripe.Price>;
  };
  billing: {
    meterEvents: {
      create(params: Stripe.Billing.MeterEventCreateParams): Promise<Stripe.Billing.MeterEvent>;
    };
    meters: {
      listEventSummaries(
        id: string,
        params: Stripe.Billing.MeterListEventSummariesParams,
      ): Promise<{ data: Stripe.Billing.MeterEventSummary[]; has_more: boolean }>;
    };
  };
  invoices: {
    list(params: Stripe.InvoiceListParams): Promise<{ data: Stripe.Invoice[]; has_more: boolean }>;
    listLineItems(
      id: string,
      params?: Stripe.InvoiceListLineItemsParams,
    ): Promise<{ data: Stripe.InvoiceLineItem[]; has_more: boolean }>;
  };
};

@Injectable()
export class StripeBillingMeterEventDispatcher implements BillingMeterEventDispatcher, BillingMeterEventReconciler {
  private readonly config: RuntimeConfig["billing"];
  private readonly client: MeterEventClient | null;

  constructor(config: RuntimeConfig["billing"] = runtimeConfig().billing, client?: MeterEventClient) {
    this.config = config;
    this.client = client ?? (config.stripeSecretKey
      ? new Stripe(config.stripeSecretKey, { apiVersion: STRIPE_BILLING_API_VERSION, maxNetworkRetries: 0 })
      : null);
  }

  status() {
    const environment = providerEnvironment(this.config.provider);
    const authorized = environment === "sandbox" || (environment === "live" && this.config.liveOverageEnabled);
    const configured = environment !== null && authorized && this.client !== null
      && Object.keys(this.config.stripeMeterBindings).length > 0;
    return {
      availability: configured ? "configured" as const : "disabled" as const,
      detail: configured
        ? `Stripe ${environment} Meter dispatch is configured for approved semantic bindings.`
        : environment === "live" && !this.config.liveOverageEnabled
          ? "Live Stripe Meter dispatch is implemented but the independent live overage switch remains disabled."
          : "Stripe Meter dispatch requires test/live credentials and at least one approved Meter binding.",
    };
  }

  async submit(input: BillingMeterEventInput): Promise<BillingMeterEventDispatchResult> {
    const environment = providerEnvironment(this.config.provider);
    if (!environment || !this.client || this.status().availability !== "configured") {
      return definite(false, "meter_dispatch_disabled", "Stripe Meter dispatch is not fully configured.");
    }
    if (input.providerKey !== STRIPE_BILLING_PROVIDER_KEY || input.providerEnvironment !== environment
      || input.providerAccountKey !== this.config.providerAccountKey || input.quantityUnit !== "whole-minute") {
      return definite(false, "meter_scope_mismatch", "The immutable Meter event does not match this provider adapter scope.");
    }
    const eventName = this.config.stripeMeterBindings[input.meterBindingKey];
    if (!eventName) {
      return definite(false, "meter_binding_unconfigured", "The immutable semantic Meter binding has no approved Stripe event-name mapping.");
    }
    const timestamp = Math.floor(new Date(input.eventTimestamp).getTime() / 1000);
    if (!Number.isSafeInteger(timestamp) || timestamp < 0 || !/^\d+$/.test(input.quantity)) {
      return definite(false, "meter_payload_invalid", "The immutable Meter event timestamp or quantity is invalid.");
    }
    try {
      await this.client.billing.meterEvents.create({
        event_name: eventName,
        identifier: input.submissionIdentifier,
        timestamp,
        payload: { stripe_customer_id: input.externalCustomerRef, value: input.quantity },
      });
      return { outcome: "accepted", providerEventRef: input.submissionIdentifier, acceptedAt: new Date().toISOString() };
    } catch (error) {
      if (isStripeResponseError(error)) {
        const retryable = error.statusCode === 408 || error.statusCode === 409 || error.statusCode === 429
          || (error.statusCode !== undefined && error.statusCode >= 500);
        return definite(retryable, `stripe_http_${error.statusCode ?? "error"}`, safeMessage(error.message));
      }
      return { outcome: "unknown", code: "stripe_transport_unknown",
        detail: "Stripe Meter submission ended without an authoritative provider response; reconciliation is required." };
    }
  }

  async reconcile(input: BillingMeterEventReconciliationInput): Promise<BillingMeterEventReconciliationResult> {
    const environment = providerEnvironment(this.config.provider);
    if (!environment || !this.client || input.providerKey !== STRIPE_BILLING_PROVIDER_KEY
      || input.providerEnvironment !== environment || input.providerAccountKey !== this.config.providerAccountKey) {
      return mismatch("The immutable reconciliation scope does not match this Stripe adapter.");
    }
    const eventName = this.config.stripeMeterBindings[input.meterBindingKey];
    const meteredPriceId = this.config.stripeMeteredPriceMappings[input.planVersionId];
    if (!eventName || !meteredPriceId) {
      return mismatch("The plan has no approved Stripe Meter event and metered Price mapping.");
    }
    const periodStart = unixSecond(input.periodStart);
    const periodEnd = unixSecond(input.periodEnd);
    const summaryStart = periodStart === null ? null : ceilUnixMinute(periodStart);
    const summaryEnd = periodEnd === null ? null : ceilUnixMinute(periodEnd);
    if (periodStart === null || periodEnd === null || periodEnd <= periodStart
      || summaryStart === null || summaryEnd === null || summaryEnd <= summaryStart || !/^\d+$/.test(input.quantity)
      || !/^\d+$/.test(input.unitPriceMinor)) {
      return mismatch("The immutable reconciliation period or commercial quantity is invalid.");
    }
    try {
      const price = await this.client.prices.retrieve(meteredPriceId);
      const meterRef = typeof price.recurring?.meter === "string" ? price.recurring.meter : null;
      if (price.livemode !== (environment === "live") || !price.active || price.currency.toUpperCase() !== input.currency
        || price.unit_amount?.toString() !== input.unitPriceMinor || price.recurring?.usage_type !== "metered" || !meterRef) {
        return mismatch("The configured Stripe metered Price no longer matches the immutable plan rate.");
      }
      const summaries = await this.client.billing.meters.listEventSummaries(meterRef, {
        customer: input.externalCustomerRef, start_time: summaryStart, end_time: summaryEnd, limit: 100,
      });
      if (summaries.has_more) return mismatch("The Meter summary exceeded the bounded reconciliation response.");
      const matchingSummaries = summaries.data.filter((summary) => summary.meter === meterRef
        && summary.start_time === summaryStart && summary.end_time === summaryEnd
        && summary.livemode === (environment === "live"));
      if (matchingSummaries.length === 0) {
        return { outcome: "pending", detail: "Stripe has not produced the exact period Meter summary yet." };
      }
      if (matchingSummaries.length !== 1) return mismatch("Stripe returned ambiguous exact-period Meter summaries.");
      const summary = matchingSummaries[0];
      if (!Number.isSafeInteger(summary.aggregated_value)
        || summary.aggregated_value.toString() !== input.quantity) {
        return mismatch("The Stripe Meter summary quantity differs from the immutable Sophia ledger.");
      }
      const invoices = await this.client.invoices.list({ customer: input.externalCustomerRef, limit: 100 });
      if (invoices.has_more) return mismatch("The invoice search exceeded the bounded reconciliation response.");
      const lineMatches: Array<{ invoice: Stripe.Invoice; line: Stripe.InvoiceLineItem }> = [];
      for (const invoice of invoices.data.filter((item) => item.status === "open" || item.status === "paid")) {
        if (!invoice.id) return mismatch("Stripe returned a finalized invoice without a stable identity.");
        const lines = await this.client.invoices.listLineItems(invoice.id, { limit: 100 });
        if (lines.has_more) return mismatch(`Invoice ${invoice.id} exceeded the bounded line-item response.`);
        for (const line of lines.data) {
          if (line.pricing?.price_details?.price === meteredPriceId
            && line.period.start === periodStart && line.period.end === periodEnd) lineMatches.push({ invoice, line });
        }
      }
      if (lineMatches.length === 0) {
        return { outcome: "pending", detail: "Stripe has not produced a finalized exact-period metered invoice line yet." };
      }
      if (lineMatches.length !== 1) return mismatch("Stripe returned ambiguous exact-period metered invoice lines.");
      const { invoice, line } = lineMatches[0];
      if (!invoice.id || line.quantity === null) {
        return mismatch("The Stripe metered invoice line has no stable invoice identity or quantity.");
      }
      const expectedAmount = BigInt(input.quantity) * BigInt(input.unitPriceMinor);
      if (!Number.isSafeInteger(line.quantity) || line.quantity.toString() !== input.quantity
        || BigInt(line.amount) !== expectedAmount || line.currency.toUpperCase() !== input.currency
        || line.livemode !== (environment === "live")) {
        return mismatch("The Stripe metered invoice line differs from the immutable Sophia quantity or rate.");
      }
      const observedAt = new Date().toISOString();
      return { outcome: "matched", evidence: {
        providerEventRef: input.submissionIdentifier,
        meterRef,
        meterSummaryRef: summary.id,
        meterSummaryStart: new Date(summary.start_time * 1000).toISOString(),
        meterSummaryEnd: new Date(summary.end_time * 1000).toISOString(),
        meterSummaryQuantity: summary.aggregated_value.toString(),
        invoiceRef: invoice.id,
        invoiceLineRef: line.id,
        meteredPriceRef: meteredPriceId,
        invoiceLineQuantity: line.quantity.toString(),
        invoiceLineAmountMinor: line.amount.toString(),
        currency: line.currency.toUpperCase(),
        observedAt,
      } };
    } catch (error) {
      if (isStripeResponseError(error) && error.statusCode !== undefined && error.statusCode >= 400
        && error.statusCode < 500 && error.statusCode !== 408 && error.statusCode !== 409 && error.statusCode !== 429) {
        return mismatch(`Stripe rejected reconciliation: ${safeMessage(error.message)}`);
      }
      return { outcome: "pending", detail: "Stripe reconciliation is temporarily unavailable or not yet consistent." };
    }
  }
}

function providerEnvironment(provider: RuntimeConfig["billing"]["provider"]): "sandbox" | "live" | null {
  if (provider === "stripe_sandbox") return "sandbox";
  if (provider === "stripe_live") return "live";
  return null;
}

function definite(retryable: boolean, code: string, detail: string): BillingMeterEventDispatchResult {
  return { outcome: "definite_failure", retryable, code, detail };
}

function mismatch(detail: string): BillingMeterEventReconciliationResult {
  return { outcome: "mismatch", detail };
}

function unixSecond(value: string): number | null {
  const milliseconds = Date.parse(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds % 1_000 !== 0) return null;
  return milliseconds / 1000;
}

function ceilUnixMinute(seconds: number): number {
  return Math.ceil(seconds / 60) * 60;
}

function isStripeResponseError(error: unknown): error is { statusCode?: number; message: string } {
  return Boolean(error && typeof error === "object" && "message" in error
    && ("statusCode" in error || "type" in error));
}

function safeMessage(value: string) { return value.slice(0, 500) || "Stripe rejected the Meter event."; }
