import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { NestFactory } from "@nestjs/core";
import Stripe from "stripe";
import { z } from "zod";
import { AppModule } from "../app.module.js";
import { BillingCommercialMilestoneService } from "../admin/billing/billing-commercial-milestone.service.js";
import { BillingInvoiceAdjustmentOutboxService } from "../admin/billing/billing-invoice-adjustment-outbox.service.js";
import { BillingLifecycleService } from "../admin/billing/billing-lifecycle.service.js";
import { BillingPeriodLedgerService } from "../admin/billing/billing-period-ledger.service.js";
import type { AdminPrincipal } from "../admin/contracts/admin-contracts.js";
import { runtimeConfig } from "../config/runtime-config.js";
import { DatabaseService } from "../database/database.service.js";

const CONFIRMATION = "I_UNDERSTAND_THIS_CREATES_STRIPE_SANDBOX_OBJECTS";
const PROVIDER_KEY = "stripe-sophia";
const PROOF_VARIANT = "founding-full-lifecycle-v1";
const stage = process.argv[2];
const tenantId = z.string().uuid().parse(process.env.SOPHIA_FOUNDING_TENANT_ID);
const planVersionId = z.string().uuid().parse(process.env.SOPHIA_FOUNDING_PLAN_VERSION_ID);
if (process.env.SOPHIA_FOUNDING_CONFIRM !== CONFIRMATION) throw new Error(`Set SOPHIA_FOUNDING_CONFIRM=${CONFIRMATION}.`);
if (!new Set(["prepare", "close", "milestone", "advance-commitment", "status"]).has(stage ?? "")) {
  throw new Error("Usage: npm run billing:founding-sandbox -- prepare|close|milestone|advance-commitment|status");
}

const config = runtimeConfig();
if (config.billing.provider !== "stripe_sandbox" || !config.billing.stripeSecretKey?.startsWith("sk_test_")) {
  throw new Error("Founding proof requires the dedicated Sophia Stripe sandbox adapter and a test-mode key.");
}
const basePrice = config.billing.stripePriceMappings[planVersionId];
const commencementPrice = config.billing.stripeInitialPriceMappings[planVersionId]?.commencement;
const deploymentPrice = config.billing.stripeMilestonePriceMappings[planVersionId]?.["production-deployment"];
const overagePrice = config.billing.stripeOveragePriceMappings[planVersionId];
const meteredPrice = config.billing.stripeMeteredPriceMappings[planVersionId];
if (!basePrice || !commencementPrice || !deploymentPrice || !overagePrice || !meteredPrice
  || !config.billing.stripeCommittedPortalConfigurationId) {
  throw new Error("Every approved Founding sandbox Price and the committed portal configuration must be deployed.");
}

const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
const database = app.get(DatabaseService);
const lifecycle = app.get(BillingLifecycleService);
const ledgers = app.get(BillingPeriodLedgerService);
const adjustments = app.get(BillingInvoiceAdjustmentOutboxService);
const milestones = app.get(BillingCommercialMilestoneService);
const stripe = new Stripe(config.billing.stripeSecretKey, { apiVersion: "2025-08-27.basil", maxNetworkRetries: 2 });

try {
  await assertFixtureAuthority();
  if (stage === "prepare") await prepare();
  if (stage === "close") await closeFirstPeriod();
  if (stage === "milestone") await acceptMilestone();
  if (stage === "advance-commitment") await advanceCommitment();
  if (stage === "status") await printStatus();
} finally {
  await app.close();
}

type ProofState = {
  proofVariant?: string; stage?: string; clockId?: string; customerId?: string;
  paymentMethodId?: string; subscriptionId?: string; periodStart?: string; periodEnd?: string;
  fixtureSessionId?: string; overageInvoiceId?: string; milestoneRequestId?: string;
};

