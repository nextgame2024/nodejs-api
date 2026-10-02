import { createHash, randomUUID } from "node:crypto";
import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { runtimeConfig } from "../../config/runtime-config.js";
import { DatabaseService } from "../../database/database.service.js";
import {
  BILLING_INVOICE_ADJUSTMENT_DISPATCHER,
  type BillingInvoiceAdjustmentDispatcher,
  type BillingInvoiceAdjustmentInput,
} from "./billing-invoice-adjustment.port.js";

export type DraftRenewalInvoice = {
  providerKey: string;
  providerEnvironment: "sandbox" | "live";
  providerAccountKey: string;
  externalCustomerRef: string;
  externalSubscriptionRef: string;
  externalInvoiceRef: string;
  periodStart: string;
  periodEnd: string;
};

type LedgerRow = {
  billing_usage_period_ledger_id: string;
  billing_provider_customer_id: string;
  commercial_plan_version_id: string;
  billable_overage_minutes: string;
  overage_unit_price_minor: string;
  currency: string;
};

type AdjustmentRow = {
  billing_invoice_adjustment_outbox_id: string;
  billing_usage_period_ledger_id: string;
  commercial_plan_version_id: string;
  provider_key: string;
  provider_environment: "sandbox" | "live";
  provider_account_key: string;
  external_customer_ref: string;
  external_subscription_ref: string;
  external_invoice_ref: string;
  one_time_price_ref: string;
  period_start: Date | string;
  period_end: Date | string;
  quantity: string;
  unit_price_minor: string;
  currency: string;
  payload_digest: string;
  lease_token: string;
};

