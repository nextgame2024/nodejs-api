import { ConflictException, Injectable } from "@nestjs/common";
import type { PoolClient } from "pg";
import { runtimeConfig } from "../../config/runtime-config.js";
import { DatabaseService } from "../../database/database.service.js";
import type { BillingInvoiceObservation, BillingSubscriptionObservation } from "./billing-provider.port.js";

type CommitmentRow = {
  billing_subscription_commitment_id: string;
  required_periods: number;
  periods_observed: number;
  commencement_period_start: Date | string;
  commitment_end: Date | string | null;
  last_observed_at: Date | string;
};

@Injectable()
export class BillingSubscriptionCommitmentService {
  constructor(private readonly database: DatabaseService) {}

  async observe(client: PoolClient, tenantId: string, providerKey: string, environment: "sandbox" | "live",
    providerAccountKey: string, observation: BillingSubscriptionObservation) {
    if (!observation.currentPeriodStart || !observation.currentPeriodEnd) return { status: "not_ready" as const };
    const schema = runtimeConfig().schema;
    const reference = await client.query<{ billing_subscription_reference_id: string }>(
      `SELECT billing_subscription_reference_id FROM ${schema}.billing_subscription_references
       WHERE customer_id=$1 AND provider_key=$2 AND provider_environment=$3 AND provider_account_key=$4
         AND external_subscription_ref=$5`,
      [tenantId, providerKey, environment, providerAccountKey, observation.externalRef]);
    if (reference.rows.length !== 1) throw new ConflictException("The observed subscription reference is not unique.");
    const existing = await client.query<CommitmentRow>(
      `SELECT * FROM ${schema}.billing_subscription_commitments
       WHERE customer_id=$1 AND billing_subscription_reference_id=$2`,
      [tenantId, reference.rows[0].billing_subscription_reference_id]);
    if (!existing.rows[0]) return { status: "awaiting_paid_commencement" as const };
    const planIdentity = await client.query<{ commercial_plan_version_id: string }>(
      `SELECT commercial_plan_version_id FROM ${schema}.billing_subscription_commitments
       WHERE customer_id=$1 AND billing_subscription_reference_id=$2`,
      [tenantId, reference.rows[0].billing_subscription_reference_id]);
    if (!observation.planVersionId || observation.planVersionId !== planIdentity.rows[0]?.commercial_plan_version_id) {
      throw new ConflictException("Subscription metadata does not match the committed commercial plan.");
    }
    const commitment = (await client.query<CommitmentRow>(
      `SELECT * FROM ${schema}.billing_subscription_commitments
       WHERE customer_id=$1 AND billing_subscription_reference_id=$2`,
      [tenantId, reference.rows[0].billing_subscription_reference_id])).rows[0];
    const periods = await client.query<{ period_start: Date | string; period_end: Date | string }>(
      `SELECT period_start,period_end FROM ${schema}.billing_subscription_periods
       WHERE customer_id=$1 AND billing_subscription_reference_id=$2
         AND period_start>=$3::timestamptz ORDER BY period_start,period_end LIMIT 121`,
      [tenantId, reference.rows[0].billing_subscription_reference_id, iso(commitment.commencement_period_start)]);
    let expectedStart = iso(commitment.commencement_period_start);
    const contiguous: Array<{ start: string; end: string }> = [];
    for (const period of periods.rows) {
      const start = iso(period.period_start); const end = iso(period.period_end);
      if (start !== expectedStart) break;
      contiguous.push({ start, end }); expectedStart = end;
      if (contiguous.length === commitment.required_periods) break;
    }
    if (contiguous.length === 0) throw new ConflictException("The commitment anchor has no matching provider period evidence.");
    const observed = Math.min(contiguous.length, commitment.required_periods);
    const boundary = observed === commitment.required_periods ? contiguous[observed - 1].end : null;
    const newerObservation = Date.parse(observation.observedAt) > Date.parse(iso(commitment.last_observed_at));
    if (observed > commitment.periods_observed || (!commitment.commitment_end && boundary) || newerObservation) {
      await client.query(
        `UPDATE ${schema}.billing_subscription_commitments
         SET periods_observed=GREATEST(periods_observed,$3),commitment_end=COALESCE(commitment_end,$4::timestamptz),
             last_observed_at=GREATEST(last_observed_at,$5::timestamptz),updated_at=now()
         WHERE customer_id=$1 AND billing_subscription_commitment_id=$2`,
        [tenantId, commitment.billing_subscription_commitment_id, observed, boundary, observation.observedAt]);
    }
    return { status: boundary ? "boundary_established" as const : "tracking" as const,
      requiredPeriods: commitment.required_periods, periodsObserved: observed, commitmentEnd: boundary };
  }

