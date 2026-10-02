import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { NestFactory } from "@nestjs/core";
import Stripe from "stripe";
import { AppModule } from "../app.module.js";
import { BillingLifecycleService } from "../admin/billing/billing-lifecycle.service.js";
import { BillingInvoiceAdjustmentOutboxService } from "../admin/billing/billing-invoice-adjustment-outbox.service.js";
import { BillingInvoiceAdjustmentRecoveryService } from "../admin/billing/billing-invoice-adjustment-recovery.service.js";
import { BillingMeterOutboxService } from "../admin/billing/billing-meter-outbox.service.js";
import { BillingPeriodLedgerService } from "../admin/billing/billing-period-ledger.service.js";
import type { AdminPrincipal } from "../admin/contracts/admin-contracts.js";
import { runtimeConfig } from "../config/runtime-config.js";
import { DatabaseService } from "../database/database.service.js";

const VOICE_PLAN_ID = "112e2d08-9e8b-4748-a89a-954a28ad43c9";
const PROVIDER_KEY = "stripe-sophia";
const PROOF_CONFIRMATION = "I_UNDERSTAND_THIS_CREATES_STRIPE_SANDBOX_OBJECTS";
const PROOF_VARIANT = "draft-invoice-adjustment-v1";
const RECOVERY_PROOF_VARIANT = "missed-window-carry-forward-v1";
const stage = process.argv[2];
const tenantId = process.env.SOPHIA_C4B_TENANT_ID;

if (!tenantId || !/^[0-9a-f-]{36}$/i.test(tenantId)) throw new Error("SOPHIA_C4B_TENANT_ID must be the approved synthetic tenant UUID.");
if (process.env.SOPHIA_C4B_CONFIRM !== PROOF_CONFIRMATION) throw new Error(`Set SOPHIA_C4B_CONFIRM=${PROOF_CONFIRMATION}.`);
if (!new Set(["prepare", "close", "finalize", "diagnose", "status",
  "prepare-recovery", "diagnose-recovery", "miss-recovery", "recover", "finalize-recovery"]).has(stage ?? "")) {
  throw new Error("Usage: npm run billing:c4b-sandbox -- prepare|close|finalize|diagnose|status|prepare-recovery|diagnose-recovery|miss-recovery|recover|finalize-recovery");
}

const config = runtimeConfig();
if (config.billing.provider !== "stripe_sandbox" || !config.billing.stripeSecretKey?.startsWith("sk_test_")) {
  throw new Error("C4B proof requires the deployed Sophia Stripe sandbox adapter and a test-mode key.");
}
const basePrice = config.billing.stripePriceMappings[VOICE_PLAN_ID];
const meteredPrice = config.billing.stripeMeteredPriceMappings[VOICE_PLAN_ID];
const overagePrice = config.billing.stripeOveragePriceMappings[VOICE_PLAN_ID];
if (!basePrice || !meteredPrice || !overagePrice || !config.billing.stripeMeterBindings["active-overage-minutes"]) {
  throw new Error("The approved Sophia Voice base, Meter-evidence, one-time overage Price and Meter binding must all be configured.");
}

const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
const database = app.get(DatabaseService);
const lifecycle = app.get(BillingLifecycleService);
const ledgers = app.get(BillingPeriodLedgerService);
const outbox = app.get(BillingMeterOutboxService);
const invoiceAdjustments = app.get(BillingInvoiceAdjustmentOutboxService);
const invoiceAdjustmentRecovery = app.get(BillingInvoiceAdjustmentRecoveryService);
const stripe = new Stripe(config.billing.stripeSecretKey, { apiVersion: "2025-08-27.basil", maxNetworkRetries: 2 });

try {
  await assertFixtureAuthority();
  if (stage === "prepare") await prepare();
  if (stage === "close") await closePeriod();
  if (stage === "finalize") await finalizeInvoice();
  if (stage === "diagnose") await diagnoseInvoice();
  if (stage === "status") await printStatus();
  if (stage === "prepare-recovery") await prepareRecovery();
  if (stage === "diagnose-recovery") await diagnoseRecovery();
  if (stage === "miss-recovery") await missRecovery();
  if (stage === "recover") await recoverMissedAdjustment();
  if (stage === "finalize-recovery") await finalizeRecovery();
} finally {
  await app.close();
}

