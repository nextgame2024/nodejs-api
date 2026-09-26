import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { DisabledBillingProvider } from "../src/admin/billing/disabled-billing.provider.js";
import { UsageBillingService } from "../src/admin/billing/usage-billing.service.js";

const connectionString = process.env.SOPHIA_RUNTIME_DATABASE_URL;
const schema = process.env.SOPHIA_RUNTIME_SCHEMA ?? "sophia_runtime";
if (!connectionString) throw new Error("SOPHIA_RUNTIME_DATABASE_URL is required.");
if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) throw new Error("SOPHIA_RUNTIME_SCHEMA is invalid.");

const tenantId = randomUUID();
const planId = randomUUID();
const assignmentId = randomUUID();
const client = new Client({ connectionString, ssl: { rejectUnauthorized: true } });

await client.connect();
try {
  await client.query("BEGIN");
  await client.query(`INSERT INTO ${schema}.customers (customer_id, name) VALUES ($1, 'commercial-read-model-probe')`, [tenantId]);
  await client.query(`INSERT INTO ${schema}.commercial_plan_versions
    (commercial_plan_version_id, plan_key, version, display_name, status, pricing_status,
     billing_currency, billing_interval, base_charge_minor, tax_mode, tax_rate_basis_points,
     overage_rounding, rate_card, entitlements, manifest_digest, published_at)
    VALUES ($1,'probe-growth',1,'Probe Growth','published','configured','AUD','month',100,
      'exclusive',1000,'ceil',$2::jsonb,'{"concurrentSessions":2}'::jsonb,repeat('a',64),now())`,
  [planId, JSON.stringify({ dimensions: [{ dimension: "reasoning-input-tokens", includedQuantity: "10",
    unitQuantity: "1", unitPriceMinor: "3" }] })]);
  await client.query(`INSERT INTO ${schema}.tenant_commercial_assignments
    (commercial_assignment_id, customer_id, commercial_plan_version_id, status, effective_from,
     assigned_by_identity, assignment_reason)
    VALUES ($1,$2,$3,'active',date_trunc('month',now()),'platform-probe','rollback-only verification')`,
  [assignmentId, tenantId, planId]);
  await client.query(`INSERT INTO ${schema}.provider_usage_events
    (customer_id, source_event_id, provider_id, adapter_key, measurement_status, usage_dimensions,
     estimated_cost_microunits, cost_currency, cost_table_version, source_digest, occurred_at)
    VALUES ($1,$2,'probe-provider','probe-v1','measured','{"reasoning-input-tokens":10.5}'::jsonb,
      1500,'AUD','provider-probe-v1',repeat('b',64),now())`, [tenantId, `commercial-${randomUUID()}`]);
  await client.query(`INSERT INTO ${schema}.billing_subscription_references
    (customer_id, provider_key, external_subscription_ref, status, current_period_start, current_period_end, observed_at)
    VALUES ($1,'probe-billing','opaque-subscription-reference','active',date_trunc('month',now()),
      date_trunc('month',now())+interval '1 month',now())`, [tenantId]);
  await client.query(`INSERT INTO ${schema}.billing_invoice_references
    (customer_id, provider_key, external_invoice_ref, status, currency, amount_due_minor, amount_paid_minor, observed_at)
    VALUES ($1,'probe-billing','opaque-invoice-reference','open','AUD',113,0,now())`, [tenantId]);

  await client.query("SET ROLE sophia_runtime_app");
  const database = {
    tenantReadTransaction: async <T>(requestedTenantId: string, work: (transactionClient: Client) => Promise<T>) => {
      await client.query("SELECT set_config('sophia.tenant_id', $1, true)", [requestedTenantId]);
      return work(client);
    },
  };
  const service = new UsageBillingService(database as never, { usage: async () => ({}) } as never,
    new DisabledBillingProvider());
  const workspace = await service.commercial(tenantId);

  await client.query("SAVEPOINT runtime_mutation_probe");
  let runtimeMutationDenied = false;
  try {
    await client.query(`INSERT INTO ${schema}.tenant_commercial_assignments
      (customer_id, commercial_plan_version_id, status, effective_from, assigned_by_identity, assignment_reason)
      VALUES ($1,$2,'scheduled',now()+interval '1 year','runtime-probe','must fail')`, [tenantId, planId]);
  } catch { runtimeMutationDenied = true; }
  await client.query("ROLLBACK TO SAVEPOINT runtime_mutation_probe");

  const flags = await client.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
    `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
     WHERE relnamespace=$1::regnamespace AND relname=ANY($2::text[])`,
    [schema, ["tenant_commercial_assignments", "billing_subscription_references", "billing_invoice_references"]]);
  const mutations = await client.query<{ table_name: string; privilege_type: string }>(
    `SELECT table_name, privilege_type FROM information_schema.role_table_grants
     WHERE grantee='sophia_runtime_app' AND table_schema=$1
       AND table_name=ANY($2::text[]) AND privilege_type<>'SELECT'`,
    [schema, ["commercial_plan_versions", "tenant_commercial_assignments",
      "billing_subscription_references", "billing_invoice_references"]]);

  await client.query("RESET ROLE");
  await client.query("SAVEPOINT retire_plan_probe");
  let publishedPlanRetirable = false;
  try {
    const retired = await client.query(`UPDATE ${schema}.commercial_plan_versions SET status='retired'
      WHERE commercial_plan_version_id=$1 RETURNING status`, [planId]);
    publishedPlanRetirable = retired.rows[0]?.status === "retired";
  } catch { publishedPlanRetirable = false; }
  await client.query("ROLLBACK TO SAVEPOINT retire_plan_probe");
  await client.query("SAVEPOINT immutable_plan_probe");
  let publishedPlanImmutable = false;
  try {
    await client.query(`UPDATE ${schema}.commercial_plan_versions SET display_name='Mutated' WHERE commercial_plan_version_id=$1`, [planId]);
  } catch { publishedPlanImmutable = true; }
  await client.query("ROLLBACK TO SAVEPOINT immutable_plan_probe");

  const evidence = {
    assignmentVisible: workspace.assignment?.planKey === "probe-growth",
    providerDisabled: workspace.providerIntegration.availability === "disabled",
    previewOnly: workspace.preview.status === "preview_only" && workspace.preview.chargeExecution === false,
    exactPreview: workspace.preview.status === "preview_only"
      && workspace.preview.lineItems[0]?.quantity === "10.5"
      && workspace.preview.lineItems[0]?.amountMinor === "2"
      && workspace.preview.totalMinor === "113",
    calendarUtcBoundary: workspace.preview.status === "preview_only"
      && workspace.preview.period.boundary === "calendar_utc",
    subscriptionReferenceVisible: workspace.subscriptions[0]?.external_subscription_ref === "opaque-subscription-reference",
    invoiceReferenceVisible: workspace.invoices[0]?.external_invoice_ref === "opaque-invoice-reference",
    runtimeMutationDenied,
    runtimeHasNoMutationGrant: mutations.rows.length === 0,
    publishedPlanRetirable,
    publishedPlanImmutable,
    tenantTablesForcedRls: flags.rows.length === 3
      && flags.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity),
    transaction: "rolled_back",
  };
  if (Object.entries(evidence).some(([key, value]) => key !== "transaction" && value !== true)) {
    throw new Error(`Commercial read-model verification failed: ${JSON.stringify(evidence)}`);
  }
  console.log(JSON.stringify(evidence));
} finally {
  await client.query("ROLLBACK").catch(() => undefined);
  await client.end();
}
