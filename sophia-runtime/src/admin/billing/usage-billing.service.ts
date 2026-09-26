import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { runtimeConfig } from "../../config/runtime-config.js";
import { DatabaseService } from "../../database/database.service.js";
import { OperationalAccountabilityService } from "../operations/operational-accountability.service.js";
import { BILLING_PROVIDER, type BillingProvider } from "./billing-provider.port.js";

const rateCardSchema = z.object({
  dimensions: z.array(z.object({
    dimension: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    includedQuantity: z.string().regex(/^\d+$/),
    unitQuantity: z.string().regex(/^[1-9]\d*$/),
    unitPriceMinor: z.string().regex(/^\d+$/),
  }).strict()).max(64),
}).strict();

type PlanRow = {
  commercial_assignment_id: string; assignment_status: string; effective_from: Date | string; effective_to: Date | string | null;
  commercial_plan_version_id: string; plan_key: string; version: number; display_name: string; plan_status: string;
  pricing_status: string; billing_currency: string | null; billing_interval: string | null;
  base_charge_minor: string | null; tax_mode: string; tax_rate_basis_points: number | null;
  overage_rounding: string; rate_card: unknown; entitlements: Record<string, unknown>; manifest_digest: string;
};

@Injectable()
export class UsageBillingService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(OperationalAccountabilityService) private readonly operations: OperationalAccountabilityService,
    @Inject(BILLING_PROVIDER) private readonly billing: BillingProvider,
  ) {}

  usage(tenantId: string) { return this.operations.usage(tenantId); }

  async commercial(tenantId: string) {
    const schema = runtimeConfig().schema;
    return this.database.tenantReadTransaction(tenantId, async (client) => {
      const assignment = await client.query<PlanRow>(
        `SELECT a.commercial_assignment_id, a.status AS assignment_status, a.effective_from, a.effective_to,
                p.commercial_plan_version_id, p.plan_key, p.version, p.display_name, p.status AS plan_status,
                p.pricing_status, p.billing_currency, p.billing_interval, p.base_charge_minor,
                p.tax_mode, p.tax_rate_basis_points, p.overage_rounding, p.rate_card, p.entitlements, p.manifest_digest
         FROM ${schema}.tenant_commercial_assignments a
         JOIN ${schema}.commercial_plan_versions p ON p.commercial_plan_version_id=a.commercial_plan_version_id
         WHERE a.customer_id=$1 AND a.status='active' AND a.effective_from<=now()
           AND (a.effective_to IS NULL OR a.effective_to>now())
         ORDER BY a.effective_from DESC LIMIT 1`, [tenantId]);
      const plan = assignment.rows[0] ?? null;
      const period = plan ? commercialPeriod(plan, new Date()) : null;
      const dimensions = period
        ? await client.query<{ dimension: string; measurement_status: string; quantity: string }>(
          `SELECT d.key AS dimension, u.measurement_status, sum(d.value::numeric)::text AS quantity
           FROM ${schema}.provider_usage_events u CROSS JOIN LATERAL jsonb_each_text(u.usage_dimensions) d
           WHERE u.customer_id=$1 AND u.occurred_at >= $2 AND u.occurred_at < $3
           GROUP BY d.key,u.measurement_status ORDER BY d.key,u.measurement_status`,
          [tenantId, period.from, period.to])
        : { rows: [] };
      const subscriptions = await client.query(
        `SELECT billing_subscription_reference_id, provider_key, external_subscription_ref, status,
                current_period_start, current_period_end, observed_at, revision
         FROM ${schema}.billing_subscription_references WHERE customer_id=$1 ORDER BY observed_at DESC LIMIT 20`, [tenantId]);
      const invoices = await client.query(
        `SELECT billing_invoice_reference_id, provider_key, external_invoice_ref, status, currency,
                amount_due_minor, amount_paid_minor, hosted_invoice_url, due_at, observed_at, revision
         FROM ${schema}.billing_invoice_references WHERE customer_id=$1 ORDER BY observed_at DESC LIMIT 50`, [tenantId]);
      const providerCustomers = await client.query<{ provider_key: string; provider_environment: string; observed_at: Date | string }>(
        `SELECT provider_key,provider_environment,observed_at FROM ${schema}.billing_provider_customers
         WHERE customer_id=$1 ORDER BY observed_at DESC`, [tenantId]);
      const webhookEvents = await client.query(
        `SELECT external_event_ref,event_type,processing_status,processing_detail,occurred_at,processed_at
         FROM ${schema}.billing_webhook_events WHERE customer_id=$1 ORDER BY occurred_at DESC LIMIT 20`, [tenantId]);
      const checkoutIntents = await client.query(
        `SELECT request_id,commercial_plan_version_id,status,created_at,expires_at
         FROM ${schema}.billing_checkout_intents WHERE customer_id=$1
           AND provider_key='stripe-sophia' AND provider_environment='sandbox'
           AND (status IN ('allocating','outcome_unknown') OR (status='created' AND expires_at>now()))
         ORDER BY created_at DESC LIMIT 1`, [tenantId]);
      return {
        tenantId,
        generatedAt: new Date().toISOString(),
        providerIntegration: this.billing.status(),
        assignment: plan ? publicPlan(plan) : null,
        preview: preview(plan, dimensions.rows, period),
        subscriptions: subscriptions.rows,
        invoices: invoices.rows,
        providerCustomers: providerCustomers.rows.map((row) => ({ providerKey: row.provider_key,
          environment: row.provider_environment, observedAt: iso(row.observed_at) })),
        recentWebhookEvents: webhookEvents.rows,
        activeCheckoutIntent: checkoutIntents.rows[0] ?? null,
        authority: {
          tenantPlanMutation: "unavailable",
          detail: "Tenant administrators cannot publish rate cards or self-assign commercial entitlements. Platform commercial authority is not implemented.",
        },
        isolation: {
          existingPayments: "excluded",
          detail: "Business Manager Toolkit, video-render and business invoice objects are outside the Sophia subscription namespace.",
        },
      };
    });
  }
}