type ProofState = {
  proofVariant?: string;
  clockId?: string;
  customerId?: string;
  subscriptionId?: string;
  paymentMethodId?: string;
  periodStart?: string;
  periodEnd?: string;
  recoveryPeriodStart?: string;
  recoveryPeriodEnd?: string;
  missedInvoiceId?: string;
  recoveryInvoiceId?: string;
  fixtureSessionId?: string;
  stage?: string;
};

async function prepareRecovery() {
  let state = await readState();
  if (Object.keys(state).length > 0 && state.proofVariant !== RECOVERY_PROOF_VARIANT) {
    throw new Error("Use a fresh isolated synthetic tenant for missed-window recovery proof.");
  }
  if (!state.clockId) {
    const clock = await stripe.testHelpers.testClocks.create({
      frozen_time: Math.floor(Date.now() / 1_000), name: `Sophia C4B recovery ${tenantId}`,
    });
    state = await saveState({ ...state, proofVariant: RECOVERY_PROOF_VARIANT,
      clockId: clock.id, stage: "recovery_clock_created" });
  }
  if (!state.customerId) {
    const customer = await stripe.customers.create({ test_clock: state.clockId,
      name: "Sophia C4B missed-window synthetic tenant", metadata: providerMetadata() });
    state = await saveState({ ...state, customerId: customer.id, stage: "recovery_customer_created" });
  }
  let paymentMethodId = state.paymentMethodId;
  if (!paymentMethodId) {
    paymentMethodId = (await stripe.paymentMethods.attach("pm_card_visa", { customer: state.customerId! })).id;
    state = await saveState({ ...state, paymentMethodId, stage: "recovery_payment_method_attached" });
  }
  await stripe.customers.update(state.customerId!, { invoice_settings: { default_payment_method: paymentMethodId } });
  if (!state.subscriptionId) {
    const subscription = await stripe.subscriptions.create({ customer: state.customerId!,
      items: [{ price: basePrice, quantity: 1 }], collection_method: "charge_automatically",
      payment_behavior: "error_if_incomplete", metadata: providerMetadata() });
    const period = subscriptionPeriod(subscription);
    state = await saveState({ ...state, subscriptionId: subscription.id,
      periodStart: period.start, periodEnd: period.end, stage: "recovery_subscription_created" });
  }
  if (!state.fixtureSessionId) {
    const start = new Date(state.periodStart!);
    const end = new Date(start.getTime() + (120_000 + 61) * 1_000);
    const sessionId = randomUUID();
    await database.tenantTransaction(tenantId!, async (client) => {
      await client.query(
        `INSERT INTO ${config.schema}.sessions
         (session_id,customer_id,ai_provider,avatar_provider,status,started_at,ended_at,metadata)
         VALUES ($1,$2,'synthetic-c4b','synthetic-c4b','closed',$3,$4,'{"sandboxRecoveryProof":true}'::jsonb)`,
        [sessionId, tenantId, start, end]);
      await client.query(
        `INSERT INTO ${config.schema}.session_activity_intervals
         (customer_id,session_id,connection_id,status,started_at,last_confirmed_at,ended_at,end_reason)
         VALUES ($1,$2,$3,'finalised',$4,$5,$5,'session_close')`,
        [tenantId, sessionId, randomUUID(), start, end]);
    });
    state = await saveState({ ...state, fixtureSessionId: sessionId, stage: "recovery_usage_fixture_created" });
  }
  print({ stage: "recovery_prepared_unbound", clockId: state.clockId, customerId: state.customerId,
    subscriptionId: state.subscriptionId, periodStart: state.periodStart, periodEnd: state.periodEnd,
    providerCustomerBound: false });
}

