import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import type { PoolClient } from "pg";
import { z } from "zod";
import { DatabaseService } from "../../database/database.service.js";
import type { StudentOperationsWorkspacePrincipal } from "./student-operations-workspace.service.js";

const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(
  (value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value,
);
const QuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(100).default(""),
  status: z.enum(["healthy", "action_required", "overdue", "no_vigente", "not_started"]).optional(),
  advisorId: z.string().uuid().optional(),
  collegeId: z.string().uuid().optional(),
  from: DateSchema.optional(),
  to: DateSchema.optional(),
  attentionThisWeek: z.enum(["true"]).optional(),
  sortBy: z.enum(["name", "studentId", "advisor", "college", "stage", "nextPayment", "status"])
    .default("name"),
  sortDir: z.enum(["asc", "desc"]).default("asc"),
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
  college: "lower(c.college_name)",
  stage: "c.current_stage",
  nextPayment: "c.next_due_on",
  status: "c.register_status",
};

type SummaryRow = {
  total: number; active_students: number; new_applications: number;
  action_required: number; no_vigente: number; attention_this_week: number;
  last_updated: string | Date | null;
};
type RegisterRow = {
  user_id: string; profile_id: string | null; student_reference: string;
  legal_name: string; email: string; case_id: string | null;
  case_reference: string | null; current_stage: string | null;
  advisor_user_id: string | null; advisor_name: string | null;
  college_id: string | null; college_name: string | null;
  register_status: string; attention_reason: string | null;
  next_due_on: string | null; next_amount: string | null;
  next_currency: string | null; next_case_id: string | null;
  case_count: number; account_created_at: string | Date;
};
type CaseLinkRow = { user_id: string; case_id: string; case_reference: string;
  lifecycle_status: string; opened_on: string };

