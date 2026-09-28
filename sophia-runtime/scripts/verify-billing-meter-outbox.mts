import { randomUUID } from "node:crypto";
import { Client } from "pg";

const connectionString = process.env.SOPHIA_RUNTIME_DATABASE_URL;
const schema = process.env.SOPHIA_RUNTIME_SCHEMA ?? "sophia_runtime";
if (!connectionString) throw new Error("SOPHIA_RUNTIME_DATABASE_URL is required.");
if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) throw new Error("SOPHIA_RUNTIME_SCHEMA is invalid.");

const tenantId = randomUUID(); const otherTenantId = randomUUID();
const sellerId = randomUUID(); const legalVersionId = randomUUID(); const policyVersionId = randomUUID();
const planId = randomUUID(); const assignmentId = randomUUID(); const providerCustomerId = randomUUID();
const subscriptionId = randomUUID(); const ledgerId = randomUUID(); const outboxId = randomUUID();
const reconciliationId = randomUUID();
const claimToken = randomUUID(); const wrongToken = randomUUID();
const suffix = randomUUID(); const client = new Client({ connectionString, ssl: { rejectUnauthorized: true } });

await client.connect();
try {
  await client.query("BEGIN");
  await client.query(`INSERT INTO ${schema}.customers(customer_id,name)
    VALUES($1,'meter-outbox-probe'),($2,'meter-outbox-other-probe')`, [tenantId, otherTenantId]);
  await client.query(`INSERT INTO ${schema}.seller_legal_entities(seller_legal_entity_id,seller_key,status)
    VALUES($1,$2,'active')`, [sellerId, `meter-probe-${suffix}`]);
  await client.query(`INSERT INTO ${schema}.seller_legal_entity_versions(
      seller_legal_entity_version_id,seller_legal_entity_id,version,status,legal_form,jurisdiction_country,
      legal_name,effective_from,published_at)
    VALUES($1,$2,1,'published','sole_trader','AU','Rollback-only meter probe',
      '2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`, [legalVersionId, sellerId]);
  await client.query(`INSERT INTO ${schema}.seller_commercial_policy_versions(
      seller_commercial_policy_version_id,seller_legal_entity_id,seller_legal_entity_version_id,version,status,
      customer_scope,gst_registered,tax_jurisdiction_country,tax_calculation_mode,price_display_mode,effective_from,published_at)
    VALUES($1,$2,$3,1,'published','business_only',false,'AU','none','no_tax',
      '2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`, [policyVersionId, sellerId, legalVersionId]);
  await client.query(`INSERT INTO ${schema}.commercial_plan_versions(
      commercial_plan_version_id,plan_key,version,display_name,status,pricing_status,billing_currency,billing_interval,
      base_charge_minor,tax_mode,overage_rounding,rate_card,entitlements,manifest_digest,published_at,
      seller_legal_entity_id,tax_category)
    VALUES($1,$2,1,'Meter probe','published','configured','AUD','month',100,'not_applicable','ceil',
      $3::jsonb,'{}'::jsonb,repeat('a',64),'2026-01-01T00:00:00Z',$4,'standard_rate')`,
  [planId, `meter-probe-${suffix}`, JSON.stringify({ dimensions: [{ dimension: "active-seconds",
    includedQuantity: "120000", unitQuantity: "60", unitPriceMinor: "50" }] }), sellerId]);
  await client.query(`INSERT INTO ${schema}.tenant_commercial_assignments(
      commercial_assignment_id,customer_id,commercial_plan_version_id,status,effective_from,
      assigned_by_identity,assignment_reason)
    VALUES($1,$2,$3,'active','2026-01-01T00:00:00Z','meter-probe','rollback-only outbox verification')`,
  [assignmentId, tenantId, planId]);
  await client.query(`INSERT INTO ${schema}.billing_provider_customers(
      billing_provider_customer_id,customer_id,provider_key,provider_environment,provider_account_key,
      external_customer_ref,observed_at)
    VALUES($1,$2,'stripe-sophia','sandbox','legacy-primary',$3,'2026-09-01T00:00:00Z')`,
  [providerCustomerId, tenantId, `cus_probe_${suffix}`]);
  await client.query(`INSERT INTO ${schema}.billing_subscription_references(
      billing_subscription_reference_id,customer_id,provider_key,provider_environment,provider_account_key,
      external_subscription_ref,status,current_period_start,current_period_end,observed_at,seller_legal_entity_id)
    VALUES($1,$2,'stripe-sophia','sandbox','legacy-primary',$3,'active',
      '2026-08-01T00:00:00Z','2026-09-01T00:00:00Z','2026-09-01T00:00:00Z',$4)`,
  [subscriptionId, tenantId, `sub_probe_${suffix}`, sellerId]);
  const period = await client.query<{ billing_subscription_period_id: string }>(
    `SELECT billing_subscription_period_id FROM ${schema}.billing_subscription_periods
     WHERE billing_subscription_reference_id=$1`, [subscriptionId]);
  await client.query(`INSERT INTO ${schema}.billing_usage_period_ledgers(
      billing_usage_period_ledger_id,customer_id,billing_subscription_period_id,commercial_assignment_id,
      assignment_revision,assignment_effective_from,assignment_effective_to,commercial_plan_version_id,
      seller_legal_entity_version_id,seller_commercial_policy_version_id,period_start,period_end,
      active_microseconds,included_active_seconds,overage_microseconds,billable_overage_minutes,
      overage_unit_price_minor,currency,rate_card_snapshot,plan_manifest_digest,ledger_digest)
    VALUES($1,$2,$3,$4,1,'2026-01-01T00:00:00Z',NULL,$5,$6,$7,
      '2026-08-01T00:00:00Z','2026-09-01T00:00:00Z',120060000001,120000,60000001,2,
      50,'AUD',$8::jsonb,repeat('a',64),repeat('b',64))`,
  [ledgerId, tenantId, period.rows[0]?.billing_subscription_period_id, assignmentId, planId,
    legalVersionId, policyVersionId, JSON.stringify({ dimension: "active-seconds", includedQuantity: "120000",
      unitQuantity: "60", unitPriceMinor: "50" })]);

  await client.query("SET ROLE sophia_runtime_app");
  await client.query("SELECT set_config('sophia.tenant_id',$1,true)", [tenantId]);
  await client.query(`INSERT INTO ${schema}.billing_meter_event_outbox(
      billing_meter_event_outbox_id,customer_id,billing_usage_period_ledger_id,billing_provider_customer_id,
      provider_key,provider_environment,provider_account_key,external_customer_ref,meter_binding_key,
      submission_identifier,event_timestamp,quantity,quantity_unit,payload_digest)
    VALUES($1,$2,$3,$4,'stripe-sophia','sandbox','legacy-primary',$5,'active-overage-minutes',
      $6,'2026-08-31T23:59:59Z',2,'whole-minute',repeat('c',64))`,
  [outboxId, tenantId, ledgerId, providerCustomerId, `cus_probe_${suffix}`, `sophia-active-minutes-${ledgerId}`]);
  const claimed = await client.query(`UPDATE ${schema}.billing_meter_event_outbox
    SET status='leased',attempt_count=attempt_count+1,lease_owner='probe-worker',lease_token=$2,
        lease_until=now()+interval '2 minutes',updated_at=now()
    WHERE billing_meter_event_outbox_id=$1 AND status='pending' RETURNING attempt_count`, [outboxId, claimToken]);
  const staleCompletion = await client.query(`UPDATE ${schema}.billing_meter_event_outbox
    SET submission_started_at=now(),updated_at=now()
    WHERE billing_meter_event_outbox_id=$1 AND lease_token=$2 RETURNING 1`, [outboxId, wrongToken]);
  await client.query(`UPDATE ${schema}.billing_meter_event_outbox
    SET submission_started_at=now(),updated_at=now()
    WHERE billing_meter_event_outbox_id=$1 AND lease_token=$2`, [outboxId, claimToken]);
  await client.query(`UPDATE ${schema}.billing_meter_event_outbox
    SET status='outcome_unknown',lease_owner=NULL,lease_token=NULL,lease_until=NULL,
        last_error_code='probe_timeout',last_error_detail='rollback-only ambiguous submission',updated_at=now()
    WHERE billing_meter_event_outbox_id=$1`, [outboxId]);
  let ambiguousRetryDenied = false;
  await client.query("SAVEPOINT ambiguous_retry_probe");
  try {
    await client.query(`UPDATE ${schema}.billing_meter_event_outbox
      SET status='pending',submission_started_at=NULL,next_attempt_at=now(),updated_at=now()
      WHERE billing_meter_event_outbox_id=$1`, [outboxId]);
  } catch { ambiguousRetryDenied = true; await client.query("ROLLBACK TO SAVEPOINT ambiguous_retry_probe"); }
  await client.query("RELEASE SAVEPOINT ambiguous_retry_probe");
  await client.query(`INSERT INTO ${schema}.billing_meter_event_reconciliations(
      billing_meter_event_reconciliation_id,customer_id,billing_meter_event_outbox_id,
      billing_usage_period_ledger_id,provider_key,provider_environment,provider_account_key,
      provider_event_ref,meter_ref,meter_summary_ref,meter_summary_start,meter_summary_end,
      meter_summary_quantity,external_invoice_ref,external_invoice_line_ref,metered_price_ref,
      invoice_line_quantity,invoice_line_amount_minor,currency,observed_at,evidence_digest)
    VALUES($1,$2,$3,$4,'stripe-sophia','sandbox','legacy-primary',$5,$6,$7,
      '2026-08-01T00:00:00Z','2026-09-01T00:00:00Z',2,$8,$9,$10,2,100,'AUD',
      '2026-09-01T01:00:00Z',repeat('d',64))`,
  [reconciliationId, tenantId, outboxId, ledgerId, `sophia-active-minutes-${ledgerId}`,
    `mtr_${suffix}`, `mtrsum_${suffix}`, `in_${suffix}`, `il_${suffix}`, `price_${suffix}`]);
  await client.query(`UPDATE ${schema}.billing_meter_event_outbox
    SET status='reconciled',provider_event_ref=$2,provider_accepted_at='2026-09-01T01:00:00Z',
        reconciled_at='2026-09-01T01:00:00Z',last_error_code=NULL,last_error_detail=NULL,updated_at=now()
    WHERE billing_meter_event_outbox_id=$1`, [outboxId, `sophia-active-minutes-${ledgerId}`]);
  let reconciliationImmutable = false;
  await client.query("SAVEPOINT reconciliation_immutable_probe");
  try {
    await client.query(`UPDATE ${schema}.billing_meter_event_reconciliations
      SET invoice_line_amount_minor=101 WHERE billing_meter_event_reconciliation_id=$1`, [reconciliationId]);
  } catch { reconciliationImmutable = true; await client.query("ROLLBACK TO SAVEPOINT reconciliation_immutable_probe"); }
  await client.query("RELEASE SAVEPOINT reconciliation_immutable_probe");
  await client.query("SELECT set_config('sophia.tenant_id',$1,true)", [otherTenantId]);
  const crossTenant = await client.query(`SELECT 1 FROM ${schema}.billing_meter_event_outbox
    WHERE billing_meter_event_outbox_id=$1`, [outboxId]);
  const crossTenantReconciliation = await client.query(
    `SELECT 1 FROM ${schema}.billing_meter_event_reconciliations
     WHERE billing_meter_event_reconciliation_id=$1`, [reconciliationId]);
  await client.query("RESET ROLE");
  const flags = await client.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
    `SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class
     WHERE relnamespace=$1::regnamespace
       AND relname IN ('billing_meter_event_outbox','billing_meter_event_reconciliations')`, [schema]);
  const grants = await client.query<{ privilege_type: string }>(
    `SELECT privilege_type FROM information_schema.role_table_grants
     WHERE grantee='sophia_runtime_app' AND table_schema=$1 AND table_name='billing_meter_event_outbox'`, [schema]);
  const privileges = new Set(grants.rows.map((row) => row.privilege_type));
  const reconciliationGrants = await client.query<{ privilege_type: string }>(
    `SELECT privilege_type FROM information_schema.role_table_grants
     WHERE grantee='sophia_runtime_app' AND table_schema=$1
       AND table_name='billing_meter_event_reconciliations'`, [schema]);
  const reconciliationPrivileges = new Set(reconciliationGrants.rows.map((row) => row.privilege_type));
  const evidence = {
    claimedOnce: claimed.rows[0]?.attempt_count === 1,
    staleLeaseFenced: staleCompletion.rowCount === 0,
    ambiguousRetryDenied,
    reconciliationImmutable,
    crossTenantHidden: crossTenant.rowCount === 0,
    crossTenantReconciliationHidden: crossTenantReconciliation.rowCount === 0,
    forcedRls: flags.rows.length === 2
      && flags.rows.every((row) => row.relrowsecurity === true && row.relforcerowsecurity === true),
    leastPrivilege: privileges.has("SELECT") && privileges.has("INSERT") && privileges.has("UPDATE")
      && !privileges.has("DELETE") && !privileges.has("TRUNCATE"),
    reconciliationLeastPrivilege: reconciliationPrivileges.has("SELECT")
      && reconciliationPrivileges.has("INSERT") && !reconciliationPrivileges.has("UPDATE")
      && !reconciliationPrivileges.has("DELETE") && !reconciliationPrivileges.has("TRUNCATE"),
    transaction: "rolled_back",
  };
  if (Object.entries(evidence).some(([key, value]) => key !== "transaction" && value !== true)) {
    throw new Error(`Billing meter outbox verification failed: ${JSON.stringify(evidence)}`);
  }
  console.log(JSON.stringify(evidence));
} finally {
  await client.query("ROLLBACK").catch(() => undefined);
  await client.end();
}