async function missRecovery() {
  let state = await requiredRecoveryState();
  const target = Math.floor(new Date(state.periodEnd!).getTime() / 1_000) + 3 * 60 * 60;
  await advanceClock(state.clockId!, target);
  const subscription = await stripe.subscriptions.retrieve(state.subscriptionId!);
  const recoveryPeriod = subscriptionPeriod(subscription);
  await database.tenantTransaction(tenantId!, async (client) => {
    await client.query(
      `INSERT INTO ${config.schema}.billing_provider_customers
       (customer_id,provider_key,provider_environment,provider_account_key,external_customer_ref,observed_at)
       VALUES ($1,$2,'sandbox',$3,$4,now()) ON CONFLICT DO NOTHING`,
      [tenantId, PROVIDER_KEY, config.billing.providerAccountKey, state.customerId]);
    await client.query(
      `INSERT INTO ${config.schema}.billing_subscription_references
       (customer_id,provider_key,provider_environment,provider_account_key,external_subscription_ref,status,
        current_period_start,current_period_end,observed_at)
       VALUES ($1,$2,'sandbox',$3,$4,'active',$5,$6,$6)
       ON CONFLICT (provider_key,provider_environment,provider_account_key,external_subscription_ref) DO NOTHING`,
      [tenantId, PROVIDER_KEY, config.billing.providerAccountKey, state.subscriptionId,
        state.periodStart, state.periodEnd]);
  });
  const observed = await lifecycle.reconcile(tenantId!, principal(), { requestId: randomUUID() });
  const finalised = await ledgers.finaliseSandboxTestClock(
    tenantId!, PROVIDER_KEY, config.billing.providerAccountKey, new Date(target * 1_000).toISOString());
  const invoices = await stripe.invoices.list({ customer: state.customerId!, limit: 100 });
  const start = unixSecond(state.periodStart!); const end = unixSecond(state.periodEnd!);
  const originals = invoices.data.filter((invoice) => invoice.billing_reason === "subscription_cycle"
    && invoice.period_start === start && invoice.period_end === end);
  if (originals.length !== 1) {
    throw new Error("The proof requires exactly one original renewal invoice for the immutable period.");
  }
  let original = originals[0];
  const originalInvoiceId = original.id;
  if (!originalInvoiceId) {
    throw new Error("The original renewal invoice has no stable provider identity.");
  }
  if (original.status === "draft") {
    original = await stripe.invoices.finalizeInvoice(originalInvoiceId, { auto_advance: false });
  }
  if (!original.id || !["open", "paid"].includes(original.status ?? "")) {
    throw new Error(`The original renewal invoice did not reach a finalized billable state (${original.status}).`);
  }
  state = await saveState({ ...state, recoveryPeriodStart: recoveryPeriod.start,
    recoveryPeriodEnd: recoveryPeriod.end, missedInvoiceId: original.id,
    stage: "recovery_original_invoice_finalized" });
  const enqueued = await invoiceAdjustments.enqueueDraftInvoice(tenantId!, {
    providerKey: PROVIDER_KEY, providerEnvironment: "sandbox", providerAccountKey: config.billing.providerAccountKey,
    externalCustomerRef: state.customerId!, externalSubscriptionRef: state.subscriptionId!,
    externalInvoiceRef: original.id, periodStart: state.periodStart!, periodEnd: state.periodEnd!,
  });
  const dispatched = await invoiceAdjustments.dispatchNext(tenantId!, PROVIDER_KEY, "sandbox",
    config.billing.providerAccountKey, `c4b-missed-window:${randomUUID()}`);
  const missedAdjustment = dispatched.status === "missed_window" ? dispatched
    : await waitForAdjustment(["missed_window", "provider_accepted", "reconciled", "terminal_failed"]);
  if (missedAdjustment?.status !== "missed_window") {
    throw new Error("The original adjustment did not prove a missed draft window.");
  }
  state = await saveState({ ...state, stage: "recovery_window_missed" });
  print({ stage: "recovery_window_missed", observed, finalised, enqueued, dispatched, missedAdjustment,
    missedInvoiceId: state.missedInvoiceId, recoveryPeriodStart: state.recoveryPeriodStart,
    recoveryPeriodEnd: state.recoveryPeriodEnd });
}

