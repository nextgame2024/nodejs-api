import { Inject, Injectable } from "@nestjs/common";
import { runtimeConfig } from "../../config/runtime-config.js";
import { DatabaseService } from "../../database/database.service.js";

type StatusRow = Record<
  | "sessions_total" | "sessions_active" | "sessions_failed" | "orphan_sessions"
  | "tools_total" | "tools_failed" | "tools_denied" | "workflow_total" | "workflow_failed"
  | "provider_cleanup_queue" | "workflow_retry_queue" | "operations_inbox_queue"
  | "old_provider_cleanup_seconds" | "old_workflow_retry_seconds" | "old_operations_inbox_seconds"
  | "callback_requested" | "notification_accepted" | "live_connected" | "handoff_failed"
  | "recent_failures" | "recent_denials", number>;

@Injectable()
export class OperationalAccountabilityService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async status(tenantId: string) {
    const schema = runtimeConfig().schema;
    const result = await this.database.tenantTransaction(tenantId, (client) => client.query<StatusRow>(
      `SELECT
        (SELECT count(*)::int FROM ${schema}.sessions s WHERE s.customer_id=$1) AS sessions_total,
        (SELECT count(*)::int FROM ${schema}.sessions s WHERE s.customer_id=$1 AND s.status IN ('created','active','closing')) AS sessions_active,
        (SELECT count(*)::int FROM ${schema}.sessions s WHERE s.customer_id=$1 AND s.status='failed') AS sessions_failed,
        (SELECT count(*)::int FROM ${schema}.sessions s WHERE s.customer_id=$1
          AND s.status IN ('active','closing')
          AND (s.hard_expires_at < now() OR s.last_seen_at < now() - interval '10 minutes')) AS orphan_sessions,
        (SELECT count(*)::int FROM ${schema}.tool_calls t WHERE t.customer_id=$1) AS tools_total,
        (SELECT count(*)::int FROM ${schema}.tool_calls t WHERE t.customer_id=$1 AND t.status IN ('failed','timed_out','unknown')) AS tools_failed,
        (SELECT count(*)::int FROM ${schema}.tool_calls t WHERE t.customer_id=$1 AND t.status='denied') AS tools_denied,
        (SELECT count(*)::int FROM ${schema}.workflow_run_references w WHERE w.customer_id=$1) AS workflow_total,
        (SELECT count(*)::int FROM ${schema}.workflow_run_references w WHERE w.customer_id=$1
          AND w.last_status IN ('failed','outcome_unknown')) AS workflow_failed,
        (SELECT count(*)::int FROM ${schema}.provider_session_allocations p WHERE p.customer_id=$1
          AND p.stage IN ('cleanup_pending','cleaning')) AS provider_cleanup_queue,
        (SELECT count(*)::int FROM ${schema}.workflow_retry_commands r WHERE r.customer_id=$1 AND r.status='executing') AS workflow_retry_queue,
        (SELECT count(*)::int FROM ${schema}.escalation_cases e WHERE e.customer_id=$1 AND e.status<>'resolved') AS operations_inbox_queue,
        COALESCE((SELECT greatest(0, extract(epoch FROM now()-min(p.cleanup_after)))::int
          FROM ${schema}.provider_session_allocations p WHERE p.customer_id=$1 AND p.stage IN ('cleanup_pending','cleaning')),0) AS old_provider_cleanup_seconds,
        COALESCE((SELECT greatest(0, extract(epoch FROM now()-min(r.created_at)))::int
          FROM ${schema}.workflow_retry_commands r WHERE r.customer_id=$1 AND r.status='executing'),0) AS old_workflow_retry_seconds,
        COALESCE((SELECT greatest(0, extract(epoch FROM now()-min(e.created_at)))::int
          FROM ${schema}.escalation_cases e WHERE e.customer_id=$1 AND e.status<>'resolved'),0) AS old_operations_inbox_seconds,
        (SELECT count(*)::int FROM ${schema}.escalation_cases e WHERE e.customer_id=$1 AND e.transfer_status='callback_requested') AS callback_requested,
        (SELECT count(*)::int FROM ${schema}.escalation_cases e WHERE e.customer_id=$1 AND e.transfer_status='notification_accepted') AS notification_accepted,
        (SELECT count(*)::int FROM ${schema}.escalation_cases e WHERE e.customer_id=$1 AND e.transfer_status='live_connected') AS live_connected,
        (SELECT count(*)::int FROM ${schema}.escalation_cases e WHERE e.customer_id=$1 AND e.transfer_status='failed') AS handoff_failed,
        ((SELECT count(*) FROM ${schema}.sessions s WHERE s.customer_id=$1 AND s.status='failed' AND s.updated_at>=now()-interval '24 hours')
          +(SELECT count(*) FROM ${schema}.tool_calls t WHERE t.customer_id=$1 AND t.status IN ('failed','timed_out','unknown') AND t.created_at>=now()-interval '24 hours')
          +(SELECT count(*) FROM ${schema}.workflow_run_references w WHERE w.customer_id=$1 AND w.last_status IN ('failed','outcome_unknown') AND coalesce(w.last_status_at,w.created_at)>=now()-interval '24 hours'))::int AS recent_failures,
        ((SELECT count(*) FROM ${schema}.tool_calls t WHERE t.customer_id=$1 AND t.status='denied' AND t.created_at>=now()-interval '5 minutes')
          +(SELECT count(*) FROM ${schema}.admin_audit_events a WHERE a.customer_id=$1 AND a.outcome='denied' AND a.created_at>=now()-interval '5 minutes'))::int AS recent_denials`,
      [tenantId],
    ));
    const row = result.rows[0];
    return {
      tenantId,
      generatedAt: new Date().toISOString(),
      observationWindow: { failuresHours: 24, denialSpikeMinutes: 5 },
      sessions: { total: count(row?.sessions_total), open: count(row?.sessions_active),
        failed: count(row?.sessions_failed), orphaned: count(row?.orphan_sessions) },
      tools: { total: count(row?.tools_total), failedOrUnknown: count(row?.tools_failed), denied: count(row?.tools_denied) },
      workflows: { total: count(row?.workflow_total), failedOrUnknown: count(row?.workflow_failed) },
      queues: {
        providerCleanup: queue(row?.provider_cleanup_queue, row?.old_provider_cleanup_seconds, "scheduler-reconciliation-only"),
        workflowRetry: queue(row?.workflow_retry_queue, row?.old_workflow_retry_seconds, "compiled-owner-idempotent-only"),
        operationsInbox: queue(row?.operations_inbox_queue, row?.old_operations_inbox_seconds, "assign-and-resolve"),
      },
      handoff: {
        operationsInbox: { availability: "supported", semantics: "case_queued" },
        callback: { availability: "unsupported", requested: count(row?.callback_requested), completed: null,
          semantics: "request-is-not-completion" },
        notification: { availability: "unsupported", accepted: count(row?.notification_accepted), delivered: null,
          semantics: "provider-acceptance-is-not-delivery" },
        liveTransfer: { availability: "unsupported", connected: count(row?.live_connected),
          semantics: "connected-only-when-connector-confirms" },
        failed: count(row?.handoff_failed),
      },
      retryCapabilities: [
        { target: "workflow", availability: "owner-dependent", guard: "tenant-owned compiled owner with idempotent retry" },
        { target: "provider-cleanup", availability: "scheduler-only", guard: "leased reconciliation command" },
        { target: "session", availability: "unsupported", guard: "sessions are not replayable" },
        { target: "tool-call", availability: "unsupported", guard: "generic business mutations are not replayable" },
      ],
      alerts: alerts(row),
    };
  }

  async usage(tenantId: string) {
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const statuses = await client.query<{ measurement_status: string; event_count: number }>(
          `SELECT measurement_status, count(*)::int AS event_count
           FROM ${schema}.provider_usage_events WHERE customer_id=$1 GROUP BY measurement_status`, [tenantId]);
      const providers = await client.query<{ provider_id: string; adapter_key: string; measurement_status: string; event_count: number }>(
          `SELECT provider_id, adapter_key, measurement_status, count(*)::int AS event_count
           FROM ${schema}.provider_usage_events WHERE customer_id=$1
           GROUP BY provider_id, adapter_key, measurement_status ORDER BY provider_id, adapter_key, measurement_status`, [tenantId]);
      const totals = await client.query<{ dimension: string; measurement_status: string; quantity: string | number }>(
          `SELECT d.key AS dimension, u.measurement_status, sum(d.value::numeric) AS quantity
           FROM ${schema}.provider_usage_events u
           CROSS JOIN LATERAL jsonb_each_text(u.usage_dimensions) d
           WHERE u.customer_id=$1 GROUP BY d.key, u.measurement_status ORDER BY d.key, u.measurement_status`, [tenantId]);
      const costs = await client.query<{ cost_currency: string; cost_table_version: string; measurement_status: string; microunits: string | number }>(
          `SELECT cost_currency, cost_table_version, measurement_status, sum(estimated_cost_microunits) AS microunits
           FROM ${schema}.provider_usage_events WHERE customer_id=$1 AND estimated_cost_microunits IS NOT NULL
           GROUP BY cost_currency, cost_table_version, measurement_status
           ORDER BY cost_currency, cost_table_version, measurement_status`, [tenantId]);
      return {
        tenantId,
        generatedAt: new Date().toISOString(),
        statusCounts: Object.fromEntries(statuses.rows.map((row) => [row.measurement_status, count(row.event_count)])),
        providers: providers.rows.map((row) => ({ providerId: row.provider_id, adapterKey: row.adapter_key,
          measurementStatus: row.measurement_status, eventCount: count(row.event_count) })),
        dimensionTotals: totals.rows.map((row) => ({ dimension: row.dimension,
          measurementStatus: row.measurement_status, quantity: String(row.quantity) })),
        providerCostEstimates: costs.rows.map((row) => ({ currency: row.cost_currency,
          costTableVersion: row.cost_table_version, measurementStatus: row.measurement_status,
          estimatedMicrounits: String(row.microunits), customerCharge: false })),
        commercialPolicy: { status: "not_configured", customerCharges: false },
        budgetAlert: { status: "unavailable", reason: "No approved customer billing balance exists. Estimate-only provider-cost alerts are configured separately and never enforce admission." },
      };
    });
  }
}

