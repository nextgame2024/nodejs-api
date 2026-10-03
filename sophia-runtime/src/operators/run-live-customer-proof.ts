import "reflect-metadata";
import Stripe from "stripe";
import { Pool } from "pg";
import { runtimeConfig } from "../config/runtime-config.js";
import { DatabaseService } from "../database/database.service.js";
import { STRIPE_BILLING_API_VERSION, STRIPE_BILLING_PROVIDER_KEY } from
  "../admin/billing/stripe-billing.constants.js";

const CONFIRMATION = "I_UNDERSTAND_THIS_CREATES_ONE_NO_CHARGE_STRIPE_LIVE_VERIFICATION_CUSTOMER";
const CUSTOMER_NAME = "Sophia Live Billing Verification";
const PURPOSE = "live-billing-verification-v1";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const stage = process.argv[2];
if (!stage || !["prepare-tenant", "bind", "signal", "verify", "status"].includes(stage)) {
  throw new Error("Use prepare-tenant, bind, signal, verify, or status.");
}
const tenantIdInput = process.env.SOPHIA_BILLING_LIVE_VERIFICATION_TENANT_ID?.trim();
if (!tenantIdInput || !uuid.test(tenantIdInput)) {
  throw new Error("SOPHIA_BILLING_LIVE_VERIFICATION_TENANT_ID must be a UUID.");
}
const tenantId = tenantIdInput;
const mutating = stage !== "verify" && stage !== "status";
if (mutating && process.env.SOPHIA_BILLING_LIVE_CUSTOMER_CONFIRM !== CONFIRMATION) {
  throw new Error(`Set SOPHIA_BILLING_LIVE_CUSTOMER_CONFIRM=${CONFIRMATION}.`);
}

const config = runtimeConfig();
if (config.billing.provider !== "stripe_live" || !config.billing.stripeSecretKey?.startsWith("sk_live_")) {
  throw new Error("The live Customer proof requires stripe_live and a live-mode secret key.");
}
if (config.billing.liveCheckoutEnabled) throw new Error("Live Checkout must remain disabled throughout this proof.");

if (stage === "prepare-tenant") {
  await prepareTenant();
} else {
  const database = new DatabaseService();
  const stripe = new Stripe(config.billing.stripeSecretKey, {
    apiVersion: STRIPE_BILLING_API_VERSION,
    maxNetworkRetries: 2,
  });
  try {
    if (stage === "bind") await bindCustomer(database, stripe);
    if (stage === "signal") await signalCustomerUpdated(database, stripe);
    if (stage === "verify") await verifyEvidence(database, stripe);
    if (stage === "status") await status(database);
  } finally {
    await database.onModuleDestroy();
  }
}

