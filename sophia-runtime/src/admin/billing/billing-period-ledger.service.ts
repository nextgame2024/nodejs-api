import { createHash } from "node:crypto";
import { ConflictException, Inject, Injectable } from "@nestjs/common";
import type { PoolClient } from "pg";
import { z } from "zod";
import { runtimeConfig } from "../../config/runtime-config.js";
import { DatabaseService } from "../../database/database.service.js";

const activeRateSchema = z.object({
  dimension: z.literal("active-seconds"),
  includedQuantity: z.literal("120000"),
  unitQuantity: z.literal("60"),
  unitPriceMinor: z.string().regex(/^\d+$/),
}).strict();

type PeriodRow = {
  billing_subscription_period_id: string;
  period_start: Date | string;
  period_end: Date | string;
};

type CommercialRow = {
  commercial_assignment_id: string;
  assignment_revision: number;
  assignment_effective_from: Date | string;
  assignment_effective_to: Date | string | null;
  commercial_plan_version_id: string;
  billing_currency: string;
  rate_card: { dimensions?: unknown[] };
  manifest_digest: string;
  seller_legal_entity_version_id: string;
  seller_commercial_policy_version_id: string;
};

export type BillingPeriodFinalisation = {
  observedPeriods: number;
  finalised: number;
  existing: number;
  blocked: Array<{ periodId: string; reason: string }>;
};

