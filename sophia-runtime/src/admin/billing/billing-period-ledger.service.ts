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
  provider_key: string;
  provider_environment: "sandbox" | "live";
  provider_account_key: string;
  billing_provider_customer_id: string | null;
  external_customer_ref: string | null;
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
    providerKey: string,
    environment: "sandbox" | "live",
    providerAccountKey: string,
  ): Promise<BillingPeriodFinalisation> {
    return this.finaliseEligibleThrough(tenantId, providerKey, environment, providerAccountKey, null);
  }

  async finaliseSandboxTestClock(
    tenantId: string,
    providerKey: string,
    providerAccountKey: string,
    providerClockTime: string,
  ): Promise<BillingPeriodFinalisation> {
    const cutoff = new Date(providerClockTime);
    const maximum = Date.now() + 62 * 24 * 60 * 60 * 1_000;
    if (!Number.isFinite(cutoff.getTime()) || cutoff.getTime() <= 0 || cutoff.getTime() > maximum) {
      throw new ConflictException("The sandbox test-clock cutoff is invalid or exceeds two monthly intervals.");
    }
    return this.finaliseEligibleThrough(tenantId, providerKey, "sandbox", providerAccountKey, cutoff.toISOString());
  }

  private async finaliseEligibleThrough(
    tenantId: string,
    providerKey: string,
    environment: "sandbox" | "live",
    providerAccountKey: string,
    eligibleThrough: string | null,
  ): Promise<BillingPeriodFinalisation> {
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `billing-period-ledger:${providerKey}:${environment}:${providerAccountKey}:${tenantId}`,
      ]);
      const periods = await client.query<PeriodRow>(
        `SELECT p.billing_subscription_period_id,p.provider_key,p.provider_environment,p.provider_account_key,
                customer.billing_provider_customer_id,customer.external_customer_ref,p.period_start,p.period_end
         FROM ${schema}.billing_subscription_periods p
         LEFT JOIN ${schema}.billing_usage_period_ledgers l
           ON l.billing_subscription_period_id=p.billing_subscription_period_id
         LEFT JOIN ${schema}.billing_provider_customers customer
           ON customer.customer_id=p.customer_id AND customer.provider_key=p.provider_key
          AND customer.provider_environment=p.provider_environment
          AND customer.provider_account_key=p.provider_account_key
         WHERE p.customer_id=$1 AND p.provider_key=$4
           AND p.provider_environment=$2 AND p.provider_account_key=$3
           AND p.period_end<=COALESCE($5::timestamptz,now()) AND l.billing_usage_period_ledger_id IS NULL
         ORDER BY p.period_end,p.billing_subscription_period_id LIMIT 24`,
        [tenantId, environment, providerAccountKey, providerKey, eligibleThrough],
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
    if (billableMinutes > 0n && (!period.billing_provider_customer_id || !period.external_customer_ref)) {
      return "The positive overage cannot be finalised without an account-scoped provider Customer binding.";
    }
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
    const inserted = await client.query<{ billing_usage_period_ledger_id: string }>(
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
    const existing = inserted.rowCount ? null : await client.query<{
      billing_usage_period_ledger_id: string; ledger_digest: string;
    }>(
      `SELECT billing_usage_period_ledger_id,ledger_digest FROM ${schema}.billing_usage_period_ledgers
       WHERE billing_subscription_period_id=$1 AND customer_id=$2`,
      [period.billing_subscription_period_id, tenantId],
    );
    if (existing && existing.rows[0]?.ledger_digest !== digest) {
      throw new ConflictException("The finalised billing period conflicts with recomputed evidence.");
    }
    const ledgerId = inserted.rows[0]?.billing_usage_period_ledger_id
      ?? existing?.rows[0]?.billing_usage_period_ledger_id;
    if (!ledgerId) throw new ConflictException("The finalised billing period has no durable ledger identity.");
    if (billableMinutes > 0n) {
      await this.enqueueOverage(client, tenantId, period, ledgerId, billableMinutes, digest);
    }
    return inserted.rowCount ? "finalised" : "existing";
  }

  private async enqueueOverage(
    client: PoolClient,
    tenantId: string,
    period: PeriodRow,
    ledgerId: string,
    quantity: bigint,
    ledgerDigest: string,
  ) {
    const schema = runtimeConfig().schema;
    const meterBindingKey = "active-overage-minutes";
    const submissionIdentifier = `sophia-active-minutes-${ledgerId}`;
    const periodStart = new Date(period.period_start).getTime();
    const periodEnd = new Date(period.period_end).getTime();
    const eventMilliseconds = periodEnd - 1_000;
    if (!Number.isSafeInteger(periodStart) || !Number.isSafeInteger(periodEnd)
      || eventMilliseconds < periodStart) {
      throw new ConflictException("The provider period cannot contain a whole-second Meter event timestamp.");
    }
    // Stripe summaries use [start, end); place the aggregate inside the observed provider period.
    const eventTimestamp = new Date(eventMilliseconds).toISOString();
    const payload = { ledgerId, ledgerDigest, providerKey: period.provider_key,
      providerEnvironment: period.provider_environment, providerAccountKey: period.provider_account_key,
      billingProviderCustomerId: period.billing_provider_customer_id, meterBindingKey,
      externalCustomerRef: period.external_customer_ref,
      submissionIdentifier, eventTimestamp, quantity: quantity.toString(), quantityUnit: "whole-minute" };
    const payloadDigest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    await client.query(
      `INSERT INTO ${schema}.billing_meter_event_outbox (
         customer_id,billing_usage_period_ledger_id,billing_provider_customer_id,
         provider_key,provider_environment,provider_account_key,external_customer_ref,
         meter_binding_key,submission_identifier,event_timestamp,quantity,quantity_unit,payload_digest
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'whole-minute',$12)
       ON CONFLICT (billing_usage_period_ledger_id) DO NOTHING`,
      [tenantId, ledgerId, period.billing_provider_customer_id, period.provider_key,
        period.provider_environment, period.provider_account_key, period.external_customer_ref,
        meterBindingKey, submissionIdentifier, eventTimestamp, quantity.toString(), payloadDigest],
    );
    const persisted = await client.query<{ payload_digest: string }>(
      `SELECT payload_digest FROM ${schema}.billing_meter_event_outbox
       WHERE customer_id=$1 AND billing_usage_period_ledger_id=$2`, [tenantId, ledgerId]);
    if (persisted.rows[0]?.payload_digest !== payloadDigest) {
      throw new ConflictException("The meter-event outbox conflicts with the immutable period ledger.");
    }
  }
}

function ceilDiv(value: bigint, divisor: bigint): bigint {
  return value === 0n ? 0n : (value + divisor - 1n) / divisor;
}
function maxBigInt(left: bigint, right: bigint): bigint { return left > right ? left : right; }