async function prepare() {
  let state = await readState();
  if (Object.keys(state).length && state.proofVariant !== PROOF_VARIANT) {
    throw new Error("Use a fresh isolated Founding proof tenant.");
  }
  if (!state.clockId) {
    const clock = await stripe.testHelpers.testClocks.create({ frozen_time: Math.floor(Date.now() / 1_000),
      name: `Sophia Founding ${tenantId}` });
    state = await saveState({ ...state, proofVariant: PROOF_VARIANT, clockId: clock.id, stage: "clock_created" });
  }
  if (!state.customerId) {
    const customer = await stripe.customers.create({ test_clock: state.clockId,
      name: "Sophia Founding synthetic tenant", metadata: providerMetadata() }, {
      idempotencyKey: `sophia:sandbox:${config.billing.providerAccountKey}:founding-proof-customer:${tenantId}`,
    });
    state = await saveState({ ...state, customerId: customer.id, stage: "customer_created" });
  }
  if (!state.paymentMethodId) {
    const paymentMethod = await stripe.paymentMethods.attach("pm_card_visa", { customer: state.customerId! });
    state = await saveState({ ...state, paymentMethodId: paymentMethod.id, stage: "payment_method_attached" });
  }
  await stripe.customers.update(state.customerId!, {
    invoice_settings: { default_payment_method: state.paymentMethodId },
  });
  await bindCustomer(state.customerId!);
  if (!state.subscriptionId) {
    const subscription = await stripe.subscriptions.create({ customer: state.customerId!,
      items: [{ price: basePrice, quantity: 1 }],
      add_invoice_items: [{ price: commencementPrice, quantity: 1 }],
      collection_method: "charge_automatically", payment_behavior: "error_if_incomplete",
      metadata: providerMetadata() }, {
      idempotencyKey: `sophia:sandbox:${config.billing.providerAccountKey}:founding-proof-subscription:${tenantId}`,
    });
    const period = subscriptionPeriod(subscription);
    state = await saveState({ ...state, subscriptionId: subscription.id,
      periodStart: period.start, periodEnd: period.end, stage: "subscription_created" });
  }
  if (!state.fixtureSessionId) {
    const start = new Date(state.periodStart!); const end = new Date(start.getTime() + 60_061_000);
    if (end >= new Date(state.periodEnd!)) throw new Error("The first provider period is too short for the usage fixture.");
    const sessionId = randomUUID();
    await database.tenantTransaction(tenantId, async (client) => {
      await client.query(
        `INSERT INTO ${config.schema}.sessions
          (session_id,customer_id,ai_provider,avatar_provider,status,started_at,ended_at,metadata)
         VALUES ($1,$2,'synthetic-founding','synthetic-founding','closed',$3,$4,'{"foundingSandboxProof":true}'::jsonb)`,
        [sessionId, tenantId, start, end]);
      await client.query(
        `INSERT INTO ${config.schema}.session_activity_intervals
          (customer_id,session_id,connection_id,status,started_at,last_confirmed_at,ended_at,end_reason)
         VALUES ($1,$2,$3,'finalised',$4,$5,$5,'session_close')`,
        [tenantId, sessionId, randomUUID(), start, end]);
    });
    state = await saveState({ ...state, fixtureSessionId: sessionId, stage: "usage_fixture_created" });
  }
  const observed = await lifecycle.reconcile(tenantId, principal(), { requestId: randomUUID() });
  const initialInvoice = await exactInitialInvoice(state.customerId!, state.subscriptionId!);
  const portal = await lifecycle.portal(tenantId, principal(), { requestId: randomUUID() });
  if (portal.cancellation.mode !== "commitment_restricted") {
    throw new Error("The Founding portal exposed cancellation before the commitment boundary.");
  }
  state = await saveState({ ...state, stage: "prepared" });
  print({ stage: "founding_prepared", clockId: state.clockId, customerId: state.customerId,
    subscriptionId: state.subscriptionId, periodStart: state.periodStart, periodEnd: state.periodEnd,
    initialInvoice, cancellation: portal.cancellation, observed });
}

