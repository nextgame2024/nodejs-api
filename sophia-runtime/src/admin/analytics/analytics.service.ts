import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import { BusinessPackRegistry } from "../../business-packs/business-pack.registry.js";
import type { AnalyticsMetricDefinition } from "../../business-packs/business-pack.contracts.js";
import { runtimeConfig } from "../../config/runtime-config.js";
import { DatabaseService } from "../../database/database.service.js";
import { AdminAuditService } from "../authorization/admin-audit.service.js";
import { AnalyticsQuerySchema, CreateAnalyticsExportSchema, type AnalyticsQuery } from "./analytics.contracts.js";

type EvidenceClass = "operational_observation" | "source_confirmed";
type CoreMetricDefinition = {
  metricKey: string;
  version: number;
  displayName: string;
  description: string;
  unit: "count" | "milliseconds";
  evidenceClass: EvidenceClass;
  denominatorMetricKey?: string;
  source: { kind: string; detail: string };
};
type AggregateRow = QueryResultRow & {
  bucket_date: string;
  agent_id: string | null;
  agent_release_id: string | null;
  channel: "voice" | "avatar" | "unknown";
  latest_at: Date | string | null;
  [key: string]: unknown;
};
type MetricPoint = {
  bucketDate: string;
  agentId: string | null;
  agentReleaseId: string | null;
  channel: string;
  metrics: Record<string, number>;
};

const MAX_ANALYTICS_POINTS = 5000;

const CORE_METRICS: readonly CoreMetricDefinition[] = [
  metric("conversations.started", "Conversations started", "Canonical runtime sessions started in the selected period.", "operational_observation", "sessions.started_at"),
  metric("conversations.completed", "Conversations completed", "Sessions started in the selected period that reached the closed lifecycle state; this is not a business conversion.", "operational_observation", "sessions.status=closed", "conversations.started"),
  metric("conversations.failed", "Conversations failed", "Sessions started in the selected period that reached the failed lifecycle state.", "operational_observation", "sessions.status=failed", "conversations.started"),
  metric("tools.attempted", "Tool commands attempted", "Distinct canonical tool invocations accepted by the runtime.", "operational_observation", "tool_calls.invocation_id"),
  metric("tools.source-confirmed-success", "Tool commands source-confirmed successful", "Distinct tool commands with a canonical success outcome.", "source_confirmed", "tool_calls.outcome_class=success", "tools.attempted"),
  metric("workflows.started", "Workflows started", "Workflow run references registered by the runtime.", "operational_observation", "workflow_run_references.created_at"),
  metric("workflows.source-confirmed-success", "Workflows source-confirmed successful", "Workflow runs started in the selected period whose current owner-reported status is succeeded.", "source_confirmed", "workflow_run_references.last_status=succeeded", "workflows.started"),
  metric("escalations.created", "Escalations created", "Escalation cases created in the selected period.", "operational_observation", "escalation_cases.created_at"),
  metric("escalations.resolved", "Escalations resolved", "Escalation cases created in the selected period that currently carry a resolved lifecycle state.", "operational_observation", "escalation_cases.status=resolved", "escalations.created"),
];

