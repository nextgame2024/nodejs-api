import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { NestFactory } from "@nestjs/core";
import Stripe from "stripe";
import { AppModule } from "../app.module.js";
import { BillingLifecycleService } from "../admin/billing/billing-lifecycle.service.js";
import { BillingMeterOutboxService } from "../admin/billing/billing-meter-outbox.service.js";
import { BillingPeriodLedgerService } from "../admin/billing/billing-period-ledger.service.js";
import type { AdminPrincipal } from "../admin/contracts/admin-contracts.js";
import { runtimeConfig } from "../config/runtime-config.js";
import { DatabaseService } from "../database/database.service.js";

const VOICE_PLAN_ID = "112e2d08-9e8b-4748-a89a-954a28ad43c9";
const PROVIDER_KEY = "stripe-sophia";
const PROOF_CONFIRMATION = "I_UNDERSTAND_THIS_CREATES_STRIPE_SANDBOX_OBJECTS";
const stage = process.argv[2];
const tenantId = process.env.SOPHIA_C4B_TENANT_ID;

if (!tenantId || !/^[0-9a-f-]{36}$/i.test(tenantId)) throw new Error("SOPHIA_C4B_TENANT_ID must be the approved synthetic tenant UUID.");
if (process.env.SOPHIA_C4B_CONFIRM !== PROOF_CONFIRMATION) throw new Error(`Set SOPHIA_C4B_CONFIRM=${PROOF_CONFIRMATION}.`);
if (!new Set(["prepare", "close", "finalize", "diagnose", "status"]).has(stage ?? "")) {
  throw new Error("Usage: npm run billing:c4b-sandbox -- prepare|close|finalize|diagnose|status");
}

const config = runtimeConfig();
if (config.billing.provider !== "stripe_sandbox" || !config.billing.stripeSecretKey?.startsWith("sk_test_")) {
  throw new Error("C4B proof requires the deployed Sophia Stripe sandbox adapter and a test-mode key.");
}
const basePrice = config.billing.stripePriceMappings[VOICE_PLAN_ID];
const meteredPrice = config.billing.stripeMeteredPriceMappings[VOICE_PLAN_ID];
if (!basePrice || !meteredPrice || !config.billing.stripeMeterBindings["active-overage-minutes"]) {
  throw new Error("The approved Sophia Voice base Price, metered Price and Meter binding must all be configured.");
}

const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
const database = app.get(DatabaseService);
const lifecycle = app.get(BillingLifecycleService);
const ledgers = app.get(BillingPeriodLedgerService);
const outbox = app.get(BillingMeterOutboxService);
const stripe = new Stripe(config.billing.stripeSecretKey, { apiVersion: "2025-08-27.basil", maxNetworkRetries: 2 });

try {
  await assertFixtureAuthority();
  if (stage === "prepare") await prepare();
  if (stage === "close") await closePeriod();
  if (stage === "finalize") await finalizeInvoice();
  if (stage === "diagnose") await diagnoseInvoice();
  if (stage === "status") await printStatus();
} finally {
  await app.close();
}

type ProofState = {
  clockId?: string;
  customerId?: string;
  subscriptionId?: string;
  paymentMethodId?: string;
  periodStart?: string;
  periodEnd?: string;
  fixtureSessionId?: string;
  stage?: string;
};

async function assertFixtureAuthority() {
  const row = await database.tenantReadTransaction(tenantId!, async (client) => client.query<{
    plan_id: string | null; name: string;
  }>(
    `SELECT c.name,(
       SELECT commercial_plan_version_id::text FROM ${config.schema}.tenant_commercial_assignments
       WHERE customer_id=c.customer_id AND status='active' AND effective_from<=now()
         AND (effective_to IS NULL OR effective_to>now()) ORDER BY effective_from DESC LIMIT 1
     ) AS plan_id FROM ${config.schema}.customers c WHERE c.customer_id=$1`, [tenantId],
  ));
  if (!row.rows[0] || row.rows[0].plan_id !== VOICE_PLAN_ID || !row.rows[0].name.startsWith("C4B ")) {
    throw new Error("The approved isolated C4B tenant with an active Sophia Voice assignment is missing.");
  }
}

