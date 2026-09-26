import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { AdminAuditService } from "../src/admin/authorization/admin-audit.service.js";
import { UsageGuardrailService } from "../src/admin/billing/usage-guardrail.service.js";
import { RuntimeAdmissionService } from "../src/platform/admission/runtime-admission.service.js";

const connectionString = process.env.SOPHIA_RUNTIME_DATABASE_URL;
const schema = process.env.SOPHIA_RUNTIME_SCHEMA ?? "sophia_runtime";
if (!connectionString) throw new Error("SOPHIA_RUNTIME_DATABASE_URL is required.");
if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) throw new Error("SOPHIA_RUNTIME_SCHEMA is invalid.");

process.env.SOPHIA_MAX_CONCURRENT_SESSIONS = "10";
process.env.SOPHIA_MAX_TOOL_CALLS_PER_MINUTE = "20";
const tenantId = randomUUID(); const otherTenantId = randomUUID(); const planId = randomUUID();
const sessionId = randomUUID(); const client = new Client({ connectionString, ssl: { rejectUnauthorized: true } });

await client.connect();
try {
  await client.query("BEGIN");
  await client.query(`INSERT INTO ${schema}.customers(customer_id,name) VALUES($1,'guardrail-probe'),($2,'other-guardrail-probe')`,
    [tenantId, otherTenantId]);
  await client.query(`INSERT INTO ${schema}.commercial_plan_versions
    (commercial_plan_version_id,plan_key,version,display_name,status,pricing_status,billing_currency,billing_interval,
     base_charge_minor,tax_mode,overage_rounding,rate_card,entitlements,manifest_digest,published_at)
    VALUES($1,'guardrail-plan',1,'Guardrail probe','published','configured','AUD','month',0,'not_applicable','ceil',
      '{"dimensions":[]}'::jsonb,'{"concurrentSessions":4,"toolCallsPerMinute":6}'::jsonb,repeat('c',64),now())`, [planId]);
  await client.query(`INSERT INTO ${schema}.tenant_commercial_assignments
    (customer_id,commercial_plan_version_id,status,effective_from,assigned_by_identity,assignment_reason)
    VALUES($1,$2,'active',date_trunc('month',now()),'platform-probe','rollback-only guardrail verification')`, [tenantId, planId]);
  await client.query(`INSERT INTO ${schema}.tenant_usage_guardrails
    (customer_id,max_concurrent_sessions,max_tool_calls_per_minute,provider_cost_alert_microunits,
     provider_cost_alert_currency,updated_by_identity)
    VALUES($1,2,2,1000,'AUD','billing-probe'),($2,1,1,NULL,NULL,'other-probe')`, [tenantId, otherTenantId]);
  await client.query(`INSERT INTO ${schema}.sessions
    (session_id,customer_id,ai_provider,avatar_provider,status,runtime_api_version,session_plan_snapshot)
    VALUES($1,$2,'probe','none','active','v1',NULL)`,
  [sessionId, tenantId]);
  await client.query(`INSERT INTO ${schema}.provider_session_allocations
    (customer_id,session_id,lifecycle_adapter_key,experience_key,stage,cleanup_after,attached_at)
    VALUES($1,$2,'probe','probe','attached',now()+interval '10 minutes',now())`, [tenantId, sessionId]);
  await client.query(`INSERT INTO ${schema}.provider_usage_events
    (customer_id,session_id,source_event_id,provider_id,adapter_key,measurement_status,usage_dimensions,
     estimated_cost_microunits,cost_currency,cost_table_version,source_digest,occurred_at)
    VALUES($1,$2,$3,'probe','probe-v1','estimated','{"requests":1}'::jsonb,1200,'AUD','probe-cost-v1',repeat('d',64),now())`,
  [tenantId, sessionId, `guardrail-${randomUUID()}`]);

  await client.query("SET ROLE sophia_runtime_app");
  const database = {
    tenantTransaction: async <T>(requestedTenant: string, work: (transactionClient: Client) => Promise<T>) => {
      await client.query("SELECT set_config('sophia.tenant_id',$1,true)", [requestedTenant]); return work(client);
    },
    tenantReadTransaction: async <T>(requestedTenant: string, work: (transactionClient: Client) => Promise<T>) => {
      await client.query("SELECT set_config('sophia.tenant_id',$1,true)", [requestedTenant]); return work(client);
    },
  };
  const admission = new RuntimeAdmissionService(database as never);
  const audit = new AdminAuditService(database as never);
  const guardrails = new UsageGuardrailService(database as never, admission, audit);
  const workspace = await guardrails.update(tenantId, { identityUserId: "billing-probe" } as never, {
    expectedRevision: 1, maxConcurrentSessions: 2, maxToolCallsPerMinute: 2,
    providerCostAlert: { thresholdMicrounits: "1000", currency: "AUD" },
  });
  const firstAllocation = await admission.reserveProviderSession(tenantId, "probe", "probe");
  let concurrentSessionDenied = false;
  try { await admission.reserveProviderSession(tenantId, "probe", "probe"); } catch { concurrentSessionDenied = true; }
  const invocationId = randomUUID();
  await admission.reserveToolAttempt({ tenantId, sessionId, invocationId,
    deduplicationKey: "provider:probe-event", maximumSessionToolCalls: 1 });
  await admission.reserveToolAttempt({ tenantId, sessionId, invocationId: randomUUID(),
    deduplicationKey: "provider:probe-event", maximumSessionToolCalls: 1 });
  let sessionToolTotalDenied = false;
  try { await admission.reserveToolAttempt({ tenantId, sessionId, invocationId: randomUUID(),
    deduplicationKey: "provider:new-event", maximumSessionToolCalls: 1 }); } catch { sessionToolTotalDenied = true; }
  const reservationCount = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${schema}.tool_admission_reservations WHERE customer_id=$1`, [tenantId]);
  const otherVisible = await client.query(`SELECT 1 FROM ${schema}.tenant_usage_guardrails WHERE customer_id=$1`, [otherTenantId]);
  const flags = await client.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
    `SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class
     WHERE relnamespace=$1::regnamespace AND relname=ANY($2::text[])`,
    [schema, ["tenant_usage_guardrails", "tool_admission_reservations"]]);
  const auditRow = await client.query(`SELECT 1 FROM ${schema}.admin_audit_events
    WHERE customer_id=$1 AND event_type='usage.guardrails.updated'`, [tenantId]);
  const evidence = {
    effectiveMinimum: workspace.limits.effective.maxConcurrentSessions === 2
      && workspace.limits.effective.maxToolCallsPerMinute === 2,
    estimateAlertActive: workspace.providerCostAlert.status === "active"
      && workspace.providerCostAlert.admissionEnforcement === false
      && workspace.providerCostAlert.customerCharge === false,
    guardrailAudited: auditRow.rows.length === 1,
    firstSessionReserved: Boolean(firstAllocation.allocationId), concurrentSessionDenied,
    providerReplayDeduplicated: reservationCount.rows[0]?.count === "1", sessionToolTotalDenied,
    crossTenantGuardrailHidden: otherVisible.rows.length === 0,
    guardrailTablesForcedRls: flags.rows.length === 2 && flags.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity),
    transaction: "rolled_back",
  };
  if (Object.entries(evidence).some(([key, value]) => key !== "transaction" && value !== true)) {
    throw new Error(`Usage guardrail verification failed: ${JSON.stringify(evidence)}`);
  }
  console.log(JSON.stringify(evidence));
} finally {
  await client.query("ROLLBACK").catch(() => undefined); await client.end();
}
