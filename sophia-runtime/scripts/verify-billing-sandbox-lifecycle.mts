import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { BillingLifecycleService } from "../src/admin/billing/billing-lifecycle.service.js";
import type { BillingProvider, BillingWebhookEvidence } from "../src/admin/billing/billing-provider.port.js";

const connectionString = process.env.SOPHIA_RUNTIME_DATABASE_URL;
const schema = process.env.SOPHIA_RUNTIME_SCHEMA ?? "sophia_runtime";
if (!connectionString) throw new Error("SOPHIA_RUNTIME_DATABASE_URL is required.");
if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) throw new Error("SOPHIA_RUNTIME_SCHEMA is invalid.");

const tenantId = randomUUID(); const otherTenantId = randomUUID(); const planId = randomUUID();
const customerRef = `cus_sophia_${randomUUID()}`; const subscriptionRef = `sub_sophia_${randomUUID()}`;
const invoiceRef = `in_sophia_${randomUUID()}`; let currentEvent: BillingWebhookEvidence;
const checkoutRef = `cs_sophia_${randomUUID()}`; const checkoutRequestId = randomUUID();
const client = new Client({ connectionString, ssl: { rejectUnauthorized: true } });

await client.connect();
try {
  await client.query("BEGIN");
  await client.query(`INSERT INTO ${schema}.customers(customer_id,name) VALUES($1,'billing-sandbox-probe'),($2,'other-billing-probe')`,
    [tenantId, otherTenantId]);
  await client.query(`INSERT INTO ${schema}.commercial_plan_versions
    (commercial_plan_version_id,plan_key,version,display_name,status,pricing_status,billing_currency,billing_interval,
     base_charge_minor,tax_mode,overage_rounding,rate_card,entitlements,manifest_digest,published_at)
    VALUES($1,$2,1,'Billing sandbox probe','published','configured','AUD','month',1000,'not_applicable','ceil',
      '{"dimensions":[]}'::jsonb,'{}'::jsonb,repeat('e',64),now())`, [planId, `billing-probe-${randomUUID()}`]);
  await client.query(`INSERT INTO ${schema}.tenant_commercial_assignments
    (customer_id,commercial_plan_version_id,status,effective_from,assigned_by_identity,assignment_reason)
    VALUES($1,$2,'active',now()-interval '1 minute','platform-probe','rollback-only billing sandbox verification')`, [tenantId, planId]);

  await client.query("SET ROLE sophia_runtime_app");
  const database = {
    query: <T>(sql: string, params?: unknown[]) => client.query<T & Record<string, unknown>>(sql, params),
    tenantTransaction: async <T>(requestedTenant: string, work: (transactionClient: Client) => Promise<T>) => {
      await client.query("SELECT set_config('sophia.tenant_id',$1,true)", [requestedTenant]); return work(client);
    },
    tenantReadTransaction: async <T>(requestedTenant: string, work: (transactionClient: Client) => Promise<T>) => {
      await client.query("SELECT set_config('sophia.tenant_id',$1,true)", [requestedTenant]); return work(client);
    },
  };
  const provider: BillingProvider = {
    status: () => ({ availability: "sandbox", providerKey: "stripe-sophia", checkout: true, portal: true,
      signedWebhooks: true, reconciliation: true, missingConfiguration: [], detail: "synthetic rollback probe" }),
    mappedPlanVersionIds: () => new Set([planId]), createHostedCheckout: async () => { throw new Error("not used"); },
    createHostedPortal: async () => { throw new Error("not used"); },
    verifyWebhook: async () => currentEvent, reconcileTenant: async () => { throw new Error("not used"); },
  };
  const lifecycle = new BillingLifecycleService(database as never, provider, { record: async () => undefined } as never);
  await client.query("SELECT set_config('sophia.tenant_id',$1,true)", [tenantId]);
  await client.query(`INSERT INTO ${schema}.billing_checkout_intents
    (customer_id,provider_key,provider_environment,request_id,commercial_plan_version_id,external_checkout_ref,status,created_at,expires_at)
    VALUES($1,'stripe-sophia','sandbox',$2,$3,$4,'created','2026-09-25T23:55:00.000Z','2026-09-26T00:30:00.000Z')`,
  [tenantId, checkoutRequestId, planId, checkoutRef]);
  currentEvent = event("evt-checkout", "checkout.session.completed", "2026-09-26T00:00:00.000Z", {
    tenantHint: tenantId, planVersionHint: planId, checkoutRef,
    subscription: { externalRef: subscriptionRef, status: "pending", currentPeriodStart: null,
      currentPeriodEnd: null, observedAt: "2026-09-26T00:00:00.000Z" },
  });
  const checkout = await lifecycle.webhook({ "stripe-signature": "synthetic-verified-by-provider" }, Buffer.from("checkout"));
  const duplicate = await lifecycle.webhook({ "stripe-signature": "synthetic-verified-by-provider" }, Buffer.from("checkout"));
  currentEvent = event("evt-invoice-new", "invoice.paid", "2026-09-26T02:00:00.000Z", {
    invoice: invoice("paid", "2026-09-26T02:00:00.000Z"),
  });
  await lifecycle.webhook({ "stripe-signature": "synthetic-verified-by-provider" }, Buffer.from("invoice-new"));
  currentEvent = event("evt-invoice-old", "invoice.created", "2026-09-26T01:00:00.000Z", {
    invoice: invoice("open", "2026-09-26T01:00:00.000Z"),
  });
  await lifecycle.webhook({ "stripe-signature": "synthetic-verified-by-provider" }, Buffer.from("invoice-old"));

  await client.query("SELECT set_config('sophia.tenant_id',$1,true)", [tenantId]);
  const invoiceState = await client.query<{ status: string; revision: number }>(
    `SELECT status,revision FROM ${schema}.billing_invoice_references WHERE external_invoice_ref=$1`, [invoiceRef]);
  const route = await client.query<{ tenant_id: string }>(
    `SELECT ${schema}.resolve_billing_customer_tenant('stripe-sophia','sandbox',$1) AS tenant_id`, [customerRef]);
  const eventCount = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${schema}.billing_webhook_events WHERE customer_id=$1`, [tenantId]);
  const checkoutIntent = await client.query<{ status: string; external_checkout_ref: string }>(
    `SELECT status,external_checkout_ref FROM ${schema}.billing_checkout_intents WHERE customer_id=$1 AND request_id=$2`,
    [tenantId, checkoutRequestId]);
  let referenceIdentityMutationDenied = false;
  await client.query("SAVEPOINT immutable_reference_probe");
  try {
    await client.query(`UPDATE ${schema}.billing_invoice_references
      SET external_invoice_ref=$2,revision=revision+1,observed_at=observed_at+interval '1 second'
      WHERE customer_id=$1 AND external_invoice_ref=$3`, [tenantId, `in_rewritten_${randomUUID()}`, invoiceRef]);
  } catch { referenceIdentityMutationDenied = true; await client.query("ROLLBACK TO SAVEPOINT immutable_reference_probe"); }
  await client.query("RELEASE SAVEPOINT immutable_reference_probe");
  await client.query("SELECT set_config('sophia.tenant_id',$1,true)", [otherTenantId]);
  const crossTenant = await client.query(`SELECT 1 FROM ${schema}.billing_provider_customers WHERE external_customer_ref=$1`, [customerRef]);
  const flags = await client.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
    `SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class
     WHERE relnamespace=$1::regnamespace AND relname=ANY($2::text[])`,
    [schema, ["billing_provider_customers", "billing_webhook_events", "billing_checkout_intents"]]);
  const evidence = {
    checkoutMapped: checkout.received === true && checkout.duplicate === false,
    issuedCheckoutIntentCompleted: checkoutIntent.rows[0]?.status === "completed"
      && checkoutIntent.rows[0]?.external_checkout_ref === checkoutRef,
    webhookReplayDeduplicated: duplicate.duplicate === true && eventCount.rows[0]?.count === "3",
    customerRoutingResolved: route.rows[0]?.tenant_id === tenantId,
    staleInvoiceIgnored: invoiceState.rows[0]?.status === "paid" && invoiceState.rows[0]?.revision === 1,
    referenceIdentityMutationDenied,
    crossTenantCustomerHidden: crossTenant.rows.length === 0,
    billingTablesForcedRls: flags.rows.length === 3 && flags.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity),
    transaction: "rolled_back",
  };
  if (Object.entries(evidence).some(([key, value]) => key !== "transaction" && value !== true)) {
    throw new Error(`Billing sandbox verification failed: ${JSON.stringify(evidence)}`);
  }
  console.log(JSON.stringify(evidence));
} finally {
  await client.query("ROLLBACK").catch(() => undefined); await client.end();
}

function event(eventId: string, eventType: string, occurredAt: string,
  values: Partial<Pick<BillingWebhookEvidence, "tenantHint" | "planVersionHint" | "checkoutRef" | "subscription" | "invoice">>): BillingWebhookEvidence {
  return { providerKey: "stripe-sophia", environment: "sandbox", eventId, eventType, occurredAt,
    payloadDigest: "a".repeat(64), customerRef, checkoutRef: null, tenantHint: null, planVersionHint: null,
    subscription: null, invoice: null, ...values };
}
function invoice(status: "open" | "paid", observedAt: string) {
  return { externalRef: invoiceRef, status, currency: "AUD", amountDueMinor: "1000",
    amountPaidMinor: status === "paid" ? "1000" : "0", hostedInvoiceUrl: "https://invoice.test/sophia",
    dueAt: null, observedAt };
}