async function prepareTenant(): Promise<void> {
  const pool = new Pool({ connectionString: config.databaseUrl,
    ssl: config.databaseSsl ? { rejectUnauthorized: true } : undefined, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const authority = await client.query<{ current_user: string; session_user: string }>(
      "SELECT current_user,session_user",
    );
    if (!authority.rows[0] || authority.rows[0].current_user === "sophia_runtime_app") {
      throw new Error("prepare-tenant requires the Neon owner connection, not the runtime application role.");
    }
    await client.query(
      `INSERT INTO ${config.schema}.customers
        (customer_id,name,external_company_id,status,metadata)
       VALUES ($1::uuid,$2,$1::uuid::text,'active',$3::jsonb)
       ON CONFLICT (customer_id) DO NOTHING`,
      [tenantId, CUSTOMER_NAME, JSON.stringify({ syntheticLiveBillingVerification: true, purpose: PURPOSE })],
    );
    const evidence = await client.query<{
      name: string; external_company_id: string | null; status: string; metadata: Record<string, unknown>;
      assignments: number; sessions: number;
    }>(`SELECT customer.name,customer.external_company_id,customer.status,customer.metadata,
              (SELECT count(*)::int FROM ${config.schema}.tenant_commercial_assignments assignment
               WHERE assignment.customer_id=customer.customer_id) AS assignments,
              (SELECT count(*)::int FROM ${config.schema}.sessions session
               WHERE session.customer_id=customer.customer_id) AS sessions
         FROM ${config.schema}.customers customer WHERE customer.customer_id=$1`, [tenantId]);
    const row = evidence.rows[0];
    if (!row || row.name !== CUSTOMER_NAME || row.external_company_id !== tenantId || row.status !== "active"
      || row.metadata.syntheticLiveBillingVerification !== true || row.metadata.purpose !== PURPOSE
      || row.assignments !== 0 || row.sessions !== 0) {
      throw new Error("The verification tenant conflicts with existing production state.");
    }
    await client.query("COMMIT");
    output("live_verification_tenant_ready", { tenantId, commercialAssignments: 0, sessions: 0,
      providerCustomerCreated: false, chargeCreated: false });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function bindCustomer(database: DatabaseService, stripe: Stripe): Promise<void> {
  await assertDedicatedTenant(database);
  let customerRef = await boundCustomer(database);
  let created = false;
  if (!customerRef) {
    const found = await stripe.customers.search({
      query: `metadata['sophiaPurpose']:'${PURPOSE}' AND metadata['sophiaTenantId']:'${tenantId}'`, limit: 10,
    });
    if (found.has_more || found.data.length > 1) throw new Error("The live verification Customer identity is ambiguous.");
    if (found.data[0]) {
      customerRef = found.data[0].id;
    } else {
      const customer = await stripe.customers.create({
        name: CUSTOMER_NAME,
        description: "Synthetic no-charge Customer used only for Sophia live webhook and reconciliation proof.",
        metadata: customerMetadata(),
      }, { idempotencyKey: `sophia:live:${config.billing.providerAccountKey}:verification-customer:${tenantId}:v1` });
      customerRef = customer.id;
      created = true;
    }
  }
  await assertStripeCustomer(stripe, customerRef);
  await database.tenantTransaction(tenantId, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`billing-customer:live:${config.billing.providerAccountKey}:${tenantId}`]);
    await client.query(
      `INSERT INTO ${config.schema}.billing_provider_customers
        (customer_id,provider_key,provider_environment,provider_account_key,external_customer_ref,observed_at)
       VALUES ($1,$2,'live',$3,$4,now())
       ON CONFLICT (customer_id,provider_key,provider_environment,provider_account_key) DO NOTHING`,
      [tenantId, STRIPE_BILLING_PROVIDER_KEY, config.billing.providerAccountKey, customerRef],
    );
    const binding = await client.query<{ external_customer_ref: string }>(
      `SELECT external_customer_ref FROM ${config.schema}.billing_provider_customers
       WHERE customer_id=$1 AND provider_key=$2 AND provider_environment='live' AND provider_account_key=$3`,
      [tenantId, STRIPE_BILLING_PROVIDER_KEY, config.billing.providerAccountKey],
    );
    if (binding.rows[0]?.external_customer_ref !== customerRef) {
      throw new Error("The live verification Customer conflicts with an existing tenant binding.");
    }
  });
  output("live_verification_customer_bound", { tenantId, customerId: customerRef, created,
    paymentMethodCreated: false, subscriptionCreated: false, invoiceCreated: false,
    checkoutCreated: false, chargeCreated: false });
}

async function signalCustomerUpdated(database: DatabaseService, stripe: Stripe): Promise<void> {
  await assertDedicatedTenant(database);
  const customerRef = await requireBoundCustomer(database);
  await assertStripeCustomer(stripe, customerRef);
  const signal = process.env.SOPHIA_BILLING_LIVE_VERIFICATION_SIGNAL?.trim() || "c3c-v1";
  if (!/^[a-z0-9-]{3,40}$/.test(signal)) {
    throw new Error("SOPHIA_BILLING_LIVE_VERIFICATION_SIGNAL must contain 3-40 lowercase letters, digits, or hyphens.");
  }
  const customer = await stripe.customers.update(customerRef, {
    metadata: { sophiaVerificationSignal: signal },
  }, { idempotencyKey: `sophia:live:${config.billing.providerAccountKey}:verification-signal:${tenantId}:${signal}` });
  if (customer.livemode !== true || customer.metadata.sophiaVerificationSignal !== signal) {
    throw new Error("Stripe did not accept the harmless live Customer verification signal.");
  }
  output("live_customer_updated_signal_sent", { tenantId, customerId: customerRef, signal,
    expectedWebhookEvent: "customer.updated", paymentMethodCreated: false, subscriptionCreated: false,
    invoiceCreated: false, checkoutCreated: false, chargeCreated: false });
}

async function verifyEvidence(database: DatabaseService, stripe: Stripe): Promise<void> {
  await assertDedicatedTenant(database);
  const customerRef = await requireBoundCustomer(database);
  await assertStripeCustomer(stripe, customerRef);
  const [subscriptions, invoices] = await Promise.all([
    stripe.subscriptions.list({ customer: customerRef, status: "all", limit: 100 }),
    stripe.invoices.list({ customer: customerRef, limit: 100 }),
  ]);
  if (subscriptions.has_more || invoices.has_more) throw new Error("Read-only reconciliation exceeded its bounded inventory.");
  if (subscriptions.data.length || invoices.data.length) {
    throw new Error("The no-charge verification Customer unexpectedly has a subscription or invoice.");
  }
  const event = await database.tenantReadTransaction<{
    external_event_ref: string; processing_status: string; occurred_at: Date | string;
    received_at: Date | string; processed_at: Date | string | null;
  } | null>(tenantId, async (client) => {
    const result = await client.query<{
      external_event_ref: string; processing_status: string; occurred_at: Date | string;
      received_at: Date | string; processed_at: Date | string | null;
    }>(`SELECT external_event_ref,processing_status,occurred_at,received_at,processed_at
        FROM ${config.schema}.billing_webhook_events
        WHERE customer_id=$1 AND provider_key=$2 AND provider_environment='live'
          AND provider_account_key=$3 AND event_type='customer.updated'
          AND received_at>=now()-interval '24 hours' AND processing_status IN ('processed','ignored')
        ORDER BY received_at DESC LIMIT 1`,
      [tenantId, STRIPE_BILLING_PROVIDER_KEY, config.billing.providerAccountKey]);
    return result.rows[0] ?? null;
  });
  if (!event) throw new Error("No persisted signed live customer.updated delivery was observed in the last 24 hours.");
  output("live_customer_proof_verified", { tenantId, customerId: customerRef,
    signedDelivery: { eventId: event.external_event_ref, processingStatus: event.processing_status,
      occurredAt: new Date(event.occurred_at).toISOString(), receivedAt: new Date(event.received_at).toISOString(),
      processedAt: event.processed_at ? new Date(event.processed_at).toISOString() : null },
    reconciliation: { status: "reconciled", subscriptionCount: 0, invoiceCount: 0, persisted: false,
      entitlementMutation: false },
    checkout: { enabled: false, providerRequest: false, chargeCreated: false },
    paymentMethodCreated: false, subscriptionCreated: false, invoiceCreated: false });
}

