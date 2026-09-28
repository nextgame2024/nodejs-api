import { createHash, randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { runtimeConfig } from "../../config/runtime-config.js";
import { DatabaseService } from "../../database/database.service.js";
import {
  BILLING_METER_EVENT_DISPATCHER,
  BILLING_METER_EVENT_RECONCILER,
  type BillingMeterEventDispatcher,
  type BillingMeterEventInput,
  type BillingMeterEventReconciler,
  type BillingMeterEventReconciliationInput,
} from "./billing-meter-event.port.js";

type OutboxRow = {
  billing_meter_event_outbox_id: string;
  billing_usage_period_ledger_id: string;
  billing_provider_customer_id: string;
  ledger_digest: string;
  submission_identifier: string;
  provider_key: string;
  provider_environment: "sandbox" | "live";
  provider_account_key: string;
  external_customer_ref: string;
  meter_binding_key: string;
  event_timestamp: Date | string;
  quantity: string;
  quantity_unit: "whole-minute";
  payload_digest: string;
  attempt_count: number;
  max_attempts: number;
  lease_token: string;
};

type ReconciliationRow = {
  billing_meter_event_outbox_id: string;
  billing_usage_period_ledger_id: string;
  commercial_plan_version_id: string;
  submission_identifier: string;
  provider_key: string;
  provider_environment: "sandbox" | "live";
  provider_account_key: string;
  external_customer_ref: string;
  meter_binding_key: string;
  period_start: Date | string;
  period_end: Date | string;
  quantity: string;
  overage_unit_price_minor: string;
  currency: string;
};

export type BillingMeterOutboxRun = {
  status: "disabled" | "idle" | "lease_lost" | "provider_accepted" | "retry_scheduled" | "outcome_unknown" | "terminal_failed";
  outboxId?: string;
  detail?: string;
};

export type BillingMeterReconciliationRun = {
  status: "idle" | "pending" | "mismatch" | "reconciled";
  outboxId?: string;
  detail?: string;
};

@Injectable()
export class BillingMeterOutboxService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(BILLING_METER_EVENT_DISPATCHER) private readonly dispatcher: BillingMeterEventDispatcher,
    @Inject(BILLING_METER_EVENT_RECONCILER) private readonly reconciler: BillingMeterEventReconciler,
  ) {}

  async dispatchNext(
    tenantId: string,
    providerKey: string,
    environment: "sandbox" | "live",
    providerAccountKey: string,
    workerId: string,
  ): Promise<BillingMeterOutboxRun> {
    const readiness = this.dispatcher.status();
    if (readiness.availability !== "configured") {
      return { status: "disabled", detail: readiness.detail };
    }
    const claim = await this.claim(tenantId, providerKey, environment, providerAccountKey, workerId);
    if (!claim) return { status: "idle" };
    if (payloadDigest(claim) !== claim.payload_digest) {
      await this.definiteFailure(tenantId, claim, false, "payload_digest_mismatch",
        "The immutable outbox payload does not match its ledger-bound digest.");
      return { status: "terminal_failed", outboxId: claim.billing_meter_event_outbox_id,
        detail: "The immutable outbox payload failed integrity validation." };
    }
    const started = await this.markSubmissionStarted(tenantId, claim);
    if (!started) return { status: "lease_lost", outboxId: claim.billing_meter_event_outbox_id,
      detail: "The lease was lost before provider submission; no provider call was made." };
    try {
      const result = await this.dispatcher.submit(toInput(claim));
      if (result.outcome === "accepted") {
        await this.providerAccepted(tenantId, claim, result.providerEventRef, result.acceptedAt);
        return { status: "provider_accepted", outboxId: claim.billing_meter_event_outbox_id };
      }
      if (result.outcome === "unknown") {
        await this.outcomeUnknown(tenantId, claim, result.code, result.detail);
        return { status: "outcome_unknown", outboxId: claim.billing_meter_event_outbox_id, detail: result.detail };
      }
      const retry = result.retryable && claim.attempt_count < claim.max_attempts;
      await this.definiteFailure(tenantId, claim, retry, result.code, result.detail);
      return { status: retry ? "retry_scheduled" : "terminal_failed",
        outboxId: claim.billing_meter_event_outbox_id, detail: result.detail };
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Provider submission failed with an unknown outcome.";
      await this.outcomeUnknown(tenantId, claim, "submission_exception", detail).catch(() => undefined);
      return { status: "outcome_unknown", outboxId: claim.billing_meter_event_outbox_id, detail };
    }
  }

  async reconcileNext(
    tenantId: string,
    providerKey: string,
    environment: "sandbox" | "live",
    providerAccountKey: string,
  ): Promise<BillingMeterReconciliationRun> {
    const row = await this.nextReconciliation(tenantId, providerKey, environment, providerAccountKey);
    if (!row) return { status: "idle" };
    const result = await this.reconciler.reconcile(toReconciliationInput(row));
    if (result.outcome !== "matched") {
      return { status: result.outcome, outboxId: row.billing_meter_event_outbox_id, detail: result.detail };
    }
    const evidence = { outboxId: row.billing_meter_event_outbox_id,
      ledgerId: row.billing_usage_period_ledger_id, ...result.evidence };
    const evidenceDigest = createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
    const schema = runtimeConfig().schema;
    await this.database.tenantTransaction(tenantId, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `billing-meter-reconcile:${row.billing_meter_event_outbox_id}`,
      ]);
      await client.query(
        `INSERT INTO ${schema}.billing_meter_event_reconciliations (
           customer_id,billing_meter_event_outbox_id,billing_usage_period_ledger_id,
           provider_key,provider_environment,provider_account_key,provider_event_ref,
           meter_ref,meter_summary_ref,meter_summary_start,meter_summary_end,meter_summary_quantity,
           external_invoice_ref,external_invoice_line_ref,metered_price_ref,invoice_line_quantity,
           invoice_line_amount_minor,currency,observed_at,evidence_digest
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         ON CONFLICT (billing_meter_event_outbox_id) DO NOTHING`,
        [tenantId, row.billing_meter_event_outbox_id, row.billing_usage_period_ledger_id,
          row.provider_key, row.provider_environment, row.provider_account_key,
          result.evidence.providerEventRef, result.evidence.meterRef, result.evidence.meterSummaryRef,
          result.evidence.meterSummaryStart, result.evidence.meterSummaryEnd,
          result.evidence.meterSummaryQuantity, result.evidence.invoiceRef,
          result.evidence.invoiceLineRef, result.evidence.meteredPriceRef,
          result.evidence.invoiceLineQuantity, result.evidence.invoiceLineAmountMinor,
          result.evidence.currency, result.evidence.observedAt, evidenceDigest],
      );
      const persisted = await client.query<{ evidence_digest: string }>(
        `SELECT evidence_digest FROM ${schema}.billing_meter_event_reconciliations
         WHERE customer_id=$1 AND billing_meter_event_outbox_id=$2`,
        [tenantId, row.billing_meter_event_outbox_id],
      );
      if (persisted.rows[0]?.evidence_digest !== evidenceDigest) {
        throw new Error("Provider reconciliation conflicts with the immutable evidence already recorded.");
      }
      const updated = await client.query(
        `UPDATE ${schema}.billing_meter_event_outbox
         SET status='reconciled',provider_event_ref=COALESCE(provider_event_ref,$3),
             provider_accepted_at=COALESCE(provider_accepted_at,$4::timestamptz),
             reconciled_at=$4::timestamptz,last_error_code=NULL,last_error_detail=NULL,updated_at=now()
         WHERE customer_id=$1 AND billing_meter_event_outbox_id=$2
           AND status IN ('provider_accepted','outcome_unknown')
         RETURNING billing_meter_event_outbox_id`,
        [tenantId, row.billing_meter_event_outbox_id, result.evidence.providerEventRef, result.evidence.observedAt],
      );
      if (!updated.rowCount) {
        const existing = await client.query<{ status: string }>(
          `SELECT status FROM ${schema}.billing_meter_event_outbox
           WHERE customer_id=$1 AND billing_meter_event_outbox_id=$2`,
          [tenantId, row.billing_meter_event_outbox_id],
        );
        if (existing.rows[0]?.status !== "reconciled") {
          throw new Error("The Meter event changed state before reconciliation evidence could be committed.");
        }
      }
    });
    return { status: "reconciled", outboxId: row.billing_meter_event_outbox_id };
  }

  private nextReconciliation(
    tenantId: string,
    providerKey: string,
    environment: "sandbox" | "live",
    providerAccountKey: string,
  ) {
    const schema = runtimeConfig().schema;
    return this.database.tenantReadTransaction(tenantId, async (client) => {
      const result = await client.query<ReconciliationRow>(
        `SELECT o.billing_meter_event_outbox_id,o.billing_usage_period_ledger_id,
                l.commercial_plan_version_id,o.submission_identifier,o.provider_key,
                o.provider_environment,o.provider_account_key,o.external_customer_ref,
                o.meter_binding_key,l.period_start,l.period_end,o.quantity,
                l.overage_unit_price_minor::text,l.currency
         FROM ${schema}.billing_meter_event_outbox o
         JOIN ${schema}.billing_usage_period_ledgers l
           ON l.billing_usage_period_ledger_id=o.billing_usage_period_ledger_id
          AND l.customer_id=o.customer_id
         WHERE o.customer_id=$1 AND o.provider_key=$2 AND o.provider_environment=$3
           AND o.provider_account_key=$4 AND o.status IN ('provider_accepted','outcome_unknown')
         ORDER BY l.period_end,o.created_at,o.billing_meter_event_outbox_id LIMIT 1`,
        [tenantId, providerKey, environment, providerAccountKey],
      );
      return result.rows[0] ?? null;
    });
  }

  private async claim(
    tenantId: string,
    providerKey: string,
    environment: "sandbox" | "live",
    accountKey: string,
    workerId: string,
  ) {
    const schema = runtimeConfig().schema;
    const claimToken = randomUUID();
    return this.database.tenantTransaction(tenantId, async (client) => {
      await client.query(
        `UPDATE ${schema}.billing_meter_event_outbox
         SET status='outcome_unknown',lease_owner=NULL,lease_token=NULL,lease_until=NULL,
             last_error_code='lease_expired_after_submission',
             last_error_detail='The worker lease expired after provider submission started; reconciliation is required.',updated_at=now()
         WHERE customer_id=$1 AND provider_key=$4 AND provider_environment=$2
           AND provider_account_key=$3 AND status='leased' AND lease_until<=now()
           AND submission_started_at IS NOT NULL`, [tenantId, environment, accountKey, providerKey]);
      await client.query(
        `UPDATE ${schema}.billing_meter_event_outbox
         SET status='terminal_failed',lease_owner=NULL,lease_token=NULL,lease_until=NULL,
             last_error_code='retry_limit_exhausted',
             last_error_detail='The pre-submission retry limit was exhausted.',updated_at=now()
         WHERE customer_id=$1 AND provider_key=$4 AND provider_environment=$2
           AND provider_account_key=$3 AND status='leased' AND lease_until<=now()
           AND submission_started_at IS NULL AND attempt_count>=max_attempts`,
        [tenantId, environment, accountKey, providerKey]);
      const claimed = await client.query<OutboxRow>(
        `WITH candidate AS (
           SELECT o.billing_meter_event_outbox_id,l.ledger_digest
           FROM ${schema}.billing_meter_event_outbox o
           JOIN ${schema}.billing_usage_period_ledgers l
             ON l.billing_usage_period_ledger_id=o.billing_usage_period_ledger_id AND l.customer_id=o.customer_id
           WHERE o.customer_id=$1 AND o.provider_key=$6 AND o.provider_environment=$2
             AND o.provider_account_key=$3 AND o.next_attempt_at<=now() AND o.attempt_count<o.max_attempts
             AND (o.status='pending' OR (o.status='leased' AND o.lease_until<=now() AND o.submission_started_at IS NULL))
           ORDER BY o.next_attempt_at,o.created_at,o.billing_meter_event_outbox_id
           FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE ${schema}.billing_meter_event_outbox o
         SET status='leased',attempt_count=o.attempt_count+1,lease_owner=$4,lease_token=$5,
             lease_until=now()+interval '2 minutes',submission_started_at=NULL,
             last_error_code=NULL,last_error_detail=NULL,updated_at=now()
         FROM candidate WHERE o.billing_meter_event_outbox_id=candidate.billing_meter_event_outbox_id
         RETURNING o.*,candidate.ledger_digest`,
        [tenantId, environment, accountKey, workerId, claimToken, providerKey]);
      return claimed.rows[0] ?? null;
    });
  }

  private async markSubmissionStarted(tenantId: string, claim: OutboxRow) {
    const result = await this.database.tenantTransaction(tenantId, (client) => client.query(
      `UPDATE ${runtimeConfig().schema}.billing_meter_event_outbox
       SET submission_started_at=now(),updated_at=now()
       WHERE billing_meter_event_outbox_id=$1 AND customer_id=$2 AND status='leased'
         AND lease_token=$3 AND lease_until>now() RETURNING billing_meter_event_outbox_id`,
      [claim.billing_meter_event_outbox_id, tenantId, claim.lease_token]));
    return Boolean(result.rowCount);
  }

  private providerAccepted(tenantId: string, claim: OutboxRow, providerEventRef: string, acceptedAt: string) {
    return this.finish(tenantId, claim,
      `status='provider_accepted',provider_event_ref=$4,provider_accepted_at=$5::timestamptz,
       lease_owner=NULL,lease_token=NULL,lease_until=NULL,last_error_code=NULL,last_error_detail=NULL`,
      [providerEventRef, acceptedAt]);
  }

  private outcomeUnknown(tenantId: string, claim: OutboxRow, code: string, detail: string) {
    return this.finish(tenantId, claim,
      `status='outcome_unknown',lease_owner=NULL,lease_token=NULL,lease_until=NULL,
       last_error_code=$4,last_error_detail=$5`, [safeCode(code), safeDetail(detail)]);
  }

  private definiteFailure(tenantId: string, claim: OutboxRow, retry: boolean, code: string, detail: string) {
    const next = retry ? "now()+make_interval(secs => LEAST(3600, 30 * (2 ^ LEAST(attempt_count, 6))))" : "next_attempt_at";
    return this.finish(tenantId, claim,
      `status='${retry ? "pending" : "terminal_failed"}',lease_owner=NULL,lease_token=NULL,lease_until=NULL,
       submission_started_at=NULL,last_definitive_failure_at=now(),next_attempt_at=${next},
       last_error_code=$4,last_error_detail=$5`, [safeCode(code), safeDetail(detail)]);
  }

  private async finish(tenantId: string, claim: OutboxRow, mutation: string, values: unknown[]) {
    const result = await this.database.tenantTransaction(tenantId, (client) => client.query(
      `UPDATE ${runtimeConfig().schema}.billing_meter_event_outbox SET ${mutation},updated_at=now()
       WHERE billing_meter_event_outbox_id=$1 AND customer_id=$2 AND status='leased' AND lease_token=$3
       RETURNING billing_meter_event_outbox_id`,
      [claim.billing_meter_event_outbox_id, tenantId, claim.lease_token, ...values]));
    if (!result.rowCount) throw new Error("Billing meter-event lease was lost; reconciliation is required.");
  }
}

