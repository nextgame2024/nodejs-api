import "reflect-metadata";
import Stripe from "stripe";
import { z } from "zod";
import { runtimeConfig } from "../config/runtime-config.js";

const CONFIRMATION = "I_UNDERSTAND_THIS_CREATES_STRIPE_SANDBOX_OBJECTS";
const PURPOSE = "founding-plan-v1";
const planVersionId = z.string().uuid().parse(process.env.SOPHIA_FOUNDING_PLAN_VERSION_ID);
if (process.env.SOPHIA_FOUNDING_CONFIRM !== CONFIRMATION) {
  throw new Error(`Set SOPHIA_FOUNDING_CONFIRM=${CONFIRMATION}.`);
}

const config = runtimeConfig();
if (config.billing.provider !== "stripe_sandbox" || !config.billing.stripeSecretKey?.startsWith("sk_test_")) {
  throw new Error("Founding provisioning requires the dedicated Sophia Stripe sandbox adapter and a test-mode key.");
}
const meterEventName = config.billing.stripeMeterBindings["active-overage-minutes"];
if (!meterEventName) throw new Error("The approved active-overage-minutes Meter binding must be configured.");

const stripe = new Stripe(config.billing.stripeSecretKey, {
  apiVersion: "2025-08-27.basil", maxNetworkRetries: 2,
});
const product = await findOrCreateProduct();
const meters = await stripe.billing.meters.list({ status: "active", limit: 100 });
if (meters.has_more) throw new Error("Meter discovery is ambiguous because more than 100 active sandbox Meters exist.");
const matchingMeters = meters.data.filter((meter) => meter.event_name === meterEventName);
if (matchingMeters.length !== 1) throw new Error("The configured semantic Meter binding must resolve to exactly one active sandbox Meter.");
const meterId = matchingMeters[0].id;

const base = await findOrCreatePrice("sophia_founding_monthly_sandbox_v1", 19_000, "licensed", null);
const commencement = await findOrCreatePrice("sophia_founding_commencement_sandbox_v1", 95_000, "one_time", null);
const deployment = await findOrCreatePrice("sophia_founding_production_deployment_sandbox_v1", 95_000, "one_time", null);
const overage = await findOrCreatePrice("sophia_founding_overage_minute_sandbox_v1", 10, "one_time", null);
const metered = await findOrCreatePrice("sophia_founding_meter_evidence_sandbox_v1", 10, "metered", meterId);
const committedPortal = await findOrCreateCommittedPortal();

process.stdout.write(`${JSON.stringify({
  stage: "founding_sandbox_resources_ready",
  planVersionId,
  productId: product.id,
  meterId,
  prices: { base: base.id, commencement: commencement.id, deployment: deployment.id,
    overage: overage.id, metered: metered.id },
  committedPortalConfigurationId: committedPortal.id,
  renderEnvironmentValues: {
    SOPHIA_BILLING_STRIPE_COMMITTED_PORTAL_CONFIGURATION_ID: committedPortal.id,
    SOPHIA_BILLING_STRIPE_PRICE_MAPPINGS_ENTRY: { [planVersionId]: base.id },
    SOPHIA_BILLING_STRIPE_INITIAL_PRICE_MAPPINGS_ENTRY: {
      [planVersionId]: { commencement: commencement.id },
    },
    SOPHIA_BILLING_STRIPE_MILESTONE_PRICE_MAPPINGS_ENTRY: {
      [planVersionId]: { "production-deployment": deployment.id },
    },
    SOPHIA_BILLING_STRIPE_METERED_PRICE_MAPPINGS_ENTRY: { [planVersionId]: metered.id },
    SOPHIA_BILLING_STRIPE_OVERAGE_PRICE_MAPPINGS_ENTRY: { [planVersionId]: overage.id },
  },
  liveMutation: false,
}, null, 2)}\n`);