async function diagnoseRecovery() {
  const state = await requiredRecoveryState();
  const [clock, subscription, invoices, local] = await Promise.all([
    stripe.testHelpers.testClocks.retrieve(state.clockId!),
    stripe.subscriptions.retrieve(state.subscriptionId!),
    stripe.invoices.list({ customer: state.customerId!, limit: 100 }),
    database.tenantReadTransaction(tenantId!, async (client) => client.query(
      `SELECT
         (SELECT count(*)::int FROM ${config.schema}.billing_provider_customers
           WHERE customer_id=$1) AS provider_bindings,
         (SELECT count(*)::int FROM ${config.schema}.billing_subscription_periods
           WHERE customer_id=$1) AS observed_periods,
         (SELECT count(*)::int FROM ${config.schema}.billing_usage_period_ledgers
           WHERE customer_id=$1) AS usage_ledgers,
         (SELECT count(*)::int FROM ${config.schema}.billing_invoice_adjustment_outbox
           WHERE customer_id=$1) AS invoice_adjustments`, [tenantId],
    )),
  ]);
  const invoiceDiagnostics = [];
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
      subscriptionRef: typeof invoice.parent?.subscription_details?.subscription === "string"
        ? invoice.parent.subscription_details.subscription
        : invoice.parent?.subscription_details?.subscription?.id ?? null,
      periodStart: unixIso(invoice.period_start),
      periodEnd: unixIso(invoice.period_end),
      createdAt: unixIso(invoice.created),
      amountDueMinor: invoice.amount_due,
      amountPaidMinor: invoice.amount_paid,
      linesHasMore: lines.has_more,
      lines: lines.data.map((line) => ({
        id: line.id,
        priceRef: line.pricing?.price_details?.price ?? null,
        quantity: line.quantity,
        amountMinor: line.amount,
        periodStart: unixIso(line.period.start),
        periodEnd: unixIso(line.period.end),
      })),
    });
  }
  print({ stage: "recovery_diagnostic", state, clock: { id: clock.id, status: clock.status,
    frozenTime: unixIso(clock.frozen_time) }, subscription: { id: subscription.id, status: subscription.status,
    ...subscriptionPeriod(subscription) }, local: local.rows[0] ?? null,
    invoicesHasMore: invoices.has_more, invoices: invoiceDiagnostics });
}

async function recoverMissedAdjustment() {
  let state = await requiredRecoveryState();
  if (!state.recoveryPeriodEnd) throw new Error("Run miss-recovery first.");
  const target = Math.floor(new Date(state.recoveryPeriodEnd).getTime() / 1_000) + 60;
  await advanceClock(state.clockId!, target);
  const recovery = await waitForRecovery(["provider_accepted", "reconciled", "reconciliation_failed",
    "missed_window", "terminal_failed"]);
  if (!recovery || !["provider_accepted", "reconciled"].includes(recovery.status)) {
    throw new Error("The missed adjustment was not authoritatively attached to the next draft renewal invoice.");
  }
  state = await saveState({ ...state, recoveryInvoiceId: recovery.target_external_invoice_ref,
    stage: "recovery_attached" });
  print({ stage: "recovery_attached", recovery });
}