function toInput(row: OutboxRow): BillingMeterEventInput {
  return {
    submissionIdentifier: row.submission_identifier,
    providerKey: row.provider_key,
    providerEnvironment: row.provider_environment,
    providerAccountKey: row.provider_account_key,
    externalCustomerRef: row.external_customer_ref,
    meterBindingKey: row.meter_binding_key,
    eventTimestamp: new Date(row.event_timestamp).toISOString(),
    quantity: row.quantity,
    quantityUnit: row.quantity_unit,
    payloadDigest: row.payload_digest,
  };
}

function toReconciliationInput(row: ReconciliationRow): BillingMeterEventReconciliationInput {
  return {
    providerKey: row.provider_key,
    providerEnvironment: row.provider_environment,
    providerAccountKey: row.provider_account_key,
    planVersionId: row.commercial_plan_version_id,
    externalCustomerRef: row.external_customer_ref,
    meterBindingKey: row.meter_binding_key,
    submissionIdentifier: row.submission_identifier,
    periodStart: new Date(row.period_start).toISOString(),
    periodEnd: new Date(row.period_end).toISOString(),
    quantity: row.quantity,
    unitPriceMinor: row.overage_unit_price_minor,
    currency: row.currency,
  };
}

function payloadDigest(row: OutboxRow) {
  return createHash("sha256").update(JSON.stringify({
    ledgerId: row.billing_usage_period_ledger_id,
    ledgerDigest: row.ledger_digest,
    providerKey: row.provider_key,
    providerEnvironment: row.provider_environment,
    providerAccountKey: row.provider_account_key,
    billingProviderCustomerId: row.billing_provider_customer_id,
    meterBindingKey: row.meter_binding_key,
    externalCustomerRef: row.external_customer_ref,
    submissionIdentifier: row.submission_identifier,
    eventTimestamp: new Date(row.event_timestamp).toISOString(),
    quantity: row.quantity,
    quantityUnit: row.quantity_unit,
  })).digest("hex");
}

function safeCode(value: string) { return value.slice(0, 80) || "provider_failure"; }
function safeDetail(value: string) { return value.slice(0, 500) || "Provider submission failed."; }