@Injectable()
export class BillingPeriodLedgerService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async finaliseEligible(
    tenantId: string,
    environment: "sandbox" | "live",
    providerAccountKey: string,
  ): Promise<BillingPeriodFinalisation> {
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `billing-period-ledger:${environment}:${providerAccountKey}:${tenantId}`,
      ]);
      const periods = await client.query<PeriodRow>(
        `SELECT p.billing_subscription_period_id,p.period_start,p.period_end
         FROM ${schema}.billing_subscription_periods p
         LEFT JOIN ${schema}.billing_usage_period_ledgers l
           ON l.billing_subscription_period_id=p.billing_subscription_period_id
         WHERE p.customer_id=$1 AND p.provider_key='stripe-sophia'
           AND p.provider_environment=$2 AND p.provider_account_key=$3
           AND p.period_end<=now() AND l.billing_usage_period_ledger_id IS NULL
         ORDER BY p.period_end,p.billing_subscription_period_id FOR UPDATE OF p SKIP LOCKED LIMIT 24`,
        [tenantId, environment, providerAccountKey],
      );
      const result: BillingPeriodFinalisation = {
        observedPeriods: periods.rows.length, finalised: 0, existing: 0, blocked: [],
      };
      for (const period of periods.rows) {
        const outcome = await this.finalisePeriod(client, tenantId, period);
        if (outcome === "finalised") result.finalised += 1;
        else if (outcome === "existing") result.existing += 1;
        else result.blocked.push({ periodId: period.billing_subscription_period_id, reason: outcome });
      }
      return result;
    });
  }

  private async finalisePeriod(
    client: PoolClient,
    tenantId: string,
    period: PeriodRow,
  ): Promise<"finalised" | "existing" | string> {
    const schema = runtimeConfig().schema;
    const periodStart = new Date(period.period_start);
    const periodEnd = new Date(period.period_end);
    const commercial = await client.query<CommercialRow>(
      `SELECT a.commercial_assignment_id,a.assignment_revision,
              a.effective_from AS assignment_effective_from,a.effective_to AS assignment_effective_to,
              p.commercial_plan_version_id,p.billing_currency,
              p.rate_card,p.manifest_digest,policy.seller_legal_entity_version_id,
              policy.seller_commercial_policy_version_id
       FROM ${schema}.tenant_commercial_assignments a
       JOIN ${schema}.commercial_plan_versions p
         ON p.commercial_plan_version_id=a.commercial_plan_version_id
       JOIN ${schema}.seller_commercial_policy_versions policy
         ON policy.seller_legal_entity_id=p.seller_legal_entity_id
        AND policy.status IN ('published','retired')
        AND policy.effective_from<=$2 AND (policy.effective_to IS NULL OR policy.effective_to>=$3)
       WHERE a.customer_id=$1 AND a.status IN ('active','ended')
         AND a.effective_from<=$2 AND (a.effective_to IS NULL OR a.effective_to>=$3)
         AND p.status IN ('published','retired') AND p.pricing_status='configured'
         AND p.billing_interval='month'
       ORDER BY a.effective_from DESC,policy.effective_from DESC LIMIT 2`,
      [tenantId, periodStart, periodEnd],
    );
    if (commercial.rows.length !== 1) {
      return "The provider period is not covered by exactly one immutable monthly assignment and seller policy; proration is unavailable.";
    }
    const plan = commercial.rows[0];
    const dimensions = Array.isArray(plan.rate_card?.dimensions) ? plan.rate_card.dimensions : [];
    const activeRates = dimensions.filter((item) => typeof item === "object" && item !== null
      && (item as { dimension?: unknown }).dimension === "active-seconds");
    const parsedRate = dimensions.length === 1 && activeRates.length === 1
      ? activeRateSchema.safeParse(activeRates[0]) : null;
    if (!parsedRate?.success) {
      return "The plan does not contain exactly one approved 120000-second/60-second active-usage rate.";
    }
    const open = await client.query(
      `SELECT 1 FROM ${schema}.session_activity_intervals
       WHERE customer_id=$1 AND status='open' AND started_at<$3 LIMIT 1`,
      [tenantId, periodStart, periodEnd],
    );
    if (open.rowCount) return "An activity interval crossing the provider period is still open.";
    const measured = await client.query<{ active_microseconds: string }>(
      `SELECT COALESCE(sum((extract(epoch FROM
         (LEAST(ended_at,$3::timestamptz)-GREATEST(started_at,$2::timestamptz))) * 1000000)::bigint),0)::text
         AS active_microseconds
       FROM ${schema}.session_activity_intervals
       WHERE customer_id=$1 AND status IN ('finalised','expired')
         AND started_at<$3 AND ended_at>$2`,
      [tenantId, periodStart, periodEnd],
    );
    const activeMicroseconds = BigInt(measured.rows[0]?.active_microseconds ?? "0");
    const includedSeconds = 120000n;
    const overageMicroseconds = maxBigInt(0n, activeMicroseconds - includedSeconds * 1_000_000n);
    const billableMinutes = ceilDiv(overageMicroseconds, 60_000_000n);
    const ledger = {
      customerId: tenantId,
      periodId: period.billing_subscription_period_id,
      assignmentId: plan.commercial_assignment_id,
      assignmentRevision: plan.assignment_revision,
      assignmentEffectiveFrom: new Date(plan.assignment_effective_from).toISOString(),
      assignmentEffectiveTo: plan.assignment_effective_to
        ? new Date(plan.assignment_effective_to).toISOString() : null,
      planVersionId: plan.commercial_plan_version_id,
      sellerLegalEntityVersionId: plan.seller_legal_entity_version_id,
      sellerCommercialPolicyVersionId: plan.seller_commercial_policy_version_id,
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      activeMicroseconds: activeMicroseconds.toString(),
      includedActiveSeconds: includedSeconds.toString(),
      overageMicroseconds: overageMicroseconds.toString(),
      billableOverageMinutes: billableMinutes.toString(),
      overageUnitPriceMinor: parsedRate.data.unitPriceMinor,
      currency: plan.billing_currency,
      rateCard: parsedRate.data,
      planManifestDigest: plan.manifest_digest,
    };
    const digest = createHash("sha256").update(JSON.stringify(ledger)).digest("hex");
    const inserted = await client.query(
      `INSERT INTO ${schema}.billing_usage_period_ledgers (
         customer_id,billing_subscription_period_id,commercial_assignment_id,assignment_revision,
         assignment_effective_from,assignment_effective_to,commercial_plan_version_id,
         seller_legal_entity_version_id,seller_commercial_policy_version_id,period_start,period_end,
         active_microseconds,included_active_seconds,overage_microseconds,billable_overage_minutes,
         overage_unit_price_minor,currency,rate_card_snapshot,plan_manifest_digest,ledger_digest
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19,$20)
       ON CONFLICT (billing_subscription_period_id) DO NOTHING RETURNING billing_usage_period_ledger_id`,
      [tenantId, period.billing_subscription_period_id, plan.commercial_assignment_id,
        plan.assignment_revision, plan.assignment_effective_from, plan.assignment_effective_to,
        plan.commercial_plan_version_id, plan.seller_legal_entity_version_id,
        plan.seller_commercial_policy_version_id, periodStart, periodEnd,
        activeMicroseconds.toString(), includedSeconds.toString(), overageMicroseconds.toString(),
        billableMinutes.toString(), parsedRate.data.unitPriceMinor, plan.billing_currency,
        JSON.stringify(parsedRate.data), plan.manifest_digest, digest],
    );
    if (inserted.rowCount) return "finalised";
    const existing = await client.query<{ ledger_digest: string }>(
      `SELECT ledger_digest FROM ${schema}.billing_usage_period_ledgers
       WHERE billing_subscription_period_id=$1 AND customer_id=$2`,
      [period.billing_subscription_period_id, tenantId],
    );
    if (existing.rows[0]?.ledger_digest !== digest) {
      throw new ConflictException("The finalised billing period conflicts with recomputed evidence.");
    }
    return "existing";
  }
}

function ceilDiv(value: bigint, divisor: bigint): bigint {
  return value === 0n ? 0n : (value + divisor - 1n) / divisor;
}
function maxBigInt(left: bigint, right: bigint): bigint { return left > right ? left : right; }