@Injectable()
export class AnalyticsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(BusinessPackRegistry) private readonly packs: BusinessPackRegistry,
    @Inject(AdminAuditService) private readonly audit: AdminAuditService,
  ) {}

  metricRegistry() {
    return [
      ...CORE_METRICS,
      ...this.packs.analyticsMetrics().map((definition) => ({ ...definition,
        source: { ...definition.source, detail: `tool_calls.canonical_tool_id=${definition.source.canonicalToolId}; outcome_class=success` },
      })),
    ];
  }

  async dashboard(tenantId: string, query: unknown) {
    const value = AnalyticsQuerySchema.parse(query);
    const range = dateRange(value);
    const schema = runtimeConfig().schema;
    return this.database.tenantReadTransaction(tenantId, async (client) => {
      const timezone = await tenantTimezone(client, schema, tenantId);
      const warnings = [...timezone.warnings];
      const points = new Map<string, MetricPoint>();
      let latestAt: string | null = null;
      const merge = (rows: AggregateRow[], mappings: ReadonlyArray<readonly [string, string]>) => {
        for (const row of rows) {
          const key = [row.bucket_date, row.agent_id ?? "", row.agent_release_id ?? "", row.channel].join("|");
          const point = points.get(key) ?? { bucketDate: row.bucket_date, agentId: row.agent_id,
            agentReleaseId: row.agent_release_id, channel: row.channel, metrics: {} };
          for (const [column, metricKey] of mappings) point.metrics[metricKey] = count(row[column]);
          points.set(key, point);
          const observed = isoOrNull(row.latest_at);
          if (observed && (!latestAt || observed > latestAt)) latestAt = observed;
        }
      };

      const sessions = await aggregate(client, schema, "sessions", tenantId, range, timezone.value, value);
      merge(sessions, [["started", "conversations.started"], ["completed", "conversations.completed"],
        ["failed", "conversations.failed"]]);
      const tools = await aggregate(client, schema, "tools", tenantId, range, timezone.value, value);
      merge(tools, [["attempted", "tools.attempted"], ["successful", "tools.source-confirmed-success"]]);
      const workflows = await aggregate(client, schema, "workflows", tenantId, range, timezone.value, value);
      merge(workflows, [["started", "workflows.started"], ["successful", "workflows.source-confirmed-success"]]);
      const escalations = await aggregate(client, schema, "escalations", tenantId, range, timezone.value, value);
      merge(escalations, [["created", "escalations.created"], ["resolved", "escalations.resolved"]]);

      const packDefinitions = this.packs.analyticsMetrics();
      if (packDefinitions.length) {
        const business = await businessAggregates(client, schema, tenantId, range, timezone.value, value, packDefinitions);
        for (const definition of packDefinitions) merge(
          business.filter((row) => row.canonical_tool_id === definition.source.canonicalToolId),
          [["successful", definition.metricKey]],
        );
      }

      const coverage = await usageCoverage(client, schema, tenantId, range, value);
      if (coverage.unattributedSessionCount > 0) warnings.push("Some usage events are not attributed to a runtime session and cannot be segmented by agent, release, or channel.");
      const costs = await providerCosts(client, schema, tenantId, range, value);
      if (points.size > MAX_ANALYTICS_POINTS) {
        throw new ConflictException(`Analytics result exceeds ${MAX_ANALYTICS_POINTS} points; narrow the date or attribution filters.`);
      }
      return {
        tenantId,
        generatedAt: new Date().toISOString(),
        range: { from: range.from.toISOString(), to: range.to.toISOString(), timezone: timezone.value,
          timezoneSource: timezone.source },
        filters: { agentId: value.agentId ?? null, agentReleaseId: value.agentReleaseId ?? null,
          channel: value.channel ?? null },
        metricRegistry: this.metricRegistry(),
        series: [...points.values()].sort(pointOrder),
        freshness: { latestSourceEventAt: latestAt, aggregation: "on_demand" },
        coverage,
        providerCostEstimates: costs,
        commercialPolicy: {
          status: "not_configured", customerCharges: false,
          currencyConversion: "not_performed",
          disclaimer: "Provider estimates are grouped by source currency, cost-table version and measurement status. They are not revenue, savings, customer charges, or causal business impact.",
        },
        warnings,
      };
    });
  }

  async listExports(tenantId: string) {
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      await client.query(
        `UPDATE ${schema}.analytics_export_jobs SET status='expired', document=NULL
         WHERE customer_id=$1 AND status='ready' AND expires_at<=now()`, [tenantId]);
      const result = await client.query(
        `SELECT analytics_export_job_id, format, status, filters, as_of, max_points, point_count,
                metric_registry_digest, document_digest, created_by_identity, created_at, expires_at,
                last_accessed_at, access_count
         FROM ${schema}.analytics_export_jobs WHERE customer_id=$1
         ORDER BY created_at DESC LIMIT 100`, [tenantId]);
      return { exports: result.rows };
    });
  }

  async createExport(tenantId: string, actorId: string, input: unknown) {
    const value = CreateAnalyticsExportSchema.parse(input);
    const dashboard = await this.dashboard(tenantId, value.filters);
    if (dashboard.series.length > value.maxPoints) {
      throw new ConflictException(`Export exceeds the ${value.maxPoints} point limit; narrow the filters or choose a larger approved bound.`);
    }
    const exportId = randomUUID();
    const filters = compactFilters({ from: dashboard.range.from, to: dashboard.range.to,
      agentId: dashboard.filters.agentId, agentReleaseId: dashboard.filters.agentReleaseId,
      channel: dashboard.filters.channel });
    const document = { schemaVersion: 1, tenantId, analyticsExportJobId: exportId,
      asOf: dashboard.generatedAt, dashboard };
    const documentDigest = digest(document);
    const registryDigest = digest(dashboard.metricRegistry);
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO ${schema}.analytics_export_jobs
          (analytics_export_job_id, customer_id, format, status, filters, as_of, max_points, point_count,
           metric_registry_digest, document_digest, document, created_by_identity, expires_at)
         VALUES ($1,$2,'json','ready',$3::jsonb,$4,$5,$6,$7,$8,$9::jsonb,$10,$4::timestamptz + interval '24 hours')
         RETURNING analytics_export_job_id, status, point_count, as_of, expires_at, document_digest`,
        [exportId, tenantId, JSON.stringify(filters), dashboard.generatedAt, value.maxPoints, dashboard.series.length,
          registryDigest, documentDigest, JSON.stringify(document), actorId]);
      await this.audit.record({ tenantId, identityUserId: actorId, eventType: "admin.analytics_export.created",
        permission: "analytics.export", outcome: "allowed", resourceType: "analytics_export", resourceId: exportId,
        metadata: { pointCount: dashboard.series.length, maxPoints: value.maxPoints,
          asOf: dashboard.generatedAt, documentDigest, registryDigest } }, client);
      return result.rows[0];
    });
  }

  async downloadExport(tenantId: string, exportId: string, actorId: string) {
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const result = await client.query<{ status: string; expires_at: Date | string; document: unknown; document_digest: string }>(
        `SELECT status, expires_at, document, document_digest FROM ${schema}.analytics_export_jobs
         WHERE customer_id=$1 AND analytics_export_job_id=$2 FOR UPDATE`, [tenantId, exportId]);
      const job = result.rows[0];
      if (!job) throw new NotFoundException("Analytics export not found.");
      if (job.status === "expired" || Date.parse(String(job.expires_at)) <= Date.now()) {
        if (job.status !== "expired") await client.query(
          `UPDATE ${schema}.analytics_export_jobs SET status='expired', document=NULL
           WHERE customer_id=$1 AND analytics_export_job_id=$2`, [tenantId, exportId]);
        throw new ConflictException("Analytics export has expired and its aggregate snapshot was scrubbed.");
      }
      if (!job.document || digest(job.document) !== job.document_digest) {
        throw new ConflictException("Analytics export digest verification failed.");
      }
      await client.query(
        `UPDATE ${schema}.analytics_export_jobs SET last_accessed_at=now(), access_count=access_count+1
         WHERE customer_id=$1 AND analytics_export_job_id=$2`, [tenantId, exportId]);
      await this.audit.record({ tenantId, identityUserId: actorId, eventType: "admin.analytics_export.accessed",
        permission: "analytics.export", outcome: "allowed", resourceType: "analytics_export", resourceId: exportId,
        metadata: { documentDigest: job.document_digest } }, client);
      return { format: "json" as const, digestAlgorithm: "sha256" as const,
        digest: job.document_digest, document: job.document };
    });
  }
}

function metric(metricKey: string, displayName: string, description: string, evidenceClass: EvidenceClass,
  detail: string, denominatorMetricKey?: string): CoreMetricDefinition {
  return { metricKey, version: 1, displayName, description, unit: "count", evidenceClass,
    ...(denominatorMetricKey ? { denominatorMetricKey } : {}), source: { kind: "canonical_runtime_record", detail } };
}

function dateRange(value: AnalyticsQuery) {
  const to = value.to ? new Date(value.to) : new Date();
  const from = value.from ? new Date(value.from) : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  if (to.getTime() - from.getTime() > 366 * 24 * 60 * 60 * 1000) {
    throw new BadRequestException("Analytics date range cannot exceed 366 days.");
  }
  return { from, to };
}

async function tenantTimezone(client: PoolClient, schema: string, tenantId: string) {
  const result = await client.query<{ configured_timezone: string | null; timezone: string; valid: boolean }>(
    `SELECT c.metadata->>'timezone' AS configured_timezone,
       COALESCE(t.name, 'UTC') AS timezone, t.name IS NOT NULL AS valid
     FROM ${schema}.customers c
     LEFT JOIN pg_timezone_names t ON t.name = c.metadata->>'timezone'
     WHERE c.customer_id = $1`, [tenantId]);
  const row = result.rows[0];
  const configured = row?.configured_timezone;
  return { value: row?.timezone ?? "UTC", source: row?.valid ? "organisation" : "fallback_utc",
    warnings: configured && !row?.valid ? [`Organisation timezone '${configured}' is invalid; UTC was used.`]
      : !configured ? ["Organisation timezone is not configured; UTC was used."] : [] };
}

async function aggregate(client: PoolClient, schema: string, source: "sessions" | "tools" | "workflows" | "escalations",
  tenantId: string, range: { from: Date; to: Date }, timezone: string, filters: AnalyticsQuery): Promise<AggregateRow[]> {
  const config = aggregateConfig(schema, source);
  const built = filterSql(filters, config.time, config.sessionAlias, config.releaseAlias, 4);
  const result = await client.query<AggregateRow>(
    `SELECT to_char(timezone($4, ${config.time}), 'YYYY-MM-DD') AS bucket_date,
       ${config.releaseAlias}.agent_id, ${config.sessionAlias}.agent_release_id,
       ${channelSql(config.sessionAlias)} AS channel, ${config.columns}, max(${config.latest}) AS latest_at
     ${config.from}
     WHERE ${config.tenantColumn}.customer_id = $1 AND ${config.time} >= $2 AND ${config.time} < $3 ${built.sql}
     GROUP BY 1, 2, 3, 4 ORDER BY 1, 2 NULLS FIRST, 3 NULLS FIRST, 4`,
    [tenantId, range.from, range.to, timezone, ...built.params],
  );
  return result.rows;
}

function aggregateConfig(schema: string, source: string) {
  const release = `LEFT JOIN ${schema}.agent_release_manifests r ON r.customer_id=s.customer_id AND r.agent_release_id=s.agent_release_id`;
  if (source === "sessions") return { time: "s.started_at", latest: "s.updated_at", sessionAlias: "s", releaseAlias: "r", tenantColumn: "s",
    from: `FROM ${schema}.sessions s ${release}`,
    columns: `count(*)::int AS started, count(*) FILTER (WHERE s.status='closed')::int AS completed,
      count(*) FILTER (WHERE s.status='failed')::int AS failed` };
  if (source === "tools") return { time: "t.started_at", latest: "COALESCE(t.completed_at,t.started_at)", sessionAlias: "s", releaseAlias: "r", tenantColumn: "t",
    from: `FROM ${schema}.tool_calls t JOIN ${schema}.sessions s ON s.customer_id=t.customer_id AND s.session_id=t.session_id ${release}`,
    columns: `count(DISTINCT t.invocation_id)::int AS attempted,
      count(DISTINCT t.invocation_id) FILTER (WHERE t.outcome_class='success')::int AS successful` };
  if (source === "workflows") return { time: "w.created_at", latest: "COALESCE(w.last_status_at,w.created_at)", sessionAlias: "s", releaseAlias: "r", tenantColumn: "w",
    from: `FROM ${schema}.workflow_run_references w LEFT JOIN ${schema}.sessions s
      ON s.customer_id=w.customer_id AND s.session_id=w.source_session_id ${release}`,
    columns: `count(DISTINCT w.workflow_run_id)::int AS started,
      count(DISTINCT w.workflow_run_id) FILTER (WHERE w.last_status='succeeded')::int AS successful` };
  return { time: "e.created_at", latest: "e.updated_at", sessionAlias: "s", releaseAlias: "r", tenantColumn: "e",
    from: `FROM ${schema}.escalation_cases e LEFT JOIN ${schema}.sessions s
      ON s.customer_id=e.customer_id AND s.session_id=e.source_session_id ${release}`,
    columns: `count(DISTINCT e.escalation_case_id)::int AS created,
      count(DISTINCT e.escalation_case_id) FILTER (WHERE e.status='resolved')::int AS resolved` };
}

async function businessAggregates(client: PoolClient, schema: string, tenantId: string,
  range: { from: Date; to: Date }, timezone: string, filters: AnalyticsQuery,
  definitions: readonly AnalyticsMetricDefinition[]): Promise<Array<AggregateRow & { canonical_tool_id: string }>> {
  const built = filterSql(filters, "t.started_at", "s", "r", 5);
  const toolIds = [...new Set(definitions.map((definition) => definition.source.canonicalToolId))];
  const result = await client.query<AggregateRow & { canonical_tool_id: string }>(
    `SELECT to_char(timezone($4, t.started_at), 'YYYY-MM-DD') AS bucket_date, r.agent_id,
       s.agent_release_id, ${channelSql("s")} AS channel, t.canonical_tool_id,
       count(DISTINCT COALESCE(t.command_id, t.invocation_id, t.tool_call_id))
         FILTER (WHERE t.outcome_class='success')::int AS successful, max(t.started_at) AS latest_at
     FROM ${schema}.tool_calls t JOIN ${schema}.sessions s
       ON s.customer_id=t.customer_id AND s.session_id=t.session_id
     LEFT JOIN ${schema}.agent_release_manifests r
       ON r.customer_id=s.customer_id AND r.agent_release_id=s.agent_release_id
     WHERE t.customer_id=$1 AND t.started_at >= $2 AND t.started_at < $3
       AND t.canonical_tool_id = ANY($5::text[]) ${built.sql}
     GROUP BY 1, 2, 3, 4, 5 ORDER BY 1, 2 NULLS FIRST, 3 NULLS FIRST, 4, 5`,
    [tenantId, range.from, range.to, timezone, toolIds, ...built.params],
  );
  return result.rows;
}

async function usageCoverage(client: PoolClient, schema: string, tenantId: string,
  range: { from: Date; to: Date }, filters: AnalyticsQuery) {
  const built = filterSql(filters, "u.occurred_at", "s", "r", 3);
  const result = await client.query<{ measurement_status: string; event_count: number; unattributed_count: number }>(
    `SELECT u.measurement_status, count(*)::int AS event_count,
       count(*) FILTER (WHERE u.session_id IS NULL)::int AS unattributed_count
     FROM ${schema}.provider_usage_events u
     LEFT JOIN ${schema}.sessions s ON s.customer_id=u.customer_id AND s.session_id=u.session_id
     LEFT JOIN ${schema}.agent_release_manifests r ON r.customer_id=s.customer_id AND r.agent_release_id=s.agent_release_id
     WHERE u.customer_id=$1 AND u.occurred_at >= $2 AND u.occurred_at < $3 ${built.sql}
     GROUP BY u.measurement_status ORDER BY u.measurement_status`, [tenantId, range.from, range.to, ...built.params]);
  return { usageStatusCounts: Object.fromEntries(result.rows.map((row) => [row.measurement_status, count(row.event_count)])),
    unattributedSessionCount: result.rows.reduce((sum, row) => sum + count(row.unattributed_count), 0) };
}

async function providerCosts(client: PoolClient, schema: string, tenantId: string,
  range: { from: Date; to: Date }, filters: AnalyticsQuery) {
  const built = filterSql(filters, "u.occurred_at", "s", "r", 3);
  const result = await client.query<{ cost_currency: string; cost_table_version: string; measurement_status: string; microunits: string }>(
    `SELECT u.cost_currency, u.cost_table_version, u.measurement_status,
       sum(u.estimated_cost_microunits)::text AS microunits
     FROM ${schema}.provider_usage_events u
     LEFT JOIN ${schema}.sessions s ON s.customer_id=u.customer_id AND s.session_id=u.session_id
     LEFT JOIN ${schema}.agent_release_manifests r ON r.customer_id=s.customer_id AND r.agent_release_id=s.agent_release_id
     WHERE u.customer_id=$1 AND u.occurred_at >= $2 AND u.occurred_at < $3
       AND u.estimated_cost_microunits IS NOT NULL ${built.sql}
     GROUP BY u.cost_currency, u.cost_table_version, u.measurement_status
     ORDER BY u.cost_currency, u.cost_table_version, u.measurement_status`,
    [tenantId, range.from, range.to, ...built.params]);
  return result.rows.map((row) => ({ currency: row.cost_currency, costTableVersion: row.cost_table_version,
    measurementStatus: row.measurement_status, estimatedMicrounits: row.microunits, customerCharge: false }));
}

function filterSql(filters: AnalyticsQuery, _time: string, sessionAlias: string, releaseAlias: string, startIndex: number) {
  const params: unknown[] = [];
  const clauses: string[] = [];
  const add = (sql: string, value: unknown) => { params.push(value); clauses.push(sql.replace("?", `$${startIndex + params.length}`)); };
  if (filters.agentId) add(`${releaseAlias}.agent_id = ?`, filters.agentId);
  if (filters.agentReleaseId) add(`${sessionAlias}.agent_release_id = ?`, filters.agentReleaseId);
  if (filters.channel) add(`${channelSql(sessionAlias)} = ?`, filters.channel);
  return { sql: clauses.length ? `AND ${clauses.join(" AND ")}` : "", params };
}

function channelSql(alias: string): string {
  return `CASE WHEN ${alias}.session_plan_snapshot->>'pipelineMode'='avatar-realtime' OR ${alias}.avatar_provider<>'none'
    THEN 'avatar' WHEN ${alias}.session_plan_snapshot->>'pipelineMode' IN ('native-realtime','chained-voice')
    THEN 'voice' ELSE 'unknown' END`;
}
function count(value: unknown): number { return Number(value) || 0; }
function isoOrNull(value: unknown): string | null { return value ? new Date(value as string | number | Date).toISOString() : null; }
function pointOrder(a: MetricPoint, b: MetricPoint): number {
  return a.bucketDate.localeCompare(b.bucketDate) || (a.agentId ?? "").localeCompare(b.agentId ?? "") ||
    (a.agentReleaseId ?? "").localeCompare(b.agentReleaseId ?? "") || a.channel.localeCompare(b.channel);
}
function compactFilters(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== null && child !== undefined && child !== ""));
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") { const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`; }
  return JSON.stringify(value) ?? "null";
}
function digest(value: unknown): string { return createHash("sha256").update(stableJson(value)).digest("hex"); }