async function status(database: DatabaseService): Promise<void> {
  const customerRef = await boundCustomer(database);
  const row = await database.query<{
    customer_exists: boolean; assignments: number; sessions: number;
  }>(`SELECT
        EXISTS (SELECT 1 FROM ${config.schema}.customers WHERE customer_id=$1) AS customer_exists,
        (SELECT count(*)::int FROM ${config.schema}.tenant_commercial_assignments WHERE customer_id=$1) AS assignments,
        (SELECT count(*)::int FROM ${config.schema}.sessions WHERE customer_id=$1) AS sessions`, [tenantId]);
  output("live_customer_proof_status", { tenantId, ...(row.rows[0] ?? {}),
    providerCustomerBound: customerRef !== null, customerId: customerRef });
}

async function assertDedicatedTenant(database: DatabaseService): Promise<void> {
  const result = await database.query<{
    name: string; status: string; metadata: Record<string, unknown>; assignments: number; sessions: number;
  }>(`SELECT customer.name,customer.status,customer.metadata,
            (SELECT count(*)::int FROM ${config.schema}.tenant_commercial_assignments assignment
             WHERE assignment.customer_id=customer.customer_id) AS assignments,
            (SELECT count(*)::int FROM ${config.schema}.sessions session
             WHERE session.customer_id=customer.customer_id) AS sessions
       FROM ${config.schema}.customers customer WHERE customer.customer_id=$1`, [tenantId]);
  const row = result.rows[0];
  if (!row || row.name !== CUSTOMER_NAME || row.status !== "active"
    || row.metadata.syntheticLiveBillingVerification !== true || row.metadata.purpose !== PURPOSE
    || row.assignments !== 0 || row.sessions !== 0) {
    throw new Error("The target is not the dedicated empty live billing verification tenant.");
  }
}

async function boundCustomer(database: DatabaseService): Promise<string | null> {
  return database.tenantReadTransaction(tenantId, async (client) => {
    const binding = await client.query<{ external_customer_ref: string }>(
      `SELECT external_customer_ref FROM ${config.schema}.billing_provider_customers
       WHERE customer_id=$1 AND provider_key=$2 AND provider_environment='live' AND provider_account_key=$3`,
      [tenantId, STRIPE_BILLING_PROVIDER_KEY, config.billing.providerAccountKey],
    );
    return binding.rows[0]?.external_customer_ref ?? null;
  });
}

async function requireBoundCustomer(database: DatabaseService): Promise<string> {
  const customerRef = await boundCustomer(database);
  if (!customerRef) throw new Error("The dedicated verification tenant has no live Stripe Customer binding.");
  return customerRef;
}

async function assertStripeCustomer(stripe: Stripe, customerRef: string): Promise<void> {
  const customer = await stripe.customers.retrieve(customerRef);
  if (("deleted" in customer && customer.deleted) || !customer.livemode
    || customer.metadata.sophiaNamespace !== "subscription-v1"
    || customer.metadata.sophiaEnvironment !== "live"
    || customer.metadata.sophiaProviderAccountKey !== config.billing.providerAccountKey
    || customer.metadata.sophiaTenantId !== tenantId || customer.metadata.sophiaPurpose !== PURPOSE) {
    throw new Error("The Stripe live Customer metadata does not authorize this verification tenant binding.");
  }
}

function customerMetadata(): Record<string, string> {
  return { sophiaNamespace: "subscription-v1", sophiaEnvironment: "live",
    sophiaProviderAccountKey: config.billing.providerAccountKey,
    sophiaTenantId: tenantId!, sophiaPurpose: PURPOSE };
}

function output(stageName: string, detail: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ stage: stageName, ...detail, liveCheckoutEnabled: false }, null, 2)}\n`);
}