async function prepare() {
  let state = await readState();
  if (!state.clockId) {
    const clock = await stripe.testHelpers.testClocks.create({
      frozen_time: Math.floor(Date.now() / 1_000), name: `Sophia C4B ${tenantId}`,
    });
    state = await saveState({ ...state, clockId: clock.id, stage: "clock_created" });
  }
  if (!state.customerId) {
    const customer = await stripe.customers.create({
      test_clock: state.clockId,
      name: "Sophia C4B synthetic tenant",
      metadata: providerMetadata(),
    });
    state = await saveState({ ...state, customerId: customer.id, stage: "customer_created" });
  }
  await database.tenantTransaction(tenantId!, async (client) => {
    await client.query(
      `INSERT INTO ${config.schema}.billing_provider_customers
       (customer_id,provider_key,provider_environment,provider_account_key,external_customer_ref,observed_at)
       VALUES ($1,$2,'sandbox',$3,$4,now()) ON CONFLICT DO NOTHING`,
      [tenantId, PROVIDER_KEY, config.billing.providerAccountKey, state.customerId],
    );
    const binding = await client.query<{ external_customer_ref: string }>(
      `SELECT external_customer_ref FROM ${config.schema}.billing_provider_customers
       WHERE customer_id=$1 AND provider_key=$2 AND provider_environment='sandbox' AND provider_account_key=$3`,
      [tenantId, PROVIDER_KEY, config.billing.providerAccountKey],
    );
    if (binding.rows[0]?.external_customer_ref !== state.customerId) throw new Error("The C4B Customer binding conflicts with existing state.");
  });
  if (!state.subscriptionId) {
    let paymentMethodId = state.paymentMethodId;
    if (!paymentMethodId) {
      const attached = await stripe.paymentMethods.list({ customer: state.customerId!, type: "card", limit: 10 });
      paymentMethodId = attached.data[0]?.id;
      if (!paymentMethodId) {
        paymentMethodId = (await stripe.paymentMethods.attach("pm_card_visa", { customer: state.customerId! })).id;
      }
      state = await saveState({ ...state, paymentMethodId, stage: "payment_method_attached" });
    }
    await stripe.customers.update(state.customerId!, { invoice_settings: { default_payment_method: paymentMethodId } });
    const subscription = await stripe.subscriptions.create({
      customer: state.customerId!,
      items: [{ price: basePrice, quantity: 1 }, { price: meteredPrice }],
      collection_method: "charge_automatically",
      payment_behavior: "error_if_incomplete",
      metadata: providerMetadata(),
    });
    const period = subscriptionPeriod(subscription);
    state = await saveState({ ...state, subscriptionId: subscription.id,
      periodStart: period.start, periodEnd: period.end, stage: "subscription_created" });
  }
  if (!state.fixtureSessionId) {
    const start = new Date(state.periodStart!);
    const end = new Date(start.getTime() + (120_000 + 61) * 1_000);
    if (end >= new Date(state.periodEnd!)) throw new Error("The provider period is too short for the positive-overage fixture.");
    const sessionId = randomUUID();
    await database.tenantTransaction(tenantId!, async (client) => {
      await client.query(
        `INSERT INTO ${config.schema}.sessions
         (session_id,customer_id,ai_provider,avatar_provider,status,started_at,ended_at,metadata)
         VALUES ($1,$2,'synthetic-c4b','synthetic-c4b','closed',$3,$4,'{"sandboxProof":true}'::jsonb)`,
        [sessionId, tenantId, start, end],
      );
      await client.query(
        `INSERT INTO ${config.schema}.session_activity_intervals
         (customer_id,session_id,connection_id,status,started_at,last_confirmed_at,ended_at,end_reason)
         VALUES ($1,$2,$3,'finalised',$4,$5,$5,'session_close')`,
        [tenantId, sessionId, randomUUID(), start, end],
      );
    });
    state = await saveState({ ...state, fixtureSessionId: sessionId, stage: "usage_fixture_created" });
  }
  const observed = await lifecycle.reconcile(tenantId!, principal(), { requestId: randomUUID() });
  await saveState({ ...state, stage: "prepared" });
  print({ stage: "prepared", clockId: state.clockId, customerId: state.customerId,
    subscriptionId: state.subscriptionId, periodStart: state.periodStart, periodEnd: state.periodEnd, observed });
}