async function closeFirstPeriod() {
  const state = await requiredState();
  const cutoff = Math.floor(new Date(state.periodEnd!).getTime() / 1_000) + 60;
  await advanceClock(state.clockId!, cutoff);
  const observed = await lifecycle.reconcile(tenantId, principal(), { requestId: randomUUID() });
  const finalised = await ledgers.finaliseSandboxTestClock(tenantId, PROVIDER_KEY,
    config.billing.providerAccountKey, new Date(cutoff * 1_000).toISOString());
  if (finalised.finalised !== 1 || finalised.blocked.length) {
    throw new Error(`The Founding first-period ledger did not finalise: ${JSON.stringify(finalised)}`);
  }
  const invoices = await stripe.invoices.list({ customer: state.customerId!, limit: 100 });
  const renewal = invoices.data.filter((invoice) => invoice.billing_reason === "subscription_cycle"
    && invoice.period_start === unixSecond(state.periodStart!) && invoice.period_end === unixSecond(state.periodEnd!));
  if (renewal.length !== 1 || renewal[0].status !== "draft") {
    throw new Error("The exact first Founding renewal invoice is not uniquely available as a draft.");
  }
  const renewalInvoiceId = renewal[0].id;
  if (!renewalInvoiceId) throw new Error("The Founding renewal invoice has no stable provider identity.");
  const enqueued = await adjustments.enqueueDraftInvoice(tenantId, { providerKey: PROVIDER_KEY,
    providerEnvironment: "sandbox", providerAccountKey: config.billing.providerAccountKey,
    externalCustomerRef: state.customerId!, externalSubscriptionRef: state.subscriptionId!,
    externalInvoiceRef: renewalInvoiceId, periodStart: state.periodStart!, periodEnd: state.periodEnd! });
  if (!new Set(["enqueued", "existing"]).has(enqueued.status)) {
    throw new Error(`The Founding overage adjustment was not enqueued: ${JSON.stringify(enqueued)}`);
  }
  const dispatched = await adjustments.dispatchNext(tenantId, PROVIDER_KEY, "sandbox",
    config.billing.providerAccountKey, `founding-overage:${randomUUID()}`);
  if (!new Set(["provider_accepted", "idle"]).has(dispatched.status)) {
    throw new Error(`The Founding overage adjustment was not accepted: ${JSON.stringify(dispatched)}`);
  }
  const closeTarget = Math.floor(new Date(state.periodEnd!).getTime() / 1_000) + 3 * 60 * 60;
  await advanceClock(state.clockId!, closeTarget);
  let reconciliation: Awaited<ReturnType<BillingInvoiceAdjustmentOutboxService["reconcileInvoice"]>> | null = null;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    reconciliation = await adjustments.reconcileInvoice(tenantId, PROVIDER_KEY, "sandbox",
      config.billing.providerAccountKey, renewalInvoiceId);
    if (["reconciled", "mismatch"].includes(reconciliation.status)) break;
    await delay(5_000);
  }
  if (reconciliation?.status !== "reconciled") throw new Error("The Founding first-period overage did not reconcile.");
  await saveState({ ...state, stage: "first_period_closed", overageInvoiceId: renewalInvoiceId });
  print({ stage: "founding_first_period_closed", expected: { includedActiveSeconds: 60_000,
    billableOverageMinutes: 2, amountMinor: 20, overagePrice }, observed, finalised,
  enqueued, dispatched, reconciliation });
}

async function acceptMilestone() {
  const state = await requiredState();
  const requestId = state.milestoneRequestId ?? randomUUID();
  if (!state.milestoneRequestId) await saveState({ ...state, milestoneRequestId: requestId, stage: state.stage });
  const result = await milestones.acceptProductionDeployment(tenantId, principal(), {
    requestId, evidenceRef: `founding-sandbox-deployment:${tenantId}`,
  });
  if (result.reconciliation?.status !== "reconciled") {
    throw new Error("The Founding production-deployment milestone invoice did not reconcile.");
  }
  await saveState({ ...(await readState()), stage: "milestone_reconciled" });
  print({ stage: "founding_milestone_reconciled", expected: { price: deploymentPrice, amountMinor: 95_000 }, result });
}

async function advanceCommitment() {
  let state = await requiredState();
  let commitment = await commitmentEvidence();
  for (let cycle = 0; cycle < 13 && (!commitment.commitment_end
    || Date.parse(commitment.current_period_start) < Date.parse(commitment.commitment_end)); cycle += 1) {
    const subscription = await stripe.subscriptions.retrieve(state.subscriptionId!);
    const period = subscriptionPeriod(subscription);
    await advanceClock(state.clockId!, unixSecond(period.end)! + 60);
    await lifecycle.reconcile(tenantId, principal(), { requestId: randomUUID() });
    commitment = await commitmentEvidence();
  }
  if (commitment.periods_observed !== 12 || !commitment.commitment_end) {
    throw new Error("Twelve contiguous provider periods did not establish the Founding commitment boundary.");
  }
  const postBoundary = Date.parse(commitment.current_period_start) >= Date.parse(commitment.commitment_end);
  if (!postBoundary) throw new Error("The provider subscription has not advanced beyond the exact commitment boundary.");
  const portal = await lifecycle.portal(tenantId, principal(), { requestId: randomUUID() });
  if (portal.cancellation.mode !== "standard") {
    throw new Error("The standard cancellation-enabled portal was not selected after the commitment boundary.");
  }
  state = await saveState({ ...state, stage: "commitment_complete" });
  print({ stage: "founding_commitment_complete", commitment, cancellation: portal.cancellation,
    liveMutation: false, state: state.stage });
}

