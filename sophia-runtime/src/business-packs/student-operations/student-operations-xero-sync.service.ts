import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { XeroConnectorService } from "../../connectors/xero/xero-connector.service.js";
import type { XeroContactRecord, XeroInvoiceRecord } from "../../connectors/xero/xero.client.js";
import { runtimeConfig } from "../../config/runtime-config.js";
import { DatabaseService } from "../../database/database.service.js";
import type { StudentOperationsWorkspacePrincipal } from "./student-operations-workspace.service.js";

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
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(100).optional(),
  sort: z.enum(["invoiceNumber", "reference", "student", "date", "dueDate", "paid", "due", "status", "sent", "advisor", "paymentTrack"]).default("date"),
  direction: z.enum(["asc", "desc"]).default("desc"),
}).strict();

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
  xero_invoice_id: string;
  xero_contact_id: string;
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
  review_status: "pending" | "accepted" | "ignored";
  student_id: string | null;
  total_count?: number;
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
        last_error_code: string | null;
        next_sync_at: Date;
      }>(
        `SELECT organisation_role, last_successful_sync_at, last_error_code, next_sync_at
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
        `INSERT INTO ${schema}.student_operations_xero_sync_configurations
           (customer_id, xero_connection_id, organisation_role)
         VALUES ($1, $2, 'trust')
         ON CONFLICT (customer_id, xero_connection_id) DO UPDATE
           SET enabled=true, updated_at=now()
         RETURNING last_successful_sync_at, last_reconciliation_sync_at,
                   invoice_metadata_version, invoice_detail_version`,
        [principal.tenantId, connectionId],
      );
      const active = await db.query<SyncRunRow>(
        `SELECT sync_run_id, xero_connection_id, mode, trigger_type, status, modified_since,
                contact_count, invoice_count, candidate_count, error_code,
                created_at, started_at, completed_at
           FROM ${schema}.student_operations_xero_sync_runs
          WHERE customer_id=$1 AND xero_connection_id=$2 AND status IN ('queued','processing')
          ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [principal.tenantId, connectionId],
      );
      if (active.rows[0]) return active.rows[0];
      const configuration = existingConfiguration.rows[0];
      const mode = !configuration?.last_successful_sync_at
        ? "initial"
        : configuration.invoice_metadata_version < 1 || configuration.invoice_detail_version < 1
          || !configuration.last_reconciliation_sync_at
          || configuration.last_reconciliation_sync_at.getTime() < Date.now() - 12 * 60 * 60 * 1000
          ? "reconciliation"
          : "incremental";
      const modifiedSince = mode === "incremental" && configuration?.last_successful_sync_at
        ? new Date(configuration.last_successful_sync_at.getTime() - 5 * 60 * 1000)
        : null;
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
    setTimeout(() => { void this.process(principal.tenantId, run.sync_run_id); }, 0);
    return runProjection(run);
  }

  async configureTrust(principal: StudentOperationsWorkspacePrincipal, connectionId: string) {
    const schema = runtimeConfig().schema;
    await this.database.tenantTransaction(principal.tenantId, async (db) => {
      await assertConnection(db, schema, principal.tenantId, connectionId);
      await db.query(
        `UPDATE ${schema}.student_operations_xero_sync_configurations
            SET organisation_role='unassigned', enabled=false, revision=revision+1, updated_at=now()
          WHERE customer_id=$1 AND organisation_role='trust' AND xero_connection_id<>$2`,
        [principal.tenantId, connectionId],
      );
      await db.query(
        `INSERT INTO ${schema}.student_operations_xero_sync_configurations
           (customer_id, xero_connection_id, organisation_role, enabled, next_sync_at)
         VALUES ($1,$2,'trust',true,now())
         ON CONFLICT (customer_id, xero_connection_id) DO UPDATE SET
           organisation_role='trust', enabled=true, next_sync_at=now(),
           revision=student_operations_xero_sync_configurations.revision+1, updated_at=now()`,
        [principal.tenantId, connectionId],
      );
    });
    return { connectionId, organisationRole: "trust" as const };
  }

  async enqueueWebhook(providerTenantId: string): Promise<boolean> {
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
    if (runId) setTimeout(() => { void this.process(row.customer_id, runId); }, 0);
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

  async invoices(tenantId: string, connectionId: string, input: unknown) {
    const parsed = InvoiceQuerySchema.safeParse(input);
    if (!parsed.success) throw new ConflictException("Invalid Xero invoice query.");
    const { page, limit, q, sort, direction } = parsed.data;
    const schema = runtimeConfig().schema;
    return this.database.tenantReadTransaction(tenantId, async (db) => {
      await assertConnection(db, schema, tenantId, connectionId);
      const params: unknown[] = [tenantId, connectionId];
      const search = q ? `AND (
        i.invoice_number ILIKE $3 OR i.invoice_reference ILIKE $3 OR c.legal_name ILIKE $3
        OR c.email ILIKE $3 OR c.contact_number ILIKE $3 OR c.account_number ILIKE $3
        OR i.concept ILIKE $3 OR i.advisor_name ILIKE $3 OR i.payment_track ILIKE $3
      )` : "";
      if (q) params.push(`%${q}%`);
      params.push(limit, (page - 1) * limit);
      const limitPosition = params.length - 1;
      const order = `${InvoiceSortExpressions[sort]} ${direction.toUpperCase()} NULLS LAST, i.xero_invoice_id ASC`;
      const result = await db.query<InvoiceRow>(
        `SELECT i.xero_invoice_id, i.xero_contact_id, i.invoice_number, i.invoice_reference,
                c.legal_name, c.email, c.contact_number, c.account_number,
                i.invoice_date::text, i.due_date::text, i.invoice_status, i.currency_code,
                i.total, i.amount_paid, i.amount_due, i.sent_to_contact, i.concept,
                i.advisor_name, i.college_name, i.payment_track,
                COALESCE(r.review_status, 'pending') AS review_status, r.student_id,
                count(*) OVER()::int AS total_count
           FROM ${schema}.student_operations_xero_invoices i
           JOIN ${schema}.student_operations_xero_contacts c
             ON c.customer_id=i.customer_id AND c.xero_connection_id=i.xero_connection_id
            AND c.xero_contact_id=i.xero_contact_id
           LEFT JOIN ${schema}.student_operations_xero_candidate_reviews r
             ON r.customer_id=i.customer_id AND r.xero_connection_id=i.xero_connection_id
            AND r.xero_contact_id=i.xero_contact_id
          WHERE i.customer_id=$1 AND i.xero_connection_id=$2
            AND i.invoice_type='ACCREC'
            ${search}
          ORDER BY ${order}
          LIMIT $${limitPosition} OFFSET $${limitPosition + 1}`,
        params,
      );
      const total = Number(result.rows[0]?.total_count ?? 0);
      return {
        invoices: result.rows.map(invoiceProjection),
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      };
    });
  }

  async invoice(tenantId: string, connectionId: string, invoiceId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(invoiceId)) throw new NotFoundException("Xero invoice not found.");
    const schema = runtimeConfig().schema;
    return this.database.tenantReadTransaction(tenantId, async (db) => {
      await assertConnection(db, schema, tenantId, connectionId);
      const result = await db.query<InvoiceRow>(
        `SELECT i.xero_invoice_id, i.xero_contact_id, i.invoice_number, i.invoice_reference,
                c.legal_name, c.email, c.contact_number, c.account_number,
                i.invoice_date::text, i.due_date::text, i.invoice_status, i.currency_code,
                i.total, i.amount_paid, i.amount_due, i.sent_to_contact, i.concept,
                i.advisor_name, i.college_name, i.payment_track, i.line_items,
                COALESCE(r.review_status, 'pending') AS review_status, r.student_id
           FROM ${schema}.student_operations_xero_invoices i
           JOIN ${schema}.student_operations_xero_contacts c
             ON c.customer_id=i.customer_id AND c.xero_connection_id=i.xero_connection_id
            AND c.xero_contact_id=i.xero_contact_id
           LEFT JOIN ${schema}.student_operations_xero_candidate_reviews r
             ON r.customer_id=i.customer_id AND r.xero_connection_id=i.xero_connection_id
            AND r.xero_contact_id=i.xero_contact_id
          WHERE i.customer_id=$1 AND i.xero_connection_id=$2 AND i.xero_invoice_id=$3
            AND i.invoice_type='ACCREC'`,
        [tenantId, connectionId, invoiceId],
      );
      const row = result.rows[0];
      if (!row) throw new NotFoundException("Xero invoice not found.");
      return { ...invoiceProjection(row), lineItems: Array.isArray(row.line_items) ? row.line_items : [] };
    });
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

  private async importInvoicePages(
    tenantId: string,
    run: SyncRunRow,
    owner: string,
    modifiedSince?: Date,
  ): Promise<number> {
    let invoiceCount = 0;
    for (let page = 1; page <= 10_000; page += 1) {
      const response = await this.xero.syncInvoicePage(tenantId, run.xero_connection_id, page, modifiedSince);
      invoiceCount += response.items.length;
      await this.persistInvoices(tenantId, run, owner, response.items, invoiceCount);
      if (page >= response.pageCount) return invoiceCount;
    }
    return invoiceCount;
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
               NULLIF(item->>'collegeName', '') AS college_name,
               NULLIF(item->>'paymentTrack', '') AS payment_track,
               COALESCE((item->>'sentToContact')::boolean, false) AS sent_to_contact,
               COALESCE(item->'lineItems', '[]'::jsonb) AS line_items,
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
              sent_to_contact, line_items,
              currency_code, total, amount_paid, amount_due, provider_updated_at, last_seen_sync_run_id)
           SELECT $1::uuid, $2::uuid, xero_invoice_id, xero_contact_id,
                  invoice_number, invoice_type, invoice_status, invoice_date, due_date,
                  invoice_reference, concept, advisor_name, college_name, payment_track,
                  sent_to_contact, line_items,
                  currency_code, total, amount_paid, amount_due, provider_updated_at, $3::uuid
             FROM source
           ON CONFLICT (customer_id, xero_connection_id, xero_invoice_id) DO UPDATE SET
             xero_contact_id=EXCLUDED.xero_contact_id, invoice_number=EXCLUDED.invoice_number,
             invoice_reference=EXCLUDED.invoice_reference, concept=EXCLUDED.concept,
             advisor_name=EXCLUDED.advisor_name, college_name=EXCLUDED.college_name,
             payment_track=EXCLUDED.payment_track, sent_to_contact=EXCLUDED.sent_to_contact,
             line_items=EXCLUDED.line_items,
             invoice_type=EXCLUDED.invoice_type, invoice_status=EXCLUDED.invoice_status,
             invoice_date=EXCLUDED.invoice_date, due_date=EXCLUDED.due_date,
             currency_code=EXCLUDED.currency_code, total=EXCLUDED.total,
             amount_paid=EXCLUDED.amount_paid, amount_due=EXCLUDED.amount_due,
             provider_updated_at=EXCLUDED.provider_updated_at,
             last_seen_sync_run_id=EXCLUDED.last_seen_sync_run_id, updated_at=now()`,
          [tenantId, run.xero_connection_id, run.sync_run_id, JSON.stringify(invoices)],
        );
      }
      await checkpointProgress(db, schema, tenantId, run.sync_run_id, owner, "invoice_count", processedCount);
    });
  }

  private complete(tenantId: string, run: SyncRunRow, owner: string, contacts: number, invoices: number) {
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (db) => {
      await assertLease(db, schema, tenantId, run.sync_run_id, owner);
      const count = await db.query<{ count: number }>(
        `SELECT count(DISTINCT i.xero_contact_id)::int AS count
           FROM ${schema}.student_operations_xero_invoices i
           LEFT JOIN ${schema}.student_operations_xero_candidate_reviews r
             ON r.customer_id=i.customer_id AND r.xero_connection_id=i.xero_connection_id
            AND r.xero_contact_id=i.xero_contact_id
          WHERE i.customer_id=$1 AND i.xero_connection_id=$2 AND i.invoice_type='ACCREC'
            AND i.invoice_status NOT IN ('VOIDED','DELETED')
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
      await db.query(
        `UPDATE ${schema}.student_operations_xero_sync_configurations
            SET last_successful_sync_at=now(),
                last_incremental_sync_at=CASE WHEN $3='incremental' THEN now() ELSE last_incremental_sync_at END,
                last_reconciliation_sync_at=CASE WHEN $3 IN ('initial','reconciliation') THEN now() ELSE last_reconciliation_sync_at END,
                invoice_metadata_version=CASE WHEN $3 IN ('initial','reconciliation') THEN 1 ELSE invoice_metadata_version END,
                invoice_detail_version=CASE WHEN $3 IN ('initial','reconciliation') THEN 1 ELSE invoice_detail_version END,
                last_error_code=NULL, next_sync_at=now()+incremental_interval,
                revision=revision+1, updated_at=now()
          WHERE customer_id=$1 AND xero_connection_id=$2`,
        [tenantId, run.xero_connection_id, run.mode],
      );
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
    xeroInvoiceId: row.xero_invoice_id,
    xeroContactId: row.xero_contact_id,
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
