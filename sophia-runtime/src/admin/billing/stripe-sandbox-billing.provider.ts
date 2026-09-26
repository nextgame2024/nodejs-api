import { createHash } from "node:crypto";
import { Injectable, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import Stripe from "stripe";
import { z } from "zod";
import { runtimeConfig, type RuntimeConfig } from "../../config/runtime-config.js";
import type {
  BillingInvoiceObservation,
  BillingProvider,
  BillingProviderStatus,
  BillingReconciliation,
  BillingSubscriptionObservation,
  BillingWebhookEvidence,
} from "./billing-provider.port.js";

type StripeClient = {
  checkout: { sessions: { create(params: Stripe.Checkout.SessionCreateParams, options?: Stripe.RequestOptions): Promise<Stripe.Checkout.Session> } };
  billingPortal: { sessions: { create(params: Stripe.BillingPortal.SessionCreateParams, options?: Stripe.RequestOptions): Promise<Stripe.BillingPortal.Session> } };
  webhooks: { constructEvent(payload: Buffer, signature: string | string[], secret: string): Stripe.Event };
  subscriptions: { list(params: Stripe.SubscriptionListParams): Promise<Stripe.ApiList<Stripe.Subscription>> };
  invoices: { list(params: Stripe.InvoiceListParams): Promise<Stripe.ApiList<Stripe.Invoice>> };
  prices: { retrieve(id: string): Promise<Stripe.Price> };
};

const eventSchema = z.object({
  id: z.string().min(1).max(240), type: z.string().min(1).max(160), created: z.number().int().nonnegative(),
  livemode: z.boolean(), data: z.object({ object: z.record(z.string(), z.unknown()) }),
});
const uuid = z.string().uuid();

@Injectable()
export class StripeSandboxBillingProvider implements BillingProvider {
  private readonly config: RuntimeConfig["billing"];
  private readonly client: StripeClient | null;

  constructor(config: RuntimeConfig["billing"] = runtimeConfig().billing, client?: StripeClient) {
    this.config = config;
    this.client = client ?? (config.stripeSecretKey
      ? new Stripe(config.stripeSecretKey, { apiVersion: "2025-08-27.basil", maxNetworkRetries: 2 }) : null);
  }

  status(): BillingProviderStatus {
    const missing = this.missingConfiguration();
    const available = this.config.provider === "stripe_sandbox" && missing.length === 0;
    return {
      availability: available ? "sandbox" : "disabled",
      providerKey: "stripe-sophia",
      checkout: available,
      portal: available,
      signedWebhooks: available,
      reconciliation: available,
      missingConfiguration: missing,
      detail: available
        ? "Dedicated Stripe test-mode subscription adapter is configured. It cannot create live charges or alter platform plan assignments."
        : "Stripe sandbox adapter is dormant until every dedicated Sophia test credential, recurring Price mapping and hosted return URL is configured.",
    };
  }

  mappedPlanVersionIds(): ReadonlySet<string> { return new Set(Object.keys(this.config.stripePriceMappings)); }

  async createHostedCheckout(input: { tenantId: string; planVersionId: string; requestId: string; customerRef: string | null;
    commercial: { currency: string; interval: "month" | "year"; baseChargeMinor: string } }) {
    const client = this.availableClient();
    const price = this.config.stripePriceMappings[input.planVersionId];
    if (!price) throw unavailable("The assigned Sophia plan has no approved Stripe sandbox Price mapping.");
    const providerPrice = await client.prices.retrieve(price);
    if (providerPrice.livemode || !providerPrice.active || providerPrice.type !== "recurring"
      || providerPrice.currency.toUpperCase() !== input.commercial.currency
      || providerPrice.unit_amount === null || String(providerPrice.unit_amount) !== input.commercial.baseChargeMinor
      || providerPrice.recurring?.interval !== input.commercial.interval) {
      throw unavailable("The Stripe sandbox Price does not exactly match the approved fixed recurring plan currency, amount and interval.");
    }
    const session = await client.checkout.sessions.create({
      mode: "subscription",
      ui_mode: "hosted",
      client_reference_id: input.tenantId,
      ...(input.customerRef ? { customer: input.customerRef } : {}),
      line_items: [{ price, quantity: 1 }],
      success_url: this.config.checkoutSuccessUrl!, cancel_url: this.config.checkoutCancelUrl!,
      metadata: metadata(input.tenantId, input.planVersionId),
      subscription_data: { metadata: metadata(input.tenantId, input.planVersionId) },
    }, { idempotencyKey: `sophia:checkout:${input.tenantId}:${input.planVersionId}:${input.requestId}` });
    return { url: hostedProviderUrl(session.url, "checkout.stripe.com"),
      expiresAt: session.expires_at ? secondsIso(session.expires_at) : null, externalCheckoutRef: session.id };
  }

  async createHostedPortal(input: { tenantId: string; requestId: string; customerRef: string }) {
    const client = this.availableClient();
    const session = await client.billingPortal.sessions.create({
      customer: input.customerRef, configuration: this.config.stripePortalConfigurationId,
      return_url: this.config.portalReturnUrl!,
    }, { idempotencyKey: `sophia:portal:${input.tenantId}:${input.requestId}` });
    return { url: hostedProviderUrl(session.url, "billing.stripe.com"), expiresAt: null };
  }

  async verifyWebhook(headers: Readonly<Record<string, string | undefined>>, rawBody: Uint8Array): Promise<BillingWebhookEvidence> {
    const client = this.availableClient();
    const signature = headers["stripe-signature"];
    if (!signature) throw new UnauthorizedException("Stripe webhook signature is required.");
    let constructed: Stripe.Event;
    try { constructed = client.webhooks.constructEvent(Buffer.from(rawBody), signature, this.config.stripeWebhookSecret!); }
    catch { throw new UnauthorizedException("Stripe webhook signature verification failed."); }
    const event = eventSchema.parse(constructed);
    if (event.livemode) throw new UnauthorizedException("Live Stripe events are rejected by the sandbox adapter.");
    const object = event.data.object;
    const metadataValue = record(object.metadata);
    const occurredAt = secondsIso(event.created);
    const customerRef = reference(object.customer);
    const subscription = subscriptionObservation(event.type, object, occurredAt);
    const invoice = invoiceObservation(event.type, object, occurredAt);
    return {
      providerKey: "stripe-sophia", environment: "sandbox", eventId: event.id, eventType: event.type,
      occurredAt, payloadDigest: createHash("sha256").update(rawBody).digest("hex"), customerRef,
      checkoutRef: event.type === "checkout.session.completed" ? reference(object.id) : null,
      tenantHint: metadataValue?.sophiaNamespace === "subscription-v1" && uuid.safeParse(metadataValue.sophiaTenantId).success
        ? String(metadataValue.sophiaTenantId) : null,
      planVersionHint: metadataValue?.sophiaNamespace === "subscription-v1" && uuid.safeParse(metadataValue.sophiaPlanVersionId).success
        ? String(metadataValue.sophiaPlanVersionId) : null,
      subscription, invoice,
    };
  }

  async reconcileTenant(input: { tenantId: string; customerRef: string }): Promise<BillingReconciliation> {
    const client = this.availableClient(); const observedAt = new Date().toISOString();
    const [subscriptions, invoices] = await Promise.all([
      client.subscriptions.list({ customer: input.customerRef, status: "all", limit: 100 }),
      client.invoices.list({ customer: input.customerRef, limit: 100 }),
    ]);
    return {
      status: subscriptions.has_more || invoices.has_more ? "incomplete" : "reconciled", observedAt,
      subscriptions: subscriptions.data.map((item) => subscriptionFromStripe(item, observedAt)),
      invoices: invoices.data.map((item) => invoiceFromStripe(item, observedAt)),
    };
  }

  private availableClient(): StripeClient {
    if (this.status().availability !== "sandbox" || !this.client) throw unavailable("Sophia Stripe sandbox billing is not fully configured.");
    return this.client;
  }

  private missingConfiguration(): string[] {
    const missing: string[] = [];
    if (this.config.provider !== "stripe_sandbox") missing.push("provider");
    if (!this.config.stripeSecretKey) missing.push("testSecretKey");
    if (!this.config.stripeWebhookSecret) missing.push("webhookSigningSecret");
    if (!this.config.stripePortalConfigurationId) missing.push("portalConfigurationId");
    if (!this.config.checkoutSuccessUrl) missing.push("checkoutSuccessUrl");
    if (!this.config.checkoutCancelUrl) missing.push("checkoutCancelUrl");
    if (!this.config.portalReturnUrl) missing.push("portalReturnUrl");
    if (Object.keys(this.config.stripePriceMappings).length === 0) missing.push("recurringPriceMappings");
    return missing;
  }
}

function metadata(tenantId: string, planVersionId: string) {
  return { sophiaNamespace: "subscription-v1", sophiaTenantId: tenantId, sophiaPlanVersionId: planVersionId };
}
function unavailable(message: string) { return new ServiceUnavailableException(message); }
function hostedProviderUrl(value: string | null, expectedHost: string): string {
  if (!value) throw unavailable("Stripe did not return a hosted URL.");
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.hostname !== expectedHost) {
    throw unavailable("Stripe returned an unexpected hosted URL origin.");
  }
  return parsed.toString();
}
function secondsIso(value: number) { return new Date(value * 1000).toISOString(); }
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function reference(value: unknown): string | null {
  if (typeof value === "string" && value.length <= 240) return value;
  const object = record(value); return typeof object?.id === "string" ? object.id.slice(0, 240) : null;
}
function subscriptionObservation(type: string, object: Record<string, unknown>, observedAt: string): BillingSubscriptionObservation | null {
  if (type === "checkout.session.completed") {
    const externalRef = reference(object.subscription); return externalRef
      ? { externalRef, status: "pending", currentPeriodStart: null, currentPeriodEnd: null, observedAt } : null;
  }
  if (!type.startsWith("customer.subscription.")) return null;
  return subscriptionFromObject(object, observedAt);
}
function subscriptionFromStripe(value: Stripe.Subscription, observedAt: string) {
  return subscriptionFromObject(value as unknown as Record<string, unknown>, observedAt);
}
function subscriptionFromObject(object: Record<string, unknown>, observedAt: string): BillingSubscriptionObservation {
  const firstItem = Array.isArray(record(object.items)?.data) ? (record(object.items)?.data as unknown[])[0] : null;
  const item = record(firstItem);
  return {
    externalRef: String(object.id), status: subscriptionStatus(object.status),
    currentPeriodStart: timestamp(object.current_period_start ?? item?.current_period_start),
    currentPeriodEnd: timestamp(object.current_period_end ?? item?.current_period_end), observedAt,
  };
}
function subscriptionStatus(value: unknown): BillingSubscriptionObservation["status"] {
  if (value === "trialing" || value === "active" || value === "past_due" || value === "paused") return value;
  if (value === "canceled") return "cancelled";
  if (value === "incomplete") return "pending";
  if (value === "incomplete_expired" || value === "unpaid") return "past_due";
  return "unknown";
}
function invoiceObservation(type: string, object: Record<string, unknown>, observedAt: string): BillingInvoiceObservation | null {
  return type.startsWith("invoice.") ? invoiceFromObject(object, observedAt) : null;
}
function invoiceFromStripe(value: Stripe.Invoice, observedAt: string) {
  return invoiceFromObject(value as unknown as Record<string, unknown>, observedAt);
}
function invoiceFromObject(object: Record<string, unknown>, observedAt: string): BillingInvoiceObservation {
  const currency = typeof object.currency === "string" && /^[a-zA-Z]{3}$/.test(object.currency) ? object.currency.toUpperCase() : null;
  const amountsValid = currency && Number.isSafeInteger(object.amount_due) && Number(object.amount_due) >= 0
    && Number.isSafeInteger(object.amount_paid) && Number(object.amount_paid) >= 0;
  const hosted = typeof object.hosted_invoice_url === "string" && object.hosted_invoice_url.startsWith("https://")
    ? object.hosted_invoice_url : null;
  return {
    externalRef: String(object.id), status: invoiceStatus(object.status), currency: amountsValid ? currency : null,
    amountDueMinor: amountsValid ? String(object.amount_due) : null,
    amountPaidMinor: amountsValid ? String(object.amount_paid) : null,
    hostedInvoiceUrl: hosted, dueAt: timestamp(object.due_date), observedAt,
  };
}
function invoiceStatus(value: unknown): BillingInvoiceObservation["status"] {
  return value === "draft" || value === "open" || value === "paid" || value === "void" || value === "uncollectible"
    ? value : "unknown";
}
function timestamp(value: unknown): string | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? secondsIso(value) : null;
}