function publicPlan(row: PlanRow) {
  return { assignmentId: row.commercial_assignment_id, assignmentStatus: row.assignment_status,
    effectiveFrom: iso(row.effective_from), effectiveTo: row.effective_to ? iso(row.effective_to) : null,
    planVersionId: row.commercial_plan_version_id, planKey: row.plan_key, version: row.version,
    displayName: row.display_name, planStatus: row.plan_status, pricingStatus: row.pricing_status,
    currency: row.billing_currency, interval: row.billing_interval,
    baseChargeMinor: row.base_charge_minor, taxMode: row.tax_mode,
    overageRounding: row.overage_rounding, entitlements: row.entitlements, manifestDigest: row.manifest_digest };
}

type CommercialPeriod = { from: Date; to: Date; boundary: "calendar_utc" };
type DecimalQuantity = { numerator: bigint; scale: bigint };

function preview(plan: PlanRow | null, rows: Array<{ dimension: string; measurement_status: string; quantity: string }>, period: CommercialPeriod | null) {
  if (!plan) return unavailablePreview("No active Sophia commercial plan assignment exists.");
  if (plan.plan_status !== "published" || plan.pricing_status !== "configured" || !plan.billing_currency
    || !plan.billing_interval || plan.base_charge_minor === null || plan.overage_rounding !== "ceil") {
    return unavailablePreview("The assigned commercial plan has no complete published pricing configuration.");
  }
  const parsed = rateCardSchema.safeParse(plan.rate_card);
  if (!parsed.success || !period) return unavailablePreview("The assigned rate card or billing period is invalid.");
  try {
    const totals = new Map<string, DecimalQuantity>();
    let evidenceStatus: "measured" | "estimated_or_incomplete" = "measured";
    for (const row of rows) {
      totals.set(row.dimension, addDecimal(totals.get(row.dimension), parseDecimal(row.quantity)));
      if (row.measurement_status !== "measured") evidenceStatus = "estimated_or_incomplete";
    }
    const lineItems = parsed.data.dimensions.map((rate) => {
      const quantity = totals.get(rate.dimension) ?? { numerator: 0n, scale: 1n };
      const includedNumerator = BigInt(rate.includedQuantity) * quantity.scale;
      const overageNumerator = quantity.numerator > includedNumerator
        ? quantity.numerator - includedNumerator : 0n;
      const amount = ceilDiv(overageNumerator * BigInt(rate.unitPriceMinor),
        quantity.scale * BigInt(rate.unitQuantity));
      return { dimension: rate.dimension, quantity: decimalString(quantity), includedQuantity: rate.includedQuantity,
        overageQuantity: decimalString({ numerator: overageNumerator, scale: quantity.scale }), amountMinor: amount.toString() };
    });
    const subtotal = BigInt(plan.base_charge_minor) + lineItems.reduce((sum, item) => sum + BigInt(item.amountMinor), 0n);
    const tax = plan.tax_mode === "exclusive" && plan.tax_rate_basis_points !== null
      ? ceilDiv(subtotal * BigInt(plan.tax_rate_basis_points), 10000n) : 0n;
    return { status: "preview_only", chargeExecution: false, currency: plan.billing_currency,
      interval: plan.billing_interval, period: { from: period.from.toISOString(), to: period.to.toISOString(), boundary: period.boundary },
      evidenceStatus, baseChargeMinor: plan.base_charge_minor,
      subtotalMinor: subtotal.toString(), taxMinor: plan.tax_mode === "inclusive" ? null : tax.toString(),
      totalMinor: (subtotal + tax).toString(), taxMode: plan.tax_mode, lineItems,
      disclaimer: "This deterministic preview creates no charge, invoice, subscription or payment instruction." };
  } catch {
    return unavailablePreview("Usage or rate-card quantities cannot be represented by the approved integer preview contract.");
  }
}
function unavailablePreview(reason: string) { return { status: "unavailable", chargeExecution: false, reason }; }
function ceilDiv(value: bigint, divisor: bigint) { return value === 0n ? 0n : (value + divisor - 1n) / divisor; }
function parseDecimal(value: string): DecimalQuantity {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value); if (!match) throw new Error("invalid decimal");
  const fraction = match[2] ?? ""; const scale = 10n ** BigInt(fraction.length);
  return { numerator: BigInt(match[1]) * scale + BigInt(fraction || "0"), scale };
}
function addDecimal(left: DecimalQuantity | undefined, right: DecimalQuantity): DecimalQuantity {
  if (!left) return right;
  const scale = left.scale > right.scale ? left.scale : right.scale;
  return { numerator: left.numerator * (scale / left.scale) + right.numerator * (scale / right.scale), scale };
}
function decimalString(value: DecimalQuantity) {
  if (value.scale === 1n) return value.numerator.toString();
  const places = value.scale.toString().length - 1;
  const padded = value.numerator.toString().padStart(places + 1, "0");
  const result = `${padded.slice(0, -places)}.${padded.slice(-places)}`;
  return result.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}
function commercialPeriod(plan: PlanRow, now: Date): CommercialPeriod | null {
  if (plan.billing_interval !== "month" && plan.billing_interval !== "year") return null;
  const from = plan.billing_interval === "month"
    ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    : new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const to = plan.billing_interval === "month"
    ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
    : new Date(Date.UTC(now.getUTCFullYear() + 1, 0, 1));
  const effectiveFrom = new Date(plan.effective_from);
  const effectiveTo = plan.effective_to ? new Date(plan.effective_to) : null;
  return { from: effectiveFrom > from ? effectiveFrom : from, to: effectiveTo && effectiveTo < to ? effectiveTo : to,
    boundary: "calendar_utc" };
}
function iso(value: Date | string) { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }
