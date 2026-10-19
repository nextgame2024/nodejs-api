import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { performance } from "node:perf_hooks";
import type { PoolClient } from "pg";
import { z } from "zod";
import { DatabaseService } from "../../database/database.service.js";
import type { StudentOperationsWorkspacePrincipal } from "./student-operations-workspace.service.js";
import { addDatabaseTimings, elapsedMs, logStudentOperationsTiming } from "./student-operations-timing.js";

const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(
  (value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value,
);
const QuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(100).default(""),
  status: z.enum(["pre_sale", "on_hold", "in_progress", "payment_overdue", "collections", "payment_done", "closed", "cancelled", "not_started"]).optional(),
  advisorId: z.string().uuid().optional(),
  collegeId: z.string().uuid().optional(),
  advisorName: z.string().trim().min(1).max(200).optional(),
  collegeName: z.string().trim().min(1).max(500).optional(),
  from: DateSchema.optional(),
  to: DateSchema.optional(),
  attentionThisWeek: z.enum(["true"]).optional(),
  sortBy: z.enum(["name", "studentId", "advisor", "advisorXero", "college", "date", "stage", "nextPayment", "status"])
    .default("date"),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
}).strict().superRefine((value, context) => {
  if (Boolean(value.from) !== Boolean(value.to)) {
    context.addIssue({ code: "custom", message: "Select both dates.", path: ["from"] });
  } else if (value.from && value.to && value.from > value.to) {
    context.addIssue({ code: "custom", message: "The start date must not be after the end date.", path: ["to"] });
  }
});
type RegisterQuery = z.infer<typeof QuerySchema>;

const SORT_COLUMNS: Record<RegisterQuery["sortBy"], string> = {
  name: "lower(c.legal_name)",
  studentId: "c.student_reference",
  advisor: "lower(c.advisor_name)",
  advisorXero: "lower(c.advisor_xero_name)",
  college: "lower(c.college_name)",
  date: "c.record_date",
  stage: "c.current_stage",
  nextPayment: "c.next_due_on",
  status: "c.register_status",
};

type SummaryRow = {
  total: number; active_students: number; new_applications: number;
  action_required: number; no_vigente: number; attention_this_week: number;
  summary_last_updated: string | Date | null;
};
type RegisterRow = {
  user_id: string; profile_id: string | null; student_reference: string;
  legal_name: string; email: string; case_id: string | null;
  case_reference: string | null; current_stage: string | null;
  advisor_user_id: string | null; advisor_id: string | null;
  advisor_name: string | null; advisor_xero_name: string | null;
  college_id: string | null; college_name: string | null;
  record_date: string;
  register_status: string; attention_reason: string | null;
  next_due_on: string | null; next_amount: string | null;
  next_currency: string | null; next_case_id: string | null;
  case_count: number; account_created_at: string | Date;
};
type RegisterResultRow = RegisterRow & SummaryRow & { filtered_total: number };
type CaseLinkRow = { user_id: string; case_id: string; case_reference: string;
  lifecycle_status: string; opened_on: string };