  async activateFromPaidInvoice(client: PoolClient, tenantId: string, providerKey: string,
    environment: "sandbox" | "live", providerAccountKey: string, invoice: BillingInvoiceObservation) {
    if (invoice.status !== "paid" || invoice.billingReason !== "subscription_create"
      || !invoice.externalSubscriptionRef) return { status: "not_commencement_payment" as const };
    const schema = runtimeConfig().schema;
    const reference = await client.query<{ billing_subscription_reference_id: string;
      current_period_start: Date | string | null; current_period_end: Date | string | null; observed_at: Date | string;
      commercial_plan_version_id: string | null }>(
      `SELECT billing_subscription_reference_id,current_period_start,current_period_end,observed_at,
              commercial_plan_version_id
       FROM ${schema}.billing_subscription_references
       WHERE customer_id=$1 AND provider_key=$2 AND provider_environment=$3 AND provider_account_key=$4
         AND external_subscription_ref=$5`,
      [tenantId, providerKey, environment, providerAccountKey, invoice.externalSubscriptionRef]);
    if (reference.rows.length !== 1 || !reference.rows[0].current_period_start || !reference.rows[0].current_period_end) {
      throw new ConflictException("Paid commencement cannot be anchored without the exact first subscription period.");
    }
    const periodStart = iso(reference.rows[0].current_period_start);
    const periodEnd = iso(reference.rows[0].current_period_end);
    const commercial = await client.query<{ commercial_assignment_id: string; commercial_plan_version_id: string;
      minimum_commitment_months: number | null; billing_interval: string }>(
      `SELECT assignment.commercial_assignment_id,plan.commercial_plan_version_id,
              plan.minimum_commitment_months,plan.billing_interval
       FROM ${schema}.tenant_commercial_assignments assignment
       JOIN ${schema}.commercial_plan_versions plan
         ON plan.commercial_plan_version_id=assignment.commercial_plan_version_id
       WHERE assignment.customer_id=$1 AND assignment.status='active' AND assignment.effective_from<=$2::timestamptz
         AND (assignment.effective_to IS NULL OR assignment.effective_to>$2::timestamptz)
         AND plan.status IN ('published','retired')
       ORDER BY assignment.effective_from DESC LIMIT 2`, [tenantId, periodStart]);
    if (commercial.rows.length !== 1 || commercial.rows[0].minimum_commitment_months === null) {
      return { status: "not_required" as const };
    }
    const plan = commercial.rows[0];
    if (plan.billing_interval !== "month") throw new ConflictException(
      "Minimum-month commitment enforcement requires a monthly commercial plan.");
    if (!reference.rows[0].commercial_plan_version_id
      || reference.rows[0].commercial_plan_version_id !== plan.commercial_plan_version_id) {
      throw new ConflictException("Paid commencement subscription metadata does not match the active commercial plan.");
    }
    await client.query(
      `INSERT INTO ${schema}.billing_subscription_commitments
        (customer_id,billing_subscription_reference_id,commercial_assignment_id,commercial_plan_version_id,
         provider_key,provider_environment,provider_account_key,external_subscription_ref,required_periods,
         commencement_period_start,commencement_period_end,periods_observed,commitment_end,last_observed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,CASE WHEN $9=1 THEN $11::timestamptz END,$12)
       ON CONFLICT (billing_subscription_reference_id) DO NOTHING`,
      [tenantId, reference.rows[0].billing_subscription_reference_id, plan.commercial_assignment_id,
        plan.commercial_plan_version_id, providerKey, environment, providerAccountKey,
        invoice.externalSubscriptionRef, plan.minimum_commitment_months, periodStart, periodEnd,
        invoice.observedAt]);
    return { status: "activated" as const, requiredPeriods: plan.minimum_commitment_months,
      commencementPeriodStart: periodStart, commencementPeriodEnd: periodEnd };
  }

  async portalPolicy(tenantId: string, providerKey: string, environment: "sandbox" | "live", providerAccountKey: string) {
    const schema = runtimeConfig().schema;
    const result = await this.database.tenantReadTransaction(tenantId, (client) => client.query<{
      minimum_commitment_months: number | null; required_periods: number | null; periods_observed: number | null;
      commitment_end: Date | string | null;
    }>(
      `SELECT active_plan.minimum_commitment_months,commitment.required_periods,
              commitment.periods_observed,commitment.commitment_end
       FROM ${schema}.billing_subscription_references subscription
       LEFT JOIN ${schema}.billing_subscription_commitments commitment
         ON commitment.billing_subscription_reference_id=subscription.billing_subscription_reference_id
        AND commitment.customer_id=subscription.customer_id
       LEFT JOIN LATERAL (
         SELECT plan.minimum_commitment_months
         FROM ${schema}.tenant_commercial_assignments assignment
         JOIN ${schema}.commercial_plan_versions plan
           ON plan.commercial_plan_version_id=assignment.commercial_plan_version_id
         WHERE assignment.customer_id=subscription.customer_id AND assignment.status='active'
           AND assignment.effective_from<=now() AND (assignment.effective_to IS NULL OR assignment.effective_to>now())
         ORDER BY assignment.effective_from DESC LIMIT 1
       ) active_plan ON true
       WHERE subscription.customer_id=$1 AND subscription.provider_key=$2
        AND subscription.provider_environment=$3 AND subscription.provider_account_key=$4
        AND subscription.status IN ('pending','trialing','active','past_due','paused')
        AND (commitment.billing_subscription_commitment_id IS NOT NULL
          OR active_plan.minimum_commitment_months IS NOT NULL)
       ORDER BY subscription.observed_at DESC LIMIT 2`, [tenantId, providerKey, environment, providerAccountKey]));
    if (result.rows.length === 0) return { mode: "standard" as const, commitmentEnd: null,
      requiredPeriods: null, periodsObserved: null };
    if (result.rows.length !== 1) throw new ConflictException("Cancellation policy is ambiguous across active subscriptions.");
    const row = result.rows[0];
    const end = row.commitment_end ? iso(row.commitment_end) : null;
    const satisfied = end !== null && Date.now() >= Date.parse(end);
    return { mode: satisfied ? "standard" as const : "commitment_restricted" as const,
      commitmentEnd: end, requiredPeriods: row.required_periods ?? row.minimum_commitment_months!,
      periodsObserved: row.periods_observed ?? 0 };
  }
}

function iso(value: Date | string) { return new Date(value).toISOString(); }