@Injectable()
export class BillingInvoiceAdjustmentOutboxService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(BILLING_INVOICE_ADJUSTMENT_DISPATCHER)
    private readonly dispatcher: BillingInvoiceAdjustmentDispatcher,
  ) {}

  async enqueueDraftInvoice(tenantId: string, input: DraftRenewalInvoice) {
    if (input.providerEnvironment === "live") {
      return { status: "disabled" as const, detail: "Live overage invoice adjustment is not authorized." };
    }
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `billing-invoice-adjustment:${input.providerKey}:${input.providerEnvironment}:${input.providerAccountKey}:${input.externalInvoiceRef}`,
      ]);
      const ledger = await client.query<LedgerRow>(
        `SELECT l.billing_usage_period_ledger_id,l.commercial_plan_version_id,
                l.billable_overage_minutes::text,l.overage_unit_price_minor::text,l.currency,
                customer.billing_provider_customer_id
         FROM ${schema}.billing_usage_period_ledgers l
         JOIN ${schema}.billing_subscription_periods p
           ON p.billing_subscription_period_id=l.billing_subscription_period_id
          AND p.customer_id=l.customer_id
         JOIN ${schema}.billing_provider_customers customer
           ON customer.customer_id=l.customer_id AND customer.provider_key=p.provider_key
          AND customer.provider_environment=p.provider_environment
          AND customer.provider_account_key=p.provider_account_key
         WHERE l.customer_id=$1 AND p.provider_key=$2 AND p.provider_environment=$3
           AND p.provider_account_key=$4 AND p.external_subscription_ref=$5
           AND customer.external_customer_ref=$6
           AND l.period_start=$7::timestamptz AND l.period_end=$8::timestamptz
         LIMIT 2`,
        [tenantId, input.providerKey, input.providerEnvironment, input.providerAccountKey,
          input.externalSubscriptionRef, input.externalCustomerRef, input.periodStart, input.periodEnd],
      );
      if (ledger.rows.length !== 1) {
        return { status: "not_eligible" as const,
          detail: "The draft invoice does not match exactly one immutable usage-period ledger." };
      }
      const row = ledger.rows[0];
      if (row.billable_overage_minutes === "0") {
        return { status: "not_required" as const,
          detail: "The exact immutable usage-period ledger has no billable overage." };
      }
      const oneTimePriceRef = runtimeConfig().billing.stripeOveragePriceMappings[row.commercial_plan_version_id];
      if (!oneTimePriceRef) {
        throw new ConflictException("The immutable plan has no approved one-time overage Price mapping.");
      }
      const payload = {
        ledgerId: row.billing_usage_period_ledger_id,
        planVersionId: row.commercial_plan_version_id,
        providerKey: input.providerKey,
        providerEnvironment: input.providerEnvironment,
        providerAccountKey: input.providerAccountKey,
        externalCustomerRef: input.externalCustomerRef,
        externalSubscriptionRef: input.externalSubscriptionRef,
        externalInvoiceRef: input.externalInvoiceRef,
        oneTimePriceRef,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        quantity: row.billable_overage_minutes,
        unitPriceMinor: row.overage_unit_price_minor,
        currency: row.currency,
      };
      const digest = payloadDigest(payload);
      const inserted = await client.query<{ billing_invoice_adjustment_outbox_id: string }>(
        `INSERT INTO ${schema}.billing_invoice_adjustment_outbox (
           customer_id,billing_usage_period_ledger_id,billing_provider_customer_id,commercial_plan_version_id,
           provider_key,provider_environment,provider_account_key,external_customer_ref,
           external_subscription_ref,external_invoice_ref,one_time_price_ref,period_start,period_end,
           quantity,unit_price_minor,currency,payload_digest
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (billing_usage_period_ledger_id) DO NOTHING
         RETURNING billing_invoice_adjustment_outbox_id`,
        [tenantId, row.billing_usage_period_ledger_id, row.billing_provider_customer_id,
          row.commercial_plan_version_id, input.providerKey, input.providerEnvironment,
          input.providerAccountKey, input.externalCustomerRef, input.externalSubscriptionRef,
          input.externalInvoiceRef, oneTimePriceRef, input.periodStart, input.periodEnd,
          row.billable_overage_minutes, row.overage_unit_price_minor, row.currency, digest],
      );
      const persisted = await client.query<{ billing_invoice_adjustment_outbox_id: string; payload_digest: string }>(
        `SELECT billing_invoice_adjustment_outbox_id,payload_digest
         FROM ${schema}.billing_invoice_adjustment_outbox
         WHERE customer_id=$1 AND billing_usage_period_ledger_id=$2`,
        [tenantId, row.billing_usage_period_ledger_id],
      );
      if (persisted.rows[0]?.payload_digest !== digest) {
        throw new ConflictException("The invoice adjustment conflicts with immutable period evidence.");
      }
      return { status: inserted.rowCount ? "enqueued" as const : "existing" as const,
        adjustmentId: persisted.rows[0].billing_invoice_adjustment_outbox_id };
    });
  }

  async dispatchNext(
    tenantId: string,
    providerKey: string,
    environment: "sandbox" | "live",
    providerAccountKey: string,
    workerId: string,
  ) {
    if (environment === "live") {
      return { status: "disabled" as const, detail: "Live overage invoice adjustment is not authorized." };
    }
    if (this.dispatcher.status().availability !== "configured") {
      return { status: "disabled" as const, detail: this.dispatcher.status().detail };
    }
    const schema = runtimeConfig().schema;
    const claim = await this.database.tenantTransaction(tenantId, async (client) => {
      await client.query(
        `UPDATE ${schema}.billing_invoice_adjustment_outbox
         SET status='pending',lease_owner=NULL,lease_token=NULL,lease_until=NULL,updated_at=now()
         WHERE customer_id=$1 AND provider_key=$2 AND provider_environment=$3 AND provider_account_key=$4
           AND status='leased' AND submission_started_at IS NULL AND lease_until<=now()`,
        [tenantId, providerKey, environment, providerAccountKey],
      );
      const leaseToken = randomUUID();
      const result = await client.query<AdjustmentRow>(
        `WITH candidate AS (
           SELECT billing_invoice_adjustment_outbox_id
           FROM ${schema}.billing_invoice_adjustment_outbox
           WHERE customer_id=$1 AND provider_key=$2 AND provider_environment=$3 AND provider_account_key=$4
             AND status='pending' AND next_attempt_at<=now() AND attempt_count<max_attempts
           ORDER BY next_attempt_at,created_at,billing_invoice_adjustment_outbox_id
           FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE ${schema}.billing_invoice_adjustment_outbox o
         SET status='leased',attempt_count=o.attempt_count+1,lease_owner=$5,lease_token=$6,
             lease_until=now()+interval '90 seconds',updated_at=now()
         FROM candidate WHERE o.billing_invoice_adjustment_outbox_id=candidate.billing_invoice_adjustment_outbox_id
         RETURNING o.*`,
        [tenantId, providerKey, environment, providerAccountKey, workerId, leaseToken],
      );
      return result.rows[0] ?? null;
    });
    if (!claim) return { status: "idle" as const };
    if (payloadDigest(payloadFromRow(claim)) !== claim.payload_digest) {
      await this.finish(tenantId, claim,
        `status='terminal_failed',lease_owner=NULL,lease_token=NULL,lease_until=NULL,
         last_error_code='payload_digest_mismatch',
         last_error_detail='Immutable invoice-adjustment payload digest verification failed before submission.'`, []);
      return { status: "terminal_failed" as const, adjustmentId: claim.billing_invoice_adjustment_outbox_id,
        detail: "Immutable invoice-adjustment payload digest verification failed before submission." };
    }
    const started = await this.database.tenantTransaction(tenantId, (client) => client.query(
      `UPDATE ${schema}.billing_invoice_adjustment_outbox
       SET submission_started_at=now(),updated_at=now()
       WHERE customer_id=$1 AND billing_invoice_adjustment_outbox_id=$2 AND status='leased'
         AND lease_token=$3 AND lease_until>now() RETURNING billing_invoice_adjustment_outbox_id`,
      [tenantId, claim.billing_invoice_adjustment_outbox_id, claim.lease_token]));
    if (!started.rowCount) return { status: "lease_lost" as const, adjustmentId: claim.billing_invoice_adjustment_outbox_id };
    try {
      const outcome = await this.dispatcher.submit(toInput(claim));
      if (outcome.outcome === "accepted") {
        await this.finish(tenantId, claim,
          `status='provider_accepted',provider_invoice_item_ref=$4,provider_accepted_at=$5::timestamptz,
           lease_owner=NULL,lease_token=NULL,lease_until=NULL,last_error_code=NULL,last_error_detail=NULL`,
          [outcome.providerInvoiceItemRef, outcome.acceptedAt]);
        return { status: "provider_accepted" as const, adjustmentId: claim.billing_invoice_adjustment_outbox_id,
          providerInvoiceItemRef: outcome.providerInvoiceItemRef };
      }
      if (outcome.outcome === "unknown") {
        await this.finish(tenantId, claim,
          `status='outcome_unknown',lease_owner=NULL,lease_token=NULL,lease_until=NULL,
           last_error_code=$4,last_error_detail=$5`, [outcome.code, outcome.detail]);
        return { status: "outcome_unknown" as const, adjustmentId: claim.billing_invoice_adjustment_outbox_id };
      }
      const missed = outcome.code === "invoice_adjustment_window_missed";
      const retry = outcome.retryable && !missed;
      await this.finish(tenantId, claim,
        `status='${missed ? "missed_window" : retry ? "pending" : "terminal_failed"}',
         lease_owner=NULL,lease_token=NULL,lease_until=NULL,
         submission_started_at=${retry ? "NULL" : "submission_started_at"},
         next_attempt_at=${retry ? "now()+interval '30 seconds'" : "next_attempt_at"},
         last_error_code=$4,last_error_detail=$5`, [outcome.code, outcome.detail]);
      return { status: missed ? "missed_window" as const : retry ? "retry_scheduled" as const : "terminal_failed" as const,
        adjustmentId: claim.billing_invoice_adjustment_outbox_id, detail: outcome.detail };
    } catch {
      await this.finish(tenantId, claim,
        `status='outcome_unknown',lease_owner=NULL,lease_token=NULL,lease_until=NULL,
         last_error_code='dispatcher_threw',last_error_detail='Invoice adjustment ended without authoritative provider evidence.'`, []);
      return { status: "outcome_unknown" as const, adjustmentId: claim.billing_invoice_adjustment_outbox_id };
    }
  }

  async reconcileInvoice(
    tenantId: string,
    providerKey: string,
    environment: "sandbox" | "live",
    providerAccountKey: string,
    externalInvoiceRef: string,
  ) {
    if (environment === "live") {
      return { status: "disabled" as const, detail: "Live overage invoice reconciliation is not authorized." };
    }
    const schema = runtimeConfig().schema;
    const row = await this.database.tenantReadTransaction(tenantId, async (client) => {
      const result = await client.query<AdjustmentRow>(
        `SELECT * FROM ${schema}.billing_invoice_adjustment_outbox
         WHERE customer_id=$1 AND provider_key=$2 AND provider_environment=$3 AND provider_account_key=$4
           AND external_invoice_ref=$5
           AND status IN ('outcome_unknown','provider_accepted','reconciliation_failed') LIMIT 2`,
        [tenantId, providerKey, environment, providerAccountKey, externalInvoiceRef],
      );
      return result.rows.length === 1 ? result.rows[0] : null;
    });
    if (!row) return { status: "idle" as const };
    if (payloadDigest(payloadFromRow(row)) !== row.payload_digest) {
      return { status: "mismatch" as const, adjustmentId: row.billing_invoice_adjustment_outbox_id,
        detail: "Immutable invoice-adjustment payload digest verification failed during reconciliation." };
    }
    const outcome = await this.dispatcher.reconcile(toInput(row));
    if (outcome.outcome !== "matched") {
      if (outcome.outcome === "mismatch") {
        await this.database.tenantTransaction(tenantId, (client) => client.query(
          `UPDATE ${schema}.billing_invoice_adjustment_outbox
           SET status='reconciliation_failed',last_error_code='invoice_line_mismatch',last_error_detail=$3,updated_at=now()
           WHERE customer_id=$1 AND billing_invoice_adjustment_outbox_id=$2
             AND status IN ('outcome_unknown','provider_accepted','reconciliation_failed')`,
          [tenantId, row.billing_invoice_adjustment_outbox_id, outcome.detail],
        ));
      }
      return { status: outcome.outcome, adjustmentId: row.billing_invoice_adjustment_outbox_id,
        detail: outcome.detail };
    }
    const evidence = { adjustmentPayloadDigest: row.payload_digest, ...outcome.evidence };
    const evidenceDigest = createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
    await this.database.tenantTransaction(tenantId, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `billing-invoice-adjustment-reconciliation:${row.billing_invoice_adjustment_outbox_id}`,
      ]);
      await client.query(
        `INSERT INTO ${schema}.billing_invoice_adjustment_reconciliations (
           customer_id,billing_invoice_adjustment_outbox_id,external_invoice_ref,provider_invoice_item_ref,
           provider_invoice_line_ref,one_time_price_ref,period_start,period_end,quantity,unit_price_minor,
           amount_minor,currency,invoice_status,observed_at,evidence_digest
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (billing_invoice_adjustment_outbox_id) DO NOTHING`,
        [tenantId, row.billing_invoice_adjustment_outbox_id, row.external_invoice_ref,
          outcome.evidence.providerInvoiceItemRef, outcome.evidence.providerInvoiceLineRef,
          outcome.evidence.oneTimePriceRef, outcome.evidence.periodStart, outcome.evidence.periodEnd,
          outcome.evidence.quantity, outcome.evidence.unitPriceMinor, outcome.evidence.amountMinor,
          outcome.evidence.currency, outcome.evidence.invoiceStatus, outcome.evidence.observedAt, evidenceDigest],
      );
      const persisted = await client.query<{ evidence_digest: string }>(
        `SELECT evidence_digest FROM ${schema}.billing_invoice_adjustment_reconciliations
         WHERE customer_id=$1 AND billing_invoice_adjustment_outbox_id=$2`,
        [tenantId, row.billing_invoice_adjustment_outbox_id],
      );
      if (persisted.rows[0]?.evidence_digest !== evidenceDigest) {
        throw new ConflictException("The finalized invoice-line evidence conflicts with immutable reconciliation evidence.");
      }
      await client.query(
        `UPDATE ${schema}.billing_invoice_adjustment_outbox
         SET status='reconciled',provider_invoice_item_ref=$3,provider_accepted_at=COALESCE(provider_accepted_at,$4),
             reconciled_at=$4,last_error_code=NULL,last_error_detail=NULL,updated_at=now()
         WHERE customer_id=$1 AND billing_invoice_adjustment_outbox_id=$2
           AND status IN ('outcome_unknown','provider_accepted','reconciliation_failed')`,
        [tenantId, row.billing_invoice_adjustment_outbox_id, outcome.evidence.providerInvoiceItemRef,
          outcome.evidence.observedAt],
      );
    });
    return { status: "reconciled" as const, adjustmentId: row.billing_invoice_adjustment_outbox_id };
  }

  private async finish(tenantId: string, claim: AdjustmentRow, mutation: string, values: unknown[]) {
    const result = await this.database.tenantTransaction(tenantId, (client) => client.query(
      `UPDATE ${runtimeConfig().schema}.billing_invoice_adjustment_outbox SET ${mutation},updated_at=now()
       WHERE customer_id=$1 AND billing_invoice_adjustment_outbox_id=$2 AND status='leased' AND lease_token=$3
       RETURNING billing_invoice_adjustment_outbox_id`,
      [tenantId, claim.billing_invoice_adjustment_outbox_id, claim.lease_token, ...values]));
    if (!result.rowCount) throw new Error("Billing invoice-adjustment lease was lost; reconciliation is required.");
  }
}

