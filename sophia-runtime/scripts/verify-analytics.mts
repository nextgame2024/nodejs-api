import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { AnalyticsService } from "../src/admin/analytics/analytics.service.js";

const connectionString = process.env.SOPHIA_RUNTIME_DATABASE_URL;
const schema = process.env.SOPHIA_RUNTIME_SCHEMA ?? "sophia_runtime";
if (!connectionString) throw new Error("SOPHIA_RUNTIME_DATABASE_URL is required.");
if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) throw new Error("SOPHIA_RUNTIME_SCHEMA is invalid.");

const tenantId = randomUUID();
const sessionId = randomUUID();
const invocationId = randomUUID();
const commandId = randomUUID();
const client = new Client({ connectionString, ssl: { rejectUnauthorized: true } });

await client.connect();
try {
  await client.query("BEGIN");
  await client.query(`INSERT INTO ${schema}.customers (customer_id, name, metadata)
    VALUES ($1, 'analytics-probe', '{"timezone":"Mars/Olympus"}'::jsonb)`, [tenantId]);
  await client.query(`INSERT INTO ${schema}.sessions
    (session_id, customer_id, ai_provider, avatar_provider, status, ended_at, session_plan_snapshot)
    VALUES ($1, $2, 'probe', 'none', 'closed', now(), '{"pipelineMode":"native-realtime"}'::jsonb)`,
    [sessionId, tenantId]);
  await client.query(`INSERT INTO ${schema}.tool_calls
    (session_id, customer_id, tool_name, status, invocation_id, policy_decision, accepted_at,
      canonical_tool_id, tool_version, command_id, outcome_class, attempt_count, completed_at, input)
    VALUES ($1, $2, 'probeBooking', 'succeeded', $3, 'allow', now(),
      'booking.commit', '1.0.0', $4, 'success', 1, now(), $5::jsonb)`,
    [sessionId, tenantId, invocationId, commandId, JSON.stringify({ email: "analytics-probe@example.invalid" })]);
  await client.query(`INSERT INTO ${schema}.provider_usage_events
    (customer_id, session_id, source_event_id, provider_id, adapter_key, measurement_status,
      usage_dimensions, estimated_cost_microunits, cost_currency, cost_table_version, source_digest, occurred_at)
    VALUES ($1, $2, $3, 'probe', 'probe-v1', 'estimated', '{"requests":1}'::jsonb,
      1200, 'USD', 'probe-1', repeat('a', 64), now())`, [tenantId, sessionId, `analytics-${randomUUID()}`]);

  await client.query("SET ROLE sophia_runtime_app");
  const database = {
    tenantTransaction: async <T>(requestedTenantId: string, work: (transactionClient: Client) => Promise<T>) => {
      await client.query("SELECT set_config('sophia.tenant_id', $1, true)", [requestedTenantId]);
      return work(client);
    },
    tenantReadTransaction: async <T>(requestedTenantId: string, work: (transactionClient: Client) => Promise<T>) => {
      await client.query("SELECT set_config('sophia.tenant_id', $1, true)", [requestedTenantId]);
      return work(client);
    },
  };
  const packs = { analyticsMetrics: () => [{
    metricKey: "probe.booking.confirmed", version: 1, displayName: "Probe confirmed bookings",
    description: "Probe-only source-confirmed booking outcome.", unit: "count" as const,
    evidenceClass: "source_confirmed" as const, denominatorMetricKey: "tools.attempted",
    source: { kind: "canonical_tool_outcome" as const, canonicalToolId: "booking.commit", outcomeClass: "success" as const },
  }] };
  const service = new AnalyticsService(database as never, packs as never, { record: async () => undefined } as never);
  const dashboard = await service.dashboard(tenantId, {
    from: new Date(Date.now() - 60_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString(),
  });
  const created = await service.createExport(tenantId, "probe-operator", {
    format: "json", filters: { from: new Date(Date.now() - 60_000).toISOString(),
      to: new Date(Date.now() + 60_000).toISOString() }, maxPoints: 100,
  });
  const downloaded = await service.downloadExport(tenantId, created.analytics_export_job_id, "probe-operator");
  const exportText = JSON.stringify(downloaded.document);
  const expiredExportId = randomUUID();
  await client.query(`INSERT INTO ${schema}.analytics_export_jobs
    (analytics_export_job_id, customer_id, format, status, filters, as_of, max_points, point_count,
     metric_registry_digest, document_digest, document, created_by_identity, created_at, expires_at)
    VALUES ($1,$2,'json','ready','{}'::jsonb,now()-interval '2 days',1,0,repeat('a',64),repeat('b',64),
      '{"probe":"expiry"}'::jsonb,'probe-operator',now()-interval '2 days',now()-interval '1 day')`,
    [expiredExportId, tenantId]);
  await service.listExports(tenantId);
  const expired = await client.query<{ status: string; document: unknown }>(
    `SELECT status, document FROM ${schema}.analytics_export_jobs
     WHERE customer_id=$1 AND analytics_export_job_id=$2`, [tenantId, expiredExportId]);
  const flags = await client.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
    `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
     WHERE oid = $1::regclass`, [`${schema}.analytics_export_jobs`]);
  const metrics = dashboard.series.flatMap((point) => Object.entries(point.metrics));
  console.log(JSON.stringify({
    timezone: dashboard.range.timezone,
    timezoneFallback: dashboard.range.timezoneSource === "fallback_utc",
    conversationsStarted: metrics.find(([key]) => key === "conversations.started")?.[1] ?? 0,
    toolsAttempted: metrics.find(([key]) => key === "tools.attempted")?.[1] ?? 0,
    sourceConfirmedBusinessOutcome: metrics.find(([key]) => key === "probe.booking.confirmed")?.[1] ?? 0,
    estimatedCostMicrounits: dashboard.providerCostEstimates[0]?.estimatedMicrounits ?? null,
    customerCharge: dashboard.providerCostEstimates[0]?.customerCharge ?? null,
    aggregation: dashboard.freshness.aggregation,
    exportPointCount: created.point_count,
    exportDigestVerified: downloaded.digest === created.document_digest && /^[a-f0-9]{64}$/.test(downloaded.digest),
    exportWithholdsRawToolInput: !exportText.includes("analytics-probe@example.invalid"),
    expiredExportScrubbed: expired.rows[0]?.status === "expired" && expired.rows[0]?.document === null,
    exportTableForcedRls: flags.rows[0]?.relrowsecurity === true && flags.rows[0]?.relforcerowsecurity === true,
    transaction: "rolled_back",
  }));
} finally {
  await client.query("ROLLBACK").catch(() => undefined);
  await client.end();
}