async function finalizeRecovery() {
  const state = await requiredRecoveryState();
  if (!state.recoveryPeriodEnd || !state.recoveryInvoiceId) throw new Error("Run recover first.");
  const target = Math.floor(new Date(state.recoveryPeriodEnd).getTime() / 1_000) + 3 * 60 * 60;
  await advanceClock(state.clockId!, target);
  let reconciliation: Awaited<ReturnType<BillingInvoiceAdjustmentRecoveryService["reconcileInvoice"]>> | null = null;
  for (let attempt = 1; attempt <= 24; attempt += 1) {
    reconciliation = await invoiceAdjustmentRecovery.reconcileInvoice(tenantId!, PROVIDER_KEY, "sandbox",
      config.billing.providerAccountKey, state.recoveryInvoiceId);
    if (reconciliation.status === "reconciled" || reconciliation.status === "mismatch") break;
    await delay(5_000);
  }
  await saveState({ ...state, stage: reconciliation?.status === "reconciled" ? "recovery_complete" : "recovery_pending" });
  print({ stage: "recovery_finalized", expected: { originalPeriodStart: state.periodStart,
    originalPeriodEnd: state.periodEnd, quantity: 2, amountMinor: 20, oneTimeOveragePrice: overagePrice },
    reconciliation });
  if (reconciliation?.status !== "reconciled") process.exitCode = 2;
}

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
  if (Object.keys(state).length > 0 && state.proofVariant !== PROOF_VARIANT) {
    throw new Error("This tenant contains legacy C4B evidence. Use a fresh isolated synthetic tenant for C4B3.");
  }
  if (!state.clockId) {
    const clock = await stripe.testHelpers.testClocks.create({
      frozen_time: Math.floor(Date.now() / 1_000), name: `Sophia C4B ${tenantId}`,
    });
    state = await saveState({ ...state, proofVariant: PROOF_VARIANT, clockId: clock.id, stage: "clock_created" });
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
      items: [{ price: basePrice, quantity: 1 }],
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
  const finalised = await ledgers.finaliseSandboxTestClock(
    tenantId!, PROVIDER_KEY, config.billing.providerAccountKey, new Date(target * 1_000).toISOString(),
  );
  const observed = await lifecycle.reconcile(tenantId!, principal(), { requestId: randomUUID() });
  const dispatched = await outbox.dispatchNext(
    tenantId!, PROVIDER_KEY, "sandbox", config.billing.providerAccountKey, `c4b-proof:${randomUUID()}`,
  );
  const reconciliation = await outbox.reconcileNext(tenantId!, PROVIDER_KEY, "sandbox", config.billing.providerAccountKey);
  const adjustment = await waitForAdjustment(["provider_accepted", "reconciled", "reconciliation_failed", "missed_window", "terminal_failed"]);
  await saveState({ ...state, stage: adjustment?.status === "provider_accepted" || adjustment?.status === "reconciled"
    ? "adjustment_attached" : "adjustment_incomplete" });
  print({ stage: "adjustment_attached", observed, finalised, meterEvidence: { dispatched, reconciliation }, adjustment });
  if (!adjustment || !["provider_accepted", "reconciled"].includes(adjustment.status)) process.exitCode = 2;
}