@Injectable()
export class StudentOperationsRegisterService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async list(principal: StudentOperationsWorkspacePrincipal, input: unknown, correlationId?: string) {
    const parsed = QuerySchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("Invalid Students register filters.");
    const query = parsed.data;
    const schema = runtimeSchema();
    const advisorScope = principal.role === "advisor" ? principal.identityUserId : null;
    const params: unknown[] = [
      principal.tenantId, advisorScope, query.q ? `%${escapeLike(query.q)}%` : null,
      query.advisorId ?? null, query.collegeId ?? null, query.from ?? null, query.to ?? null,
      query.advisorName ?? null, query.collegeName ?? null,
    ];
    const cohortSql = buildStudentRegisterCohortSql(schema);
    const startedAt = performance.now();
    const durations: Record<string, number | undefined> = {};
    let outcome: "ok" | "error" = "error";
    try {
      const result = await this.database.tenantReadTransaction(principal.tenantId, async (client) => {
      durations.transactionSetupMs = elapsedMs(startedAt);
      // Materialize the roster/case/Xero cohort once, then derive both cards and
      // the filtered page from that snapshot. Pagination never fetches all rows.
      const registerStartedAt = performance.now();
      const register = await client.query<RegisterResultRow>(`${cohortSql},
        filtered AS MATERIALIZED (
          SELECT c.* FROM cohort c
           WHERE ($10::text IS NULL OR c.register_status = $10)
             AND ($11::boolean IS NOT TRUE OR c.attention_this_week)
        ), summary AS (
          SELECT count(*)::int AS total,
                 count(*) FILTER (WHERE has_current_case)::int AS active_students,
                 count(*) FILTER (WHERE newest_case_opened_in_range)::int AS new_applications,
                 count(*) FILTER (WHERE attention_reason IS NOT NULL)::int AS action_required,
                 count(*) FILTER (WHERE case_count > 0 AND NOT has_current_case)::int AS no_vigente,
                 count(*) FILTER (WHERE attention_this_week)::int AS attention_this_week,
                 max(last_updated) AS summary_last_updated
            FROM cohort c
        )
        SELECT summary.*, (SELECT count(*)::int FROM filtered) AS filtered_total, page.*
          FROM summary
          LEFT JOIN LATERAL (
            SELECT c.* FROM filtered c
             ORDER BY ${SORT_COLUMNS[query.sortBy]} ${query.sortDir.toUpperCase()} NULLS LAST,
                      lower(c.legal_name) ASC, c.user_id ASC
             LIMIT $12 OFFSET $13
          ) page ON true`,
      [...params, query.status ?? null, query.attentionThisWeek === "true",
        query.limit, (query.page - 1) * query.limit]);
      durations.registerQueryMs = elapsedMs(registerStartedAt);
      const pageRows = register.rows.filter((row) => Boolean(row.user_id));
      const caseLinksStartedAt = performance.now();
      const cases = await loadCaseLinks(client, schema, principal, pageRows);
      durations.caseLinksMs = elapsedMs(caseLinksStartedAt);
      const caseMap = new Map<string, CaseLinkRow[]>();
      for (const row of cases) {
        const list = caseMap.get(row.user_id) ?? [];
        list.push(row);
        caseMap.set(row.user_id, list);
      }
      const optionsStartedAt = performance.now();
      const options = await loadOptions(client, schema, principal);
      durations.optionsMs = elapsedMs(optionsStartedAt);
      const fullPayment = principal.role !== "advisor";
      const totals = register.rows[0];
      return {
        students: pageRows.map((row) => ({
          userId: row.user_id, studentProfileId: row.profile_id,
          studentReference: row.student_reference, legalName: row.legal_name,
          email: row.email, caseId: row.case_id, caseReference: row.case_reference,
          currentStage: row.current_stage, advisorUserId: row.advisor_user_id,
          advisorId: row.advisor_id, advisorName: row.advisor_name,
          advisorXeroName: row.advisor_xero_name, collegeId: row.college_id,
          collegeName: row.college_name, recordDate: row.record_date,
          status: row.register_status,
          attentionReason: row.attention_reason, caseCount: Number(row.case_count),
          cases: (caseMap.get(row.user_id) ?? []).map((c) => ({
            caseId: c.case_id, caseReference: c.case_reference,
            lifecycleStatus: c.lifecycle_status, openedOn: c.opened_on,
          })),
          nextPayment: row.next_due_on ? {
            caseId: row.next_case_id, dueOn: row.next_due_on,
            ...(fullPayment ? { amount: row.next_amount, currency: row.next_currency } : {}),
          } : null,
        })),
        page: query.page, limit: query.limit, total: Number(totals?.filtered_total ?? 0),
        summary: {
          total: Number(totals?.total ?? 0),
          activeStudents: Number(totals?.active_students ?? 0),
          newApplications: Number(totals?.new_applications ?? 0),
          actionRequired: Number(totals?.action_required ?? 0),
          noVigente: Number(totals?.no_vigente ?? 0),
          attentionThisWeek: Number(totals?.attention_this_week ?? 0),
          lastUpdated: totals?.summary_last_updated ?? null,
          trend: { available: false, reason: "Historical comparison is not yet available." },
        },
        options,
      };
      }, (timings) => addDatabaseTimings(durations, timings));
      outcome = "ok";
      return result;
    } finally {
      logStudentOperationsTiming("student-register", correlationId, outcome, {
        ...durations, totalMs: elapsedMs(startedAt),
      });
    }
  }
}

