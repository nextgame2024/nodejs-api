import { createHash } from "node:crypto";
import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { runtimeConfig } from "../../config/runtime-config.js";
import { DatabaseService } from "../../database/database.service.js";
import {
  BILLING_INVOICE_ADJUSTMENT_DISPATCHER,
  type BillingInvoiceAdjustmentDispatcher,
  type BillingInvoiceAdjustmentInput,
} from "./billing-invoice-adjustment.port.js";
import type { DraftRenewalInvoice } from "./billing-invoice-adjustment-outbox.service.js";

type RecoveryRow = {
  billing_invoice_adjustment_recovery_attempt_id: string;
  source_billing_invoice_adjustment_outbox_id: string;
  billing_usage_period_ledger_id: string;
  commercial_plan_version_id: string;
  provider_key: string;
  provider_environment: "sandbox" | "live";
  provider_account_key: string;
  external_customer_ref: string;
  external_subscription_ref: string;
  target_external_invoice_ref: string;
  one_time_price_ref: string;
  period_start: Date | string;
  period_end: Date | string;
  target_period_start: Date | string;
  target_period_end: Date | string;
  quantity: string;
  unit_price_minor: string;
  currency: string;
  source_payload_digest: string;
  payload_digest: string;
  status: "pending" | "submitting" | "outcome_unknown" | "provider_accepted" | "reconciled"
    | "reconciliation_failed" | "terminal_failed" | "missed_window";
  attempt_count: number;
  provider_invoice_item_ref: string | null;
};

