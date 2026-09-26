import { HttpException, HttpStatus, Inject, Injectable } from "@nestjs/common";
import type { PoolClient } from "pg";
import { z } from "zod";
import { runtimeConfig } from "../../config/runtime-config.js";
import { DatabaseService } from "../../database/database.service.js";

const entitlementLimitSchema = z.number().int().nonnegative();

type LimitRow = {
  status: string;
  revision: number | null;
  max_concurrent_sessions: number | null;
  max_tool_calls_per_minute: number | null;
  provider_cost_alert_microunits: string | null;
  provider_cost_alert_currency: string | null;
  entitlements: unknown | null;
  plan_key: string | null;
  plan_version: number | null;
};

export type EffectiveAdmissionLimits = {
  platformHardCaps: { maxConcurrentSessions: number; maxToolCallsPerMinute: number };
  commercialCeilings: { planKey: string; version: number; maxConcurrentSessions: number | null; maxToolCallsPerMinute: number | null } | null;
  tenantGuardrails: {
    revision: number; maxConcurrentSessions: number | null; maxToolCallsPerMinute: number | null;
    providerCostAlertMicrounits: string | null; providerCostAlertCurrency: string | null;
  } | null;
  effective: { maxConcurrentSessions: number; maxToolCallsPerMinute: number };
};