function count(value: unknown): number { return Number(value) || 0; }
function queue(value: unknown, age: unknown, retry: string) {
  return { count: count(value), oldestAgeSeconds: count(age), retry };
}
function alerts(row: StatusRow | undefined) {
  return [
    alert("queue-age", Math.max(count(row?.old_provider_cleanup_seconds), count(row?.old_workflow_retry_seconds),
      count(row?.old_operations_inbox_seconds)) > 900, "warning", "A tracked operational queue is older than 15 minutes."),
    alert("orphan-sessions", count(row?.orphan_sessions) > 0, "critical", `${count(row?.orphan_sessions)} session(s) appear orphaned.`),
    alert("recent-failures", count(row?.recent_failures) > 0, "warning", `${count(row?.recent_failures)} failure or unknown outcome(s) occurred in 24 hours.`),
    alert("denial-spike", count(row?.recent_denials) >= 10, "critical", `${count(row?.recent_denials)} denials occurred in 5 minutes.`),
    { key: "budget-exhaustion", status: "unavailable", severity: "informational",
      detail: "No approved customer billing balance exists; provider-cost estimate alerts are non-enforcing." },
  ];
}
function alert(key: string, active: boolean, severity: string, detail: string) {
  return { key, status: active ? "active" : "clear", severity, detail };
}