@Injectable()
export class BillingInvoiceAdjustmentRecoveryService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(BILLING_INVOICE_ADJUSTMENT_DISPATCHER)
    private readonly dispatcher: BillingInvoiceAdjustmentDispatcher,
  ) {}

  async enqueueAndDispatch(tenantId: string, invoice: DraftRenewalInvoice, workerId: string) {
    if (invoice.providerEnvironment === "live") {
      return { status: "disabled" as const, detail: "Live missed-window carry-forward is not authorized." };
    }
    const schema = runtimeConfig().schema;
    const attempts = await this.database.tenantTransaction(tenantId, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `billing-invoice-adjustment-recovery:${invoice.providerKey}:${invoice.providerEnvironment}:${invoice.providerAccountKey}:${invoice.externalInvoiceRef}`,
      ]);
      const sources = await client.query<{
        billing_invoice_adjustment_outbox_id: string;
        payload_digest: string;
      }>(
        `SELECT source.billing_invoice_adjustment_outbox_id,source.payload_digest
         FROM ${schema}.billing_invoice_adjustment_outbox source
         WHERE source.customer_id=$1 AND source.provider_key=$2 AND source.provider_environment=$3
           AND source.provider_account_key=$4 AND source.external_customer_ref=$5
           AND source.external_subscription_ref=$6 AND source.status='missed_window'
           AND source.period_end<=$7::timestamptz
           AND NOT EXISTS (
             SELECT 1 FROM ${schema}.billing_invoice_adjustment_recovery_attempts recovered
             WHERE recovered.customer_id=source.customer_id
               AND recovered.source_billing_invoice_adjustment_outbox_id=source.billing_invoice_adjustment_outbox_id
               AND recovered.status<>'missed_window'
           )
         ORDER BY source.period_start,source.billing_invoice_adjustment_outbox_id
         LIMIT 51`,
        [tenantId, invoice.providerKey, invoice.providerEnvironment, invoice.providerAccountKey,
          invoice.externalCustomerRef, invoice.externalSubscriptionRef, invoice.periodStart],
      );
      if (sources.rows.length > 50) {
        throw new ConflictException("The missed-window carry-forward backlog exceeds the bounded invoice safety limit.");
      }
      for (const source of sources.rows) {
        const payload = recoveryPayload(source.billing_invoice_adjustment_outbox_id, source.payload_digest, invoice);
        const digest = recoveryDigest(payload);
        await client.query(
          `INSERT INTO ${schema}.billing_invoice_adjustment_recovery_attempts (
             customer_id,source_billing_invoice_adjustment_outbox_id,target_external_invoice_ref,
             target_period_start,target_period_end,payload_digest
           ) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (source_billing_invoice_adjustment_outbox_id,target_external_invoice_ref) DO NOTHING`,
          [tenantId, source.billing_invoice_adjustment_outbox_id, invoice.externalInvoiceRef,
            invoice.periodStart, invoice.periodEnd, digest],
        );
        const persisted = await client.query<{ billing_invoice_adjustment_recovery_attempt_id: string; payload_digest: string }>(
          `SELECT billing_invoice_adjustment_recovery_attempt_id,payload_digest
           FROM ${schema}.billing_invoice_adjustment_recovery_attempts
           WHERE customer_id=$1 AND source_billing_invoice_adjustment_outbox_id=$2
             AND target_external_invoice_ref=$3`,
          [tenantId, source.billing_invoice_adjustment_outbox_id, invoice.externalInvoiceRef],
        );
        if (persisted.rows.length !== 1 || persisted.rows[0].payload_digest !== digest) {
          throw new ConflictException("The carry-forward target conflicts with immutable recovery evidence.");
        }
      }
      const target = await client.query<{ billing_invoice_adjustment_recovery_attempt_id: string }>(
        `SELECT recovery.billing_invoice_adjustment_recovery_attempt_id
         FROM ${schema}.billing_invoice_adjustment_recovery_attempts recovery
         JOIN ${schema}.billing_invoice_adjustment_outbox source
           ON source.customer_id=recovery.customer_id
          AND source.billing_invoice_adjustment_outbox_id=recovery.source_billing_invoice_adjustment_outbox_id
         WHERE recovery.customer_id=$1 AND recovery.target_external_invoice_ref=$2
           AND source.provider_key=$3 AND source.provider_environment=$4 AND source.provider_account_key=$5
           AND source.external_customer_ref=$6 AND source.external_subscription_ref=$7
         ORDER BY recovery.created_at,recovery.billing_invoice_adjustment_recovery_attempt_id`,
        [tenantId, invoice.externalInvoiceRef, invoice.providerKey, invoice.providerEnvironment,
          invoice.providerAccountKey, invoice.externalCustomerRef, invoice.externalSubscriptionRef],
      );
      return target.rows.map((row) => row.billing_invoice_adjustment_recovery_attempt_id);
    });
    if (attempts.length === 0) return { status: "not_required" as const, attempts: [] };
    const results = [];
    for (const attemptId of attempts) results.push(await this.dispatchAttempt(tenantId, attemptId, workerId));
    return { status: results.every((result) => result.status === "provider_accepted")
      ? "provider_accepted" as const : "incomplete" as const, attempts: results };
  }

  async reconcileInvoice(tenantId: string, providerKey: string, environment: "sandbox" | "live",
    providerAccountKey: string, externalInvoiceRef: string) {
    if (environment === "live") return { status: "disabled" as const, attempts: [] };
    const rows = await this.database.tenantReadTransaction(tenantId, (client) => client.query<RecoveryRow>(
      `${recoverySelect(runtimeConfig().schema)}
       WHERE recovery.customer_id=$1 AND source.provider_key=$2 AND source.provider_environment=$3
         AND source.provider_account_key=$4 AND recovery.target_external_invoice_ref=$5
         AND recovery.status IN ('outcome_unknown','provider_accepted','reconciliation_failed')
       ORDER BY recovery.created_at,recovery.billing_invoice_adjustment_recovery_attempt_id`,
      [tenantId, providerKey, environment, providerAccountKey, externalInvoiceRef],
    ));
    if (rows.rows.length === 0) return { status: "idle" as const, attempts: [] };
    const results = [];
    for (const row of rows.rows) results.push(await this.reconcileAttempt(tenantId, row));
    const status = results.every((result) => result.status === "reconciled") ? "reconciled" as const
      : results.some((result) => result.status === "mismatch") ? "mismatch" as const : "pending" as const;
    return { status, attempts: results };
  }

  private async dispatchAttempt(tenantId: string, attemptId: string, _workerId: string) {
    const schema = runtimeConfig().schema;
    const row = await this.database.tenantTransaction(tenantId, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `billing-invoice-adjustment-recovery-attempt:${attemptId}`,
      ]);
      const selected = await client.query<RecoveryRow>(
        `${recoverySelect(schema)} WHERE recovery.customer_id=$1
           AND recovery.billing_invoice_adjustment_recovery_attempt_id=$2 FOR UPDATE OF recovery`,
        [tenantId, attemptId],
      );
      const value = selected.rows[0];
      if (!value) return null;
      if (value.status === "provider_accepted" || value.status === "reconciled") return value;
      if (!["pending", "submitting", "outcome_unknown"].includes(value.status) || value.attempt_count >= 12) return value;
      await client.query(
        `UPDATE ${schema}.billing_invoice_adjustment_recovery_attempts
         SET status='submitting',attempt_count=attempt_count+1,updated_at=now()
         WHERE customer_id=$1 AND billing_invoice_adjustment_recovery_attempt_id=$2`,
        [tenantId, attemptId],
      );
      value.attempt_count += 1;
      value.status = "submitting";
      return value;
    });
    if (!row) return { status: "missing" as const, attemptId };
    if (!validRecoveryDigest(row)) {
      return { status: "terminal_failed" as const, attemptId,
        detail: "Immutable carry-forward payload digest verification failed." };
    }
    if (row.status === "provider_accepted" || row.status === "reconciled") {
      return { status: "provider_accepted" as const, existingStatus: row.status, attemptId,
        providerInvoiceItemRef: row.provider_invoice_item_ref };
    }
    if (row.status !== "submitting") return { status: row.status, attemptId };
    let outcome;
    try {
      outcome = await this.dispatcher.submit(toRecoveryInput(row));
    } catch {
      await this.updateStatus(tenantId, attemptId, "outcome_unknown", "dispatcher_threw",
        "Carry-forward submission ended without authoritative provider evidence.");
      return { status: "outcome_unknown" as const, attemptId };
    }
    if (outcome.outcome === "accepted") {
      await this.database.tenantTransaction(tenantId, (client) => client.query(
        `UPDATE ${schema}.billing_invoice_adjustment_recovery_attempts
         SET status='provider_accepted',provider_invoice_item_ref=$3,provider_accepted_at=$4,
             last_error_code=NULL,last_error_detail=NULL,updated_at=now()
         WHERE customer_id=$1 AND billing_invoice_adjustment_recovery_attempt_id=$2 AND status='submitting'`,
        [tenantId, attemptId, outcome.providerInvoiceItemRef, outcome.acceptedAt],
      ));
      return { status: "provider_accepted" as const, attemptId,
        providerInvoiceItemRef: outcome.providerInvoiceItemRef };
    }
    if (outcome.outcome === "unknown" || outcome.retryable) {
      await this.updateStatus(tenantId, attemptId, "outcome_unknown", outcome.code, outcome.detail);
      return { status: "outcome_unknown" as const, attemptId };
    }
    const status = outcome.code === "invoice_adjustment_window_missed" ? "missed_window" : "terminal_failed";
    await this.updateStatus(tenantId, attemptId, status, outcome.code, outcome.detail);
    return { status, attemptId };
  }

  private async reconcileAttempt(tenantId: string, row: RecoveryRow) {
    const attemptId = row.billing_invoice_adjustment_recovery_attempt_id;
    if (!validRecoveryDigest(row)) return { status: "mismatch" as const, attemptId,
      detail: "Immutable carry-forward payload digest verification failed during reconciliation." };
    const outcome = await this.dispatcher.reconcile(toRecoveryInput(row));
    if (outcome.outcome !== "matched") {
      if (outcome.outcome === "mismatch") await this.database.tenantTransaction(tenantId, (client) => client.query(
        `UPDATE ${runtimeConfig().schema}.billing_invoice_adjustment_recovery_attempts
         SET status='reconciliation_failed',last_error_code='invoice_line_mismatch',last_error_detail=$3,updated_at=now()
         WHERE customer_id=$1 AND billing_invoice_adjustment_recovery_attempt_id=$2
           AND status IN ('outcome_unknown','provider_accepted')`,
        [tenantId, attemptId, outcome.detail],
      ));
      return { status: outcome.outcome, attemptId, detail: outcome.detail };
    }
    const schema = runtimeConfig().schema;
    const evidenceDigest = createHash("sha256").update(JSON.stringify({
      recoveryPayloadDigest: row.payload_digest, ...outcome.evidence,
    })).digest("hex");
    await this.database.tenantTransaction(tenantId, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `billing-invoice-adjustment-recovery-reconciliation:${attemptId}`,
      ]);
      await client.query(
        `INSERT INTO ${schema}.billing_invoice_adjustment_recovery_reconciliations (
           customer_id,billing_invoice_adjustment_recovery_attempt_id,source_billing_invoice_adjustment_outbox_id,
           external_invoice_ref,provider_invoice_item_ref,provider_invoice_line_ref,one_time_price_ref,
           period_start,period_end,quantity,unit_price_minor,amount_minor,currency,invoice_status,observed_at,evidence_digest
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (billing_invoice_adjustment_recovery_attempt_id) DO NOTHING`,
        [tenantId, attemptId, row.source_billing_invoice_adjustment_outbox_id, row.target_external_invoice_ref,
          outcome.evidence.providerInvoiceItemRef, outcome.evidence.providerInvoiceLineRef,
          outcome.evidence.oneTimePriceRef, outcome.evidence.periodStart, outcome.evidence.periodEnd,
          outcome.evidence.quantity, outcome.evidence.unitPriceMinor, outcome.evidence.amountMinor,
          outcome.evidence.currency, outcome.evidence.invoiceStatus, outcome.evidence.observedAt, evidenceDigest],
      );
      const persisted = await client.query<{ evidence_digest: string }>(
        `SELECT evidence_digest FROM ${schema}.billing_invoice_adjustment_recovery_reconciliations
         WHERE customer_id=$1 AND billing_invoice_adjustment_recovery_attempt_id=$2`, [tenantId, attemptId]);
      if (persisted.rows[0]?.evidence_digest !== evidenceDigest) {
        throw new ConflictException("The carry-forward line conflicts with immutable reconciliation evidence.");
      }
      await client.query(
        `UPDATE ${schema}.billing_invoice_adjustment_recovery_attempts
         SET status='reconciled',provider_invoice_item_ref=$3,
             provider_accepted_at=COALESCE(provider_accepted_at,$4),reconciled_at=$4,
             last_error_code=NULL,last_error_detail=NULL,updated_at=now()
         WHERE customer_id=$1 AND billing_invoice_adjustment_recovery_attempt_id=$2
           AND status IN ('outcome_unknown','provider_accepted','reconciliation_failed')`,
        [tenantId, attemptId, outcome.evidence.providerInvoiceItemRef, outcome.evidence.observedAt],
      );
    });
    return { status: "reconciled" as const, attemptId };
  }

  private async updateStatus(tenantId: string, attemptId: string, status: string, code: string, detail: string) {
    await this.database.tenantTransaction(tenantId, (client) => client.query(
      `UPDATE ${runtimeConfig().schema}.billing_invoice_adjustment_recovery_attempts
       SET status=$3,last_error_code=$4,last_error_detail=$5,updated_at=now()
       WHERE customer_id=$1 AND billing_invoice_adjustment_recovery_attempt_id=$2 AND status='submitting'`,
      [tenantId, attemptId, status, code, detail],
    ));
  }
}