async function closePeriod() {
  const state = await requiredState();
  const target = Math.floor(new Date(state.periodEnd!).getTime() / 1_000) + 60;
  await advanceClock(state.clockId!, target);
  const observed = await lifecycle.reconcile(tenantId!, principal(), { requestId: randomUUID() });
  const finalised = await ledgers.finaliseSandboxTestClock(
    tenantId!, PROVIDER_KEY, config.billing.providerAccountKey, new Date(target * 1_000).toISOString(),
  );
  const dispatched = await outbox.dispatchNext(
    tenantId!, PROVIDER_KEY, "sandbox", config.billing.providerAccountKey, `c4b-proof:${randomUUID()}`,
  );
  const reconciliation = await outbox.reconcileNext(tenantId!, PROVIDER_KEY, "sandbox", config.billing.providerAccountKey);
  await saveState({ ...state, stage: "meter_dispatched" });
  print({ stage: "meter_dispatched", observed, finalised, dispatched, reconciliation });
}

async function finalizeInvoice() {
  const state = await requiredState();
  const target = Math.floor(new Date(state.periodEnd!).getTime() / 1_000) + 3 * 60 * 60;
  await advanceClock(state.clockId!, target);
  let result: Awaited<ReturnType<BillingLifecycleService["reconcile"]>> | null = null;
  for (let attempt = 1; attempt <= 24; attempt += 1) {
    result = await lifecycle.reconcile(tenantId!, principal(), { requestId: randomUUID() });
    if (result.meterEventReconciliation.status === "reconciled" || result.meterEventReconciliation.status === "mismatch") break;
    await delay(5_000);
  }
  await saveState({ ...state, stage: result?.meterEventReconciliation.status === "reconciled" ? "complete" : "finalize_pending" });
  print({ stage: "invoice_finalized", result });
  if (result?.meterEventReconciliation.status !== "reconciled") process.exitCode = 2;
}

async function diagnoseInvoice() {
  const state = await requiredState();
  const periodStart = unixSecond(state.periodStart!);
  const periodEnd = unixSecond(state.periodEnd!);
  if (periodStart === null || periodEnd === null) throw new Error("The stored provider period is invalid.");
  const summaryStart = ceilUnixMinute(periodStart);
  const summaryEnd = ceilUnixMinute(periodEnd);
  const price = await stripe.prices.retrieve(meteredPrice);
  const meterRef = typeof price.recurring?.meter === "string" ? price.recurring.meter : null;
  const summaries = meterRef ? await stripe.billing.meters.listEventSummaries(meterRef, {
    customer: state.customerId!, start_time: summaryStart, end_time: summaryEnd, limit: 100,
  }) : null;
  const invoices = await stripe.invoices.list({ customer: state.customerId!, limit: 100 });
  const invoiceDiagnostics: Array<Record<string, unknown>> = [];
  for (const invoice of invoices.data) {
    if (!invoice.id) {
      invoiceDiagnostics.push({ id: null, status: invoice.status, stableIdentity: false });
      continue;
    }
    const lines = await stripe.invoices.listLineItems(invoice.id, { limit: 100 });
    invoiceDiagnostics.push({
      id: invoice.id,
      status: invoice.status,
      billingReason: invoice.billing_reason,
      autoAdvance: invoice.auto_advance,
      periodStart: unixIso(invoice.period_start),
      periodEnd: unixIso(invoice.period_end),
      linesHasMore: lines.has_more,
      lines: lines.data.map((line) => ({
        id: line.id,
        priceRef: line.pricing?.price_details?.price ?? null,
        quantity: line.quantity,
        amountMinor: line.amount,
        currency: line.currency.toUpperCase(),
        periodStart: unixIso(line.period.start),
        periodEnd: unixIso(line.period.end),
        livemode: line.livemode,
      })),
    });
  }
  print({
    stage: "diagnostic",
    expected: {
      subscriptionId: state.subscriptionId,
      meteredPrice,
      providerPeriodStart: state.periodStart,
      providerPeriodEnd: state.periodEnd,
      summaryStart: unixIso(summaryStart),
      summaryEnd: unixIso(summaryEnd),
      meterRef,
    },
    summariesHasMore: summaries?.has_more ?? null,
    summaries: summaries?.data.map((summary) => ({
      id: summary.id,
      meterRef: summary.meter,
      start: unixIso(summary.start_time),
      end: unixIso(summary.end_time),
      quantity: summary.aggregated_value,
      livemode: summary.livemode,
    })) ?? [],
    invoicesHasMore: invoices.has_more,
    invoices: invoiceDiagnostics,
  });
}

