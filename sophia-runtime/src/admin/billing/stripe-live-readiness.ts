import Stripe from "stripe";
import {
  STRIPE_BILLING_API_VERSION,
  STRIPE_BILLING_WEBHOOK_EVENT_TYPES,
} from "./stripe-billing.constants.js";

export type LivePlanExpectation = {
  planVersionId: string;
  planKey: string;
  displayName: string;
  priceId: string;
  meteredPriceId: string;
  meterEventName: string;
  currency: string;
  interval: "month" | "year";
  baseChargeMinor: string;
  overageRateMinor: string;
};

export type ReadOnlyStripeBillingClient = {
  prices: { retrieve(id: string): Promise<Stripe.Price> };
  billing: { meters: { retrieve(id: string): Promise<Stripe.Billing.Meter> } };
  billingPortal: { configurations: { retrieve(id: string): Promise<Stripe.BillingPortal.Configuration> } };
  webhookEndpoints: { list(params: Stripe.WebhookEndpointListParams): Promise<Stripe.ApiList<Stripe.WebhookEndpoint>> };
};

export type LiveResourceReadiness = {
  environment: "live";
  checkoutEnabled: false;
  prices: { verified: number };
  portal: { active: true; requiredFeatures: string[] };
  webhook: { enabled: true; apiVersion: string; requiredEventCount: number };
};

export async function verifyLiveStripeResources(input: {
  client: ReadOnlyStripeBillingClient;
  plans: LivePlanExpectation[];
  portalConfigurationId: string;
  webhookUrl: string;
}): Promise<LiveResourceReadiness> {
  if (input.plans.length === 0) throw new Error("At least one approved live Price mapping is required.");
  const webhookUrl = canonicalHttpsUrl(input.webhookUrl);

  for (const plan of input.plans) {
    const commercialIdentity = `${plan.planKey} ${plan.displayName}`;
    if (/(^|[^a-z0-9])(sandbox|test)([^a-z0-9]|$)/i.test(commercialIdentity)) {
      throw new Error(`Live Price mapping cannot use sandbox/test-labelled commercial plan ${plan.planVersionId}.`);
    }
    const [price, meteredPrice] = await Promise.all([
      input.client.prices.retrieve(plan.priceId), input.client.prices.retrieve(plan.meteredPriceId),
    ]);
    if (!price.livemode || !price.active || price.type !== "recurring"
      || price.currency.toUpperCase() !== plan.currency
      || price.unit_amount === null || String(price.unit_amount) !== plan.baseChargeMinor
      || price.recurring?.interval !== plan.interval || price.recurring?.usage_type !== "licensed"
      || price.recurring.meter !== null) {
      throw new Error(`Live Price mapping does not match approved fixed plan ${plan.planVersionId}.`);
    }
    if (!meteredPrice.livemode || !meteredPrice.active || meteredPrice.type !== "recurring"
      || meteredPrice.currency.toUpperCase() !== plan.currency
      || meteredPrice.unit_amount === null || String(meteredPrice.unit_amount) !== plan.overageRateMinor
      || meteredPrice.recurring?.interval !== plan.interval || meteredPrice.recurring?.usage_type !== "metered"
      || !meteredPrice.recurring.meter) {
      throw new Error(`Live metered Price mapping does not match approved overage plan ${plan.planVersionId}.`);
    }
    const meter = await input.client.billing.meters.retrieve(meteredPrice.recurring.meter);
    if (!meter.livemode || meter.status !== "active" || meter.event_name !== plan.meterEventName
      || meter.default_aggregation.formula !== "sum") {
      throw new Error(`Live Meter does not match approved overage semantics for plan ${plan.planVersionId}.`);
    }
  }

  const portal = await input.client.billingPortal.configurations.retrieve(input.portalConfigurationId);
  const requiredPortalFeatures = ["invoice_history", "payment_method_update", "subscription_cancel"];
  if (!portal.livemode || !portal.active || !portal.features.invoice_history.enabled
    || !portal.features.payment_method_update.enabled || !portal.features.subscription_cancel.enabled) {
    throw new Error("The live Customer Portal configuration is inactive, test-mode, or missing required self-service features.");
  }

  const endpoints = await input.client.webhookEndpoints.list({ limit: 100 });
  if (endpoints.has_more) throw new Error("Webhook inventory exceeds the bounded verification limit.");
  const matching = endpoints.data.filter((endpoint) => endpoint.livemode && endpoint.status === "enabled"
    && canonicalHttpsUrl(endpoint.url) === webhookUrl);
  if (matching.length !== 1) throw new Error("Exactly one enabled live Sophia webhook destination must match the deployed URL.");
  const endpoint = matching[0]!;
  if (endpoint.api_version !== STRIPE_BILLING_API_VERSION) {
    throw new Error(`The live webhook destination must use Stripe API version ${STRIPE_BILLING_API_VERSION}.`);
  }
  const enabled = new Set(endpoint.enabled_events);
  const missingEvents = STRIPE_BILLING_WEBHOOK_EVENT_TYPES.filter((event) => !enabled.has("*") && !enabled.has(event));
  if (missingEvents.length) throw new Error(`The live webhook destination is missing ${missingEvents.length} required event type(s).`);

  return {
    environment: "live",
    checkoutEnabled: false,
    prices: { verified: input.plans.length },
    portal: { active: true, requiredFeatures: requiredPortalFeatures },
    webhook: { enabled: true, apiVersion: STRIPE_BILLING_API_VERSION,
      requiredEventCount: STRIPE_BILLING_WEBHOOK_EVENT_TYPES.length },
  };
}

function canonicalHttpsUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw new Error("The Stripe webhook destination must be a public HTTPS URL without credentials or a fragment.");
  }
  return parsed.toString();
}
