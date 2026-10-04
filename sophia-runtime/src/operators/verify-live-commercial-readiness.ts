import "reflect-metadata";
import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { isStripeLiveCredential, runtimeConfig } from "../config/runtime-config.js";
import { DatabaseService } from "../database/database.service.js";
import { StripeBillingProvider } from "../admin/billing/stripe-billing.provider.js";
import { STRIPE_BILLING_API_VERSION } from "../admin/billing/stripe-billing.constants.js";
import { verifyLiveStripeResources, type LivePlanExpectation } from
  "../admin/billing/stripe-live-readiness.js";

const EXPECTED = [
  { id: "112e2d08-9e8b-4748-a89a-954a28ad43c9", key: "sophia-voice", name: "Sophia Voice",
    base: "75000", included: "120000", overage: "10" },
  { id: "935879fa-a44d-4505-af58-76836a70fd33", key: "sophia-live", name: "Sophia Live",
    base: "175000", included: "120000", overage: "50" },
  { id: "b5b32d0a-ef4c-42b3-b9b4-072005b22904", key: "sophia-premium", name: "Sophia Premium",
    base: "275000", included: "120000", overage: "75" },
  { id: "cbfebc94-7bb8-43f9-b114-496eebf332fa", key: "sophia-essential-founding",
    name: "Sophia Essential Founding", base: "19000", included: "60000", overage: "10" },
] as const;
const FOUNDING_ID = "cbfebc94-7bb8-43f9-b114-496eebf332fa";

const config = runtimeConfig();
if (config.billing.provider !== "stripe_live" || !isStripeLiveCredential(config.billing.stripeSecretKey)) {
  throw new Error("Live readiness verification requires stripe_live and a live-mode Stripe credential.");
}
if (config.billing.liveCheckoutEnabled) throw new Error("Live Checkout must remain disabled during readiness verification.");
if (!config.billing.stripeWebhookSecret || !config.billing.stripePortalConfigurationId
  || !config.billing.stripeCommittedPortalConfigurationId) {
  throw new Error("Live Stripe webhook and portal configuration is incomplete.");
}
const meterEventName = config.billing.stripeMeterBindings["active-overage-minutes"];
if (!meterEventName) throw new Error("The live active-overage-minutes Meter binding is required.");

const database = new DatabaseService();
const stripe = new Stripe(config.billing.stripeSecretKey, {
  apiVersion: STRIPE_BILLING_API_VERSION,
  maxNetworkRetries: 2,
});

try {
  const plans = await approvedPlans();
  assertExactMappingKeys(config.billing.stripePriceMappings, "base");
  assertExactMappingKeys(config.billing.stripeMeteredPriceMappings, "metered");
  assertExactMappingKeys(config.billing.stripeOveragePriceMappings, "overage");

  const resources = await verifyLiveStripeResources({
    client: stripe,
    plans,
    portalConfigurationId: config.billing.stripePortalConfigurationId,
    webhookUrl: expectedWebhookUrl(),
  });

  for (const plan of EXPECTED) {
    await verifyOneTimePrice(config.billing.stripeOveragePriceMappings[plan.id]!, plan.overage,
      `overage Price for ${plan.id}`);
  }
  const initial = config.billing.stripeInitialPriceMappings[FOUNDING_ID];
  const milestone = config.billing.stripeMilestonePriceMappings[FOUNDING_ID];
  if (Object.keys(config.billing.stripeInitialPriceMappings).length !== 1
    || Object.keys(initial ?? {}).length !== 1 || !initial?.commencement) {
    throw new Error("The live Founding commencement Price mapping is incomplete or ambiguous.");
  }
  if (Object.keys(config.billing.stripeMilestonePriceMappings).length !== 1
    || Object.keys(milestone ?? {}).length !== 1 || !milestone?.["production-deployment"]) {
    throw new Error("The live Founding deployment Price mapping is incomplete or ambiguous.");
  }
  await verifyOneTimePrice(initial.commencement, "95000", "Founding commencement Price");
  await verifyOneTimePrice(milestone["production-deployment"], "95000", "Founding deployment Price");

  const committedPortal = await stripe.billingPortal.configurations.retrieve(
    config.billing.stripeCommittedPortalConfigurationId,
  );
  if (!committedPortal.livemode || !committedPortal.active
    || !committedPortal.features.invoice_history.enabled
    || !committedPortal.features.payment_method_update.enabled
    || committedPortal.features.subscription_cancel.enabled) {
    throw new Error("The live committed portal must be active and keep subscription cancellation disabled.");
  }

  const provider = new StripeBillingProvider(config.billing);
  const rawBody = Buffer.from(JSON.stringify({
    id: `evt_readiness_${randomUUID()}`,
    type: "customer.subscription.updated",
    created: Math.floor(Date.now() / 1000),
    livemode: true,
    data: { object: { id: "sub_readiness_no_provider_call", customer: "cus_readiness_no_provider_call",
      status: "active", metadata: { sophiaNamespace: "subscription-v1", sophiaEnvironment: "live",
        sophiaProviderAccountKey: config.billing.providerAccountKey } } },
  }));
  const signature = Stripe.webhooks.generateTestHeaderString({ payload: rawBody.toString("utf8"),
    secret: config.billing.stripeWebhookSecret, timestamp: Math.floor(Date.now() / 1000) });
  const signingEvidence = await provider.verifyWebhook({ "stripe-signature": signature }, rawBody);
  if (signingEvidence.environment !== "live") {
    throw new Error("The configured signing secret did not produce live-environment evidence.");
  }

  process.stdout.write(`${JSON.stringify({
    stage: "live_commercial_readiness_verified",
    resources,
    plansVerified: EXPECTED.length,
    oneTimePricesVerified: EXPECTED.length + 2,
    committedPortal: { active: true, cancellationEnabled: false },
    signingSecret: { verifiedLocally: true, exposed: false },
    checkout: { enabled: false, providerRequest: false, chargeCreated: false },
    customerCreated: false,
    subscriptionCreated: false,
    invoiceCreated: false,
  }, null, 2)}\n`);
} finally {
  await database.onModuleDestroy();
}