@Injectable()
export class RuntimeAdmissionService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  limits(tenantId: string): Promise<EffectiveAdmissionLimits> {
    return this.database.tenantReadTransaction(tenantId, (client) => this.limitsWithClient(client, tenantId));
  }

  async reserveProviderSession(customerId: string, adapterKey: string, experience: string) {
    const config = runtimeConfig();
    return this.database.tenantTransaction(customerId, async (client) => {
      await advisoryLock(client, `session:${customerId}`);
      const limits = await this.limitsWithClient(client, customerId);
      if ((await this.organisationStatus(client, customerId)) !== "active") {
        throw new AdmissionLimitExceededException("This organisation is not admitting new Sophia sessions.", HttpStatus.FORBIDDEN);
      }
      const occupied = await client.query<{ occupied_count: string }>(
        `SELECT (
           (SELECT count(*) FROM ${config.schema}.provider_session_allocations a
            WHERE a.customer_id=$1 AND a.stage IN ('allocating','allocated','attached','cleanup_pending','cleaning'))
           +
           (SELECT count(*) FROM ${config.schema}.sessions s
            WHERE s.customer_id=$1 AND s.status='active' AND s.started_at>now()-interval '2 hours'
              AND NOT EXISTS (SELECT 1 FROM ${config.schema}.provider_session_allocations a WHERE a.session_id=s.session_id))
         )::text AS occupied_count`, [customerId]);
      if (Number(occupied.rows[0]?.occupied_count ?? 0) >= limits.effective.maxConcurrentSessions) {
        throw new AdmissionLimitExceededException(
          "Sophia has reached the active-session limit for this organisation.", HttpStatus.TOO_MANY_REQUESTS);
      }
      const result = await client.query<{ allocation_id: string }>(
        `INSERT INTO ${config.schema}.provider_session_allocations
          (customer_id, lifecycle_adapter_key, experience_key, cleanup_after)
         VALUES ($1,$2,$3,now()+make_interval(secs=>$4)) RETURNING allocation_id`,
        [customerId, adapterKey, experience, config.providerSessionMaxSeconds]);
      return { allocationId: result.rows[0].allocation_id, customerId, adapterKey };
    });
  }

  async reserveToolAttempt(input: {
    tenantId: string; sessionId: string; invocationId: string; deduplicationKey: string | null;
    maximumSessionToolCalls: number | null;
  }): Promise<void> {
    const config = runtimeConfig();
    await this.database.tenantTransaction(input.tenantId, async (client) => {
      await advisoryLock(client, `tool:${input.tenantId}:${input.sessionId}`);
      await client.query(`DELETE FROM ${config.schema}.tool_admission_reservations
        WHERE customer_id=$1 AND expires_at<=now()`, [input.tenantId]);
      if (input.deduplicationKey) {
        const duplicate = await client.query(
          `SELECT 1 FROM ${config.schema}.tool_admission_reservations
             WHERE customer_id=$1 AND session_id=$2 AND deduplication_key=$3
           UNION ALL
           SELECT 1 FROM ${config.schema}.tool_calls
             WHERE customer_id=$1 AND session_id=$2 AND deduplication_key=$3 LIMIT 1`,
          [input.tenantId, input.sessionId, input.deduplicationKey]);
        if (duplicate.rows[0]) return;
      }
      const limits = await this.limitsWithClient(client, input.tenantId);
      const counts = await client.query<{ recent_count: string; total_count: string }>(
        `SELECT
          (SELECT count(*) FROM (
            SELECT invocation_id FROM ${config.schema}.tool_calls
             WHERE customer_id=$1 AND session_id=$2 AND created_at>now()-interval '1 minute'
            UNION
            SELECT invocation_id FROM ${config.schema}.tool_admission_reservations
             WHERE customer_id=$1 AND session_id=$2 AND created_at>now()-interval '1 minute'
          ) recent)::text AS recent_count,
          (SELECT count(*) FROM (
            SELECT invocation_id FROM ${config.schema}.tool_calls WHERE customer_id=$1 AND session_id=$2
            UNION
            SELECT invocation_id FROM ${config.schema}.tool_admission_reservations WHERE customer_id=$1 AND session_id=$2
          ) total)::text AS total_count`, [input.tenantId, input.sessionId]);
      if (Number(counts.rows[0]?.recent_count ?? 0) >= limits.effective.maxToolCallsPerMinute) {
        throw new AdmissionLimitExceededException(
          "Sophia's per-minute tool limit has been reached. Please wait before trying again.", HttpStatus.TOO_MANY_REQUESTS);
      }
      if (input.maximumSessionToolCalls !== null
          && Number(counts.rows[0]?.total_count ?? 0) >= input.maximumSessionToolCalls) {
        throw new AdmissionLimitExceededException(
          "This session has reached its immutable total tool-call limit.", HttpStatus.TOO_MANY_REQUESTS);
      }
      await client.query(
        `INSERT INTO ${config.schema}.tool_admission_reservations
          (invocation_id,customer_id,session_id,deduplication_key)
         VALUES ($1,$2,$3,$4)`,
        [input.invocationId, input.tenantId, input.sessionId, input.deduplicationKey]);
    });
  }

  async limitsWithClient(client: PoolClient, tenantId: string): Promise<EffectiveAdmissionLimits> {
    const config = runtimeConfig();
    const result = await client.query<LimitRow>(
      `SELECT c.status, g.revision, g.max_concurrent_sessions, g.max_tool_calls_per_minute,
              g.provider_cost_alert_microunits::text, g.provider_cost_alert_currency,
              plan.entitlements, plan.plan_key, plan.version AS plan_version
       FROM ${config.schema}.customers c
       LEFT JOIN ${config.schema}.tenant_usage_guardrails g ON g.customer_id=c.customer_id
       LEFT JOIN LATERAL (
         SELECT p.entitlements, p.plan_key, p.version
         FROM ${config.schema}.tenant_commercial_assignments a
         JOIN ${config.schema}.commercial_plan_versions p ON p.commercial_plan_version_id=a.commercial_plan_version_id
         WHERE a.customer_id=c.customer_id AND a.status='active' AND a.effective_from<=now()
           AND (a.effective_to IS NULL OR a.effective_to>now()) AND p.status IN ('published','retired')
         ORDER BY a.effective_from DESC LIMIT 1
       ) plan ON true WHERE c.customer_id=$1`, [tenantId]);
    const row = result.rows[0];
    const entitlements = parseEntitlements(row?.entitlements);
    const concurrentCeiling = Math.min(config.maxConcurrentSessions,
      entitlements.concurrentSessions ?? Number.POSITIVE_INFINITY);
    const toolCeiling = Math.min(config.maxToolCallsPerMinute,
      entitlements.toolCallsPerMinute ?? Number.POSITIVE_INFINITY);
    const guardrails = row?.revision ? {
      revision: row.revision,
      maxConcurrentSessions: row.max_concurrent_sessions,
      maxToolCallsPerMinute: row.max_tool_calls_per_minute,
      providerCostAlertMicrounits: row.provider_cost_alert_microunits,
      providerCostAlertCurrency: row.provider_cost_alert_currency,
    } : null;
    return {
      platformHardCaps: { maxConcurrentSessions: config.maxConcurrentSessions,
        maxToolCallsPerMinute: config.maxToolCallsPerMinute },
      commercialCeilings: row?.plan_key ? { planKey: row.plan_key, version: Number(row.plan_version),
        maxConcurrentSessions: entitlements.concurrentSessions ?? null,
        maxToolCallsPerMinute: entitlements.toolCallsPerMinute ?? null } : null,
      tenantGuardrails: guardrails,
      effective: {
        maxConcurrentSessions: Math.min(concurrentCeiling, guardrails?.maxConcurrentSessions ?? Number.POSITIVE_INFINITY),
        maxToolCallsPerMinute: Math.min(toolCeiling, guardrails?.maxToolCallsPerMinute ?? Number.POSITIVE_INFINITY),
      },
    };
  }

  private async organisationStatus(client: PoolClient, tenantId: string) {
    const result = await client.query<{ status: string }>(
      `SELECT status FROM ${runtimeConfig().schema}.customers WHERE customer_id=$1`, [tenantId]);
    return result.rows[0]?.status;
  }
}

export class AdmissionLimitExceededException extends HttpException {
  constructor(message: string, status = HttpStatus.TOO_MANY_REQUESTS) { super(message, status); }
}

function advisoryLock(client: PoolClient, key: string) {
  return client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
}

function parseEntitlements(value: unknown): { concurrentSessions?: number; toolCallsPerMinute?: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  return { ...entitlement("concurrentSessions"), ...entitlement("toolCallsPerMinute") };
  function entitlement(key: "concurrentSessions" | "toolCallsPerMinute") {
    if (!(key in input)) return {};
    const parsed = entitlementLimitSchema.safeParse(input[key]);
    return { [key]: parsed.success ? parsed.data : 0 };
  }
}
