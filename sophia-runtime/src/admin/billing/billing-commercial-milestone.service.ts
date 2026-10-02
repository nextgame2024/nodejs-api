import { createHash } from "node:crypto";
import { ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { runtimeConfig } from "../../config/runtime-config.js";
import { DatabaseService } from "../../database/database.service.js";
import { AdminAuditService } from "../authorization/admin-audit.service.js";
import type { AdminPrincipal } from "../contracts/admin-contracts.js";
import { deploymentMilestoneAcceptanceSchema } from "./billing-lifecycle.contracts.js";
import {
  BILLING_COMMERCIAL_MILESTONE_DISPATCHER,
  type BillingCommercialMilestoneDispatcher,
  type BillingCommercialMilestoneInput,
} from "./billing-commercial-milestone.port.js";
import { STRIPE_BILLING_PROVIDER_KEY } from "./stripe-billing.constants.js";

const COMPONENT_KEY = "production-deployment";
const MILESTONE_KEY = "production-deployment";

type MilestoneRow = {
  billing_commercial_milestone_outbox_id: string;
  billing_commercial_milestone_acceptance_id: string;
  commercial_plan_version_id: string;
  component_key: string;
  milestone_key: string;
  provider_key: string;
  provider_environment: "sandbox" | "live";
  provider_account_key: string;
  external_customer_ref: string;
  one_time_price_ref: string;
  quantity: string;
  unit_price_minor: string;
  currency: string;
  payload_digest: string;
  status: string;
  external_invoice_ref: string | null;
  provider_invoice_item_ref: string | null;
};

@Injectable()
export class BillingCommercialMilestoneService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(BILLING_COMMERCIAL_MILESTONE_DISPATCHER)
    private readonly dispatcher: BillingCommercialMilestoneDispatcher,
    @Inject(AdminAuditService) private readonly audit: AdminAuditService,
  ) {}

  async acceptProductionDeployment(tenantId: string, principal: AdminPrincipal, body: unknown) {
    const input = deploymentMilestoneAcceptanceSchema.parse(body);
    const config = runtimeConfig();
    if (config.billing.provider !== "stripe_sandbox") {
      throw new ServiceUnavailableException("Production-deployment milestone submission remains sandbox-only.");
    }
    if (this.dispatcher.status().availability !== "configured") {
      throw new ServiceUnavailableException(this.dispatcher.status().detail);
    }
    const accountKey = config.billing.providerAccountKey;
    const created = await this.database.tenantTransaction(tenantId, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `billing-commercial-milestone:${tenantId}:${COMPONENT_KEY}`,
      ]);
      const existing = await client.query<MilestoneRow & { request_id: string; evidence_ref: string; accepted_by_identity: string }>(
        `SELECT o.*,a.request_id::text,a.evidence_ref,a.accepted_by_identity
         FROM ${config.schema}.billing_commercial_milestone_acceptances a
         JOIN ${config.schema}.billing_commercial_milestone_outbox o
           ON o.billing_commercial_milestone_acceptance_id=a.billing_commercial_milestone_acceptance_id
          AND o.customer_id=a.customer_id
         WHERE a.customer_id=$1 AND a.commercial_plan_charge_component_id=(
           SELECT component.commercial_plan_charge_component_id
           FROM ${config.schema}.tenant_commercial_assignments assignment
           JOIN ${config.schema}.commercial_plan_versions plan
             ON plan.commercial_plan_version_id=assignment.commercial_plan_version_id
           JOIN ${config.schema}.commercial_plan_charge_components component
             ON component.commercial_plan_version_id=plan.commercial_plan_version_id
           WHERE assignment.customer_id=$1 AND assignment.status='active' AND assignment.effective_from<=now()
             AND (assignment.effective_to IS NULL OR assignment.effective_to>now())
             AND plan.status IN ('published','retired') AND component.component_key=$2
             AND component.charge_timing='operator_milestone' AND component.milestone_key=$3
           ORDER BY assignment.effective_from DESC LIMIT 1)`,
        [tenantId, COMPONENT_KEY, MILESTONE_KEY],
      );
      if (existing.rows[0]) {
        const row = existing.rows[0];
        if (row.request_id !== input.requestId || row.evidence_ref !== input.evidenceRef
          || row.accepted_by_identity !== principal.identityUserId) {
          throw new ConflictException("The production-deployment milestone was already accepted with different immutable evidence.");
        }
        return { row, existing: true };
      }
      const context = await client.query<{ commercial_plan_version_id: string; commercial_plan_charge_component_id: string;
        amount_minor: string; currency: string; external_customer_ref: string }>(
        `SELECT plan.commercial_plan_version_id,component.commercial_plan_charge_component_id,
                component.amount_minor::text,component.currency,customer.external_customer_ref
         FROM ${config.schema}.tenant_commercial_assignments assignment
         JOIN ${config.schema}.commercial_plan_versions plan
           ON plan.commercial_plan_version_id=assignment.commercial_plan_version_id
         JOIN ${config.schema}.commercial_plan_charge_components component
           ON component.commercial_plan_version_id=plan.commercial_plan_version_id
          AND component.component_key=$2 AND component.charge_timing='operator_milestone'
          AND component.milestone_key=$3
         JOIN ${config.schema}.billing_provider_customers customer ON customer.customer_id=assignment.customer_id
          AND customer.provider_key=$4 AND customer.provider_environment='sandbox' AND customer.provider_account_key=$5
         WHERE assignment.customer_id=$1 AND assignment.status='active' AND assignment.effective_from<=now()
          AND (assignment.effective_to IS NULL OR assignment.effective_to>now()) AND plan.status IN ('published','retired')
         ORDER BY assignment.effective_from DESC LIMIT 2`,
        [tenantId, COMPONENT_KEY, MILESTONE_KEY, STRIPE_BILLING_PROVIDER_KEY, accountKey],
      );
      if (context.rows.length !== 1) throw new NotFoundException(
        "The active plan does not expose one sandbox-bound production-deployment milestone.");
      const commercial = context.rows[0];
      const priceRef = config.billing.stripeMilestonePriceMappings[commercial.commercial_plan_version_id]?.[COMPONENT_KEY];
      if (!priceRef) throw new ConflictException("The production-deployment milestone has no approved sandbox Price mapping.");
      const acceptance = await client.query<{ billing_commercial_milestone_acceptance_id: string }>(
        `INSERT INTO ${config.schema}.billing_commercial_milestone_acceptances
          (customer_id,commercial_plan_version_id,commercial_plan_charge_component_id,request_id,
           milestone_key,evidence_ref,accepted_by_identity)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING billing_commercial_milestone_acceptance_id`,
        [tenantId, commercial.commercial_plan_version_id, commercial.commercial_plan_charge_component_id,
          input.requestId, MILESTONE_KEY, input.evidenceRef, principal.identityUserId],
      );
      const acceptanceId = acceptance.rows[0].billing_commercial_milestone_acceptance_id;
      const payload = { acceptanceId, planVersionId: commercial.commercial_plan_version_id,
        componentKey: COMPONENT_KEY, milestoneKey: MILESTONE_KEY, providerKey: STRIPE_BILLING_PROVIDER_KEY,
        providerEnvironment: "sandbox" as const, providerAccountKey: accountKey,
        externalCustomerRef: commercial.external_customer_ref, oneTimePriceRef: priceRef,
        quantity: "1" as const, unitPriceMinor: commercial.amount_minor, currency: commercial.currency };
      const digest = digestOf(payload);
      const outbox = await client.query<MilestoneRow>(
        `INSERT INTO ${config.schema}.billing_commercial_milestone_outbox
          (customer_id,billing_commercial_milestone_acceptance_id,commercial_plan_version_id,component_key,
           milestone_key,provider_key,provider_environment,provider_account_key,external_customer_ref,
           one_time_price_ref,quantity,unit_price_minor,currency,payload_digest)
         VALUES ($1,$2,$3,$4,$5,$6,'sandbox',$7,$8,$9,1,$10,$11,$12) RETURNING *`,
        [tenantId, acceptanceId, commercial.commercial_plan_version_id, COMPONENT_KEY, MILESTONE_KEY,
          STRIPE_BILLING_PROVIDER_KEY, accountKey, commercial.external_customer_ref, priceRef,
          commercial.amount_minor, commercial.currency, digest],
      );
      await this.audit.record({ tenantId, identityUserId: principal.identityUserId,
        eventType: "billing.commercial_milestone.accepted", permission: "billing.manage", outcome: "allowed",
        correlationId: input.requestId, resourceType: "commercialPlanChargeComponent",
        resourceId: commercial.commercial_plan_charge_component_id,
        metadata: { componentKey: COMPONENT_KEY, milestoneKey: MILESTONE_KEY, evidenceRef: input.evidenceRef,
          providerEnvironment: "sandbox", liveCharge: false } }, client);
      return { row: outbox.rows[0], existing: false };
    });
    const dispatched = await this.dispatch(tenantId, created.row);
    const reconciliation = dispatched.status === "provider_accepted" && dispatched.externalInvoiceRef
      ? await this.reconcileInvoice(tenantId, STRIPE_BILLING_PROVIDER_KEY, "sandbox", accountKey,
        dispatched.externalInvoiceRef) : null;
    return { stage: reconciliation?.status === "reconciled" ? "milestone_invoice_reconciled"
      : dispatched.status === "provider_accepted" ? "milestone_invoice_submitted" : "milestone_accepted",
      acceptanceId: created.row.billing_commercial_milestone_acceptance_id,
      milestoneOutboxId: created.row.billing_commercial_milestone_outbox_id,
      existing: created.existing, dispatch: dispatched, reconciliation, liveCharge: false };
  }

  async reconcileInvoice(tenantId: string, providerKey: string, environment: "sandbox" | "live",
    providerAccountKey: string, externalInvoiceRef: string) {
    if (environment === "live") return { status: "disabled" as const,
      detail: "Live commercial milestone reconciliation is not authorized." };
    const schema = runtimeConfig().schema;
    const result = await this.database.tenantReadTransaction(tenantId, (client) => client.query<MilestoneRow>(
      `SELECT * FROM ${schema}.billing_commercial_milestone_outbox
       WHERE customer_id=$1 AND provider_key=$2 AND provider_environment=$3 AND provider_account_key=$4
         AND external_invoice_ref=$5 AND status IN ('provider_accepted','reconciliation_failed') LIMIT 2`,
      [tenantId, providerKey, environment, providerAccountKey, externalInvoiceRef],
    ));
    if (result.rows.length !== 1) return { status: "idle" as const };
    const row = result.rows[0];
    if (digestOf(payloadFromRow(row)) !== row.payload_digest) return { status: "mismatch" as const,
      milestoneOutboxId: row.billing_commercial_milestone_outbox_id,
      detail: "Immutable commercial milestone payload digest verification failed." };
    if (!row.provider_invoice_item_ref) return { status: "mismatch" as const,
      milestoneOutboxId: row.billing_commercial_milestone_outbox_id,
      detail: "The accepted milestone invoice-item reference is missing." };
    const outcome = await this.dispatcher.reconcile({ ...toDispatcherInput(row), externalInvoiceRef,
      providerInvoiceItemRef: row.provider_invoice_item_ref });
    if (outcome.outcome !== "matched") {
      if (outcome.outcome === "mismatch") await this.database.tenantTransaction(tenantId, (client) => client.query(
        `UPDATE ${schema}.billing_commercial_milestone_outbox SET status='reconciliation_failed',
         last_error_code='invoice_line_mismatch',last_error_detail=$3,updated_at=now()
         WHERE customer_id=$1 AND billing_commercial_milestone_outbox_id=$2 AND status='provider_accepted'`,
        [tenantId, row.billing_commercial_milestone_outbox_id, outcome.detail]));
      return { status: outcome.outcome, milestoneOutboxId: row.billing_commercial_milestone_outbox_id,
        detail: outcome.detail };
    }
    const evidenceDigest = digestOf({ payloadDigest: row.payload_digest, ...outcome.evidence });
    await this.database.tenantTransaction(tenantId, async (client) => {
      await client.query(
        `INSERT INTO ${schema}.billing_commercial_milestone_reconciliations
          (customer_id,billing_commercial_milestone_outbox_id,external_invoice_ref,provider_invoice_item_ref,
           provider_invoice_line_ref,one_time_price_ref,quantity,unit_price_minor,amount_minor,currency,
           invoice_status,observed_at,evidence_digest)
         VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING`,
        [tenantId, row.billing_commercial_milestone_outbox_id, outcome.evidence.externalInvoiceRef,
          outcome.evidence.providerInvoiceItemRef, outcome.evidence.providerInvoiceLineRef,
          outcome.evidence.oneTimePriceRef, outcome.evidence.unitPriceMinor, outcome.evidence.amountMinor,
          outcome.evidence.currency, outcome.evidence.invoiceStatus, outcome.evidence.observedAt, evidenceDigest]);
      await client.query(
        `UPDATE ${schema}.billing_commercial_milestone_outbox SET status='reconciled',reconciled_at=$3,
         provider_invoice_item_ref=$4,last_error_code=NULL,last_error_detail=NULL,updated_at=now()
         WHERE customer_id=$1 AND billing_commercial_milestone_outbox_id=$2
           AND status IN ('provider_accepted','reconciliation_failed')`,
        [tenantId, row.billing_commercial_milestone_outbox_id, outcome.evidence.observedAt,
          outcome.evidence.providerInvoiceItemRef]);
    });
    return { status: "reconciled" as const, milestoneOutboxId: row.billing_commercial_milestone_outbox_id };
  }

  private async dispatch(tenantId: string, row: MilestoneRow) {
    if (["provider_accepted", "reconciled"].includes(row.status)) return { status: "provider_accepted" as const,
      externalInvoiceRef: row.external_invoice_ref, providerInvoiceItemRef: row.provider_invoice_item_ref };
    const schema = runtimeConfig().schema;
    const claimed = await this.database.tenantTransaction(tenantId, (client) => client.query(
      `UPDATE ${schema}.billing_commercial_milestone_outbox SET status='submitting',attempt_count=attempt_count+1,
       updated_at=now() WHERE customer_id=$1 AND billing_commercial_milestone_outbox_id=$2 AND status='pending'
       AND attempt_count<max_attempts RETURNING billing_commercial_milestone_outbox_id`,
      [tenantId, row.billing_commercial_milestone_outbox_id]));
    if (!claimed.rowCount) return { status: "idle" as const };
    if (digestOf(payloadFromRow(row)) !== row.payload_digest) {
      await this.fail(tenantId, row, "terminal_failed", "payload_digest_mismatch",
        "Immutable commercial milestone payload digest verification failed before submission.");
      return { status: "terminal_failed" as const };
    }
    try {
      const outcome = await this.dispatcher.submit(toDispatcherInput(row));
      if (outcome.outcome === "accepted") {
        await this.database.tenantTransaction(tenantId, (client) => client.query(
          `UPDATE ${schema}.billing_commercial_milestone_outbox SET status='provider_accepted',
           external_invoice_ref=$3,provider_invoice_item_ref=$4,provider_accepted_at=$5,updated_at=now()
           WHERE customer_id=$1 AND billing_commercial_milestone_outbox_id=$2 AND status='submitting'`,
          [tenantId, row.billing_commercial_milestone_outbox_id, outcome.externalInvoiceRef,
            outcome.providerInvoiceItemRef, outcome.acceptedAt]));
        return { status: "provider_accepted" as const, externalInvoiceRef: outcome.externalInvoiceRef,
          providerInvoiceItemRef: outcome.providerInvoiceItemRef };
      }
      if (outcome.outcome === "unknown") {
        await this.fail(tenantId, row, "outcome_unknown", outcome.code, outcome.detail);
        return { status: "outcome_unknown" as const };
      }
      await this.fail(tenantId, row, outcome.retryable ? "pending" : "terminal_failed", outcome.code, outcome.detail);
      return { status: outcome.retryable ? "retry_scheduled" as const : "terminal_failed" as const,
        detail: outcome.detail };
    } catch {
      await this.fail(tenantId, row, "outcome_unknown", "dispatcher_threw",
        "Commercial milestone submission ended without authoritative provider evidence.");
      return { status: "outcome_unknown" as const };
    }
  }

  private async fail(tenantId: string, row: MilestoneRow, status: string, code: string, detail: string) {
    await this.database.tenantTransaction(tenantId, (client) => client.query(
      `UPDATE ${runtimeConfig().schema}.billing_commercial_milestone_outbox SET status=$3,
       next_attempt_at=CASE WHEN $3='pending' THEN now()+interval '30 seconds' ELSE next_attempt_at END,
       last_error_code=$4,last_error_detail=$5,updated_at=now()
       WHERE customer_id=$1 AND billing_commercial_milestone_outbox_id=$2 AND status='submitting'`,
      [tenantId, row.billing_commercial_milestone_outbox_id, status, code, detail]));
  }
}

function payloadFromRow(row: MilestoneRow) {
  return { acceptanceId: row.billing_commercial_milestone_acceptance_id,
    planVersionId: row.commercial_plan_version_id, componentKey: row.component_key,
    milestoneKey: row.milestone_key, providerKey: row.provider_key,
    providerEnvironment: row.provider_environment, providerAccountKey: row.provider_account_key,
    externalCustomerRef: row.external_customer_ref, oneTimePriceRef: row.one_time_price_ref,
    quantity: "1" as const, unitPriceMinor: row.unit_price_minor, currency: row.currency };
}
function toDispatcherInput(row: MilestoneRow): BillingCommercialMilestoneInput {
  return { milestoneOutboxId: row.billing_commercial_milestone_outbox_id, ...payloadFromRow(row),
    payloadDigest: row.payload_digest };
}
function digestOf(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
