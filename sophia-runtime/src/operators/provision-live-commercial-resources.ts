import "reflect-metadata";
import Stripe from "stripe";
import { runtimeConfig } from "../config/runtime-config.js";
import { DatabaseService } from "../database/database.service.js";
import { STRIPE_BILLING_API_VERSION, STRIPE_BILLING_WEBHOOK_EVENT_TYPES } from
  "../admin/billing/stripe-billing.constants.js";

const CONFIRMATION = "I_UNDERSTAND_THIS_CREATES_STRIPE_LIVE_CATALOG_OBJECTS_NO_CHARGES";
const PURPOSE = "live-commercial-catalog-v1";
const EXPECTED = [
  { id: "112e2d08-9e8b-4748-a89a-954a28ad43c9", key: "sophia-voice", name: "Sophia Voice",
    base: "75000", included: "120000", overage: "10", components: [] },
  { id: "935879fa-a44d-4505-af58-76836a70fd33", key: "sophia-live", name: "Sophia Live",
    base: "175000", included: "120000", overage: "50", components: [] },
  { id: "b5b32d0a-ef4c-42b3-b9b4-072005b22904", key: "sophia-premium", name: "Sophia Premium",
    base: "275000", included: "120000", overage: "75", components: [] },
  { id: "cbfebc94-7bb8-43f9-b114-496eebf332fa", key: "sophia-essential-founding",
    name: "Sophia Essential Founding", base: "19000", included: "60000", overage: "10",
    components: [
      { key: "commencement", timing: "initial_checkout", milestone: null, amount: "95000" },
      { key: "production-deployment", timing: "operator_milestone",
        milestone: "production-deployment", amount: "95000" },
    ] },
] as const;

if (process.env.SOPHIA_BILLING_LIVE_RESOURCE_CONFIRM !== CONFIRMATION) {
  throw new Error(`Set SOPHIA_BILLING_LIVE_RESOURCE_CONFIRM=${CONFIRMATION}.`);
}
const config = runtimeConfig();
if (config.billing.provider !== "stripe_live" || !config.billing.stripeSecretKey?.startsWith("sk_live_")) {
  throw new Error("Live catalog provisioning requires stripe_live and a live-mode secret key.");
}
if (config.billing.liveCheckoutEnabled) throw new Error("Live Checkout must remain disabled during provisioning.");
const meterEventName = config.billing.stripeMeterBindings["active-overage-minutes"];
if (!meterEventName) throw new Error("The active-overage-minutes Meter binding is required.");

const database = new DatabaseService();
const stripe = new Stripe(config.billing.stripeSecretKey, {
  apiVersion: STRIPE_BILLING_API_VERSION, maxNetworkRetries: 2,
});

try {
  await validateCatalog();
  const meter = await findOrCreateMeter();
  const standardPortal = await findOrCreatePortal("standard", true);
  const committedPortal = await findOrCreatePortal("committed", false);
  const priceMappings: Record<string, string> = {};
  const meteredMappings: Record<string, string> = {};
  const overageMappings: Record<string, string> = {};
  const initialMappings: Record<string, Record<string, string>> = {};
  const milestoneMappings: Record<string, Record<string, string>> = {};
  const resources: Array<Record<string, unknown>> = [];

  for (const plan of EXPECTED) {
    const product = await findOrCreateProduct(plan);
    const stem = plan.key.replaceAll("-", "_");
    const base = await findOrCreatePrice(product.id, plan, `${stem}_monthly_live_v1`, Number(plan.base), "licensed", null);
    const overage = await findOrCreatePrice(product.id, plan, `${stem}_overage_minute_live_v1`, Number(plan.overage), "one_time", null);
    const metered = await findOrCreatePrice(product.id, plan, `${stem}_meter_evidence_live_v1`, Number(plan.overage), "metered", meter.id);
    priceMappings[plan.id] = base.id;
    overageMappings[plan.id] = overage.id;
    meteredMappings[plan.id] = metered.id;
    const componentPrices: Record<string, string> = {};
    for (const component of plan.components) {
      const price = await findOrCreatePrice(product.id, plan,
        `${stem}_${component.key.replaceAll("-", "_")}_live_v1`, Number(component.amount), "one_time", null);
      componentPrices[component.key] = price.id;
      if (component.timing === "initial_checkout") initialMappings[plan.id] = { [component.key]: price.id };
      if (component.timing === "operator_milestone") milestoneMappings[plan.id] = { [component.key]: price.id };
    }
    resources.push({ planVersionId: plan.id, productId: product.id,
      prices: { base: base.id, overage: overage.id, metered: metered.id, ...componentPrices } });
  }

  process.stdout.write(`${JSON.stringify({
    stage: "live_commercial_catalog_ready", resources, meterId: meter.id,
    standardPortalConfigurationId: standardPortal.id,
    committedPortalConfigurationId: committedPortal.id,
    renderEnvironmentValues: {
      SOPHIA_BILLING_STRIPE_PRICE_MAPPINGS: priceMappings,
      SOPHIA_BILLING_STRIPE_METERED_PRICE_MAPPINGS: meteredMappings,
      SOPHIA_BILLING_STRIPE_OVERAGE_PRICE_MAPPINGS: overageMappings,
      SOPHIA_BILLING_STRIPE_INITIAL_PRICE_MAPPINGS: initialMappings,
      SOPHIA_BILLING_STRIPE_MILESTONE_PRICE_MAPPINGS: milestoneMappings,
      SOPHIA_BILLING_STRIPE_PORTAL_CONFIGURATION_ID: standardPortal.id,
      SOPHIA_BILLING_STRIPE_COMMITTED_PORTAL_CONFIGURATION_ID: committedPortal.id,
      SOPHIA_BILLING_STRIPE_METER_BINDINGS: { "active-overage-minutes": meterEventName },
      SOPHIA_BILLING_LIVE_CHECKOUT_ENABLED: false,
    },
    webhook: { created: false, requiredEventTypes: STRIPE_BILLING_WEBHOOK_EVENT_TYPES,
      reason: "Create in Stripe Dashboard and store its signing secret directly in Render." },
    customerCreated: false, subscriptionCreated: false, invoiceCreated: false,
    checkoutCreated: false, chargeCreated: false,
  }, null, 2)}\n`);
} finally {
  await database.onModuleDestroy();
}