function recoverySelect(schema: string) {
  return `SELECT recovery.*,source.billing_usage_period_ledger_id,source.commercial_plan_version_id,
      source.provider_key,source.provider_environment,source.provider_account_key,
      source.external_customer_ref,source.external_subscription_ref,source.one_time_price_ref,
      source.period_start,source.period_end,source.quantity::text,source.unit_price_minor::text,
      source.currency,source.payload_digest AS source_payload_digest
    FROM ${schema}.billing_invoice_adjustment_recovery_attempts recovery
    JOIN ${schema}.billing_invoice_adjustment_outbox source
      ON source.customer_id=recovery.customer_id
     AND source.billing_invoice_adjustment_outbox_id=recovery.source_billing_invoice_adjustment_outbox_id`;
}

function recoveryPayload(sourceAdjustmentId: string, sourcePayloadDigest: string, invoice: DraftRenewalInvoice) {
  return { sourceAdjustmentId, sourcePayloadDigest, targetExternalInvoiceRef: invoice.externalInvoiceRef,
    targetPeriodStart: invoice.periodStart, targetPeriodEnd: invoice.periodEnd };
}
function recoveryPayloadFromRow(row: RecoveryRow) {
  return { sourceAdjustmentId: row.source_billing_invoice_adjustment_outbox_id,
    sourcePayloadDigest: row.source_payload_digest, targetExternalInvoiceRef: row.target_external_invoice_ref,
    targetPeriodStart: new Date(row.target_period_start).toISOString(),
    targetPeriodEnd: new Date(row.target_period_end).toISOString() };
}
function recoveryDigest(payload: ReturnType<typeof recoveryPayload> | ReturnType<typeof recoveryPayloadFromRow>) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
function validRecoveryDigest(row: RecoveryRow) { return recoveryDigest(recoveryPayloadFromRow(row)) === row.payload_digest; }
function toRecoveryInput(row: RecoveryRow): BillingInvoiceAdjustmentInput {
  return {
    adjustmentId: row.source_billing_invoice_adjustment_outbox_id,
    deliveryId: row.billing_invoice_adjustment_recovery_attempt_id,
    ledgerId: row.billing_usage_period_ledger_id,
    planVersionId: row.commercial_plan_version_id,
    providerKey: row.provider_key,
    providerEnvironment: row.provider_environment,
    providerAccountKey: row.provider_account_key,
    externalCustomerRef: row.external_customer_ref,
    externalSubscriptionRef: row.external_subscription_ref,
    externalInvoiceRef: row.target_external_invoice_ref,
    oneTimePriceRef: row.one_time_price_ref,
    periodStart: new Date(row.period_start).toISOString(),
    periodEnd: new Date(row.period_end).toISOString(),
    targetPeriodStart: new Date(row.target_period_start).toISOString(),
    targetPeriodEnd: new Date(row.target_period_end).toISOString(),
    quantity: row.quantity,
    unitPriceMinor: row.unit_price_minor,
    currency: row.currency,
    payloadDigest: row.payload_digest,
  };
}
