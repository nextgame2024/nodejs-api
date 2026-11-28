import { availableTrustPaymentIds, currentTrustInvoice, currentPaymentList, importedInvoicePayments, receiptAllocationBasis, trustOverpaymentCandidates, trustReceiptPaymentCandidates } from './trust-receipt-payment-candidates.js';
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { PoolClient } from "pg";
import { z } from "zod";
import { XeroConnectorService } from "../../connectors/xero/xero-connector.service.js";
import type { XeroContactRecord, XeroInvoiceRecord } from "../../connectors/xero/xero.client.js";
import { runtimeConfig } from "../../config/runtime-config.js";
import { DatabaseService } from "../../database/database.service.js";
import type { StudentOperationsWorkspacePrincipal } from "./student-operations-workspace.service.js";
import { addDatabaseTimings, elapsedMs, logStudentOperationsTiming } from "./student-operations-timing.js";
import { autoMatchStudentInvoices } from './student-invoice-matching.js';
import { autoMatchCollegeContacts } from './student-college-auto-matching.js';

const CandidateQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(100).optional(),
  sort: z.enum(["student", "studentReference", "invoiceDate", "invoiceReference", "concept", "advisor", "college", "invoices", "nextPayment", "paymentState"]).default("student"),
  direction: z.enum(["asc", "desc"]).default("asc"),
}).strict();

const CandidateSortExpressions = {
  student: "lower(c.legal_name)",
  studentReference: "lower(COALESCE(c.contact_number, c.account_number, ''))",
  invoiceDate: "latest_invoice_date",
  invoiceReference: "latest_invoice_reference",
  concept: "latest_concept",
  advisor: "latest_advisor_name",
  college: "latest_college_name",
  invoices: "invoice_count",
  nextPayment: "next_payment_date",
  paymentState: "payment_status",
} as const;

const InvoiceQuerySchema = z.object({
  importedPaymentDate: z.iso.date().optional(),
  importedPaymentAmount: z.string().regex(/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/).refine(amount=>Number(amount)>0).optional(),
  paymentCandidateStatus: z.enum(["available", "multiple", "partial", "none"]).optional(),
  excessLinkStatus: z.enum(["needs_link", "fully_linked", "link_mismatch"]).optional(),
  reconciliationStatus: z.enum(["link_mismatch", "checked_pending", "checked_unknown", "unchecked_pending", "unchecked_unknown"]).optional(),
  minFollowUpDays: z.coerce.number().int().min(1).max(3650).optional(),
  followUpOwner: z.enum(["mine", "unassigned"]).optional(),
  queue: z.enum(["outstanding_invoices", "receipts_awaiting_link", "excess_receipts", "reconciliation_review", "reconciled_payments", "receipt_exceptions", "payments_without_receipts"]).optional(),
  supplierId: z.uuid().optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(150).optional(),
  status: z.enum(["DRAFT", "SUBMITTED", "AUTHORISED", "PAID"]).optional(),
  dateFrom: z.iso.date().optional(),
  dateTo: z.iso.date().optional(),
  paymentTrack: z.string().trim().min(1).max(200).optional(),
  sort: z.enum(["invoiceNumber", "reference", "student", "date", "dueDate", "paid", "due", "status", "sent", "advisor", "paymentTrack"]).optional(),
  direction: z.enum(["asc", "desc"]).default("desc"),
}).strict().refine((value) => !value.dateFrom || !value.dateTo || value.dateFrom <= value.dateTo,
  { message: "The start date must be on or before the end date." });

const InvoiceSortExpressions = {
  invoiceNumber: "lower(COALESCE(i.invoice_number, ''))",
  reference: "lower(COALESCE(i.invoice_reference, ''))",
  student: "lower(c.legal_name)",
  date: "i.invoice_date",
  dueDate: "i.due_date",
  paid: "i.amount_paid",
  due: "i.amount_due",
  status: "lower(i.invoice_status)",
  sent: "i.sent_to_contact",
  advisor: "lower(COALESCE(i.advisor_name, ''))",
  paymentTrack: "lower(COALESCE(i.payment_track, ''))",
} as const;

const XERO_REGISTER_STATUSES_SQL = "'DRAFT','SUBMITTED','AUTHORISED','PAID'";

type SyncRunRow = {
  sync_run_id: string;
  xero_connection_id: string;
  mode: "initial" | "incremental" | "reconciliation";
  trigger_type: string;
  status: "queued" | "processing" | "succeeded" | "failed";
  modified_since: Date | null;
  contact_count: number;
  invoice_count: number;
  candidate_count: number;
  error_code: string | null;
  provider_status?: number | null;
  provider_correlation_id?: string | null;
  retry_after_seconds?: number | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
};

type SafeProviderFailure = {
  code: string;
  providerStatus: number | null;
  correlationId: string | null;
  retryAfterSeconds: number;
};

type CandidateRow = {
  xero_contact_id: string;
  legal_name: string;
  email: string | null;
  contact_number: string | null;
  account_number: string | null;
  invoice_count: number;
  latest_invoice_number: string | null;
  latest_invoice_date: string | null;
  latest_invoice_reference: string | null;
  latest_concept: string | null;
  latest_advisor_name: string | null;
  latest_college_name: string | null;
  next_payment_date: string | null;
  next_payment_amount: string | number | null;
  total_invoiced: string | number;
  total_paid: string | number;
  amount_due: string | number;
  currency_code: string | null;
  payment_status: "paid" | "due" | "overdue";
  total_count: number;
};

type InvoiceRow = {
  unlinked_receipt_count?: number;
  receipts_with_candidates?: number;
  receipts_with_multiple_candidates?: number;
  unlinked_receipt_amount?: string;
  receipt_excess?: string;
  unlinked_excess?: string;
  unlinked_excess_days?: number | null;
  oldest_pending_link?: Date;
  pending_days?: number;
  pending_amount?: string;
  confirmed_amount?: string;
  confirmed_count?: number;
  available_payments?: number;
  available_amount?: string;
  latest_payment_on?: string;
  exception_reason?: 'voided' | 'deleted' | 'not_current';
  verified_count?: number;
  verified_amount?: string;
  latest_receipt_on?: string;
  pending_count?: number;
  checked_count?: number;
  latest_reported_reconciled_on?: string | null;
  unassigned_count?: number;
  xero_pending_count?: number;
  unknown_status_count?: number;
  unmatched_link_count?: number;
  xero_invoice_id: string;
  xero_contact_id: string;
  invoice_type: string;
  invoice_number: string | null;
  invoice_reference: string | null;
  legal_name: string;
  email: string | null;
  contact_number: string | null;
  account_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  invoice_status: string;
  currency_code: string | null;
  total: string | number;
  amount_paid: string | number;
  amount_due: string | number;
  sent_to_contact: boolean;
  concept: string | null;
  advisor_name: string | null;
  college_name: string | null;
  payment_track: string | null;
  line_items?: unknown;
  settlement?:unknown;
  review_status: "pending" | "accepted" | "ignored";
  student_id: string | null;
  total_count?: number;
  invoice_total_count?: number;
  credit_note_total_count?: number;
  prepayment_total_count?: number;
  overpayment_total_count?: number;
  draft_total_count?: number;
  submitted_total_count?: number;
  authorised_total_count?: number;
  paid_total_count?: number;
};