async function printStatus() {
  const state = await readState();
  const evidence = await database.tenantReadTransaction(tenantId, (client) => client.query(
    `SELECT commitment.required_periods,commitment.periods_observed,commitment.commencement_period_start,
            commitment.commitment_end,subscription.current_period_start,subscription.current_period_end
     FROM ${config.schema}.billing_subscription_commitments commitment
     JOIN ${config.schema}.billing_subscription_references subscription
       ON subscription.billing_subscription_reference_id=commitment.billing_subscription_reference_id
      AND subscription.customer_id=commitment.customer_id
     WHERE commitment.customer_id=$1`, [tenantId]));
  const milestonesEvidence = await database.tenantReadTransaction(tenantId, (client) => client.query(
    `SELECT status,external_invoice_ref,one_time_price_ref,unit_price_minor,currency,reconciled_at
     FROM ${config.schema}.billing_commercial_milestone_outbox WHERE customer_id=$1`, [tenantId]));
  print({ stage: state.stage ?? "not_started", state, commitment: evidence.rows,
    milestones: milestonesEvidence.rows });
}

async function exactInitialInvoice(customerId: string, subscriptionId: string) {
  const invoices = await stripe.invoices.list({ customer: customerId, limit: 100 });
  const matches = invoices.data.filter((invoice) => invoice.billing_reason === "subscription_create"
    && subscriptionReference(invoice) === subscriptionId);
  if (matches.length !== 1 || matches[0].status !== "paid" || matches[0].amount_paid !== 114_000) {
    throw new Error("The Founding initial paid invoice is not the exact approved AUD 1,140 composition.");
  }
  const invoiceId = matches[0].id;
  if (!invoiceId) throw new Error("The Founding initial invoice has no stable provider identity.");
  const lines = await stripe.invoices.listLineItems(invoiceId, { limit: 100 });
  const expected = new Map([[basePrice, 19_000], [commencementPrice, 95_000]]);
  for (const line of lines.data) {
    const price = line.pricing?.price_details?.price;
    if (typeof price === "string" && expected.get(price) === line.amount) expected.delete(price);
  }
  if (lines.has_more || expected.size) throw new Error("The Founding initial invoice lines do not match the approved Prices.");
  return { invoiceId, status: matches[0].status, amountPaidMinor: matches[0].amount_paid,
    currency: matches[0].currency.toUpperCase() };
}

async function commitmentEvidence() {
  const result = await database.tenantReadTransaction(tenantId, (client) => client.query<{
    required_periods: number; periods_observed: number; commitment_end: Date | string | null;
    current_period_start: Date | string;
  }>(`SELECT commitment.required_periods,commitment.periods_observed,commitment.commitment_end,
             subscription.current_period_start
      FROM ${config.schema}.billing_subscription_commitments commitment
      JOIN ${config.schema}.billing_subscription_references subscription
        ON subscription.billing_subscription_reference_id=commitment.billing_subscription_reference_id
       AND subscription.customer_id=commitment.customer_id
      WHERE commitment.customer_id=$1`, [tenantId]));
  if (result.rows.length !== 1) throw new Error("The Founding commitment evidence is missing or ambiguous.");
  const row = result.rows[0];
  return { required_periods: row.required_periods, periods_observed: row.periods_observed,
    commitment_end: row.commitment_end ? iso(row.commitment_end) : null,
    current_period_start: iso(row.current_period_start) };
}

async function assertFixtureAuthority() {
  const result = await database.tenantReadTransaction(tenantId, (client) => client.query<{ name: string; plan_id: string }>(
    `SELECT customer.name,assignment.commercial_plan_version_id::text AS plan_id
     FROM ${config.schema}.customers customer
     JOIN ${config.schema}.tenant_commercial_assignments assignment ON assignment.customer_id=customer.customer_id
      AND assignment.status='active' AND assignment.effective_from<=now()
      AND (assignment.effective_to IS NULL OR assignment.effective_to>now())
     WHERE customer.customer_id=$1`, [tenantId]));
  if (result.rows.length !== 1 || result.rows[0].plan_id !== planVersionId
    || !result.rows[0].name.startsWith("C4B Founding")) {
    throw new Error("The isolated C4B Founding tenant and sole active plan assignment are missing.");
  }
}

