import { describe, expect, it, jest } from "@jest/globals";
import type { DatabaseService } from "../../database/database.service.js";
import { buildStudentRegisterCohortSql, StudentOperationsRegisterService } from "./student-operations-register.service.js";
import type { StudentOperationsWorkspacePrincipal } from "./student-operations-workspace.service.js";

describe("Student Operations register query", () => {
  it("keeps the Xero advisor label separate from the tenant advisor directory", () => {
    const sql = buildStudentRegisterCohortSql("sophia_runtime");
    expect(sql).toContain("profile.advisor_id, directory.name AS advisor_name");
    expect(sql).toContain("AS advisor_xero_name");
    expect(sql).toContain("LEFT JOIN sophia_runtime.student_operations_advisor_directory directory");
    expect(sql).not.toContain("LEFT JOIN sophia_runtime.student_operations_advisor_roster ar");
  });

  it("projects the latest case workflow status without treating active pre-sale and payment cases as closed", () => {
    const sql = buildStudentRegisterCohortSql("sophia_runtime");
    expect(sql).toContain("WHEN d.lifecycle_status = 'completed' THEN 'closed'");
    expect(sql).toContain("bool_or(v.lifecycle_status NOT IN ('closed', 'completed', 'cancelled'))");
    expect(sql).toContain("v.current_stage = 'documents_requested'");
    expect(sql).toContain("d.lifecycle_status = 'collections' THEN 'In collections'");
  });

  it("projects case-opened or account-created Date and sorts the paginated register newest first", async () => {
    const queries: string[] = [];
    const db = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("LEFT JOIN LATERAL (\n            SELECT c.* FROM filtered c")) {
          return { rows: [{ user_id: "user-1", profile_id: null, student_reference: "STD-1",
            legal_name: "Example Student", email: "student@example.com", record_date: "2026-10-16",
            case_id: null, case_reference: null, current_stage: null, advisor_user_id: null,
            advisor_name: null, college_id: null, college_name: null, register_status: "not_started",
            attention_reason: null, case_count: 0, next_due_on: null, filtered_total: 1, total: 1 }] };
        }
        return { rows: [] };
      }),
    };
    const database = { tenantReadTransaction: async (_tenant: string, work: (client: typeof db) => Promise<unknown>) => work(db) } as unknown as DatabaseService;
    const principal: StudentOperationsWorkspacePrincipal = {
      tenantId: "11111111-1111-4111-8111-111111111111",
      externalCompanyId: "11111111-1111-4111-8111-111111111111",
      identityUserId: "11111111-1111-4111-8111-111111111111",
      entitlementId: "11111111-1111-4111-8111-111111111111",
      role: "chief_executive", authorizationRevision: 1,
    };
    const service = new StudentOperationsRegisterService(database);
    const result = await service.list(principal, {});
    expect(result.students[0]).toMatchObject({ recordDate: "2026-10-16" });
    expect(queries[0]).toContain("coalesce(d.opened_on, r.account_created_at::date)::text AS record_date");
    expect(queries[0]).toContain("ORDER BY c.record_date DESC NULLS LAST,\n                      lower(c.legal_name) ASC, c.user_id ASC");

    queries.length = 0;
    await service.list(principal, { sortBy: "date", sortDir: "asc", page: 2, limit: 25 });
    expect(queries[0]).toContain("ORDER BY c.record_date ASC NULLS LAST");
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("LIMIT $12 OFFSET $13"),
      expect.arrayContaining([25]));
  });
});