async function validateCatalog() {
  const result = await database.query<{
    commercial_plan_version_id: string; plan_key: string; display_name: string; base_charge_minor: string;
    billing_currency: string; billing_interval: string; tax_mode: string; status: string;
    minimum_commitment_months: number | null; rate_card: { dimensions?: Array<Record<string, unknown>> };
  }>(`SELECT commercial_plan_version_id::text,plan_key,display_name,base_charge_minor::text,
             billing_currency,billing_interval,tax_mode,status,minimum_commitment_months,rate_card
      FROM ${config.schema}.commercial_plan_versions
      WHERE commercial_plan_version_id=ANY($1::uuid[])`, [EXPECTED.map((plan) => plan.id)]);
  if (result.rows.length !== EXPECTED.length) throw new Error("The approved live commercial catalog is incomplete.");
  for (const plan of EXPECTED) {
    const row = result.rows.find((candidate) => candidate.commercial_plan_version_id === plan.id);
    const rate = row?.rate_card.dimensions?.[0];
    if (!row || row.plan_key !== plan.key || row.display_name !== plan.name || row.base_charge_minor !== plan.base
      || row.billing_currency !== "AUD" || row.billing_interval !== "month" || row.tax_mode !== "not_applicable"
      || row.status !== "published" || rate?.dimension !== "active-seconds" || rate.unitQuantity !== "60"
      || rate.includedQuantity !== plan.included || rate.unitPriceMinor !== plan.overage
      || row.minimum_commitment_months !== (plan.key === "sophia-essential-founding" ? 12 : null)) {
      throw new Error(`Commercial plan ${plan.id} differs from the approved immutable live definition.`);
    }
  }
  const components = await database.query<{
    commercial_plan_version_id: string; component_key: string; charge_timing: string;
    milestone_key: string | null; amount_minor: string; currency: string;
  }>(`SELECT commercial_plan_version_id::text,component_key,charge_timing,milestone_key,
             amount_minor::text,currency
      FROM ${config.schema}.commercial_plan_charge_components
      WHERE commercial_plan_version_id=ANY($1::uuid[])`, [EXPECTED.map((plan) => plan.id)]);
  const expectedCount = EXPECTED.reduce((sum, plan) => sum + plan.components.length, 0);
  if (components.rows.length !== expectedCount) throw new Error("The approved live charge-component catalog differs from the database.");
  for (const plan of EXPECTED) for (const component of plan.components) {
    const row = components.rows.find((candidate) => candidate.commercial_plan_version_id === plan.id
      && candidate.component_key === component.key);
    if (!row || row.charge_timing !== component.timing || row.milestone_key !== component.milestone
      || row.amount_minor !== component.amount || row.currency !== "AUD") {
      throw new Error(`Commercial component ${plan.id}/${component.key} differs from the approved definition.`);
    }
  }
}

async function findOrCreateMeter() {
  const listed = await stripe.billing.meters.list({ status: "active", limit: 100 });
  if (listed.has_more) throw new Error("Live Meter discovery exceeds the bounded inventory limit.");
  const matches = listed.data.filter((meter) => meter.event_name === meterEventName);
  if (matches.length > 1) throw new Error("The live semantic Meter identity is ambiguous.");
  const existing = matches[0];
  if (existing) {
    if (!existing.livemode || existing.default_aggregation.formula !== "sum") {
      throw new Error("The existing live Meter does not match aggregate-minute evidence semantics.");
    }
    return existing;
  }
  return stripe.billing.meters.create({ display_name: "Sophia active overage minutes",
    event_name: meterEventName, default_aggregation: { formula: "sum" },
    customer_mapping: { type: "by_id", event_payload_key: "stripe_customer_id" },
    value_settings: { event_payload_key: "value" } },
  { idempotencyKey: `sophia:live:${config.billing.providerAccountKey}:active-overage-meter:v1` });
}