export function buildStudentRegisterCohortSql(schema: string): string {
  return `WITH visible_cases AS NOT MATERIALIZED (
      SELECT c.* FROM ${schema}.student_operations_cases c
       WHERE c.customer_id = $1
         AND ($2::text IS NULL OR EXISTS (
           SELECT 1 FROM ${schema}.student_operations_case_advisors ca
            WHERE ca.customer_id = c.customer_id AND ca.case_id = c.case_id
              AND ca.advisor_user_id::text = $2 AND ca.is_primary))
    ), eligible AS (
      SELECT r.* FROM ${schema}.student_operations_student_roster r
       WHERE r.customer_id = $1 AND r.account_status <> 'archived'
         AND ($2::text IS NULL OR EXISTS (
           SELECT 1 FROM visible_cases vc WHERE vc.student_id = r.profile_id))
    ), cohort AS MATERIALIZED (
      SELECT r.user_id, r.profile_id, r.student_reference, r.legal_name, r.email,
             r.account_created_at, greatest(r.account_updated_at, coalesce(cs.last_case_update, r.account_updated_at)) AS last_updated,
             coalesce(d.opened_on, r.account_created_at::date)::text AS record_date,
             d.case_id, d.case_reference, d.current_stage, ad.advisor_user_id,
             profile.advisor_id, directory.name AS advisor_name,
             latest_advisor.advisor_name AS advisor_xero_name,
             cl.college_id,
             coalesce(cl.college_name, ci.college_name, xi.college_name) AS college_name,
             coalesce(cs.case_count, 0)::int AS case_count,
             coalesce(cs.has_current_case, false) AS has_current_case,
             coalesce(cs.newest_case_opened_in_range, false) AS newest_case_opened_in_range,
             coalesce(pay.due_on, invoice_pay.due_date)::text AS next_due_on,
             coalesce(pay.amount, invoice_pay.amount_due)::text AS next_amount,
             coalesce(pay.currency_code, invoice_pay.currency_code) AS next_currency,
             coalesce(pay.case_id, invoice_pay.case_id) AS next_case_id,
             CASE WHEN d.lifecycle_status = 'open' THEN 'in_progress'
                  WHEN d.lifecycle_status = 'completed' THEN 'closed'
                  WHEN d.lifecycle_status IS NOT NULL THEN d.lifecycle_status
                  ELSE 'not_started' END AS register_status,
             CASE WHEN coalesce(pay.due_on, invoice_pay.due_date) < CURRENT_DATE THEN 'Payment overdue'
                  WHEN d.lifecycle_status = 'payment_overdue' THEN 'Payment overdue'
                  WHEN d.lifecycle_status = 'collections' THEN 'In collections'
                  WHEN d.lifecycle_status = 'on_hold' THEN 'Case on hold'
                  ELSE NULL END AS attention_reason,
             (coalesce(pay.due_on, invoice_pay.due_date) < CURRENT_DATE + 7 OR d.lifecycle_status IN ('on_hold', 'payment_overdue', 'collections')) AS attention_this_week
        FROM eligible r
        LEFT JOIN ${schema}.student_operations_students profile
          ON profile.customer_id = $1 AND profile.student_id = r.profile_id
        LEFT JOIN ${schema}.student_operations_advisor_directory directory
          ON directory.customer_id = profile.customer_id AND directory.advisor_id = profile.advisor_id
        LEFT JOIN ${schema}.student_operations_latest_invoice_advisors latest_advisor
          ON latest_advisor.customer_id = profile.customer_id AND latest_advisor.profile_id = profile.student_id
        LEFT JOIN LATERAL (
          SELECT count(*)::int AS case_count,
                 bool_or(v.lifecycle_status NOT IN ('closed', 'completed', 'cancelled')) AS has_current_case,
                 bool_or(v.current_stage = 'documents_requested' AND v.opened_on BETWEEN coalesce($6::date, '-infinity'::date)
                        AND coalesce($7::date, 'infinity'::date)) AS newest_case_opened_in_range,
                 max(v.updated_at) AS last_case_update
            FROM visible_cases v WHERE v.student_id = r.profile_id
        ) cs ON true
        LEFT JOIN LATERAL (
          SELECT v.* FROM visible_cases v
           WHERE v.student_id = r.profile_id
           ORDER BY v.created_at DESC, v.case_id DESC LIMIT 1
        ) d ON true
        LEFT JOIN LATERAL (
          SELECT ca.advisor_user_id FROM ${schema}.student_operations_case_advisors ca
           WHERE ca.customer_id = $1 AND ca.case_id = d.case_id
           ORDER BY ca.is_primary DESC, ca.assigned_at ASC, ca.advisor_user_id ASC LIMIT 1
        ) ad ON true
        LEFT JOIN LATERAL (
          SELECT cc.college_id, col.college_name
            FROM ${schema}.student_operations_case_colleges cc
            JOIN ${schema}.student_operations_colleges col
              ON col.customer_id = cc.customer_id AND col.college_id = cc.college_id
           WHERE cc.customer_id = $1 AND cc.case_id = d.case_id
           ORDER BY cc.is_primary DESC, cc.created_at ASC, cc.college_id ASC LIMIT 1
        ) cl ON true
        LEFT JOIN LATERAL (
          SELECT nullif(btrim(i.advisor_name), '') AS advisor_name,
                 coalesce(nullif(btrim(i.invoice_reference), ''),
                          nullif(btrim(i.college_name), '')) AS college_name
            FROM ${schema}.student_operations_case_invoice_links link
            JOIN ${schema}.student_operations_xero_invoices i
              ON i.customer_id = link.customer_id
             AND i.xero_connection_id = link.xero_connection_id
             AND i.xero_invoice_id = link.xero_invoice_id
           WHERE link.customer_id = $1 AND link.case_id = d.case_id
             AND i.invoice_status NOT IN ('DELETED', 'VOIDED')
             AND (i.advisor_name IS NOT NULL OR i.invoice_reference IS NOT NULL
                  OR i.college_name IS NOT NULL)
           ORDER BY i.invoice_date DESC NULLS LAST, i.xero_invoice_id DESC LIMIT 1
        ) ci ON d.case_id IS NOT NULL
        LEFT JOIN LATERAL (
          SELECT nullif(btrim(i.advisor_name), '') AS advisor_name,
                 coalesce(nullif(btrim(i.invoice_reference), ''),
                          nullif(btrim(i.college_name), '')) AS college_name
            FROM ${schema}.student_operations_xero_invoices i
           WHERE i.customer_id = $1 AND i.student_id = r.student_reference
             AND cs.case_count = 0
             AND i.invoice_status NOT IN ('DELETED', 'VOIDED')
             AND (i.advisor_name IS NOT NULL OR i.invoice_reference IS NOT NULL
                  OR i.college_name IS NOT NULL)
           ORDER BY i.invoice_date DESC NULLS LAST, i.xero_invoice_id DESC LIMIT 1
        ) xi ON cs.case_count = 0
        LEFT JOIN LATERAL (
          SELECT ps.case_id, ps.due_on, ps.amount, ps.currency_code
            FROM ${schema}.student_operations_case_payment_schedule ps
           WHERE ps.customer_id = $1 AND ps.case_id = d.case_id
             AND d.lifecycle_status NOT IN ('closed', 'completed', 'cancelled') AND ps.status IN ('pending', 'partially_paid')
           ORDER BY ps.due_on ASC, ps.payment_schedule_id ASC LIMIT 1
        ) pay ON true
        LEFT JOIN LATERAL (
          SELECT d.case_id, i.due_date, i.amount_due, i.currency_code
            FROM ${schema}.student_operations_case_invoice_links link
            JOIN ${schema}.student_operations_xero_invoices i
              ON i.customer_id = link.customer_id
             AND i.xero_connection_id = link.xero_connection_id
             AND i.xero_invoice_id = link.xero_invoice_id
           WHERE link.customer_id = $1 AND link.case_id = d.case_id
             AND d.lifecycle_status NOT IN ('closed', 'completed', 'cancelled') AND pay.case_id IS NULL
             AND i.invoice_type = 'ACCREC'
             AND i.invoice_status IN ('DRAFT', 'SUBMITTED', 'AUTHORISED', 'PAID')
             AND i.amount_due > 0 AND i.due_date IS NOT NULL
           ORDER BY i.due_date ASC, i.xero_invoice_id ASC LIMIT 1
        ) invoice_pay ON true
       WHERE (d.case_id IS NOT NULL
          OR ($5::uuid IS NULL AND cs.case_count = 0
              AND ($6::date IS NULL OR r.account_created_at::date BETWEEN $6::date AND $7::date)
              AND ($9::text IS NULL OR lower(xi.college_name) = lower($9))))
         AND ($4::uuid IS NULL OR profile.advisor_id = $4)
         AND ($5::uuid IS NULL OR cl.college_id = $5)
         AND ($6::date IS NULL OR cs.case_count = 0 OR d.opened_on BETWEEN $6::date AND $7::date)
         AND ($8::text IS NULL OR lower(directory.name) = lower($8))
         AND ($9::text IS NULL OR lower(coalesce(cl.college_name, ci.college_name, xi.college_name)) = lower($9))
         AND ($3::text IS NULL OR r.legal_name ILIKE $3 ESCAPE '\\'
              OR r.student_reference ILIKE $3 ESCAPE '\\'
              OR r.email ILIKE $3 ESCAPE '\\'
              OR coalesce(cl.college_name, ci.college_name, xi.college_name)
                 ILIKE $3 ESCAPE '\\')
    )`;
}