function toInput(row: AdjustmentRow): BillingInvoiceAdjustmentInput {
  const payload = payloadFromRow(row);
  return {
    adjustmentId: row.billing_invoice_adjustment_outbox_id,
    ...payload,
    payloadDigest: row.payload_digest,
  };
}

function payloadFromRow(row: AdjustmentRow) {
  return {
    ledgerId: row.billing_usage_period_ledger_id,
    planVersionId: row.commercial_plan_version_id,
    providerKey: row.provider_key,
    providerEnvironment: row.provider_environment,
    providerAccountKey: row.provider_account_key,
    externalCustomerRef: row.external_customer_ref,
    externalSubscriptionRef: row.external_subscription_ref,
    externalInvoiceRef: row.external_invoice_ref,
    oneTimePriceRef: row.one_time_price_ref,
    periodStart: new Date(row.period_start).toISOString(),
    periodEnd: new Date(row.period_end).toISOString(),
    quantity: row.quantity,
    unitPriceMinor: row.unit_price_minor,
    currency: row.currency,
  };
}

function payloadDigest(payload: ReturnType<typeof payloadFromRow> | {
  ledgerId: string; planVersionId: string; providerKey: string; providerEnvironment: "sandbox" | "live";
  providerAccountKey: string; externalCustomerRef: string; externalSubscriptionRef: string;
  externalInvoiceRef: string; oneTimePriceRef: string; periodStart: string; periodEnd: string;
  quantity: string; unitPriceMinor: string; currency: string;
}) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