async function printStatus() {
  const state = await readState();
  const evidence = await database.tenantReadTransaction(tenantId!, async (client) => client.query(
    `SELECT o.status,o.quantity,o.provider_event_ref,o.provider_accepted_at,o.reconciled_at,
            e.meter_ref,e.meter_summary_ref,e.invoice_ref,e.invoice_line_ref,e.observed_at
     FROM ${config.schema}.billing_meter_event_outbox o
     LEFT JOIN ${config.schema}.billing_meter_event_reconciliations e
       ON e.billing_meter_event_outbox_id=o.billing_meter_event_outbox_id
     WHERE o.customer_id=$1 ORDER BY o.created_at`, [tenantId],
  ));
  print({ stage: state.stage ?? "not_started", state, evidence: evidence.rows });
}

async function requiredState() {
  const state = await readState();
  if (!state.clockId || !state.customerId || !state.subscriptionId || !state.periodStart || !state.periodEnd) {
    throw new Error("Run the prepare stage first.");
  }
  return state;
}

async function readState(): Promise<ProofState> {
  const result = await database.query<{ proof: ProofState | null }>(
    `SELECT metadata->'c4bBillingProof' AS proof FROM ${config.schema}.customers WHERE customer_id=$1`, [tenantId],
  );
  return result.rows[0]?.proof ?? {};
}

async function saveState(state: ProofState): Promise<ProofState> {
  await database.query(
    `UPDATE ${config.schema}.customers SET metadata=jsonb_set(metadata,'{c4bBillingProof}',$2::jsonb,true),updated_at=now()
     WHERE customer_id=$1`, [tenantId, JSON.stringify(state)],
  );
  return state;
}

async function advanceClock(clockId: string, target: number) {
  let clock = await stripe.testHelpers.testClocks.retrieve(clockId);
  if (clock.frozen_time < target) clock = await stripe.testHelpers.testClocks.advance(clockId, { frozen_time: target });
  for (let attempt = 1; clock.status === "advancing" && attempt <= 60; attempt += 1) {
    await delay(2_000);
    clock = await stripe.testHelpers.testClocks.retrieve(clockId);
  }
  if (clock.status !== "ready" || clock.frozen_time < target) throw new Error(`Stripe test clock did not reach ready state (${clock.status}).`);
}

function subscriptionPeriod(subscription: Stripe.Subscription) {
  const item = subscription.items.data[0];
  if (!item?.current_period_start || !item.current_period_end) throw new Error("Stripe subscription has no usable provider period.");
  return { start: new Date(item.current_period_start * 1_000).toISOString(),
    end: new Date(item.current_period_end * 1_000).toISOString() };
}

function providerMetadata() {
  return { sophiaNamespace: "subscription-v1", sophiaEnvironment: "sandbox",
    sophiaProviderAccountKey: config.billing.providerAccountKey,
    sophiaTenantId: tenantId!, sophiaPlanVersionId: VOICE_PLAN_ID, sophiaProof: "P6-A06C3B0C4B" };
}

function principal(): AdminPrincipal {
  return { apiVersion: "1.0.0", identityUserId: "operator:c4b-sandbox-proof", tenantId: tenantId!,
    externalCompanyId: tenantId!, membershipId: tenantId!, role: "billing_administrator",
    permissions: ["billing.manage"], authorizationRevision: 1, mfaVerifiedAt: new Date().toISOString() };
}

function delay(milliseconds: number) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function print(value: unknown) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

function unixSecond(value: string): number | null {
  const milliseconds = Date.parse(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds % 1_000 !== 0) return null;
  return milliseconds / 1_000;
}

function ceilUnixMinute(seconds: number): number { return Math.ceil(seconds / 60) * 60; }
function unixIso(seconds: number): string { return new Date(seconds * 1_000).toISOString(); }