async function loadCaseLinks(
  client: PoolClient, schema: string, principal: StudentOperationsWorkspacePrincipal,
  page: RegisterRow[],
): Promise<CaseLinkRow[]> {
  const profileIds = page.map((row) => row.profile_id).filter((id): id is string => Boolean(id));
  if (!profileIds.length) return [];
  const result = await client.query<CaseLinkRow>(
    `SELECT l.user_id, c.case_id, c.case_reference, c.lifecycle_status,
            c.opened_on::text AS opened_on
       FROM ${schema}.student_operations_cases c
       JOIN ${schema}.student_operations_student_user_links l
         ON l.customer_id = c.customer_id AND l.student_id = c.student_id
      WHERE c.customer_id = $1 AND c.student_id = ANY($2::uuid[])
        AND ($3::text IS NULL OR EXISTS (
          SELECT 1 FROM ${schema}.student_operations_case_advisors ca
           WHERE ca.customer_id = c.customer_id AND ca.case_id = c.case_id
             AND ca.advisor_user_id::text = $3 AND ca.is_primary))
      ORDER BY c.created_at DESC, c.case_id DESC`,
    [principal.tenantId, profileIds,
      principal.role === "advisor" ? principal.identityUserId : null],
  );
  return result.rows;
}

async function loadOptions(client: PoolClient, schema: string,
  principal: StudentOperationsWorkspacePrincipal) {
  const advisorScope = principal.role === "advisor" ? principal.identityUserId : null;
  const [advisors, colleges] = await Promise.all([
    client.query<{ advisor_id: string; code: string; name: string }>(
      `SELECT directory.advisor_id, directory.code, directory.name
         FROM ${schema}.student_operations_advisor_directory directory
        WHERE directory.customer_id = $1 AND directory.status = 'active'
          AND ($2::text IS NULL OR EXISTS (
            SELECT 1 FROM ${schema}.student_operations_students student
            JOIN ${schema}.student_operations_cases c
              ON c.customer_id = student.customer_id AND c.student_id = student.student_id
            JOIN ${schema}.student_operations_case_advisors mine
              ON mine.customer_id = c.customer_id AND mine.case_id = c.case_id
             AND mine.is_primary AND mine.advisor_user_id::text = $2
            WHERE student.customer_id = directory.customer_id
              AND student.advisor_id = directory.advisor_id))
        ORDER BY lower(directory.name), directory.advisor_id`,
      [principal.tenantId, advisorScope],
    ),
    client.query<{ college_id: string | null; college_name: string }>(
      `SELECT min(source.college_id) AS college_id, source.college_name
         FROM (
        SELECT col.college_id::text AS college_id, col.college_name
         FROM ${schema}.student_operations_colleges col
         JOIN ${schema}.student_operations_case_colleges cc
           ON cc.customer_id = col.customer_id AND cc.college_id = col.college_id
         JOIN ${schema}.student_operations_cases c
           ON c.customer_id = cc.customer_id AND c.case_id = cc.case_id
         JOIN ${schema}.student_operations_student_user_links link
           ON link.customer_id = c.customer_id AND link.student_id = c.student_id
         JOIN ${schema}.student_operations_student_roster roster
           ON roster.customer_id = link.customer_id AND roster.user_id = link.user_id
        WHERE col.customer_id = $1
          AND roster.account_status <> 'archived'
          AND ($2::text IS NULL OR EXISTS (
            SELECT 1 FROM ${schema}.student_operations_case_advisors mine
             WHERE mine.customer_id = c.customer_id AND mine.case_id = c.case_id
               AND mine.advisor_user_id::text = $2))
        UNION ALL
        SELECT NULL::text AS college_id,
               coalesce(nullif(btrim(i.invoice_reference), ''),
                        nullif(btrim(i.college_name), '')) AS college_name
          FROM ${schema}.student_operations_xero_invoices i
          JOIN ${schema}.student_operations_student_roster roster
            ON roster.customer_id = i.customer_id AND roster.student_reference = i.student_id
         WHERE i.customer_id = $1 AND $2::text IS NULL
           AND roster.account_status <> 'archived'
           AND i.invoice_status NOT IN ('DELETED', 'VOIDED')
           AND coalesce(nullif(btrim(i.invoice_reference), ''),
                        nullif(btrim(i.college_name), '')) IS NOT NULL
         ) source
        GROUP BY source.college_name
        ORDER BY source.college_name`,
      [principal.tenantId, advisorScope],
    ),
  ]);
  return {
    advisors: advisors.rows.map((row) => ({ advisorId: row.advisor_id, code: row.code, name: row.name })),
    colleges: colleges.rows.map((row) => ({ collegeId: row.college_id, name: row.college_name })),
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function runtimeSchema(): string {
  const schema = process.env.SOPHIA_RUNTIME_DB_SCHEMA || "sophia_runtime";
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error("Invalid runtime schema.");
  return schema;
}
