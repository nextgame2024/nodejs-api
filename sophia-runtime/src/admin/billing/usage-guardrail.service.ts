import { BadRequestException, ConflictException, Inject, Injectable } from "@nestjs/common";
import { runtimeConfig } from "../../config/runtime-config.js";
import { DatabaseService } from "../../database/database.service.js";
import { RuntimeAdmissionService, type EffectiveAdmissionLimits } from "../../platform/admission/runtime-admission.service.js";
import { AdminAuditService } from "../authorization/admin-audit.service.js";
import type { AdminPrincipal } from "../contracts/admin-contracts.js";
import { UsageGuardrailUpdateSchema } from "./usage-guardrail.contracts.js";

@Injectable()
export class UsageGuardrailService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(RuntimeAdmissionService) private readonly admission: RuntimeAdmissionService,
    @Inject(AdminAuditService) private readonly audit: AdminAuditService,
  ) {}

  async workspace(tenantId: string) {
    const limits = await this.admission.limits(tenantId);
    return { tenantId, generatedAt: new Date().toISOString(), limits, providerCostAlert: await this.alert(tenantId, limits) };
  }

  async update(tenantId: string, principal: AdminPrincipal, input: unknown) {
    const parsed = UsageGuardrailUpdateSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((issue) => issue.message).join("; "));
    const schema = runtimeConfig().schema;
    await this.database.tenantTransaction(tenantId, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`guardrail:${tenantId}`]);
      const current = await this.admission.limitsWithClient(client, tenantId);
      const ceilings = commercialCeilings(current);
      if (parsed.data.maxConcurrentSessions !== null && parsed.data.maxConcurrentSessions > ceilings.maxConcurrentSessions) {
        throw new BadRequestException(`maxConcurrentSessions cannot exceed the current ceiling of ${ceilings.maxConcurrentSessions}.`);
      }
      if (parsed.data.maxToolCallsPerMinute !== null && parsed.data.maxToolCallsPerMinute > ceilings.maxToolCallsPerMinute) {
        throw new BadRequestException(`maxToolCallsPerMinute cannot exceed the current ceiling of ${ceilings.maxToolCallsPerMinute}.`);
      }
      const alert = parsed.data.providerCostAlert;
      const params = [tenantId, parsed.data.maxConcurrentSessions, parsed.data.maxToolCallsPerMinute,
        alert?.thresholdMicrounits ?? null, alert?.currency ?? null, principal.identityUserId];
      const result = parsed.data.expectedRevision === 0
        ? await client.query(
          `INSERT INTO ${schema}.tenant_usage_guardrails
            (customer_id,max_concurrent_sessions,max_tool_calls_per_minute,
             provider_cost_alert_microunits,provider_cost_alert_currency,updated_by_identity)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (customer_id) DO NOTHING RETURNING revision`, params)
        : await client.query(
          `UPDATE ${schema}.tenant_usage_guardrails
           SET max_concurrent_sessions=$2,max_tool_calls_per_minute=$3,
               provider_cost_alert_microunits=$4,provider_cost_alert_currency=$5,
               updated_by_identity=$6,revision=revision+1,updated_at=now()
           WHERE customer_id=$1 AND revision=$7 RETURNING revision`, [...params, parsed.data.expectedRevision]);
      if (result.rowCount !== 1) throw new ConflictException("Usage guardrails changed; reload before saving.");
      await this.audit.record({
        tenantId, identityUserId: principal.identityUserId, eventType: "usage.guardrails.updated",
        permission: "usage.limits.manage", outcome: "allowed", resourceType: "tenant_usage_guardrails", resourceId: tenantId,
        metadata: { previousRevision: parsed.data.expectedRevision,
          maxConcurrentSessions: parsed.data.maxConcurrentSessions,
          maxToolCallsPerMinute: parsed.data.maxToolCallsPerMinute,
          providerCostAlertConfigured: alert !== null, providerCostAlertCurrency: alert?.currency ?? null,
          admissionEffect: "downward-only", providerCostAlertEffect: "estimate-only-non-enforcing" },
      }, client);
    });
    return this.workspace(tenantId);
  }

  private async alert(tenantId: string, limits: EffectiveAdmissionLimits) {
    const guardrail = limits.tenantGuardrails;
    if (!guardrail?.providerCostAlertMicrounits || !guardrail.providerCostAlertCurrency) return {
      status: "not_configured" as const, admissionEnforcement: false, customerCharge: false,
      detail: "No provider-cost estimate alert is configured.",
    };
    const schema = runtimeConfig().schema;
    const result = await this.database.tenantReadTransaction(tenantId, (client) => client.query<{
      cost_table_version: string; measurement_status: string; microunits: string;
    }>(`SELECT cost_table_version,measurement_status,sum(estimated_cost_microunits)::text AS microunits
        FROM ${schema}.provider_usage_events
        WHERE customer_id=$1 AND cost_currency=$2 AND estimated_cost_microunits IS NOT NULL
          AND occurred_at>=(date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
          AND occurred_at<(date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')+interval '1 month'
        GROUP BY cost_table_version,measurement_status ORDER BY cost_table_version,measurement_status`,
    [tenantId, guardrail.providerCostAlertCurrency]));
    const total = result.rows.reduce((sum, row) => sum + BigInt(row.microunits), 0n);
    const threshold = BigInt(guardrail.providerCostAlertMicrounits);
    return {
      status: result.rows.length === 0 ? "no_evidence" as const : total >= threshold ? "active" as const : "clear" as const,
      period: { boundary: "calendar_utc" as const, interval: "month" as const },
      currency: guardrail.providerCostAlertCurrency, thresholdMicrounits: threshold.toString(),
      estimatedMicrounits: total.toString(), evidence: result.rows.map((row) => ({
        costTableVersion: row.cost_table_version, measurementStatus: row.measurement_status, estimatedMicrounits: row.microunits,
      })),
      admissionEnforcement: false, customerCharge: false,
      detail: "This compares versioned provider-cost estimates only; it is not a customer charge, invoice, balance or admission decision.",
    };
  }
}

function commercialCeilings(limits: EffectiveAdmissionLimits) {
  return {
    maxConcurrentSessions: Math.min(limits.platformHardCaps.maxConcurrentSessions,
      limits.commercialCeilings?.maxConcurrentSessions ?? Number.POSITIVE_INFINITY),
    maxToolCallsPerMinute: Math.min(limits.platformHardCaps.maxToolCallsPerMinute,
      limits.commercialCeilings?.maxToolCallsPerMinute ?? Number.POSITIVE_INFINITY),
  };
}