async function finalizeInvoice() {
  const state = await requiredState();
  const target = Math.floor(new Date(state.periodEnd!).getTime() / 1_000) + 3 * 60 * 60;
  await advanceClock(state.clockId!, target);
  const adjustment = await waitForAdjustment(["provider_accepted", "reconciled", "reconciliation_failed"]);
  if (!adjustment) throw new Error("No C4B3 invoice adjustment exists for the fresh fixture.");
  let invoiceReconciliation: Awaited<ReturnType<BillingInvoiceAdjustmentOutboxService["reconcileInvoice"]>> | null = null;
  for (let attempt = 1; attempt <= 24; attempt += 1) {
    invoiceReconciliation = await invoiceAdjustments.reconcileInvoice(tenantId!, PROVIDER_KEY, "sandbox",
      config.billing.providerAccountKey, adjustment.external_invoice_ref);
    if (invoiceReconciliation.status === "reconciled" || invoiceReconciliation.status === "mismatch") break;
    await delay(5_000);
  }
  const meterEvidence = await lifecycle.reconcile(tenantId!, principal(), { requestId: randomUUID() });
  await saveState({ ...state, stage: invoiceReconciliation?.status === "reconciled" ? "complete" : "finalize_pending" });
  print({ stage: "invoice_finalized", expected: { oneTimeOveragePrice: overagePrice },
    invoiceReconciliation, meterEvidence });
  if (invoiceReconciliation?.status !== "reconciled") process.exitCode = 2;
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
            e.meter_ref,e.meter_summary_ref,e.external_invoice_ref,e.external_invoice_line_ref,e.observed_at
     FROM ${config.schema}.billing_meter_event_outbox o
     LEFT JOIN ${config.schema}.billing_meter_event_reconciliations e
       ON e.billing_meter_event_outbox_id=o.billing_meter_event_outbox_id
     WHERE o.customer_id=$1 ORDER BY o.created_at`, [tenantId],
  ));
  const adjustments = await database.tenantReadTransaction(tenantId!, async (client) => client.query(
    `SELECT o.status,o.external_invoice_ref,o.one_time_price_ref,o.quantity,o.unit_price_minor,o.currency,
            o.provider_invoice_item_ref,o.provider_accepted_at,o.reconciled_at,
            e.provider_invoice_line_ref,e.amount_minor,e.invoice_status,e.observed_at
     FROM ${config.schema}.billing_invoice_adjustment_outbox o
     LEFT JOIN ${config.schema}.billing_invoice_adjustment_reconciliations e
       ON e.billing_invoice_adjustment_outbox_id=o.billing_invoice_adjustment_outbox_id
     WHERE o.customer_id=$1 ORDER BY o.created_at`, [tenantId],
  ));
  const recoveries = await database.tenantReadTransaction(tenantId!, async (client) => client.query(
    `SELECT recovery.status,recovery.target_external_invoice_ref,recovery.target_period_start,
            recovery.target_period_end,recovery.provider_invoice_item_ref,recovery.provider_accepted_at,
            recovery.reconciled_at,source.period_start AS original_period_start,
            source.period_end AS original_period_end,source.quantity,source.unit_price_minor,source.currency,
            evidence.provider_invoice_line_ref,evidence.amount_minor,evidence.invoice_status,evidence.observed_at
     FROM ${config.schema}.billing_invoice_adjustment_recovery_attempts recovery
     JOIN ${config.schema}.billing_invoice_adjustment_outbox source
       ON source.billing_invoice_adjustment_outbox_id=recovery.source_billing_invoice_adjustment_outbox_id
      AND source.customer_id=recovery.customer_id
     LEFT JOIN ${config.schema}.billing_invoice_adjustment_recovery_reconciliations evidence
       ON evidence.billing_invoice_adjustment_recovery_attempt_id=recovery.billing_invoice_adjustment_recovery_attempt_id
     WHERE recovery.customer_id=$1 ORDER BY recovery.created_at`, [tenantId],
  ));
  print({ stage: state.stage ?? "not_started", state, meterEvidence: evidence.rows,
    invoiceAdjustmentEvidence: adjustments.rows, invoiceAdjustmentRecoveryEvidence: recoveries.rows });
}

async function waitForAdjustment(statuses: string[]) {
  for (let attempt = 1; attempt <= 24; attempt += 1) {
    const result = await database.tenantReadTransaction(tenantId!, async (client) => client.query<{
      status: string; external_invoice_ref: string;
    }>(
      `SELECT status,external_invoice_ref FROM ${config.schema}.billing_invoice_adjustment_outbox
       WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 1`, [tenantId],
    ));
    const row = result.rows[0];
    if (row && statuses.includes(row.status)) return row;
    await delay(5_000);
  }
  return null;
}

async function waitForRecovery(statuses: string[]) {
  for (let attempt = 1; attempt <= 24; attempt += 1) {
    const result = await database.tenantReadTransaction(tenantId!, async (client) => client.query<{
      status: string; target_external_invoice_ref: string; provider_invoice_item_ref: string | null;
      original_period_start: Date | string; original_period_end: Date | string;
      target_period_start: Date | string; target_period_end: Date | string;
    }>(
      `SELECT recovery.status,recovery.target_external_invoice_ref,recovery.provider_invoice_item_ref,
              source.period_start AS original_period_start,source.period_end AS original_period_end,
              recovery.target_period_start,recovery.target_period_end
       FROM ${config.schema}.billing_invoice_adjustment_recovery_attempts recovery
       JOIN ${config.schema}.billing_invoice_adjustment_outbox source
         ON source.billing_invoice_adjustment_outbox_id=recovery.source_billing_invoice_adjustment_outbox_id
        AND source.customer_id=recovery.customer_id
       WHERE recovery.customer_id=$1 ORDER BY recovery.created_at DESC LIMIT 1`, [tenantId],
    ));
    const row = result.rows[0];
    if (row && statuses.includes(row.status)) return row;
    await delay(5_000);
  }
  return null;
}

async function requiredState() {
  const state = await readState();
  if (!state.clockId || !state.customerId || !state.subscriptionId || !state.periodStart || !state.periodEnd) {
    throw new Error("Run the prepare stage first.");
  }
  if (state.proofVariant !== PROOF_VARIANT) throw new Error("Use a fresh isolated C4B3 tenant; legacy evidence cannot be reused.");
  return state;
}

async function requiredRecoveryState() {
  const state = await readState();
  if (!state.clockId || !state.customerId || !state.subscriptionId || !state.periodStart || !state.periodEnd) {
    throw new Error("Run the prepare-recovery stage first.");
  }
  if (state.proofVariant !== RECOVERY_PROOF_VARIANT) {
    throw new Error("Use a fresh isolated missed-window recovery tenant; other evidence cannot be reused.");
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