async function approvedPlans(): Promise<LivePlanExpectation[]> {
  const result = await database.query<{
    commercial_plan_version_id: string; plan_key: string; display_name: string;
    billing_currency: string; billing_interval: "month" | "year"; base_charge_minor: string;
    pricing_status: string; status: string; tax_mode: string;
    minimum_commitment_months: number | null; rate_card: { dimensions?: Array<Record<string, unknown>> };
  }>(`SELECT commercial_plan_version_id::text,plan_key,display_name,billing_currency,billing_interval,
             base_charge_minor::text,pricing_status,status,tax_mode,minimum_commitment_months,rate_card
      FROM ${config.schema}.commercial_plan_versions
      WHERE commercial_plan_version_id=ANY($1::uuid[])`, [EXPECTED.map((plan) => plan.id)]);
  if (result.rows.length !== EXPECTED.length) throw new Error("The approved live commercial catalog is incomplete.");
  return EXPECTED.map((plan) => {
    const row = result.rows.find((candidate) => candidate.commercial_plan_version_id === plan.id);
    const rate = row?.rate_card.dimensions?.[0];
    if (!row || row.plan_key !== plan.key || row.display_name !== plan.name || row.base_charge_minor !== plan.base
      || row.billing_currency !== "AUD" || row.billing_interval !== "month" || row.tax_mode !== "not_applicable"
      || row.pricing_status !== "configured" || row.status !== "published"
      || row.minimum_commitment_months !== (plan.id === FOUNDING_ID ? 12 : null)
      || rate?.dimension !== "active-seconds" || rate.unitQuantity !== "60"
      || rate.includedQuantity !== plan.included || rate.unitPriceMinor !== plan.overage) {
      throw new Error(`Commercial plan ${plan.id} differs from the approved immutable live definition.`);
    }
    return { planVersionId: plan.id, planKey: plan.key, displayName: plan.name,
      priceId: config.billing.stripePriceMappings[plan.id]!,
      meteredPriceId: config.billing.stripeMeteredPriceMappings[plan.id]!, meterEventName,
      currency: "AUD", interval: "month", baseChargeMinor: plan.base, overageRateMinor: plan.overage };
  });
}

function assertExactMappingKeys(mapping: Record<string, string>, label: string): void {
  const expected = new Set(EXPECTED.map((plan) => plan.id));
  const actual = Object.keys(mapping);
  if (actual.length !== expected.size || actual.some((id) => !expected.has(id as typeof EXPECTED[number]["id"]))) {
    throw new Error(`The live ${label} Price mapping must contain exactly the four approved plans.`);
  }
}

async function verifyOneTimePrice(priceId: string, amountMinor: string, label: string): Promise<void> {
  const price = await stripe.prices.retrieve(priceId);
  if (!price.livemode || !price.active || price.type !== "one_time" || price.recurring !== null
    || price.currency !== "aud" || price.unit_amount === null || String(price.unit_amount) !== amountMinor
    || price.tax_behavior !== "exclusive") {
    throw new Error(`The live ${label} differs from the approved definition.`);
  }
}

function expectedWebhookUrl(): string {
  const explicit = process.env.SOPHIA_BILLING_STRIPE_WEBHOOK_URL?.trim();
  if (explicit) return explicit;
  const renderUrl = process.env.RENDER_EXTERNAL_URL?.trim();
  if (!renderUrl) throw new Error("SOPHIA_BILLING_STRIPE_WEBHOOK_URL or RENDER_EXTERNAL_URL is required.");
  return `${renderUrl.replace(/\/$/, "")}/api/billing/v1/webhooks/stripe`;
}
