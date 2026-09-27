import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { runtimeConfig } from "../src/config/runtime-config.js";
import { DatabaseService } from "../src/database/database.service.js";
import { StripeBillingProvider } from "../src/admin/billing/stripe-billing.provider.js";
import { STRIPE_BILLING_API_VERSION, STRIPE_BILLING_PROVIDER_KEY } from "../src/admin/billing/stripe-billing.constants.js";
import { verifyLiveStripeResources, type LivePlanExpectation } from "../src/admin/billing/stripe-live-readiness.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function main() {
  const config = runtimeConfig();
  if (config.billing.provider !== "stripe_live") throw new Error("SOPHIA_BILLING_PROVIDER must be stripe_live.");
  if (config.billing.liveCheckoutEnabled) throw new Error("Live Checkout must remain disabled during readiness verification.");
  if (!config.billing.stripeSecretKey || !config.billing.stripePortalConfigurationId
    || !config.billing.stripeWebhookSecret) throw new Error("Live Stripe secrets and portal configuration are incomplete.");

  const provider = new StripeBillingProvider(config.billing);
  const status = provider.status();
  if (status.availability !== "live" || status.checkout || !status.portal || !status.signedWebhooks || !status.reconciliation) {
    throw new Error(`Live adapter readiness failed: ${status.missingConfiguration.join(",") || "invalid capability state"}.`);
  }

  const database = new DatabaseService();
  try {
    const planIds = Object.keys(config.billing.stripePriceMappings);
    const result = await database.query<{
      commercial_plan_version_id: string; plan_key: string; display_name: string;
      billing_currency: string | null; billing_interval: "month" | "year" | null;
      base_charge_minor: string | null; pricing_status: string; status: string; tax_mode: string; rate_card_dimensions: string;
    }>(
      `SELECT commercial_plan_version_id,plan_key,display_name,billing_currency,billing_interval,base_charge_minor::text,
              pricing_status,status,tax_mode,
              jsonb_array_length(COALESCE(rate_card->'dimensions','[]'::jsonb))::text AS rate_card_dimensions
       FROM ${config.schema}.commercial_plan_versions
       WHERE commercial_plan_version_id=ANY($1::uuid[])`, [planIds]);
    if (result.rows.length !== planIds.length) throw new Error("Every live Price mapping must reference an existing commercial plan version.");
    const plans: LivePlanExpectation[] = result.rows.map((row) => {
      if (row.pricing_status !== "configured" || !["published", "retired"].includes(row.status)
        || !row.billing_currency || !row.billing_interval || row.base_charge_minor === null
        || row.tax_mode !== "not_applicable" || Number(row.rate_card_dimensions) !== 0) {
        throw new Error(`Mapped plan ${row.commercial_plan_version_id} is not an approved fixed recurring plan.`);
      }
      return { planVersionId: row.commercial_plan_version_id, planKey: row.plan_key, displayName: row.display_name,
        priceId: config.billing.stripePriceMappings[row.commercial_plan_version_id]!,
        currency: row.billing_currency, interval: row.billing_interval, baseChargeMinor: row.base_charge_minor };
    });

    const stripe = new Stripe(config.billing.stripeSecretKey, {
      apiVersion: STRIPE_BILLING_API_VERSION,
      maxNetworkRetries: 2,
    });
    const webhookUrl = expectedWebhookUrl();
    const resources = await verifyLiveStripeResources({ client: stripe, plans,
      portalConfigurationId: config.billing.stripePortalConfigurationId, webhookUrl });

    const rawBody = Buffer.from(JSON.stringify({ id: `evt_readiness_${randomUUID()}`,
      type: "customer.subscription.updated", created: Math.floor(Date.now() / 1000), livemode: true,
      data: { object: { id: "sub_readiness_no_provider_call", customer: "cus_readiness_no_provider_call",
        status: "active", metadata: { sophiaNamespace: "subscription-v1", sophiaEnvironment: "live" } } } }));
    const signature = Stripe.webhooks.generateTestHeaderString({ payload: rawBody,
      secret: config.billing.stripeWebhookSecret, timestamp: Math.floor(Date.now() / 1000) });
    const signingEvidence = await provider.verifyWebhook({ "stripe-signature": signature }, rawBody);
    if (signingEvidence.environment !== "live") throw new Error("Live signing-secret verification produced the wrong environment.");

    const tenantId = process.env.SOPHIA_BILLING_LIVE_VERIFICATION_TENANT_ID?.trim();
    let reconciliation: Record<string, unknown>;
    let deployedDelivery: Record<string, unknown>;
    if (!tenantId) {
      reconciliation = { verified: false, reason: "SOPHIA_BILLING_LIVE_VERIFICATION_TENANT_ID is not configured." };
      deployedDelivery = { verified: false, reason: "A verification tenant is required to inspect persisted signed delivery evidence." };
      process.exitCode = 2;
    } else {
      if (!uuidPattern.test(tenantId)) throw new Error("The live verification tenant ID must be a UUID.");
      const customerRef = await database.tenantReadTransaction(tenantId, async (client) => {
        const customer = await client.query<{ external_customer_ref: string }>(
          `SELECT external_customer_ref FROM ${config.schema}.billing_provider_customers
           WHERE customer_id=$1 AND provider_key=$2 AND provider_environment='live'`,
          [tenantId, STRIPE_BILLING_PROVIDER_KEY]);
        return customer.rows[0]?.external_customer_ref ?? null;
      });
      if (!customerRef) {
        reconciliation = { verified: false, reason: "The approved tenant has no live Sophia customer binding." };
        deployedDelivery = { verified: false, reason: "The approved tenant has no live Sophia customer binding." };
        process.exitCode = 2;
      } else {
        const observed = await provider.reconcileTenant({ tenantId, customerRef });
        if (observed.status !== "reconciled") throw new Error("Live reconciliation exceeded the bounded 100-object read limit.");
        reconciliation = { verified: true, status: observed.status,
          subscriptionCount: observed.subscriptions.length, invoiceCount: observed.invoices.length,
          persisted: false, entitlementMutation: false };
        const delivery = await database.tenantReadTransaction(tenantId, async (client) => client.query<{
          processing_status: string; occurred_at: Date | string; processed_at: Date | string | null;
        }>(
          `SELECT processing_status,occurred_at,processed_at
           FROM ${config.schema}.billing_webhook_events
           WHERE customer_id=$1 AND provider_key=$2 AND provider_environment='live'
             AND event_type='customer.updated' AND occurred_at>=now()-interval '24 hours'
             AND processing_status IN ('processed','ignored')
           ORDER BY occurred_at DESC LIMIT 1`,
          [tenantId, STRIPE_BILLING_PROVIDER_KEY]));
        const evidence = delivery.rows[0];
        if (!evidence) {
          deployedDelivery = { verified: false,
            reason: "No persisted signed live customer.updated delivery was observed for this tenant in the last 24 hours." };
          process.exitCode = 2;
        } else {
          deployedDelivery = { verified: true, eventType: "customer.updated",
            processingStatus: evidence.processing_status, occurredAt: new Date(evidence.occurred_at).toISOString(),
            processedAt: evidence.processed_at ? new Date(evidence.processed_at).toISOString() : null };
        }
      }
    }

    console.log(JSON.stringify({ ok: process.exitCode !== 2, resources,
      signingSecret: { verifiedLocally: true, providerRequest: false }, deployedDelivery, reconciliation,
      checkout: { enabled: false, providerRequest: false, chargeCreated: false },
    }, null, 2));
  } finally {
    await database.onModuleDestroy();
  }
}

function expectedWebhookUrl(): string {
  const explicit = process.env.SOPHIA_BILLING_STRIPE_WEBHOOK_URL?.trim();
  if (explicit) return explicit;
  const renderUrl = process.env.RENDER_EXTERNAL_URL?.trim();
  if (!renderUrl) throw new Error("SOPHIA_BILLING_STRIPE_WEBHOOK_URL or RENDER_EXTERNAL_URL is required.");
  return `${renderUrl.replace(/\/$/, "")}/api/billing/v1/webhooks/stripe`;
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown readiness failure.";
  console.error(`Live Stripe readiness failed: ${message}`);
  process.exitCode = 1;
});