@Injectable()
export class StudentOperationsRegisterService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async list(principal: StudentOperationsWorkspacePrincipal, input: unknown) {
    const parsed = QuerySchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("Invalid Students register filters.");
    const query = parsed.data;
    const schema = runtimeSchema();
    const advisorScope = principal.role === "advisor" ? principal.identityUserId : null;
    const params: unknown[] = [
      principal.tenantId, advisorScope, query.q ? `%${escapeLike(query.q)}%` : null,
      query.advisorId ?? null, query.collegeId ?? null, query.from ?? null, query.to ?? null,
    ];
    const cohortSql = buildStudentRegisterCohortSql(schema);
    return this.database.tenantReadTransaction(principal.tenantId, async (client) => {
      // The cohort is identical for totals and page rows. Status only narrows the table;
      // cards remain a breakdown of the same search/case/date cohort.
      const summary = await client.query<SummaryRow>(`${cohortSql}
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE has_current_case)::int AS active_students,
               count(*) FILTER (WHERE newest_case_opened_in_range)::int AS new_applications,
               count(*) FILTER (WHERE register_status IN ('action_required', 'overdue'))::int AS action_required,
               count(*) FILTER (WHERE register_status = 'no_vigente')::int AS no_vigente,
               count(*) FILTER (WHERE attention_this_week)::int AS attention_this_week,
               max(last_updated) AS last_updated
          FROM cohort c`, params);
      const filteredTotal = query.status || query.attentionThisWeek
        ? Number((await client.query<{ total: number }>(`${cohortSql}
          SELECT count(*)::int AS total FROM cohort c
           WHERE ($8::text IS NULL OR c.register_status = $8)
             AND ($9::boolean IS NOT TRUE OR c.attention_this_week)`,
        [...params, query.status ?? null, query.attentionThisWeek === "true"])).rows[0]?.total ?? 0)
        : Number(summary.rows[0]?.total ?? 0);
      const pageRows = await client.query<RegisterRow>(`${cohortSql}
        SELECT c.* FROM cohort c
         WHERE ($8::text IS NULL OR c.register_status = $8)
           AND ($9::boolean IS NOT TRUE OR c.attention_this_week)
         ORDER BY ${SORT_COLUMNS[query.sortBy]} ${query.sortDir.toUpperCase()} NULLS LAST,
                  lower(c.legal_name) ASC, c.user_id ASC
         LIMIT $10 OFFSET $11`,
      [...params, query.status ?? null, query.attentionThisWeek === "true",
        query.limit, (query.page - 1) * query.limit]);
      const cases = await loadCaseLinks(client, schema, principal, pageRows.rows);
      const caseMap = new Map<string, CaseLinkRow[]>();
      for (const row of cases) {
        const list = caseMap.get(row.user_id) ?? [];
        list.push(row);
        caseMap.set(row.user_id, list);
      }
      const options = await loadOptions(client, schema, principal);
      const fullPayment = principal.role !== "advisor";
      const totals = summary.rows[0];
      return {
        students: pageRows.rows.map((row) => ({
          userId: row.user_id, studentProfileId: row.profile_id,
          studentReference: row.student_reference, legalName: row.legal_name,
          email: row.email, caseId: row.case_id, caseReference: row.case_reference,
          currentStage: row.current_stage, advisorUserId: row.advisor_user_id,
          advisorName: row.advisor_name, collegeId: row.college_id,
          collegeName: row.college_name, status: row.register_status,
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
        page: query.page, limit: query.limit, total: filteredTotal,
        summary: {
          total: Number(totals?.total ?? 0),
          activeStudents: Number(totals?.active_students ?? 0),
          newApplications: Number(totals?.new_applications ?? 0),
          actionRequired: Number(totals?.action_required ?? 0),
          noVigente: Number(totals?.no_vigente ?? 0),
          attentionThisWeek: Number(totals?.attention_this_week ?? 0),
          lastUpdated: totals?.last_updated ?? null,
          trend: { available: false, reason: "Historical comparison is not yet available." },
        },
        options,
      };
    });
  }
}

export function buildStudentRegisterCohortSql(schema: string): string {
  return `WITH visible_cases AS MATERIALIZED (
      SELECT c.* FROM ${schema}.student_operations_cases c
       WHERE c.customer_id = $1
         AND ($2::text IS NULL OR EXISTS (
           SELECT 1 FROM ${schema}.student_operations_case_advisors ca
            WHERE ca.customer_id = c.customer_id AND ca.case_id = c.case_id
              AND ca.advisor_user_id::text = $2))
    ), eligible AS (
      SELECT r.* FROM ${schema}.student_operations_student_roster r
       WHERE r.customer_id = $1 AND r.account_status <> 'archived'
         AND ($3::text IS NULL OR r.legal_name ILIKE $3 ESCAPE '\\'
              OR r.student_reference ILIKE $3 ESCAPE '\\'
              OR r.email ILIKE $3 ESCAPE '\\')
         AND ($2::text IS NULL OR EXISTS (
           SELECT 1 FROM visible_cases vc WHERE vc.student_id = r.profile_id))
    ), cohort AS (
      SELECT r.user_id, r.profile_id, r.student_reference, r.legal_name, r.email,
             r.account_created_at, greatest(r.account_updated_at, coalesce(cs.last_case_update, r.account_updated_at)) AS last_updated,
             d.case_id, d.case_reference, d.current_stage, ad.advisor_user_id,
             ar.display_name AS advisor_name, cl.college_id, cl.college_name,
             coalesce(cs.case_count, 0)::int AS case_count,
             coalesce(cs.has_current_case, false) AS has_current_case,
             coalesce(cs.newest_case_opened_in_range, false) AS newest_case_opened_in_range,
             pay.due_on::text AS next_due_on, pay.amount::text AS next_amount,
             pay.currency_code AS next_currency, pay.case_id AS next_case_id,
             CASE WHEN pay.due_on < CURRENT_DATE THEN 'overdue'
                  WHEN coalesce(cs.has_on_hold, false) THEN 'action_required'
                  WHEN coalesce(cs.has_current_case, false) THEN 'healthy'
                  WHEN coalesce(cs.case_count, 0) > 0 THEN 'no_vigente'
                  ELSE 'not_started' END AS register_status,
             CASE WHEN pay.due_on < CURRENT_DATE THEN 'Payment overdue'
                  WHEN coalesce(cs.has_on_hold, false) THEN 'Case on hold'
                  ELSE NULL END AS attention_reason,
             (pay.due_on < CURRENT_DATE + 7 OR coalesce(cs.has_on_hold, false)) AS attention_this_week
        FROM eligible r
        LEFT JOIN LATERAL (
          SELECT count(*)::int AS case_count,
                 bool_or(v.lifecycle_status IN ('open', 'on_hold')) AS has_current_case,
                 bool_or(v.lifecycle_status = 'on_hold') AS has_on_hold,
                 bool_or(v.opened_on BETWEEN coalesce($6::date, '-infinity'::date)
                        AND coalesce($7::date, 'infinity'::date)) AS newest_case_opened_in_range,
                 max(v.updated_at) AS last_case_update
            FROM visible_cases v WHERE v.student_id = r.profile_id
        ) cs ON true
        LEFT JOIN LATERAL (
          SELECT v.* FROM visible_cases v
           WHERE v.student_id = r.profile_id
             AND ($4::uuid IS NULL OR EXISTS (
               SELECT 1 FROM ${schema}.student_operations_case_advisors ca
                WHERE ca.customer_id = v.customer_id AND ca.case_id = v.case_id
                  AND ca.advisor_user_id = $4))
             AND ($5::uuid IS NULL OR EXISTS (
               SELECT 1 FROM ${schema}.student_operations_case_colleges cc
                WHERE cc.customer_id = v.customer_id AND cc.case_id = v.case_id
                  AND cc.college_id = $5))
             AND ($6::date IS NULL OR v.opened_on BETWEEN $6::date AND $7::date)
           ORDER BY (v.lifecycle_status = 'open') DESC,
                    v.opened_on DESC, v.case_id DESC LIMIT 1
        ) d ON true
        LEFT JOIN LATERAL (
          SELECT ca.advisor_user_id FROM ${schema}.student_operations_case_advisors ca
           WHERE ca.customer_id = $1 AND ca.case_id = d.case_id
           ORDER BY ca.is_primary DESC, ca.assigned_at ASC, ca.advisor_user_id ASC LIMIT 1
        ) ad ON true
        LEFT JOIN ${schema}.student_operations_advisor_roster ar
          ON ar.customer_id = $1 AND ar.user_id = ad.advisor_user_id
        LEFT JOIN LATERAL (
          SELECT cc.college_id, col.college_name
            FROM ${schema}.student_operations_case_colleges cc
            JOIN ${schema}.student_operations_colleges col
              ON col.customer_id = cc.customer_id AND col.college_id = cc.college_id
           WHERE cc.customer_id = $1 AND cc.case_id = d.case_id
           ORDER BY cc.is_primary DESC, cc.created_at ASC, cc.college_id ASC LIMIT 1
        ) cl ON true
        LEFT JOIN LATERAL (
          SELECT ps.case_id, ps.due_on, ps.amount, ps.currency_code
            FROM ${schema}.student_operations_case_payment_schedule ps
            JOIN visible_cases vc ON vc.case_id = ps.case_id
           WHERE vc.student_id = r.profile_id AND vc.lifecycle_status = 'open'
             AND ps.customer_id = $1 AND ps.status IN ('pending', 'partially_paid')
           ORDER BY ps.due_on ASC, ps.payment_schedule_id ASC LIMIT 1
        ) pay ON true
       WHERE d.case_id IS NOT NULL
          OR ($4::uuid IS NULL AND $5::uuid IS NULL
              AND cs.case_count = 0
              AND ($6::date IS NULL OR r.account_created_at::date BETWEEN $6::date AND $7::date))
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
             AND ca.advisor_user_id::text = $3))
      ORDER BY c.opened_on DESC, c.case_id DESC`,
    [principal.tenantId, profileIds,
      principal.role === "advisor" ? principal.identityUserId : null],
  );
  return result.rows;
}

async function loadOptions(client: PoolClient, schema: string,
  principal: StudentOperationsWorkspacePrincipal) {
  const advisorScope = principal.role === "advisor" ? principal.identityUserId : null;
  const [advisors, colleges] = await Promise.all([
    client.query<{ user_id: string; display_name: string }>(
      `SELECT DISTINCT ar.user_id, ar.display_name
         FROM ${schema}.student_operations_advisor_roster ar
         JOIN ${schema}.student_operations_case_advisors ca
           ON ca.customer_id = ar.customer_id AND ca.advisor_user_id = ar.user_id
         JOIN ${schema}.student_operations_cases c
           ON c.customer_id = ca.customer_id AND c.case_id = ca.case_id
         JOIN ${schema}.student_operations_student_user_links link
           ON link.customer_id = c.customer_id AND link.student_id = c.student_id
         JOIN ${schema}.student_operations_student_roster roster
           ON roster.customer_id = link.customer_id AND roster.user_id = link.user_id
        WHERE ar.customer_id = $1
          AND roster.account_status <> 'archived'
          AND ($2::text IS NULL OR EXISTS (
            SELECT 1 FROM ${schema}.student_operations_case_advisors mine
             WHERE mine.customer_id = c.customer_id AND mine.case_id = c.case_id
               AND mine.advisor_user_id::text = $2))
        ORDER BY ar.display_name, ar.user_id`,
      [principal.tenantId, advisorScope],
    ),
    client.query<{ college_id: string; college_name: string }>(
      `SELECT DISTINCT col.college_id, col.college_name
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
        ORDER BY col.college_name, col.college_id`,
      [principal.tenantId, advisorScope],
    ),
  ]);
  return {
    advisors: advisors.rows.map((row) => ({ userId: row.user_id, name: row.display_name })),
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