async function findOrCreateProduct(plan: typeof EXPECTED[number]) {
  const found = await stripe.products.search({
    query: `metadata['sophiaPurpose']:'${PURPOSE}' AND metadata['sophiaPlanVersionId']:'${plan.id}'`, limit: 10,
  });
  if (found.has_more || found.data.length > 1) throw new Error(`Live Product identity is ambiguous for ${plan.id}.`);
  const existing = found.data[0];
  if (existing) {
    if (!existing.livemode || !existing.active || existing.name !== plan.name) {
      throw new Error(`Existing live Product differs from approved plan ${plan.id}.`);
    }
    return existing;
  }
  return stripe.products.create({ name: plan.name,
    description: "Sophia business AI membership. Commercial terms are governed by the immutable plan version.",
    metadata: metadata(plan.id, "product") },
  { idempotencyKey: `sophia:live:${config.billing.providerAccountKey}:product:${plan.id}` });
}

async function findOrCreatePrice(productId: string, plan: typeof EXPECTED[number], lookupKey: string,
  amount: number, kind: "licensed" | "metered" | "one_time", meterId: string | null) {
  const listed = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 10 });
  if (listed.has_more || listed.data.length > 1) throw new Error(`Live Price lookup key ${lookupKey} is ambiguous.`);
  const existing = listed.data[0];
  const productRef = existing ? (typeof existing.product === "string" ? existing.product : existing.product.id) : null;
  if (existing) {
    if (!existing.livemode || productRef !== productId || existing.currency !== "aud"
      || existing.unit_amount !== amount || existing.tax_behavior !== "exclusive"
      || existing.type !== (kind === "one_time" ? "one_time" : "recurring")
      || (kind === "one_time" ? existing.recurring !== null
        : existing.recurring?.interval !== "month" || existing.recurring.usage_type !== kind
          || (existing.recurring.meter ?? null) !== (kind === "metered" ? meterId : null))) {
      throw new Error(`Existing live Price ${lookupKey} differs from the approved definition.`);
    }
    return existing;
  }
  return stripe.prices.create({ product: productId, currency: "aud", unit_amount: amount,
    tax_behavior: "exclusive", lookup_key: lookupKey, nickname: lookupKey.replaceAll("_", " "),
    ...(kind === "one_time" ? {} : { recurring: { interval: "month" as const, usage_type: kind,
      ...(kind === "metered" ? { meter: meterId! } : {}) } }),
    metadata: metadata(plan.id, lookupKey) },
  { idempotencyKey: `sophia:live:${config.billing.providerAccountKey}:price:${plan.id}:${lookupKey}` });
}

async function findOrCreatePortal(role: "standard" | "committed", cancellationEnabled: boolean) {
  const listed = await stripe.billingPortal.configurations.list({ active: true, limit: 100 });
  if (listed.has_more) throw new Error("Live portal discovery exceeds the bounded inventory limit.");
  const matches = listed.data.filter((portal) => portal.metadata?.sophiaPurpose === PURPOSE
    && portal.metadata?.sophiaPortalRole === role);
  if (matches.length > 1) throw new Error(`Live ${role} portal identity is ambiguous.`);
  const existing = matches[0];
  if (existing) {
    if (!existing.livemode || !existing.active || existing.features.subscription_cancel.enabled !== cancellationEnabled
      || !existing.features.invoice_history.enabled || !existing.features.payment_method_update.enabled) {
      throw new Error(`Existing live ${role} portal differs from the approved policy.`);
    }
    return existing;
  }
  return stripe.billingPortal.configurations.create({
    name: role === "standard" ? "Sophia — standard cancellation" : "Sophia — commitment restricted",
    default_return_url: config.billing.portalReturnUrl,
    features: { customer_update: { enabled: false, allowed_updates: [] },
      invoice_history: { enabled: true }, payment_method_update: { enabled: true },
      subscription_cancel: { enabled: cancellationEnabled,
        ...(cancellationEnabled ? { mode: "at_period_end" as const, proration_behavior: "none" as const } : {}) },
      subscription_update: { enabled: false, default_allowed_updates: [] } },
    metadata: { sophiaNamespace: "subscription-v1", sophiaEnvironment: "live",
      sophiaProviderAccountKey: config.billing.providerAccountKey, sophiaPurpose: PURPOSE, sophiaPortalRole: role },
  }, { idempotencyKey: `sophia:live:${config.billing.providerAccountKey}:portal:${role}:v1` });
}

function metadata(planVersionId: string, role: string) {
  return { sophiaNamespace: "subscription-v1", sophiaEnvironment: "live",
    sophiaProviderAccountKey: config.billing.providerAccountKey,
    sophiaPlanVersionId: planVersionId, sophiaPurpose: PURPOSE, sophiaPriceRole: role };
}