@Injectable()
export class StudentOperationsXeroSyncService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(XeroConnectorService) private readonly xero: XeroConnectorService,
  ) {}

  async status(tenantId: string, connectionId: string) {
    const schema = runtimeConfig().schema;
    return this.database.tenantReadTransaction(tenantId, async (db) => {
      await assertConnection(db, schema, tenantId, connectionId);
      const configuration = await db.query<{
        organisation_role: string;
        last_successful_sync_at: Date | null;
        last_reconciliation_sync_at: Date | null;
        last_error_code: string | null;
        next_sync_at: Date;
      }>(
        `SELECT organisation_role, last_successful_sync_at, last_reconciliation_sync_at,
                last_error_code, next_sync_at
           FROM ${schema}.student_operations_xero_sync_configurations
          WHERE customer_id=$1 AND xero_connection_id=$2`,
        [tenantId, connectionId],
      );
      const run = await db.query<SyncRunRow>(
        `SELECT sync_run_id, xero_connection_id, mode, trigger_type, status, modified_since,
                contact_count, invoice_count, candidate_count, error_code, provider_status,
                provider_correlation_id, retry_after_seconds,
                created_at, started_at, completed_at
           FROM ${schema}.student_operations_xero_sync_runs
          WHERE customer_id=$1 AND xero_connection_id=$2
          ORDER BY created_at DESC LIMIT 1`,
        [tenantId, connectionId],
      );
      const row = configuration.rows[0];
      return {
        configured: Boolean(row),
        organisationRole: row?.organisation_role ?? null,
        lastSuccessfulSyncAt: row?.last_successful_sync_at?.toISOString() ?? null,
        lastFullSyncAt: row?.last_reconciliation_sync_at?.toISOString() ?? null,
        lastErrorCode: row?.last_error_code ?? null,
        nextScheduledSyncAt: row?.next_sync_at?.toISOString() ?? null,
        latestRun: run.rows[0] ? runProjection(run.rows[0]) : null,
      };
    });
  }

  async enqueueManual(principal: StudentOperationsWorkspacePrincipal, connectionId: string) {
    const schema = runtimeConfig().schema;
    const run = await this.database.tenantTransaction(principal.tenantId, async (db) => {
      await assertConnection(db, schema, principal.tenantId, connectionId);
      const existingConfiguration = await db.query<{
        last_successful_sync_at: Date | null;
        last_reconciliation_sync_at: Date | null;
        invoice_metadata_version: number;
        invoice_detail_version: number;
      }>(
        `UPDATE ${schema}.student_operations_xero_sync_configurations
           SET enabled=true, updated_at=now()
         WHERE customer_id=$1 AND xero_connection_id=$2 AND enabled
           AND organisation_role IN ('trust','operating')
         RETURNING last_successful_sync_at, last_reconciliation_sync_at,
                   invoice_metadata_version, invoice_detail_version`,
        [principal.tenantId, connectionId],
      );
      if (!existingConfiguration.rows.length) throw new ConflictException('Assign this organisation as TRUST or PTY in Company before refreshing.');
      const active = await db.query<SyncRunRow>(
        `SELECT sync_run_id, xero_connection_id, mode, trigger_type, status, modified_since,
                contact_count, invoice_count, candidate_count, error_code,
                created_at, started_at, completed_at
           FROM ${schema}.student_operations_xero_sync_runs
          WHERE customer_id=$1 AND xero_connection_id=$2 AND status IN ('queued','processing')
          ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [principal.tenantId, connectionId],
      );
      if (active.rows[0]) {
        // A manual click must release an automatic job held for tonight, not
        // leave it silently queued until the next window. Preserve its run ID.
        await db.query(`UPDATE ${schema}.student_operations_xero_sync_runs
          SET trigger_type='manual',requested_by_identity=$3
          WHERE customer_id=$1 AND sync_run_id=$2 AND status IN ('queued','processing')`,
          [principal.tenantId,active.rows[0].sync_run_id,principal.identityUserId]);
        return {...active.rows[0],trigger_type:'manual'};
      }
      const configuration = existingConfiguration.rows[0];
      // An explicit refresh is authoritative: scan the complete provider register so
      // records removed from Xero can be retired from the local read model.
      const mode = !configuration?.last_successful_sync_at ? "initial" : "reconciliation";
      const modifiedSince = null;
      const inserted = await db.query<SyncRunRow>(
        `INSERT INTO ${schema}.student_operations_xero_sync_runs
           (customer_id, xero_connection_id, mode, trigger_type, requested_by_identity, modified_since)
         VALUES ($1, $2, $3, 'manual', $4, $5)
         RETURNING sync_run_id, xero_connection_id, mode, trigger_type, status, modified_since,
                   contact_count, invoice_count, candidate_count, error_code,
                   created_at, started_at, completed_at`,
        [principal.tenantId, connectionId, mode, principal.identityUserId, modifiedSince],
      );
      return inserted.rows[0]!;
    });
    if (process.env.XERO_SYNC_EXECUTION_MODE !== 'worker') {
      setTimeout(() => { void this.process(principal.tenantId, run.sync_run_id); }, 0);
    }
    return runProjection(run);
  }

  async configureTrust(principal: StudentOperationsWorkspacePrincipal, connectionId: string) {
    return this.configureOrganisation(principal, connectionId, 'trust');
  }

  async configureOrganisation(principal: StudentOperationsWorkspacePrincipal, connectionId: string, role: 'trust' | 'operating') {
    const schema = runtimeConfig().schema;
    await this.database.tenantTransaction(principal.tenantId, async (db) => {
      // Serialize assignments across connections, including first-time assignments.
      await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`xero-organisation-role:${principal.tenantId}`]);
      await assertConnection(db, schema, principal.tenantId, connectionId);
      if(role==='operating'){
        const ready=await db.query(`SELECT to_regclass($1) IS NOT NULL AS ready`,[`${schema}.student_college_xero_contact_links`]);
        if(!ready.rows[0]?.ready)throw new ConflictException('PTY setup requires the accounting database update.');
      }
      const current = await db.query<{organisation_role:string}>(`SELECT organisation_role FROM ${schema}.student_operations_xero_sync_configurations
        WHERE customer_id=$1 AND xero_connection_id=$2 FOR UPDATE`, [principal.tenantId,connectionId]);
      if (current.rows[0] && !['unassigned',role].includes(current.rows[0].organisation_role))
        throw new ConflictException('This organisation already has a different accounting purpose. Keep TRUST and PTY separate.');
      await db.query(
        `UPDATE ${schema}.student_operations_xero_sync_configurations
            SET enabled=false, revision=revision+1, updated_at=now()
          WHERE customer_id=$1 AND organisation_role=$3 AND xero_connection_id<>$2`,
        [principal.tenantId, connectionId, role],
      );
      await db.query(
        `INSERT INTO ${schema}.student_operations_xero_sync_configurations
           (customer_id, xero_connection_id, organisation_role, enabled, next_sync_at)
         VALUES ($1,$2,$3,true,now())
         ON CONFLICT (customer_id, xero_connection_id) DO UPDATE SET
           organisation_role=EXCLUDED.organisation_role, enabled=true, next_sync_at=now(),
           revision=student_operations_xero_sync_configurations.revision+1, updated_at=now()`,
        [principal.tenantId, connectionId, role],
      );
    });
    return { connectionId, organisationRole: role };
  }

  async enqueueWebhook(providerTenantId: string, events: {category:string; id:string; at:string}[] = []): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(providerTenantId)) return false;
    const schema = runtimeConfig().schema;
    const target = await this.database.query<{ customer_id: string; xero_connection_id: string }>(
      `SELECT customer_id, xero_connection_id
         FROM ${schema}.resolve_student_operations_xero_sync_target($1)`,
      [providerTenantId],
    );
    const row = target.rows[0];
    if (!row) return false;
    const runId = await this.database.tenantTransaction(row.customer_id, async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['xero-webhook/'+row.customer_id+'/'+row.xero_connection_id]);
      if (events.length) {
        const changes=await db.query(`INSERT INTO ${schema}.student_xero_webhook_resources AS inbox
          (customer_id,xero_connection_id,category,resource_id,event_at)
          SELECT DISTINCT ON (e.category,e.id) $1,$2,e.category,e.id,e.at
          FROM jsonb_to_recordset($3::jsonb) AS e(category text,id uuid,at timestamptz)
          JOIN ${schema}.student_operations_xero_sync_configurations c ON c.customer_id=$1 AND c.xero_connection_id=$2 AND c.enabled
          ORDER BY e.category,e.id,e.at DESC
          ON CONFLICT(customer_id,xero_connection_id,category,resource_id) DO UPDATE
          SET event_at=excluded.event_at,refreshed_at=NULL WHERE excluded.event_at>inbox.event_at`,
          [row.customer_id,row.xero_connection_id,JSON.stringify(events)]);
        if (!changes.rowCount) return null;
      }
      const inserted = await db.query<{ sync_run_id: string }>(
        `INSERT INTO ${schema}.student_operations_xero_sync_runs
           (customer_id, xero_connection_id, mode, trigger_type, modified_since)
         SELECT c.customer_id, c.xero_connection_id, 'incremental', 'webhook',
                c.last_successful_sync_at - interval '5 minutes'
           FROM ${schema}.student_operations_xero_sync_configurations c
          WHERE c.customer_id=$1 AND c.xero_connection_id=$2 AND c.enabled
         ON CONFLICT DO NOTHING
         RETURNING sync_run_id`,
        [row.customer_id, row.xero_connection_id],
      );
      return inserted.rows[0]?.sync_run_id ?? null;
    });
    if (runId && process.env.XERO_SYNC_EXECUTION_MODE !== 'worker') {
      setTimeout(() => { void this.process(row.customer_id, runId); }, 0);
    }
    return true;
  }

  async candidates(tenantId: string, connectionId: string, input: unknown) {
    const parsed = CandidateQuerySchema.safeParse(input);
    if (!parsed.success) throw new ConflictException("Invalid Xero candidate query.");
    const { page, limit, q, sort, direction } = parsed.data;
    const schema = runtimeConfig().schema;
    return this.database.tenantReadTransaction(tenantId, async (db) => {
      await assertConnection(db, schema, tenantId, connectionId);
      const params: unknown[] = [tenantId, connectionId];
      const search = q ? `AND (
        c.legal_name ILIKE $3 OR c.email ILIKE $3 OR c.contact_number ILIKE $3 OR c.account_number ILIKE $3
        OR EXISTS (
          SELECT 1 FROM ${schema}.student_operations_xero_invoices search_i
           WHERE search_i.customer_id=c.customer_id
             AND search_i.xero_connection_id=c.xero_connection_id
             AND search_i.xero_contact_id=c.xero_contact_id
             AND (search_i.invoice_number ILIKE $3 OR search_i.invoice_reference ILIKE $3
               OR search_i.concept ILIKE $3 OR search_i.advisor_name ILIKE $3 OR search_i.college_name ILIKE $3)
        )
      )` : "";
      if (q) params.push(`%${q}%`);
      params.push(limit, (page - 1) * limit);
      const limitPosition = params.length - 1;
      const order = `${CandidateSortExpressions[sort]} ${direction.toUpperCase()} NULLS LAST, lower(c.legal_name) ASC, c.xero_contact_id ASC`;
      const result = await db.query<CandidateRow>(
        `SELECT c.xero_contact_id, c.legal_name, c.email, c.contact_number, c.account_number,
                count(i.xero_invoice_id)::int AS invoice_count,
                (array_agg(i.invoice_number ORDER BY i.invoice_date DESC NULLS LAST, i.xero_invoice_id DESC))[1] AS latest_invoice_number,
                max(i.invoice_date)::text AS latest_invoice_date,
                (array_agg(i.invoice_reference ORDER BY i.invoice_date DESC NULLS LAST, i.xero_invoice_id DESC))[1] AS latest_invoice_reference,
                (array_agg(i.concept ORDER BY i.invoice_date DESC NULLS LAST, i.xero_invoice_id DESC))[1] AS latest_concept,
                (array_agg(i.advisor_name ORDER BY i.invoice_date DESC NULLS LAST, i.xero_invoice_id DESC))[1] AS latest_advisor_name,
                (array_agg(i.college_name ORDER BY i.invoice_date DESC NULLS LAST, i.xero_invoice_id DESC))[1] AS latest_college_name,
                min(i.due_date) FILTER (WHERE i.amount_due > 0)::text AS next_payment_date,
                (array_agg(i.amount_due ORDER BY i.due_date ASC NULLS LAST)
                  FILTER (WHERE i.amount_due > 0))[1] AS next_payment_amount,
                sum(i.total) AS total_invoiced, sum(i.amount_paid) AS total_paid,
                sum(i.amount_due) AS amount_due,
                (array_agg(i.currency_code ORDER BY i.invoice_date DESC NULLS LAST))[1] AS currency_code,
                CASE
                  WHEN bool_or(i.amount_due > 0 AND i.due_date < current_date) THEN 'overdue'
                  WHEN bool_or(i.amount_due > 0) THEN 'due'
                  ELSE 'paid'
                END AS payment_status,
                count(*) OVER()::int AS total_count
           FROM ${schema}.student_operations_xero_contacts c
           JOIN ${schema}.student_operations_xero_invoices i
             ON i.customer_id=c.customer_id AND i.xero_connection_id=c.xero_connection_id
            AND i.xero_contact_id=c.xero_contact_id
           LEFT JOIN ${schema}.student_operations_xero_candidate_reviews r
             ON r.customer_id=c.customer_id AND r.xero_connection_id=c.xero_connection_id
            AND r.xero_contact_id=c.xero_contact_id
          WHERE c.customer_id=$1 AND c.xero_connection_id=$2
            AND i.invoice_type='ACCREC' AND i.invoice_status NOT IN ('VOIDED','DELETED')
            AND COALESCE(r.review_status, 'pending')='pending'
            ${search}
          GROUP BY c.xero_contact_id, c.legal_name, c.email, c.contact_number, c.account_number
          ORDER BY ${order}
          LIMIT $${limitPosition} OFFSET $${limitPosition + 1}`,
        params,
      );
      return {
        candidates: result.rows.map(candidateProjection),
        page,
        limit,
        total: Number(result.rows[0]?.total_count ?? 0),
      };
    });
  }

  async invoices(tenantId: string, connectionId: string, input: unknown, correlationId?: string, identityUserId?: string, exactInvoiceId?: string) {
    const parsed = InvoiceQuerySchema.safeParse(input);
    if (!parsed.success) throw new ConflictException("Invalid Xero invoice query.");
    const { followUpOwner, minFollowUpDays, reconciliationStatus, queue } = parsed.data;
    const importedQueue = queue === 'payments_without_receipts';
    if ((parsed.data.importedPaymentDate || parsed.data.importedPaymentAmount) && !importedQueue) {
      throw new ConflictException('Choose imported payments without receipt links to filter payment date or amount.');
    }
    if (parsed.data.paymentCandidateStatus && queue !== 'receipts_awaiting_link') throw new ConflictException('Choose the unlinked receipts queue to filter possible payments.');
    if (parsed.data.excessLinkStatus && queue !== 'excess_receipts') throw new ConflictException('Choose the excess receipts queue to filter overpayment links.');
    if ((followUpOwner || minFollowUpDays || reconciliationStatus) && queue !== 'reconciliation_review') throw new ConflictException('Choose the reconciliation queue to filter follow-ups.');
    if (followUpOwner === 'mine' && !identityUserId) throw new ConflictException('A manager identity is required for personal follow-ups.');
    const { page, limit, q, status, dateFrom, dateTo, paymentTrack, sort, direction, supplierId } = parsed.data;
    const schema = runtimeConfig().schema;
    const startedAt = performance.now();
    const durations: Record<string, number | undefined> = {};
    let outcome: "ok" | "error" = "error";
    try {
      const invoiceResult = await this.database.tenantReadTransaction(tenantId, async (db) => {
      durations.transactionSetupMs = elapsedMs(startedAt);
      const connectionStartedAt = performance.now();
      await assertConnection(db, schema, tenantId, connectionId);
      durations.connectionCheckMs = elapsedMs(connectionStartedAt);
      const params: unknown[] = [tenantId, connectionId];
      const filters: string[] = [];
      const exceptionQueue = queue === 'receipt_exceptions';
      if (exactInvoiceId) filters.push(`AND i.xero_invoice_id=$${params.push(exactInvoiceId)}::uuid`);
      const receiptSearch = q && queue && queue !== 'outstanding_invoices' ? params.push(q) : 0;
      const receiptMatch = (alias: 'receipt' | 'r', linkedId?: 'credit.overpayment_id' | 'l.payment_id') =>
        receiptSearch ? `bool_or(${alias}.bank_transaction_id = $${receiptSearch}
          OR strpos(lower(${alias}.reference),lower($${receiptSearch})) > 0
          ${linkedId ? `OR ${linkedId}::text = lower($${receiptSearch})` : ''}) AS matches_receipt,` : '';
      const importedJoin = importedQueue ? `JOIN LATERAL (
        SELECT count(*)::int AS available_payments, sum(payment.amount) AS available_amount, max(payment.payment_date) AS latest_payment_on
          ${receiptSearch ? `,bool_or(payment.id=lower($${receiptSearch}) OR payment.matches_reference) AS matches_receipt` : ''}
        FROM (${importedInvoicePayments(receiptSearch)}) payment
        WHERE ${currentPaymentList}
          AND NOT EXISTS (SELECT 1 FROM ${schema}.student_trust_receipt_payment_links used
            WHERE used.customer_id=i.customer_id AND used.connection_id=i.xero_connection_id AND used.payment_id=payment.id::uuid)
          ${parsed.data.importedPaymentDate ? `AND payment.payment_date=$${params.push(parsed.data.importedPaymentDate)}::text` : ''}
          ${parsed.data.importedPaymentAmount ? `AND payment.amount=$${params.push(parsed.data.importedPaymentAmount)}::numeric` : ''}
      ) available ON available.available_payments>0` : '';
      if (importedQueue) filters.push(`AND i.invoice_type='ACCREC' AND i.currency_code='AUD' AND i.invoice_status IN ('PAID','AUTHORISED')
        AND EXISTS (SELECT 1 FROM ${schema}.student_operations_xero_sync_configurations cfg WHERE cfg.customer_id=i.customer_id
          AND cfg.xero_connection_id=i.xero_connection_id AND cfg.enabled AND cfg.organisation_role='trust')`);
      const exceptionJoin = exceptionQueue ? `JOIN LATERAL (
        SELECT count(*)::int AS verified_count, sum(receipt.amount) AS verified_amount,
          max(receipt.received_on)::text AS latest_receipt_on
          ${receiptSearch ? `, bool_or(receipt.bank_transaction_id=$${receiptSearch}
            OR strpos(lower(receipt.reference), lower($${receiptSearch}))>0
            OR link.payment_id::text=lower($${receiptSearch}) OR credit.overpayment_id::text=lower($${receiptSearch})) AS matches_receipt` : ''}
        FROM ${schema}.student_trust_receipt_verifications receipt
        ${receiptSearch ? `LEFT JOIN ${schema}.student_trust_receipt_payment_links link USING (customer_id,connection_id,verification_id)
          LEFT JOIN ${schema}.student_trust_receipt_overpayment_links credit USING (customer_id,connection_id,verification_id)` : ''}
        JOIN ${schema}.student_operations_xero_sync_configurations cfg ON cfg.customer_id=receipt.customer_id
          AND cfg.xero_connection_id=receipt.connection_id AND cfg.enabled AND cfg.organisation_role='trust'
        WHERE receipt.customer_id=i.customer_id AND receipt.connection_id=i.xero_connection_id AND receipt.invoice_id=i.xero_invoice_id
      ) evidence ON evidence.verified_count > 0` : '';
      const excessQueue = parsed.data.queue === 'excess_receipts';
      const mismatchHaving = parsed.data.excessLinkStatus === 'link_mismatch'
        ? `HAVING bool_or(credit.overpayment_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM (${trustOverpaymentCandidates(schema, 'receipt')}) candidate
            WHERE candidate.id=credit.overpayment_id))` : '';
      const excessJoin = excessQueue ? `JOIN LATERAL (
        SELECT ${receiptMatch('receipt','credit.overpayment_id')} sum(receipt.amount - ${receiptAllocationBasis('receipt')}) AS receipt_excess,
               coalesce(sum(receipt.amount - ${receiptAllocationBasis('receipt')})
                 FILTER (WHERE credit.overpayment_id IS NULL), 0) AS unlinked_excess,
               (now() AT TIME ZONE 'Australia/Brisbane')::date
                 - min(receipt.received_on) FILTER (WHERE credit.overpayment_id IS NULL) AS unlinked_excess_days
        FROM ${schema}.student_trust_receipt_verifications receipt
        LEFT JOIN ${schema}.student_trust_receipt_overpayment_links credit USING (customer_id,connection_id,verification_id)
        JOIN ${schema}.student_operations_xero_sync_configurations cfg
          ON cfg.customer_id=receipt.customer_id AND cfg.xero_connection_id=receipt.connection_id
        WHERE cfg.enabled AND cfg.organisation_role='trust'
          AND receipt.customer_id=i.customer_id AND receipt.connection_id=i.xero_connection_id
          AND receipt.invoice_id=i.xero_invoice_id
          AND receipt.amount > ${receiptAllocationBasis('receipt')}
        ${mismatchHaving}
      ) excess ON excess.receipt_excess > 0` : '';
      if (parsed.data.excessLinkStatus === 'needs_link') filters.push('AND excess.unlinked_excess > 0');
      if (parsed.data.excessLinkStatus === 'fully_linked') filters.push('AND excess.unlinked_excess = 0');
      if (parsed.data.queue === 'outstanding_invoices') {
        filters.push("AND i.invoice_type='ACCREC' AND i.invoice_status='AUTHORISED' AND i.amount_due > 0");
      }
      const unlinkedQueue = queue === 'receipts_awaiting_link';
      const unlinkedJoin = unlinkedQueue ? `JOIN LATERAL (
          SELECT ${receiptMatch('r')} count(*)::int AS unlinked_receipt_count, sum(r.amount) AS unlinked_receipt_amount,
                 count(*) FILTER (WHERE matches.count > 0)::int AS receipts_with_candidates,
                 count(*) FILTER (WHERE matches.count = 2)::int AS receipts_with_multiple_candidates
          FROM ${schema}.student_trust_receipt_verifications r
          JOIN ${schema}.student_operations_xero_sync_configurations cfg
            ON cfg.customer_id=r.customer_id AND cfg.xero_connection_id=r.connection_id
          CROSS JOIN LATERAL (
            SELECT count(*) FROM (${availableTrustPaymentIds(schema)} LIMIT 2) available
          ) matches
          WHERE cfg.enabled AND cfg.organisation_role='trust'
            AND r.customer_id=i.customer_id AND r.connection_id=i.xero_connection_id
            AND r.invoice_id=i.xero_invoice_id
            AND NOT EXISTS (
              SELECT 1 FROM ${schema}.student_trust_receipt_payment_links link
              WHERE link.customer_id=r.customer_id AND link.connection_id=r.connection_id
                AND link.verification_id=r.verification_id
            )
        ) unlinked ON unlinked.unlinked_receipt_count > 0` : '';
      if (parsed.data.paymentCandidateStatus === 'available') filters.push('AND unlinked.receipts_with_candidates > 0');
      if (parsed.data.paymentCandidateStatus === 'multiple') filters.push('AND unlinked.receipts_with_multiple_candidates > 0');
      if (parsed.data.paymentCandidateStatus === 'partial') {
        filters.push('AND unlinked.receipts_with_candidates > 0 AND unlinked.receipts_with_candidates < unlinked.unlinked_receipt_count');
      }
      if (parsed.data.paymentCandidateStatus === 'none') filters.push('AND unlinked.receipts_with_candidates = 0');
      const confirmedQueue = queue === 'reconciled_payments';
      const reconciliationQueue = confirmedQueue || queue === 'reconciliation_review';
      let ownerFilter = '';
      if (followUpOwner === 'mine') {
        params.push(identityUserId);
        ownerFilter = `AND claim.claimed_by=$${params.length}`;
      } else if (followUpOwner === 'unassigned') {
        ownerFilter = 'AND claim.claim_id IS NULL';
      }
      const ageFilter = minFollowUpDays
        ? `AND (l.linked_at AT TIME ZONE 'Australia/Brisbane')::date <=
            (now() AT TIME ZONE 'Australia/Brisbane')::date - $${params.push(minFollowUpDays)}::int` : '';
      const reconciliationConditions = {
        link_mismatch: 'imported.matches = 0',
        checked_pending: 'check_record.payment_id IS NOT NULL AND imported.reconciled IS FALSE',
        checked_unknown: 'check_record.payment_id IS NOT NULL AND imported.matches > 0 AND imported.reconciled IS NULL',
        unchecked_pending: 'check_record.payment_id IS NULL AND imported.reconciled IS FALSE',
        unchecked_unknown: 'check_record.payment_id IS NULL AND imported.matches > 0 AND imported.reconciled IS NULL',
      };
      const reconciliationFilter = reconciliationStatus ? `AND ${reconciliationConditions[reconciliationStatus]}` : '';
      const reconciliationJoin = reconciliationQueue ? `JOIN LATERAL (
          SELECT ${receiptMatch('r','l.payment_id')} min(l.linked_at) AS oldest_pending_link,
                 (now() AT TIME ZONE 'Australia/Brisbane')::date
                   - (min(l.linked_at) AT TIME ZONE 'Australia/Brisbane')::date AS pending_days,
                 sum(l.payment_amount) AS pending_amount,
                 count(*)::int AS pending_count, count(check_record.payment_id)::int AS checked_count,
                 max(check_record.reported_reconciled_on)::text AS latest_reported_reconciled_on,
                 count(*) FILTER (WHERE claim.claim_id IS NULL)::int AS unassigned_count,
                 count(*) FILTER (WHERE imported.reconciled IS FALSE)::int AS xero_pending_count,
                 count(*) FILTER (WHERE imported.matches > 0 AND imported.reconciled IS NULL)::int AS unknown_status_count,
                 count(*) FILTER (WHERE imported.matches = 0)::int AS unmatched_link_count
          FROM ${schema}.student_trust_receipt_verifications r
          JOIN ${schema}.student_trust_receipt_payment_links l USING (customer_id,connection_id,verification_id)
          JOIN ${schema}.student_operations_xero_sync_configurations cfg
            ON cfg.customer_id=r.customer_id AND cfg.xero_connection_id=r.connection_id
          LEFT JOIN ${schema}.student_trust_reconciliation_claims claim
            ON claim.customer_id=l.customer_id AND claim.connection_id=l.connection_id AND claim.payment_id=l.payment_id AND claim.released_at IS NULL
          LEFT JOIN ${schema}.student_trust_payment_reconciliation_checks check_record
            ON check_record.customer_id=l.customer_id AND check_record.connection_id=l.connection_id AND check_record.payment_id=l.payment_id
          CROSS JOIN LATERAL (
            SELECT count(*) AS matches, bool_or(candidate."isReconciled") AS reconciled
            FROM (${trustReceiptPaymentCandidates(schema)}) candidate
            WHERE candidate.id=l.payment_id AND candidate.amount=l.payment_amount
          ) imported
          WHERE cfg.enabled AND cfg.organisation_role='trust'
            AND r.customer_id=i.customer_id AND r.connection_id=i.xero_connection_id AND r.invoice_id=i.xero_invoice_id
            ${ageFilter}
            ${ownerFilter}
            ${reconciliationFilter}
            AND imported.reconciled IS ${confirmedQueue ? 'TRUE' : 'NOT TRUE'}
        ) pending ON pending.pending_count > 0` : '';
      if (supplierId) {
        params.push(supplierId);
        filters.push(`AND EXISTS (
          SELECT 1 FROM ${schema}.student_college_xero_contact_links supplier_link
          WHERE supplier_link.customer_id=i.customer_id
            AND supplier_link.xero_connection_id=i.xero_connection_id
            AND supplier_link.xero_contact_id=i.xero_contact_id
            AND supplier_link.classification='supplier'
            AND supplier_link.supplier_id=$${params.length}::uuid
        )`);
      }
      if (q) {
        const searchText = queue ? q.replace(/[\\%_]/g, '\\$&') : q;
        params.push(`%${searchText}%`);
        const position = params.length;
        filters.push(`AND (
          i.invoice_number ILIKE $${position} OR i.invoice_reference ILIKE $${position}
          OR c.legal_name ILIKE $${position} OR c.email ILIKE $${position}
          OR c.contact_number ILIKE $${position} OR c.account_number ILIKE $${position}
          OR i.concept ILIKE $${position} OR i.advisor_name ILIKE $${position}
          OR i.payment_track ILIKE $${position}
          ${receiptSearch ? `OR ${importedQueue ? 'available.matches_receipt' : exceptionQueue ? 'evidence.matches_receipt' : excessQueue ? 'excess.matches_receipt' : unlinkedQueue ? 'unlinked.matches_receipt' : 'pending.matches_receipt'}` : ''}
        )`);
      }
      if (status) {
        params.push(status);
        filters.push(`AND i.invoice_status = $${params.length}`);
      }
      if (dateFrom) {
        params.push(dateFrom);
        filters.push(`AND i.invoice_date >= $${params.length}::date`);
      }
      if (dateTo) {
        params.push(dateTo);
        filters.push(`AND i.invoice_date <= $${params.length}::date`);
      }
      if (paymentTrack) {
        params.push(paymentTrack);
        filters.push(`AND lower(btrim(i.payment_track)) = lower($${params.length})`);
      }
      params.push(limit, (page - 1) * limit);
      const limitPosition = params.length - 1;
      let order = `${InvoiceSortExpressions[sort ?? "date"]} ${direction.toUpperCase()} NULLS LAST, i.xero_invoice_id ASC`;
      if (!sort && importedQueue) order = 'available.latest_payment_on DESC, i.xero_invoice_id ASC';
      if (!sort && exceptionQueue) order = 'evidence.latest_receipt_on DESC, i.xero_invoice_id ASC';
      if (!sort && reconciliationQueue) order = "pending.oldest_pending_link ASC, i.xero_invoice_id ASC";
      if (!sort && parsed.data.excessLinkStatus === 'needs_link') order = "excess.unlinked_excess_days DESC, i.xero_invoice_id ASC";
      const queryStartedAt = performance.now();
      const result = await db.query<InvoiceRow>(
        `SELECT i.xero_invoice_id, i.xero_contact_id, i.invoice_type, i.invoice_number, i.invoice_reference,
                c.legal_name, c.email, c.contact_number, c.account_number,
                i.invoice_date::text, i.due_date::text, i.invoice_status, i.currency_code,
                i.total, i.amount_paid, i.amount_due, i.sent_to_contact, i.concept,
                i.advisor_name, i.college_name, i.payment_track,
                COALESCE(r.review_status, 'pending') AS review_status, r.student_id,
                count(*) OVER()::int AS total_count,
                ${unlinkedQueue ? 'unlinked.unlinked_receipt_count, unlinked.unlinked_receipt_amount, unlinked.receipts_with_candidates, unlinked.receipts_with_multiple_candidates,' : ''}
                ${excessQueue ? 'excess.receipt_excess, excess.unlinked_excess, excess.unlinked_excess_days,' : ''}
                ${exceptionQueue ? `evidence.verified_count, evidence.verified_amount, evidence.latest_receipt_on,
                  CASE i.invoice_status WHEN 'VOIDED' THEN 'voided' WHEN 'DELETED' THEN 'deleted' ELSE 'not_current' END AS exception_reason,` : ''}
                ${importedQueue ? 'available.available_payments,available.available_amount,available.latest_payment_on,' : ''}
                ${confirmedQueue ? 'pending.pending_amount AS confirmed_amount, pending.pending_count AS confirmed_count,' : ''}
                ${reconciliationQueue && !confirmedQueue ? 'pending.oldest_pending_link, pending.pending_days, pending.pending_amount, pending.pending_count, pending.checked_count, pending.latest_reported_reconciled_on, pending.unassigned_count, pending.xero_pending_count, pending.unknown_status_count, pending.unmatched_link_count,' : ''}
                count(*) FILTER (WHERE i.invoice_type='ACCREC') OVER()::int AS invoice_total_count,
                count(*) FILTER (WHERE i.invoice_type='ACCRECCREDIT') OVER()::int AS credit_note_total_count,
                count(*) FILTER (WHERE i.invoice_type='RECEIVE-PREPAYMENT') OVER()::int AS prepayment_total_count,
                count(*) FILTER (WHERE i.invoice_type='RECEIVE-OVERPAYMENT') OVER()::int AS overpayment_total_count,
                count(*) FILTER (WHERE i.invoice_status='DRAFT') OVER()::int AS draft_total_count,
                count(*) FILTER (WHERE i.invoice_status='SUBMITTED') OVER()::int AS submitted_total_count,
                count(*) FILTER (WHERE i.invoice_status='AUTHORISED') OVER()::int AS authorised_total_count,
                count(*) FILTER (WHERE i.invoice_status='PAID') OVER()::int AS paid_total_count
          FROM ${schema}.student_operations_xero_invoices i
          ${importedJoin}
          ${exceptionJoin}
          ${unlinkedJoin}
          ${excessJoin}
          ${reconciliationJoin}
          ${exceptionQueue ? 'LEFT JOIN' : 'JOIN'} ${schema}.student_operations_xero_contacts c
             ON c.customer_id=i.customer_id AND c.xero_connection_id=i.xero_connection_id
            AND c.xero_contact_id=i.xero_contact_id
           ${exceptionQueue ? '' : `JOIN ${schema}.student_operations_xero_sync_runs seen
             ON seen.customer_id=i.customer_id AND seen.sync_run_id=i.last_seen_sync_run_id`}
           LEFT JOIN ${schema}.student_operations_xero_candidate_reviews r
             ON r.customer_id=i.customer_id AND r.xero_connection_id=i.xero_connection_id
            AND r.xero_contact_id=i.xero_contact_id
          WHERE i.customer_id=$1 AND i.xero_connection_id=$2
            ${exceptionQueue ? `AND i.invoice_type='ACCREC'
              AND (i.invoice_status IN ('VOIDED','DELETED') OR NOT ${currentTrustInvoice(schema,'i')})` : `AND i.invoice_type IN ('ACCREC','ACCRECCREDIT','RECEIVE-PREPAYMENT','RECEIVE-OVERPAYMENT')
            AND i.invoice_status IN (${XERO_REGISTER_STATUSES_SQL})
            AND seen.created_at >= COALESCE((
              SELECT max(full_run.created_at)
                FROM ${schema}.student_operations_xero_sync_runs full_run
               WHERE full_run.customer_id=$1
                 AND full_run.xero_connection_id=$2
                 AND full_run.status='succeeded'
                 AND full_run.mode IN ('initial','reconciliation')
            ), seen.created_at)`}
            ${filters.join("\n            ")}
          ORDER BY ${order}
          LIMIT $${limitPosition} OFFSET $${limitPosition + 1}`,
        params,
      );
      durations.invoiceQueryMs = elapsedMs(queryStartedAt);
      const total = Number(result.rows[0]?.total_count ?? 0);
      return {
        invoices: await this.financialProjection(db,tenantId,connectionId,result.rows),
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        invoiceTotal: Number(result.rows[0]?.invoice_total_count ?? 0),
        creditNoteTotal: Number(result.rows[0]?.credit_note_total_count ?? 0),
        prepaymentTotal: Number(result.rows[0]?.prepayment_total_count ?? 0),
        overpaymentTotal: Number(result.rows[0]?.overpayment_total_count ?? 0),
        statusTotals: {
          draft: Number(result.rows[0]?.draft_total_count ?? 0),
          awaitingApproval: Number(result.rows[0]?.submitted_total_count ?? 0),
          awaitingPayment: Number(result.rows[0]?.authorised_total_count ?? 0),
          paid: Number(result.rows[0]?.paid_total_count ?? 0),
        },
      };
      }, (timings) => addDatabaseTimings(durations, timings));
      outcome = "ok";
      return invoiceResult;
    } finally {
      logStudentOperationsTiming("xero-invoices", correlationId, outcome, {
        ...durations, totalMs: elapsedMs(startedAt),
      });
    }
  }

  async invoicePaymentTracks(tenantId: string, connectionId: string) {
    const schema = runtimeConfig().schema;
    return this.database.tenantReadTransaction(tenantId, async (db) => {
      await assertConnection(db, schema, tenantId, connectionId);
      const result = await db.query<{ payment_track: string }>(
        `SELECT min(btrim(i.payment_track)) AS payment_track
           FROM ${schema}.student_operations_xero_invoices i
           JOIN ${schema}.student_operations_xero_sync_runs seen
             ON seen.customer_id=i.customer_id AND seen.sync_run_id=i.last_seen_sync_run_id
          WHERE i.customer_id=$1 AND i.xero_connection_id=$2
            AND i.invoice_type IN ('ACCREC','ACCRECCREDIT','RECEIVE-PREPAYMENT','RECEIVE-OVERPAYMENT')
            AND i.invoice_status IN (${XERO_REGISTER_STATUSES_SQL})
            AND NULLIF(btrim(i.payment_track), '') IS NOT NULL
            AND seen.created_at >= COALESCE((
              SELECT max(full_run.created_at)
                FROM ${schema}.student_operations_xero_sync_runs full_run
               WHERE full_run.customer_id=i.customer_id
                 AND full_run.xero_connection_id=i.xero_connection_id
                 AND full_run.status='succeeded'
                 AND full_run.mode IN ('initial','reconciliation')
            ), seen.created_at)
          GROUP BY lower(btrim(i.payment_track))
          ORDER BY lower(btrim(i.payment_track))`,
        [tenantId, connectionId],
      );
      return { paymentTracks: result.rows.map((row) => row.payment_track) };
    });
  }

  async invoice(tenantId: string, connectionId: string, invoiceId: string, receiptHistory = false) {
    if (!z.uuid().safeParse(invoiceId).success) throw new NotFoundException("Xero invoice not found.");
    if (receiptHistory) {
      const history = await this.invoices(tenantId,connectionId,{queue:'receipt_exceptions',limit:1},undefined,undefined,invoiceId);
      if (history.invoices[0]) {
        const cases=await this.database.tenantReadTransaction(tenantId,db=>this.invoiceCases(db,tenantId,connectionId,invoiceId));
        return {...history.invoices[0],lineItems:[],settlement:null,relatedInvoices:[],cases};
      }
    }
    const schema = runtimeConfig().schema;
    return this.database.tenantReadTransaction(tenantId, async (db) => {
      await assertConnection(db, schema, tenantId, connectionId);
      const result = await db.query<InvoiceRow>(
        `SELECT i.xero_invoice_id, i.xero_contact_id, i.invoice_type, i.invoice_number, i.invoice_reference,
                c.legal_name, c.email, c.contact_number, c.account_number,
                i.invoice_date::text, i.due_date::text, i.invoice_status, i.currency_code,
                i.total, i.amount_paid, i.amount_due, i.sent_to_contact, i.concept,
                i.advisor_name, i.college_name, i.payment_track, i.line_items, i.settlement,
                COALESCE(r.review_status, 'pending') AS review_status, r.student_id
          FROM ${schema}.student_operations_xero_invoices i
          JOIN ${schema}.student_operations_xero_contacts c
             ON c.customer_id=i.customer_id AND c.xero_connection_id=i.xero_connection_id
            AND c.xero_contact_id=i.xero_contact_id
           JOIN ${schema}.student_operations_xero_sync_runs seen
             ON seen.customer_id=i.customer_id AND seen.sync_run_id=i.last_seen_sync_run_id
           LEFT JOIN ${schema}.student_operations_xero_candidate_reviews r
             ON r.customer_id=i.customer_id AND r.xero_connection_id=i.xero_connection_id
            AND r.xero_contact_id=i.xero_contact_id
          WHERE i.customer_id=$1 AND i.xero_connection_id=$2 AND i.xero_invoice_id=$3
            AND i.invoice_type IN ('ACCREC','ACCRECCREDIT','RECEIVE-PREPAYMENT','RECEIVE-OVERPAYMENT')
            AND i.invoice_status IN (${XERO_REGISTER_STATUSES_SQL})
            AND seen.created_at >= COALESCE((
              SELECT max(full_run.created_at)
                FROM ${schema}.student_operations_xero_sync_runs full_run
               WHERE full_run.customer_id=i.customer_id
                 AND full_run.xero_connection_id=i.xero_connection_id
                 AND full_run.status='succeeded'
                 AND full_run.mode IN ('initial','reconciliation')
            ), seen.created_at)`,
        [tenantId, connectionId, invoiceId],
      );
      const row = result.rows[0];
      if (!row) throw new NotFoundException("Xero invoice not found.");
      return { ...(await this.financialProjection(db,tenantId,connectionId,[row]))[0], lineItems: Array.isArray(row.line_items) ? row.line_items : [],settlement:row.settlement??null,cases:await this.invoiceCases(db,tenantId,connectionId,invoiceId),relatedInvoices:await this.relatedInvoices(db,tenantId,connectionId,invoiceId) };
    });
  }

  private async financialProjection(db:PoolClient,tenantId:string,connectionId:string,rows:InvoiceRow[]) {
    const schema=runtimeConfig().schema;
    const config=await db.query<{organisation_role:string}>(`SELECT organisation_role FROM ${schema}.student_operations_xero_sync_configurations WHERE customer_id=$1 AND xero_connection_id=$2`,[tenantId,connectionId]);
    if(config.rows[0]?.organisation_role!=='operating')return rows.map(row=>({...invoiceProjection(row),organisationRole:'trust' as const,contactName:row.legal_name,collegeId:null as string|null,matchingStatus:null as string|null}));
    const mappings=await db.query<{xero_contact_id:string;college_id:string|null;college_name:string|null;classification:string}>(`SELECT m.xero_contact_id,m.college_id,d.college_name,m.classification
      FROM ${schema}.student_college_xero_contact_links m LEFT JOIN ${schema}.student_operations_college_directory d ON d.customer_id=m.customer_id AND d.college_id=m.college_id
      WHERE m.customer_id=$1 AND m.xero_connection_id=$2 AND m.xero_contact_id=ANY($3::uuid[])`,[tenantId,connectionId,rows.map(row=>row.xero_contact_id)]);
    const studentLinks=(await db.query(`SELECT i.xero_invoice_id,d.user_id,d.name,d.email,d.student_reference,l.case_id
      FROM ${schema}.student_operations_xero_invoices i
      LEFT JOIN ${schema}.student_invoice_link_directory d ON d.customer_id=i.customer_id AND d.student_reference=i.student_id
      LEFT JOIN ${schema}.student_operations_case_invoice_links l ON l.customer_id=i.customer_id AND l.xero_connection_id=i.xero_connection_id AND l.xero_invoice_id=i.xero_invoice_id
      WHERE i.customer_id=$1 AND i.xero_connection_id=$2 AND i.xero_invoice_id=ANY($3::uuid[])`,[tenantId,connectionId,rows.map(row=>row.xero_invoice_id)])).rows;
    const byStudent=new Map(studentLinks.map(row=>[row.xero_invoice_id,row]));
    const byContact=new Map(mappings.rows.map(row=>[row.xero_contact_id,row]));
    return rows.map(row=>{const mapping=byContact.get(row.xero_contact_id),student=byStudent.get(row.xero_invoice_id);return {...invoiceProjection(row),organisationRole:'operating' as const,
      contactName:row.legal_name,studentName:student?.name??row.invoice_reference??'',studentEmail:student?.email??null,suggestedStudentReference:student?.student_reference??null,studentId:row.student_id??null,linkedStudentUserId:student?.user_id??null,linkedCaseId:student?.case_id??null,
      collegeName:mapping?.college_name??null,collegeId:mapping?.college_id??null,matchingStatus:mapping?.classification??'unresolved'};});
  }

  private async invoiceCases(db:PoolClient,tenant:string,connection:string,invoice:string) {
    const s=runtimeConfig().schema;
    return (await db.query(`WITH origins AS (
      SELECT case_id FROM ${s}.student_operations_case_invoice_links WHERE customer_id=$1 AND xero_connection_id=$2 AND xero_invoice_id=$3
      UNION SELECT case_id FROM ${s}.student_case_xero_invoice_exports WHERE customer_id=$1 AND xero_connection_id=$2 AND xero_invoice_id=$3 AND status='created'
      UNION SELECT case_id FROM ${s}.student_commission_exports WHERE customer_id=$1 AND xero_connection_id=$2 AND xero_invoice_id=$3 AND status='created'
    ) SELECT c.case_id AS id,c.case_reference AS reference FROM origins JOIN ${s}.student_operations_cases c USING(case_id)
      WHERE c.customer_id=$1 AND c.deleting_at IS NULL AND NOT EXISTS (
        SELECT 1 FROM ${s}.student_case_invoice_removals r WHERE r.customer_id=$1 AND r.xero_connection_id=$2 AND r.xero_invoice_id=$3 AND r.completed
      ) ORDER BY c.case_reference,c.case_id`,[tenant,connection,invoice])).rows;
  }

  private async relatedInvoices(db:PoolClient,tenant:string,connectionId:string,invoiceId:string){
    const s=runtimeConfig().schema;
    if(!(await db.query('SELECT to_regclass($1) IS NOT NULL AS ready',[`${s}.student_commission_exports`])).rows[0]?.ready)return [];
    return (await db.query(`WITH related AS (
      SELECT e.case_id,e.batch_id,e.sequence,e.trust_connection_id AS connection_id,e.trust_invoice_id AS invoice_id,'trust' AS role,e.xero_connection_id AS source_connection,e.xero_invoice_id AS source_invoice
      FROM ${s}.student_commission_exports e WHERE e.customer_id=$1 AND e.status='created'
      UNION ALL SELECT e.case_id,e.batch_id,e.sequence,e.xero_connection_id,e.xero_invoice_id,'operating',e.trust_connection_id,e.trust_invoice_id
      FROM ${s}.student_commission_exports e WHERE e.customer_id=$1 AND e.status='created')
      SELECT r.case_id AS "caseId",r.sequence,r.role,r.connection_id AS "connectionId",r.invoice_id AS "invoiceId",i.invoice_number AS "invoiceNumber",i.invoice_status AS status,
        i.currency_code AS "currencyCode",i.invoice_date AS date,i.due_date AS "dueDate",CASE WHEN i.last_seen_sync_run_id IS NOT NULL THEN i.amount_paid END AS "amountPaid",
        CASE WHEN i.last_seen_sync_run_id IS NOT NULL THEN i.amount_due END AS "amountDue",
        ${currentTrustInvoice(s,'i')} AS indexed
      FROM related r LEFT JOIN ${s}.student_operations_xero_invoices i ON i.customer_id=$1 AND i.xero_connection_id=r.connection_id AND i.xero_invoice_id=r.invoice_id
      WHERE r.source_connection=$2 AND r.source_invoice=$3 ORDER BY r.sequence,r.connection_id,r.invoice_id`,[tenant,connectionId,invoiceId])).rows;
  }

  async process(tenantId: string, runId: string): Promise<void> {
    const owner = randomUUID();
    const schema = runtimeConfig().schema;
    const run = await this.database.tenantTransaction(tenantId, async (db) => {
      const claimed = await db.query<SyncRunRow>(
        `UPDATE ${schema}.student_operations_xero_sync_runs
            SET status='processing', attempt_count=attempt_count+1, lease_owner=$3,
                lease_expires_at=now()+interval '10 minutes', started_at=COALESCE(started_at, now())
          WHERE customer_id=$1 AND sync_run_id=$2
            AND (status='queued' OR (status='processing' AND lease_expires_at < now()))
        RETURNING sync_run_id, xero_connection_id, mode, trigger_type, status, modified_since,
                  contact_count, invoice_count, candidate_count, error_code,
                  created_at, started_at, completed_at`,
        [tenantId, runId, owner],
      );
      return claimed.rows[0] ?? null;
    });
    if (!run) return;

    try {
      if (run.mode==='incremental') {
        const targeted=await this.refreshWebhookResources(tenantId,run,owner);
        if (targeted.complete && run.trigger_type==='webhook' && run.modified_since) {
          await this.complete(tenantId,run,owner,targeted.contacts,targeted.invoices,true);
          return;
        }
      }
      const modifiedSince = run.modified_since ?? undefined;
      let contactCount = 0;
      for (let page = 1; page <= 10_000; page += 1) {
        const response = await this.xero.syncContactPage(tenantId, run.xero_connection_id, page, modifiedSince);
        contactCount += response.items.length;
        await this.persistContacts(tenantId, run, owner, response.items, contactCount);
        if (page >= response.pageCount) break;
      }
      const invoiceCount = await this.importInvoicePages(tenantId, run, owner, modifiedSince);
      await this.complete(tenantId, run, owner, contactCount, invoiceCount);
    } catch (error) {
      await this.fail(tenantId, runId, owner, safeProviderFailure(error));
    }
  }

  private async refreshWebhookResources(tenant:string,run:SyncRunRow,owner:string) {
    const table=runtimeConfig().schema+'.student_xero_webhook_resources';
    const connection=run.xero_connection_id;
    const pending=await this.database.tenantTransaction(tenant,db=>db.query<{category:string;resource_id:string;event_at:string}>(
      `SELECT category,resource_id,event_at::text FROM ${table}
       WHERE customer_id=$1 AND xero_connection_id=$2 AND refreshed_at IS NULL ORDER BY event_at,resource_id,category LIMIT 51`,[tenant,connection]));
    let contacts=0,invoices=0;
    let complete=pending.rows.length>0 && pending.rows.length<=50;
    for (const event of pending.rows.slice(0,50)) {
      try {
        if (event.category==='CONTACT') {
          const contact=await this.xero.contactById(tenant,connection,event.resource_id);
          await this.persistContacts(tenant,run,owner,[contact],++contacts);
        } else {
          const invoice=await this.xero.invoiceById(tenant,connection,event.resource_id);
          if(invoice.invoiceId!==event.resource_id) throw new ConflictException('Xero returned a different invoice.');
          if(invoice.type==='ACCREC') {
            const contact=await this.xero.contactById(tenant,connection,invoice.contactId);
            await this.persistContacts(tenant,run,owner,[contact],++contacts);
            await this.persistInvoices(tenant,run,owner,[invoice],++invoices);
          }
        }
      } catch(error) {
        if (safeProviderFailure(error).providerStatus!==404) throw error;
        complete=false;
        // The normal register sweep handles records that Xero no longer returns by ID.
      }
      await this.database.tenantTransaction(tenant,db=>db.query(`UPDATE ${table} SET refreshed_at=now()
        WHERE customer_id=$1 AND xero_connection_id=$2 AND category=$3 AND resource_id=$4 AND event_at=$5`,
        [tenant,connection,event.category,event.resource_id,event.event_at]));
    }
    return {contacts,invoices,complete};
  }

  private async importInvoicePages(
    tenantId: string,
    run: SyncRunRow,
    owner: string,
    modifiedSince?: Date,
  ): Promise<number> {
    let invoiceCount = 0;
    let providerItemCount: number | undefined;
    const seenInvoiceIds = new Set<string>();
    for (let page = 1; page <= 10_000; page += 1) {
      const response = await this.xero.syncInvoicePage(
        tenantId,
        run.xero_connection_id,
        page,
        modifiedSince,
        false,
      );
      if (response.itemCount !== undefined) {
        if (providerItemCount !== undefined && response.itemCount !== providerItemCount) {
          throw new ConflictException("Xero invoice pagination changed during synchronization.");
        }
        providerItemCount = response.itemCount;
      }
      for (const invoice of response.items) {
        if (seenInvoiceIds.has(invoice.invoiceId)) {
          throw new ConflictException("Xero invoice pagination returned a duplicate record.");
        }
        seenInvoiceIds.add(invoice.invoiceId);
      }
      invoiceCount += response.items.length;
      await this.persistInvoices(tenantId, run, owner, response.items, invoiceCount);
      if (page >= response.pageCount) {
        if (providerItemCount !== undefined && invoiceCount !== providerItemCount) {
          throw new ConflictException("Xero invoice synchronization returned an incomplete register.");
        }
        const creditNoteCount = await this.importSupplementalPages(
          tenantId,
          run,
          owner,
          modifiedSince,
          invoiceCount,
          "credit note",
        );
        const prepaymentCount = await this.importSupplementalPages(
          tenantId,
          run,
          owner,
          modifiedSince,
          invoiceCount + creditNoteCount,
          "prepayment",
        );
        const overpaymentCount = await this.importSupplementalPages(
          tenantId,
          run,
          owner,
          modifiedSince,
          invoiceCount + creditNoteCount + prepaymentCount,
          "overpayment",
        );
        return invoiceCount + creditNoteCount + prepaymentCount + overpaymentCount;
      }
    }
    throw new ConflictException("Xero invoice synchronization exceeded the page limit.");
  }

  private async importSupplementalPages(
    tenantId: string,
    run: SyncRunRow,
    owner: string,
    modifiedSince: Date | undefined,
    processedBefore: number,
    resource: "credit note" | "prepayment" | "overpayment",
  ): Promise<number> {
    let itemCount = 0;
    let providerItemCount: number | undefined;
    const seenIds = new Set<string>();
    for (let page = 1; page <= 10_000; page += 1) {
      const response = resource === "credit note"
        ? await this.xero.syncCreditNotePage(tenantId, run.xero_connection_id, page, modifiedSince)
        : resource === "prepayment"
          ? await this.xero.syncPrepaymentPage(tenantId, run.xero_connection_id, page, modifiedSince)
          : await this.xero.syncOverpaymentPage(tenantId, run.xero_connection_id, page, modifiedSince);
      if (response.itemCount !== undefined) {
        if (providerItemCount !== undefined && response.itemCount !== providerItemCount) {
          throw new ConflictException(`Xero ${resource} pagination changed during synchronization.`);
        }
        providerItemCount = response.itemCount;
      }
      for (const item of response.items) {
        if (seenIds.has(item.invoiceId)) {
          throw new ConflictException(`Xero ${resource} pagination returned a duplicate record.`);
        }
        seenIds.add(item.invoiceId);
      }
      itemCount += response.items.length;
      await this.persistInvoices(
        tenantId,
        run,
        owner,
        response.items,
        processedBefore + itemCount,
      );
      if (page >= response.pageCount) {
        if (providerItemCount !== undefined && itemCount !== providerItemCount) {
          throw new ConflictException(`Xero ${resource} synchronization returned an incomplete register.`);
        }
        return itemCount;
      }
    }
    throw new ConflictException(`Xero ${resource} synchronization exceeded the page limit.`);
  }

  private persistContacts(
    tenantId: string,
    run: SyncRunRow,
    owner: string,
    contacts: XeroContactRecord[],
    processedCount: number,
  ) {
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (db) => {
      await assertLease(db, schema, tenantId, run.sync_run_id, owner);
      if (contacts.length) {
        await db.query(
          `WITH source AS (
             SELECT
               (item->>'contactId')::uuid AS xero_contact_id,
               NULLIF(item->>'status', '') AS contact_status,
               item->>'legalName' AS legal_name,
               NULLIF(item->>'email', '') AS email,
               NULLIF(item->>'contactNumber', '') AS contact_number,
               NULLIF(item->>'accountNumber', '') AS account_number,
               NULLIF(item->>'updatedAt', '')::timestamptz AS provider_updated_at
             FROM jsonb_array_elements($4::jsonb) AS item
           )
           INSERT INTO ${schema}.student_operations_xero_contacts
             (customer_id, xero_connection_id, xero_contact_id, contact_status, legal_name,
              email, contact_number, account_number, provider_updated_at, last_seen_sync_run_id)
           SELECT $1::uuid, $2::uuid, xero_contact_id, contact_status, legal_name,
                  email, contact_number, account_number, provider_updated_at, $3::uuid
             FROM source
           ON CONFLICT (customer_id, xero_connection_id, xero_contact_id) DO UPDATE SET
             contact_status=EXCLUDED.contact_status, legal_name=EXCLUDED.legal_name,
             email=EXCLUDED.email, contact_number=EXCLUDED.contact_number,
             account_number=EXCLUDED.account_number, provider_updated_at=EXCLUDED.provider_updated_at,
             last_seen_sync_run_id=EXCLUDED.last_seen_sync_run_id, updated_at=now()`,
          [tenantId, run.xero_connection_id, run.sync_run_id, JSON.stringify(contacts)],
        );
      }
      await checkpointProgress(db, schema, tenantId, run.sync_run_id, owner, "contact_count", processedCount);
    });
  }

  private persistInvoices(
    tenantId: string,
    run: SyncRunRow,
    owner: string,
    invoices: XeroInvoiceRecord[],
    processedCount: number,
  ) {
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (db) => {
      await assertLease(db, schema, tenantId, run.sync_run_id, owner);
      if (invoices.length) {
        await db.query(
          `WITH source AS (
             SELECT
               (item->>'invoiceId')::uuid AS xero_invoice_id,
               (item->>'contactId')::uuid AS xero_contact_id,
               NULLIF(item->>'invoiceNumber', '') AS invoice_number,
               NULLIF(item->>'invoiceReference', '') AS invoice_reference,
               NULLIF(item->>'concept', '') AS concept,
               NULLIF(item->>'advisorName', '') AS advisor_name,
               CASE WHEN EXISTS(SELECT 1 FROM ${schema}.student_operations_xero_sync_configurations
                 WHERE customer_id=$1 AND xero_connection_id=$2 AND organisation_role='trust')
                 THEN NULLIF(item->>'collegeName', '') ELSE NULL END AS college_name,
               NULLIF(item->>'paymentTrack', '') AS payment_track,
               COALESCE((item->>'sentToContact')::boolean, false) AS sent_to_contact,
               COALESCE(item->'lineItems', '[]'::jsonb) AS line_items,
               item->'settlement' AS settlement,
               item->>'type' AS invoice_type,
               item->>'status' AS invoice_status,
               NULLIF(item->>'invoiceDate', '')::date AS invoice_date,
               NULLIF(item->>'dueDate', '')::date AS due_date,
               NULLIF(item->>'currencyCode', '') AS currency_code,
               COALESCE((item->>'total')::numeric, 0) AS total,
               COALESCE((item->>'amountPaid')::numeric, 0) AS amount_paid,
               COALESCE((item->>'amountDue')::numeric, 0) AS amount_due,
               NULLIF(item->>'updatedAt', '')::timestamptz AS provider_updated_at
             FROM jsonb_array_elements($4::jsonb) AS item
           )
           INSERT INTO ${schema}.student_operations_xero_invoices
             (customer_id, xero_connection_id, xero_invoice_id, xero_contact_id,
              invoice_number, invoice_type, invoice_status, invoice_date, due_date,
              invoice_reference, concept, advisor_name, college_name, payment_track,
              sent_to_contact, line_items, settlement,
              currency_code, total, amount_paid, amount_due, provider_updated_at, last_seen_sync_run_id)
           SELECT $1::uuid, $2::uuid, xero_invoice_id, xero_contact_id,
                  invoice_number, invoice_type, invoice_status, invoice_date, due_date,
                  invoice_reference, concept, advisor_name, college_name, payment_track,
                  sent_to_contact, line_items, settlement,
                  currency_code, total, amount_paid, amount_due, provider_updated_at, $3::uuid
             FROM source
           ON CONFLICT (customer_id, xero_connection_id, xero_invoice_id) DO UPDATE SET
             xero_contact_id=EXCLUDED.xero_contact_id, invoice_number=EXCLUDED.invoice_number,
             invoice_reference=EXCLUDED.invoice_reference, concept=EXCLUDED.concept,
             advisor_name=EXCLUDED.advisor_name, college_name=EXCLUDED.college_name,
             payment_track=EXCLUDED.payment_track, sent_to_contact=EXCLUDED.sent_to_contact,
             line_items=EXCLUDED.line_items,
             settlement=CASE WHEN EXCLUDED.currency_code IS NULL OR student_operations_xero_invoices.currency_code IS DISTINCT FROM EXCLUDED.currency_code
               THEN EXCLUDED.settlement
               WHEN EXCLUDED.settlement->>'allocationListsOmitted' = 'true'
               THEN jsonb_set(EXCLUDED.settlement,'{entries}',COALESCE(student_operations_xero_invoices.settlement->'entries','[]'::jsonb))
               WHEN EXCLUDED.settlement IS NULL
               THEN student_operations_xero_invoices.settlement || '{"allocationListsOmitted":true}'::jsonb
               WHEN EXCLUDED.settlement ? 'omittedKinds'
               THEN jsonb_set(EXCLUDED.settlement,'{entries}',(EXCLUDED.settlement->'entries') || COALESCE((
                 SELECT jsonb_agg(prior.entry ORDER BY prior.position)
                 FROM jsonb_array_elements(student_operations_xero_invoices.settlement->'entries') WITH ORDINALITY AS prior(entry,position)
                 WHERE (EXCLUDED.settlement->'omittedKinds') ? (prior.entry->>'kind')
               ),'[]'::jsonb))
               ELSE EXCLUDED.settlement END,
             invoice_type=EXCLUDED.invoice_type, invoice_status=EXCLUDED.invoice_status,
             invoice_date=EXCLUDED.invoice_date, due_date=EXCLUDED.due_date,
             currency_code=EXCLUDED.currency_code, total=EXCLUDED.total,
             amount_paid=EXCLUDED.amount_paid, amount_due=EXCLUDED.amount_due,
             provider_updated_at=EXCLUDED.provider_updated_at,
             last_seen_sync_run_id=EXCLUDED.last_seen_sync_run_id, updated_at=now()`,
          [tenantId, run.xero_connection_id, run.sync_run_id, JSON.stringify(invoices)],
        );
        const observations = invoices.flatMap(invoice => (invoice.settlement?.entries ?? [])
          .filter(entry => entry.kind === 'payment')
          .map(entry => ({
            invoice_id:invoice.invoiceId, payment_id:entry.id, amount:entry.amount,
            currency_code:invoice.currencyCode, payment_date:entry.date, is_reconciled:entry.isReconciled,
          })));
        if (observations.length) {
          await db.query(`INSERT INTO ${schema}.student_xero_payment_observations
              (customer_id,xero_connection_id,first_seen_run_id,xero_invoice_id,payment_id,amount,currency_code,payment_date,is_reconciled)
            SELECT $1,$2,$3,invoice_id,payment_id,amount,currency_code,payment_date,is_reconciled
            FROM jsonb_to_recordset($4::jsonb) AS observation(invoice_id uuid,payment_id uuid,amount numeric,
              currency_code text,payment_date date,is_reconciled boolean)
            ON CONFLICT DO NOTHING`,
            [tenantId,run.xero_connection_id,run.sync_run_id,JSON.stringify(observations)]);
        }
      }
      await checkpointProgress(db, schema, tenantId, run.sync_run_id, owner, "invoice_count", processedCount);
    });
  }

  private complete(tenantId: string, run: SyncRunRow, owner: string, contacts: number, invoices: number,targeted=false) {
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['xero-webhook/'+tenantId+'/'+run.xero_connection_id]);
      await assertLease(db, schema, tenantId, run.sync_run_id, owner);
      await autoMatchCollegeContacts(db,tenantId,run.xero_connection_id);
      await db.query(`SELECT ${schema}.reconcile_latest_invoice_advisors($1::uuid)
        WHERE EXISTS(SELECT 1 FROM ${schema}.student_operations_xero_sync_configurations
          WHERE customer_id=$1 AND xero_connection_id=$2 AND organisation_role='trust')`, [tenantId,run.xero_connection_id]);
      const count = await db.query<{ count: number }>(
        `SELECT count(DISTINCT i.xero_contact_id)::int AS count
           FROM ${schema}.student_operations_xero_invoices i
           LEFT JOIN ${schema}.student_operations_xero_candidate_reviews r
             ON r.customer_id=i.customer_id AND r.xero_connection_id=i.xero_connection_id
            AND r.xero_contact_id=i.xero_contact_id
          WHERE i.customer_id=$1 AND i.xero_connection_id=$2 AND i.invoice_type='ACCREC'
            AND i.invoice_status IN (${XERO_REGISTER_STATUSES_SQL})
            AND COALESCE(r.review_status, 'pending')='pending'`,
        [tenantId, run.xero_connection_id],
      );
      const candidates = Number(count.rows[0]?.count ?? 0);
      await db.query(
        `UPDATE ${schema}.student_operations_xero_sync_runs
            SET status='succeeded', contact_count=$4, invoice_count=$5, candidate_count=$6,
                error_code=NULL, completed_at=now(), lease_owner=NULL, lease_expires_at=NULL
          WHERE customer_id=$1 AND sync_run_id=$2 AND lease_owner=$3`,
        [tenantId, run.sync_run_id, owner, contacts, invoices, candidates],
      );
      // Only a register scan advances its watermark and postpones the next scheduled sweep.
      if(!targeted) await db.query(
        `UPDATE ${schema}.student_operations_xero_sync_configurations
            SET last_successful_sync_at=now(),
                last_incremental_sync_at=CASE WHEN $3='incremental' THEN now() ELSE last_incremental_sync_at END,
                last_reconciliation_sync_at=CASE WHEN $3 IN ('initial','reconciliation') THEN now() ELSE last_reconciliation_sync_at END,
                invoice_metadata_version=CASE WHEN $3 IN ('initial','reconciliation') THEN 1 ELSE invoice_metadata_version END,
                invoice_detail_version=CASE WHEN $3 IN ('initial','reconciliation') THEN 1 ELSE invoice_detail_version END,
                last_error_code=NULL, next_sync_at=CASE WHEN $4::boolean THEN
                  (((now() AT TIME ZONE 'Australia/Brisbane')::date + 1 + time '01:00') AT TIME ZONE 'Australia/Brisbane')
                  ELSE now()+incremental_interval END,
                revision=revision+1, updated_at=now()
          WHERE customer_id=$1 AND xero_connection_id=$2`,
        [tenantId, run.xero_connection_id, run.mode,process.env.XERO_SYNC_EXECUTION_MODE === 'worker'],
      );
      if(process.env.XERO_SYNC_EXECUTION_MODE==='worker') {
        // A delivery during an active run could not claim its own active-run slot.
        await db.query(`INSERT INTO ${schema}.student_operations_xero_sync_runs
          (customer_id,xero_connection_id,mode,trigger_type,modified_since)
          SELECT c.customer_id,c.xero_connection_id,'incremental','webhook',c.last_successful_sync_at-interval '5 minutes'
          FROM ${schema}.student_operations_xero_sync_configurations c
          WHERE c.customer_id=$1 AND c.xero_connection_id=$2 AND c.enabled AND EXISTS(
            SELECT 1 FROM ${schema}.student_xero_webhook_resources r WHERE r.customer_id=c.customer_id
              AND r.xero_connection_id=c.xero_connection_id AND r.refreshed_at IS NULL)
          ON CONFLICT DO NOTHING`,[tenantId,run.xero_connection_id]);
      }
      // Match against this completed run so removed provider records are excluded.
      await autoMatchStudentInvoices(db,tenantId,run.xero_connection_id);
    });
  }

  private fail(tenantId: string, runId: string, owner: string, failure: SafeProviderFailure) {
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (db) => {
      const previousFailures = await db.query<{ count: number }>(
        `SELECT count(*)::int AS count
           FROM ${schema}.student_operations_xero_sync_runs failed
          WHERE failed.customer_id=$1 AND failed.status='failed'
            AND failed.xero_connection_id=(SELECT current_run.xero_connection_id
              FROM ${schema}.student_operations_xero_sync_runs current_run
              WHERE current_run.customer_id=$1 AND current_run.sync_run_id=$2)
            AND failed.created_at > COALESCE((
              SELECT max(succeeded.created_at)
                FROM ${schema}.student_operations_xero_sync_runs succeeded
               WHERE succeeded.customer_id=$1 AND succeeded.status='succeeded'
                 AND succeeded.xero_connection_id=failed.xero_connection_id
            ), '-infinity'::timestamptz)`,
        [tenantId, runId],
      );
      const retryAfterSeconds = durableRetryDelay(
        failure.retryAfterSeconds, Number(previousFailures.rows[0]?.count ?? 0),
      );
      await db.query(
        `UPDATE ${schema}.student_operations_xero_sync_runs
            SET status='failed', error_code=$4, provider_status=$5,
                provider_correlation_id=$6, retry_after_seconds=$7,
                completed_at=now(), lease_owner=NULL, lease_expires_at=NULL
          WHERE customer_id=$1 AND sync_run_id=$2 AND lease_owner=$3`,
        [tenantId, runId, owner, failure.code, failure.providerStatus,
          failure.correlationId, retryAfterSeconds],
      );
      await db.query(
        `UPDATE ${schema}.student_operations_xero_sync_configurations c
            SET last_error_code=$3,
                next_sync_at=now()+($4 * interval '1 second'), updated_at=now()
          WHERE c.customer_id=$1
            AND c.xero_connection_id=(SELECT r.xero_connection_id
              FROM ${schema}.student_operations_xero_sync_runs r
              WHERE r.customer_id=$1 AND r.sync_run_id=$2)`,
        [tenantId, runId, failure.code, retryAfterSeconds],
      );
    });
  }
}

async function assertConnection(db: PoolClient, schema: string, tenantId: string, connectionId: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(connectionId)) throw new NotFoundException("Xero connection not found.");
  const result = await db.query(
    `SELECT 1 FROM ${schema}.xero_connections
      WHERE customer_id=$1 AND xero_connection_id=$2 AND status <> 'revoked'`,
    [tenantId, connectionId],
  );
  if (!result.rowCount) throw new NotFoundException("Xero connection not found.");
}

async function assertLease(db: PoolClient, schema: string, tenantId: string, runId: string, owner: string): Promise<void> {
  const result = await db.query(
    `UPDATE ${schema}.student_operations_xero_sync_runs
        SET lease_expires_at=now()+interval '10 minutes'
      WHERE customer_id=$1 AND sync_run_id=$2 AND status='processing' AND lease_owner=$3
      RETURNING 1`,
    [tenantId, runId, owner],
  );
  if (!result.rowCount) throw new ConflictException("The Xero sync lease was lost.");
}

async function checkpointProgress(
  db: PoolClient,
  schema: string,
  tenantId: string,
  runId: string,
  owner: string,
  column: "contact_count" | "invoice_count",
  processedCount: number,
): Promise<void> {
  const result = await db.query(
    `UPDATE ${schema}.student_operations_xero_sync_runs
        SET ${column}=$4, lease_expires_at=now()+interval '10 minutes'
      WHERE customer_id=$1 AND sync_run_id=$2 AND status='processing' AND lease_owner=$3
      RETURNING 1`,
    [tenantId, runId, owner, processedCount],
  );
  if (!result.rowCount) throw new ConflictException("The Xero sync lease was lost.");
}

function runProjection(row: SyncRunRow) {
  return {
    syncRunId: row.sync_run_id,
    connectionId: row.xero_connection_id,
    mode: row.mode,
    triggerType: row.trigger_type,
    status: row.status,
    contactCount: Number(row.contact_count),
    invoiceCount: Number(row.invoice_count),
    candidateCount: Number(row.candidate_count),
    errorCode: row.error_code,
    providerStatus: row.provider_status ?? null,
    providerCorrelationId: row.provider_correlation_id ?? null,
    retryAfterSeconds: row.retry_after_seconds ?? null,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
  };
}

function candidateProjection(row: CandidateRow) {
  return {
    xeroContactId: row.xero_contact_id,
    legalName: row.legal_name,
    email: row.email,
    suggestedStudentReference: row.contact_number ?? row.account_number,
    invoiceCount: Number(row.invoice_count),
    latestInvoiceNumber: row.latest_invoice_number,
    latestInvoiceDate: row.latest_invoice_date,
    latestInvoiceReference: row.latest_invoice_reference,
    concept: row.latest_concept,
    advisorName: row.latest_advisor_name,
    collegeName: row.latest_college_name,
    nextPaymentDate: row.next_payment_date,
    nextPaymentAmount: row.next_payment_amount === null ? null : Number(row.next_payment_amount),
    totalInvoiced: Number(row.total_invoiced),
    totalPaid: Number(row.total_paid),
    amountDue: Number(row.amount_due),
    currencyCode: row.currency_code,
    paymentStatus: row.payment_status,
  };
}

function invoiceProjection(row: InvoiceRow) {
  return {
    ...(row.exception_reason ? {receiptException:{reason:row.exception_reason,count:row.verified_count,
      amount:Number(row.verified_amount),latestReceiptOn:row.latest_receipt_on}} : {}),
    ...(row.available_payments == null ? {} : {availablePayments:{count:row.available_payments,
      amount:Number(row.available_amount), latestDate:row.latest_payment_on}}),
    ...(row.confirmed_count == null ? {} : {confirmedPayments:{count:row.confirmed_count, amount:Number(row.confirmed_amount)}}),
    ...(row.oldest_pending_link == null ? {} : { reconciliation: {
      oldestLinkedAt: row.oldest_pending_link.toISOString(),
      pendingDays: row.pending_days,
      amount: Number(row.pending_amount),
      payments: row.pending_count,
      managerChecks: row.checked_count,
      latestReportedReconciledOn: row.latest_reported_reconciled_on,
      unassigned: row.unassigned_count,
      xeroPending: row.xero_pending_count,
      statusUnknown: row.unknown_status_count,
      linkMismatch: row.unmatched_link_count,
    } }),
    ...(row.unlinked_receipt_count == null ? {} : { unlinkedReceipts: {
      count: row.unlinked_receipt_count, withCandidates: row.receipts_with_candidates, withMultipleCandidates: row.receipts_with_multiple_candidates, amount: Number(row.unlinked_receipt_amount),
    } }),
    ...(row.receipt_excess == null ? {} : { receiptExcess: Number(row.receipt_excess), unlinkedExcess: Number(row.unlinked_excess), unlinkedExcessDays: row.unlinked_excess_days }),
    xeroInvoiceId: row.xero_invoice_id,
    xeroContactId: row.xero_contact_id,
    documentType: row.invoice_type === "ACCRECCREDIT"
      ? "credit_note"
      : row.invoice_type === "RECEIVE-PREPAYMENT"
        ? "prepayment"
        : row.invoice_type === "RECEIVE-OVERPAYMENT"
          ? "overpayment"
          : "invoice",
    invoiceNumber: row.invoice_number,
    reference: row.invoice_reference,
    studentName: row.legal_name,
    studentEmail: row.email,
    suggestedStudentReference: row.contact_number ?? row.account_number,
    invoiceDate: row.invoice_date,
    dueDate: row.due_date,
    status: row.invoice_status.toLowerCase(),
    currencyCode: row.currency_code,
    total: Number(row.total),
    amountPaid: Number(row.amount_paid),
    amountDue: Number(row.amount_due),
    sentToContact: row.sent_to_contact,
    concept: row.concept,
    advisorName: row.advisor_name,
    collegeName: row.invoice_reference ?? row.college_name,
    paymentTrack: row.payment_track,
    reviewStatus: row.review_status,
    studentId: row.student_id,
  };
}

function safeProviderFailure(error: unknown): SafeProviderFailure {
  const fallback: SafeProviderFailure = {
    code: "xero_sync_failed",
    providerStatus: null,
    correlationId: null,
    retryAfterSeconds: 300,
  };
  if (error && typeof error === "object" && "getResponse" in error) {
    const response = (error as { getResponse(): unknown }).getResponse();
    if (response && typeof response === "object") {
      const value = response as Record<string, unknown>;
      const code = typeof value.errorCode === "string" && /^[a-z0-9_]{1,80}$/.test(value.errorCode)
        ? value.errorCode
        : fallback.code;
      const providerStatus = typeof value.providerStatus === "number" ? value.providerStatus : null;
      const correlationId = typeof value.correlationId === "string"
        ? value.correlationId.slice(0, 200)
        : null;
      const requestedRetry = typeof value.retryAfterSeconds === "number"
        ? value.retryAfterSeconds
        : providerStatus === 429 ? 60 : providerStatus !== null && providerStatus >= 500 ? 300 : 900;
      return {
        code,
        providerStatus,
        correlationId,
        retryAfterSeconds: Math.max(30, Math.min(86_400, Math.ceil(requestedRetry))),
      };
    }
  }
  return fallback;
}

function durableRetryDelay(providerDelaySeconds: number, previousFailureCount: number): number {
  const multipliers = [1, 3, 12, 72, 144];
  const multiplier = multipliers[Math.min(previousFailureCount, multipliers.length - 1)] ?? 144;
  return Math.min(43_200, Math.max(providerDelaySeconds, 300 * multiplier));
}