async function findOrCreateProduct() {
  const result = await stripe.products.search({
    query: `metadata['sophiaPurpose']:'${PURPOSE}' AND metadata['sophiaPlanVersionId']:'${planVersionId}'`,
    limit: 10,
  });
  if (result.has_more || result.data.length > 1) throw new Error("Founding sandbox Product identity is ambiguous.");
  const existing = result.data[0];
  if (existing) {
    if (!existing.active || existing.livemode || existing.name !== "Sophia Essential Founding (Sandbox)") {
      throw new Error("The existing Founding sandbox Product does not match the approved immutable identity.");
    }
    return existing;
  }
  return stripe.products.create({
    name: "Sophia Essential Founding (Sandbox)",
    description: "Sandbox-only Founding membership and approved milestone obligations.",
    metadata: { sophiaNamespace: "subscription-v1", sophiaEnvironment: "sandbox",
      sophiaProviderAccountKey: config.billing.providerAccountKey,
      sophiaPlanVersionId: planVersionId, sophiaPurpose: PURPOSE },
  }, { idempotencyKey: `sophia:sandbox:${config.billing.providerAccountKey}:founding-product:${planVersionId}` });
}

async function findOrCreatePrice(lookupKey: string, unitAmount: number,
  kind: "licensed" | "metered" | "one_time", meter: string | null) {
  const listed = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 10 });
  if (listed.has_more || listed.data.length > 1) throw new Error(`Stripe Price lookup key ${lookupKey} is ambiguous.`);
  const expectedRecurring = kind === "one_time" ? null : { interval: "month", usage_type: kind,
    meter: kind === "metered" ? meter : null };
  const existing = listed.data[0];
  if (existing) {
    const productRef = typeof existing.product === "string" ? existing.product : existing.product.id;
    if (existing.livemode || productRef !== product.id || existing.currency !== "aud"
      || existing.unit_amount !== unitAmount || existing.tax_behavior !== "exclusive"
      || existing.type !== (kind === "one_time" ? "one_time" : "recurring")
      || (expectedRecurring === null ? existing.recurring !== null
        : existing.recurring?.interval !== expectedRecurring.interval
          || existing.recurring?.usage_type !== expectedRecurring.usage_type
          || (existing.recurring?.meter ?? null) !== expectedRecurring.meter)) {
      throw new Error(`Stripe Price ${lookupKey} does not match the approved Founding sandbox definition.`);
    }
    return existing;
  }
  return stripe.prices.create({
    product: product.id, currency: "aud", unit_amount: unitAmount, tax_behavior: "exclusive",
    lookup_key: lookupKey,
    nickname: lookupKey.replaceAll("_", " "),
    ...(kind === "one_time" ? {} : { recurring: { interval: "month" as const,
      usage_type: kind, ...(kind === "metered" ? { meter: meter! } : {}) } }),
    metadata: { sophiaNamespace: "subscription-v1", sophiaEnvironment: "sandbox",
      sophiaProviderAccountKey: config.billing.providerAccountKey,
      sophiaPlanVersionId: planVersionId, sophiaPurpose: PURPOSE, sophiaPriceRole: lookupKey },
  }, { idempotencyKey: `sophia:sandbox:${config.billing.providerAccountKey}:founding-price:${planVersionId}:${lookupKey}` });
}

async function findOrCreateCommittedPortal() {
  const configurations = await stripe.billingPortal.configurations.list({ active: true, limit: 100 });
  if (configurations.has_more) throw new Error("Portal configuration discovery is ambiguous because more than 100 active configurations exist.");
  const matches = configurations.data.filter((configuration) => configuration.metadata?.sophiaPurpose === PURPOSE
    && configuration.metadata?.sophiaPlanVersionId === planVersionId);
  if (matches.length > 1) throw new Error("Founding committed portal configuration identity is ambiguous.");
  const existing = matches[0];
  if (existing) {
    if (existing.livemode || existing.features.subscription_cancel.enabled
      || !existing.features.invoice_history.enabled || !existing.features.payment_method_update.enabled) {
      throw new Error("The existing Founding committed portal configuration is not cancellation-restricted.");
    }
    return existing;
  }
  return stripe.billingPortal.configurations.create({
    name: "Sophia Founding — commitment restricted (Sandbox)",
    default_return_url: config.billing.portalReturnUrl,
    features: {
      customer_update: { enabled: false, allowed_updates: [] },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: { enabled: false },
      subscription_update: { enabled: false, default_allowed_updates: [] },
    },
    metadata: { sophiaNamespace: "subscription-v1", sophiaEnvironment: "sandbox",
      sophiaProviderAccountKey: config.billing.providerAccountKey,
      sophiaPlanVersionId: planVersionId, sophiaPurpose: PURPOSE },
  }, { idempotencyKey: `sophia:sandbox:${config.billing.providerAccountKey}:founding-portal:${planVersionId}` });
}