async function bindCustomer(customerId: string) {
  await database.tenantTransaction(tenantId, async (client) => {
    await client.query(
      `INSERT INTO ${config.schema}.billing_provider_customers
        (customer_id,provider_key,provider_environment,provider_account_key,external_customer_ref,observed_at)
       VALUES ($1,$2,'sandbox',$3,$4,now()) ON CONFLICT DO NOTHING`,
      [tenantId, PROVIDER_KEY, config.billing.providerAccountKey, customerId]);
    const result = await client.query<{ external_customer_ref: string }>(
      `SELECT external_customer_ref FROM ${config.schema}.billing_provider_customers
       WHERE customer_id=$1 AND provider_key=$2 AND provider_environment='sandbox' AND provider_account_key=$3`,
      [tenantId, PROVIDER_KEY, config.billing.providerAccountKey]);
    if (result.rows[0]?.external_customer_ref !== customerId) throw new Error("The Founding Customer binding conflicts with existing state.");
  });
}

async function readState(): Promise<ProofState> {
  const result = await database.query<{ proof: ProofState | null }>(
    `SELECT metadata->'foundingBillingProof' AS proof FROM ${config.schema}.customers WHERE customer_id=$1`, [tenantId]);
  return result.rows[0]?.proof ?? {};
}
async function saveState(state: ProofState) {
  await database.query(
    `UPDATE ${config.schema}.customers SET metadata=jsonb_set(metadata,'{foundingBillingProof}',$2::jsonb,true),updated_at=now()
     WHERE customer_id=$1`, [tenantId, JSON.stringify(state)]);
  return state;
}
async function requiredState() {
  const state = await readState();
  if (state.proofVariant !== PROOF_VARIANT || !state.clockId || !state.customerId || !state.subscriptionId
    || !state.periodStart || !state.periodEnd) throw new Error("Run the Founding prepare stage first.");
  return state;
}
async function advanceClock(clockId: string, target: number) {
  let clock = await stripe.testHelpers.testClocks.retrieve(clockId);
  if (clock.frozen_time < target) clock = await stripe.testHelpers.testClocks.advance(clockId, { frozen_time: target });
  for (let attempt = 0; clock.status === "advancing" && attempt < 60; attempt += 1) {
    await delay(2_000); clock = await stripe.testHelpers.testClocks.retrieve(clockId);
  }
  if (clock.status !== "ready" || clock.frozen_time < target) throw new Error(`Stripe test clock did not become ready (${clock.status}).`);
}
function subscriptionPeriod(subscription: Stripe.Subscription) {
  const item = subscription.items.data[0];
  if (!item?.current_period_start || !item.current_period_end) throw new Error("The subscription has no exact provider period.");
  return { start: new Date(item.current_period_start * 1_000).toISOString(),
    end: new Date(item.current_period_end * 1_000).toISOString() };
}
function subscriptionReference(invoice: Stripe.Invoice) {
  const value = invoice.parent?.subscription_details?.subscription;
  return typeof value === "string" ? value : value?.id ?? null;
}
function providerMetadata() { return { sophiaNamespace: "subscription-v1", sophiaEnvironment: "sandbox",
  sophiaProviderAccountKey: config.billing.providerAccountKey, sophiaTenantId: tenantId,
  sophiaPlanVersionId: planVersionId, sophiaProof: "P6-A06C3B0D4" }; }
function principal(): AdminPrincipal { return { apiVersion: "1.0.0", identityUserId: "operator:founding-sandbox-proof",
  tenantId, externalCompanyId: tenantId, membershipId: tenantId, role: "billing_administrator",
  permissions: ["billing.manage"], authorizationRevision: 1, mfaVerifiedAt: new Date().toISOString() }; }
function unixSecond(value: string) { return Date.parse(value) / 1_000; }
function iso(value: Date | string) { return new Date(value).toISOString(); }
function delay(milliseconds: number) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function print(value: unknown) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
