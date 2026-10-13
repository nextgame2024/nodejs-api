import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import { runStudentProfileBackfill } from "../../scripts/backfill-student-profiles.js";
import { buildStudentRegisterCohortSql, StudentOperationsRegisterService } from "../business-packs/student-operations/student-operations-register.service.js";
import type { StudentOperationsWorkspacePrincipal } from "../business-packs/student-operations/student-operations-workspace.service.js";

const url = process.env.LOCAL_STUDENT_CASE_TEST_DATABASE_URL;
if (url && !["localhost", "127.0.0.1"].includes(new URL(url).hostname)) {
  throw new Error("Student case integration tests require a disposable local database");
}
const suite = url ? describe : describe.skip;
const tenantA = "11111111-1111-4111-8111-111111111111";
const tenantB = "22222222-2222-4222-8222-222222222222";
const companyA = "33333333-3333-4333-8333-333333333333";
const companyB = "44444444-4444-4444-8444-444444444444";
const user1 = "00000000-0000-4000-8000-000000000001";
const user2 = "00000000-0000-4000-8000-000000000002";
const user3 = "00000000-0000-4000-8000-000000000003";
const user4 = "00000000-0000-4000-8000-000000000004";
const user5 = "00000000-0000-4000-8000-000000000005";
const advisorA = "00000000-0000-4000-8000-000000000011";
const advisorB = "00000000-0000-4000-8000-000000000012";
const advisorOther = "00000000-0000-4000-8000-000000000013";
const legacy1 = "99999999-9999-4999-8999-999999999991";
const legacy3 = "99999999-9999-4999-8999-999999999993";

suite("Student case foundation on disposable PostgreSQL", () => {
  const pool = new Pool({ connectionString: url!, max: 3 });

  beforeAll(async () => {
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sophia_runtime_app') THEN
          CREATE ROLE sophia_runtime_app NOLOGIN;
        END IF;
      END $$;
      CREATE SCHEMA sophia_runtime;
      GRANT USAGE ON SCHEMA sophia_runtime TO sophia_runtime_app;
      CREATE TABLE sophia_runtime.customers(
        customer_id uuid PRIMARY KEY, external_company_id text, status text);
      CREATE TABLE sophia_runtime.business_pack_entitlements(
        customer_id uuid NOT NULL, identity_user_id text NOT NULL,
        pack_id text NOT NULL, status text NOT NULL, role_key text NOT NULL);
      CREATE TABLE public.bm_company(company_id uuid PRIMARY KEY, workspace_profile text);
      CREATE TABLE public.users(
        id uuid PRIMARY KEY, company_id uuid NOT NULL, student_id text,
        name text, email text, password text, type text, status text,
        createdat timestamptz NOT NULL DEFAULT now(),
        updatedat timestamptz NOT NULL DEFAULT now());
      CREATE TABLE sophia_runtime.student_operations_students(
        student_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id uuid NOT NULL REFERENCES sophia_runtime.customers(customer_id),
        student_reference text NOT NULL,
        legal_name text NOT NULL, email text NOT NULL,
        current_stage text NOT NULL DEFAULT 'new_application',
        status text NOT NULL DEFAULT 'active',
        UNIQUE (student_id, customer_id),
        UNIQUE (customer_id, student_reference));
      ALTER TABLE sophia_runtime.student_operations_students ENABLE ROW LEVEL SECURITY;
      ALTER TABLE sophia_runtime.student_operations_students FORCE ROW LEVEL SECURITY;
      CREATE POLICY profiles_tenant ON sophia_runtime.student_operations_students
        USING (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid)
        WITH CHECK (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid);
      GRANT SELECT, INSERT, UPDATE ON sophia_runtime.student_operations_students
        TO sophia_runtime_app;
      CREATE TABLE sophia_runtime.student_operations_xero_invoices(
        customer_id uuid NOT NULL, xero_connection_id uuid NOT NULL,
        xero_invoice_id uuid NOT NULL, student_id text,
        invoice_status text NOT NULL,
        PRIMARY KEY(customer_id, xero_connection_id, xero_invoice_id));
      CREATE FUNCTION sophia_runtime.protect_student_operations_student_audit_event()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION 'append-only';
      END $$;
    `);
    const sql = await readFile(new URL("./migrations/069_student_case_foundation.sql", import.meta.url), "utf8");
    await pool.query(sql.replaceAll("__SOPHIA_RUNTIME_SCHEMA__", "sophia_runtime"));
    const registerSql = await readFile(new URL("./migrations/070_student_register_advisor_projection.sql", import.meta.url), "utf8");
    await pool.query(registerSql.replaceAll("__SOPHIA_RUNTIME_SCHEMA__", "sophia_runtime"));
    await pool.query(
      `INSERT INTO sophia_runtime.customers VALUES
        ($1,$2,'active'),($3,$4,'active')`,
      [tenantA, companyA, tenantB, companyB],
    );
    await pool.query(
      `INSERT INTO public.bm_company VALUES
        ($1,'student_operations'),($2,'student_operations')`,
      [companyA, companyB],
    );
    for (const [id, company, sid, name, email, type, status] of [
      [user1, companyA, "STD-1", "Joselin Nicole Aburto Moya", "joselin@example.test", "student", "active"],
      [user2, companyA, "STD-2", "Fabian Andres Lopez Patino", "fabian@example.test", "student", "active"],
      [user3, companyA, "STD-3", "Older Student", "older@example.test", "student", "active"],
      [user4, companyA, "STD-4", "Archived Student", "archived@example.test", "student", "archived"],
      [user5, companyB, "STD-5", "Another Tenant", "other@example.test", "student", "active"],
      [advisorA, companyA, null, "Advisor A", "a@example.test", "advisor", "active"],
      [advisorB, companyA, null, "Advisor B", "b@example.test", "advisor", "active"],
      [advisorOther, companyB, null, "Advisor Other", "c@example.test", "advisor", "active"],
    ]) {
      await pool.query(
        `INSERT INTO public.users(id,company_id,student_id,name,email,type,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, company, sid, name, email, type, status],
      );
    }
    await pool.query(
      `INSERT INTO sophia_runtime.business_pack_entitlements
       (customer_id,identity_user_id,pack_id,status,role_key) VALUES
       ($1,$2,'student-operations','active','advisor'),
       ($1,$3,'student-operations','active','advisor'),
       ($4,$5,'student-operations','active','advisor')`,
      [tenantA, advisorA, advisorB, tenantB, advisorOther],
    );
    await pool.query(
      `INSERT INTO sophia_runtime.student_operations_students
       (student_id,customer_id,student_reference,legal_name,email) VALUES
       ($1,$2,'STD-1','Joselin Nicole Aburto Moya','joselin@example.test'),
       ($3,$2,'LEGACY-3','Older Student','older@example.test')`,
      [legacy1, tenantA, legacy3],
    );
  });

  afterAll(async () => { await pool.end(); });

  test("preview reports conflicts without modifying profiles; apply and rerun are idempotent", async () => {
    const before = await pool.query("SELECT count(*)::int AS n FROM sophia_runtime.student_operations_students");
    const preview = await runStudentProfileBackfill(pool, "preview");
    expect(preview.counts).toMatchObject({ link_existing: 1, create: 2, pending: 1 });
    expect(preview.pending).toEqual([expect.objectContaining({
      userId: user3, reason: "possible_existing_profile",
    })]);
    expect((await pool.query("SELECT count(*)::int AS n FROM sophia_runtime.student_operations_students")).rows[0].n)
      .toBe(before.rows[0].n);
    const applied = await runStudentProfileBackfill(pool, "apply");
    expect(applied.counts).toMatchObject({ linked_existing: 1, created: 2, pending: 1 });
    const again = await runStudentProfileBackfill(pool, "apply");
    expect(again.counts).toMatchObject({ linked: 3, pending: 1 });
    expect((await pool.query("SELECT count(*)::int AS n FROM sophia_runtime.student_operations_student_user_links")).rows[0].n)
      .toBe(3);
    expect((await pool.query("SELECT student_id FROM sophia_runtime.student_operations_student_user_links WHERE user_id=$1", [user1])).rows[0].student_id)
      .toBe(legacy1);
    expect((await pool.query("SELECT count(*)::int AS n FROM sophia_runtime.student_operations_cases")).rows[0].n)
      .toBe(0);
    expect((await pool.query("SELECT student_id FROM public.users WHERE id=$1", [user1])).rows[0].student_id)
      .toBe("STD-1");
  });

  test("one profile owns two cases with independent advisors, colleges, payments and activity", async () => {
    const case1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
    const case2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
    const college1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
    const college2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
    await pool.query(
      `INSERT INTO sophia_runtime.student_operations_cases
       (case_id,customer_id,student_id,case_reference,case_kind)
       VALUES ($1,$3,$4,'CASE-1','english'),($2,$3,$4,'CASE-2','visa_renewal')`,
      [case1, case2, tenantA, legacy1],
    );
    await pool.query(
      `INSERT INTO sophia_runtime.student_operations_colleges(college_id,customer_id,college_name)
       VALUES ($1,$3,'College One'),($2,$3,'College Two')`,
      [college1, college2, tenantA],
    );
    await pool.query(
      `INSERT INTO sophia_runtime.student_operations_case_advisors
       (customer_id,case_id,company_id,advisor_user_id,is_primary)
       VALUES ($1,$2,$3,$4,true),($1,$2,$3,$5,false),($1,$6,$3,$5,true)`,
      [tenantA, case1, companyA, advisorA, advisorB, case2],
    );
    await pool.query(
      `INSERT INTO sophia_runtime.student_operations_case_colleges
       (customer_id,case_id,college_id,is_primary)
       VALUES ($1,$2,$3,true),($1,$2,$4,false),($1,$5,$4,true)`,
      [tenantA, case1, college1, college2, case2],
    );
    await pool.query(
      `INSERT INTO sophia_runtime.student_operations_case_payment_schedule
       (customer_id,case_id,source_kind,due_on,amount,currency_code)
       VALUES ($1,$2,'manual','2026-12-01',4500,'AUD'),
              ($1,$3,'approved_offer','2027-06-01',5500,'AUD')`,
      [tenantA, case1, case2],
    );
    await pool.query(
      `INSERT INTO sophia_runtime.student_operations_case_activity
       (customer_id,case_id,actor_identity_user_id,event_type,summary)
       VALUES ($1,$2,$3,'case.created','Created case')`,
      [tenantA, case1, advisorA],
    );
    expect((await pool.query("SELECT count(*)::int AS n FROM sophia_runtime.student_operations_cases WHERE student_id=$1", [legacy1])).rows[0].n)
      .toBe(2);
    expect((await pool.query("SELECT count(*)::int AS n FROM sophia_runtime.student_operations_case_advisors WHERE case_id=$1", [case1])).rows[0].n)
      .toBe(2);
    await expect(pool.query("UPDATE sophia_runtime.student_operations_case_activity SET summary='changed'"))
      .rejects.toThrow("append-only");
  });

  test("tenant and student foreign keys reject crossed advisors, cases and invoices", async () => {
    const otherProfile = (await pool.query<{ student_id: string }>(
      "SELECT student_id FROM sophia_runtime.student_operations_student_user_links WHERE user_id=$1", [user5],
    )).rows[0].student_id;
    await expect(pool.query(
      `INSERT INTO sophia_runtime.student_operations_cases
       (customer_id,student_id,case_reference,case_kind)
       VALUES ($1,$2,'BAD-CASE','english')`, [tenantA, otherProfile],
    )).rejects.toThrow();
    await expect(pool.query(
      `INSERT INTO sophia_runtime.student_operations_case_advisors
       (customer_id,case_id,company_id,advisor_user_id)
       VALUES ($1,$2,$3,$4)`,
      [tenantA, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", companyA, advisorOther],
    )).rejects.toThrow();
    const connection = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const invoice = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await pool.query(
      `INSERT INTO sophia_runtime.student_operations_xero_invoices
       (customer_id,xero_connection_id,xero_invoice_id,student_id,invoice_status)
       VALUES ($1,$2,$3,'STD-2','DRAFT')`, [tenantA, connection, invoice],
    );
    await expect(pool.query(
      `INSERT INTO sophia_runtime.student_operations_case_invoice_links
       (customer_id,case_id,student_id,student_reference,
        xero_connection_id,xero_invoice_id,linked_by_identity)
       VALUES ($1,$2,$3,'STD-1',$4,$5,'test')`,
      [tenantA, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", legacy1, connection, invoice],
    )).rejects.toThrow();
  });

  test("runtime role sees only the selected tenant through the roster and RLS", async () => {
    const client: PoolClient = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE sophia_runtime_app");
      await client.query("SELECT set_config('sophia.tenant_id',$1,true)", [tenantA]);
      const roster = await client.query<{ student_reference: string }>(
        "SELECT student_reference FROM sophia_runtime.student_operations_student_roster ORDER BY student_reference",
      );
      expect(roster.rows.map((row) => row.student_reference)).toEqual(["STD-1", "STD-2", "STD-3", "STD-4"]);
      expect((await client.query("SELECT count(*)::int AS n FROM sophia_runtime.student_operations_cases")).rows[0].n)
        .toBe(2);
      await client.query("SELECT set_config('sophia.tenant_id',$1,true)", [tenantB]);
      expect((await client.query("SELECT student_reference FROM sophia_runtime.student_operations_student_roster")).rows.map((row) => row.student_reference))
        .toEqual(["STD-5"]);
      expect((await client.query("SELECT count(*)::int AS n FROM sophia_runtime.student_operations_cases")).rows[0].n)
        .toBe(0);
      await expect(client.query("SELECT password FROM public.users")).rejects.toThrow();
      await client.query("ROLLBACK");
    } finally { client.release(); }
  });

  test("new Student users appear in the roster and gain a profile only for an authorized case write", async () => {
    const newUser = "00000000-0000-4000-8000-000000000006";
    await pool.query(
      `INSERT INTO public.users(id,company_id,student_id,name,email,type,status)
       VALUES ($1,$2,'STD-6','New Student','new@example.test','student','active')`,
      [newUser, companyA],
    );
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE sophia_runtime_app");
      await client.query("SELECT set_config('sophia.tenant_id',$1,true)", [tenantA]);
      const initial = await client.query<{ profile_id: string | null }>(
        `SELECT profile_id FROM sophia_runtime.student_operations_student_roster
          WHERE user_id = $1`, [newUser],
      );
      expect(initial.rows).toEqual([{ profile_id: null }]);
      const first = await client.query<{ profile_id: string }>(
        `SELECT sophia_runtime.ensure_student_operations_profile($1) AS profile_id`, [newUser],
      );
      const second = await client.query<{ profile_id: string }>(
        `SELECT sophia_runtime.ensure_student_operations_profile($1) AS profile_id`, [newUser],
      );
      expect(second.rows[0].profile_id).toBe(first.rows[0].profile_id);
      await client.query("COMMIT");

      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE sophia_runtime_app");
      await client.query("SELECT set_config('sophia.tenant_id',$1,true)", [tenantA]);
      await expect(client.query(
        `SELECT sophia_runtime.ensure_student_operations_profile($1)`, [user5],
      )).rejects.toThrow("not eligible");
      await client.query("ROLLBACK");

      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE sophia_runtime_app");
      await client.query("SELECT set_config('sophia.tenant_id',$1,true)", [tenantA]);
      await expect(client.query(
        `SELECT sophia_runtime.ensure_student_operations_profile($1)`, [user3],
      )).rejects.toThrow("requires review");
      await client.query("ROLLBACK");
    } finally { client.release(); }
    expect((await pool.query(
      "SELECT count(*)::int AS n FROM sophia_runtime.student_operations_student_user_links WHERE user_id = $1",
      [newUser],
    )).rows[0].n).toBe(1);
  });

  test("register keeps one row per user, enforces case scope, and paginates exact totals", async () => {
    const database = {
      tenantReadTransaction: async <T>(tenantId: string, work: (client: PoolClient) => Promise<T>): Promise<T> => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
          await client.query("SET LOCAL ROLE sophia_runtime_app");
          await client.query("SELECT set_config('sophia.tenant_id',$1,true)", [tenantId]);
          const result = await work(client);
          await client.query("COMMIT");
          return result;
        } catch (error) { await client.query("ROLLBACK"); throw error; }
        finally { client.release(); }
      },
    };
    const service = new StudentOperationsRegisterService(database as never);
    const principal = (role: "operations" | "advisor", userId: string): StudentOperationsWorkspacePrincipal => ({
      tenantId: tenantA, externalCompanyId: companyA, identityUserId: userId,
      role, entitlementId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", authorizationRevision: 1,
    });
    const manager = principal("operations", advisorA);
    const all = await service.list(manager, { limit: 2 });
    expect(all.total).toBe(4); // archived account excluded; four active accounts incl. new Student
    expect(all.students).toHaveLength(2);
    expect(all.summary.total).toBe(4);
    expect(all.summary.activeStudents).toBe(1);
    expect(all.options.advisors.map((row) => row.userId)).toEqual([advisorA, advisorB]);
    const farPage = await service.list(manager, { page: 20, limit: 2 });
    expect(farPage.students).toEqual([]);
    expect(farPage.total).toBe(4);
    const descending = await service.list(manager, { sortBy: "name", sortDir: "desc", limit: 1 });
    expect(descending.students[0].legalName).toBe("Older Student");
    const joselin = await service.list(manager, { q: "STD-1" });
    expect(joselin.total).toBe(1);
    expect(joselin.students[0].cases).toHaveLength(2);
    expect(joselin.students[0].caseId).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2");
    expect(joselin.students[0].nextPayment).toMatchObject({ amount: "4500.0000", currency: "AUD" });
    const advisor = await service.list(principal("advisor", advisorA), {});
    expect(advisor.total).toBe(1);
    expect(advisor.students[0].cases).toHaveLength(1);
    expect(advisor.students[0].nextPayment).toMatchObject({ dueOn: "2026-12-01" });
    expect(advisor.students[0].nextPayment).not.toHaveProperty("amount");
    expect(advisor.options.advisors.map((row) => row.userId)).toEqual([advisorA, advisorB]);
    const noMatch = await service.list(manager, {
      advisorId: advisorA, collegeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
      from: "2027-01-01", to: "2027-12-31",
    });
    expect(noMatch.total).toBe(0); // advisor A is on case 1, date is for case 2
    const otherTenant = await service.list({
      ...manager, tenantId: tenantB, externalCompanyId: companyB,
    }, {});
    expect(otherTenant.total).toBe(1);
    expect(otherTenant.students[0].studentReference).toBe("STD-5");
    expect(otherTenant.options.advisors).toEqual([]);
    await pool.query(
      `UPDATE sophia_runtime.student_operations_case_payment_schedule
          SET due_on = CURRENT_DATE - 1
        WHERE case_id = $1`, ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1"],
    );
    const attention = await service.list(manager, { status: "overdue", attentionThisWeek: "true" });
    expect(attention.total).toBe(1);
    expect(attention.summary.attentionThisWeek).toBe(1);
    expect(attention.students[0].attentionReason).toBe("Payment overdue");
    await expect(service.list(manager, { from: "2026-01-01" })).rejects.toThrow();
    await expect(service.list(manager, { from: "2026-12-31", to: "2026-01-01" })).rejects.toThrow();
  });

  test("register aggregate has a bounded plan on a synthetic thousand-student cohort", async () => {
    await pool.query(
      `INSERT INTO public.users(id,company_id,student_id,name,email,type,status)
       SELECT gen_random_uuid(), $1, 'STD-' || (20000 + n)::text,
              'Load Student ' || n::text, 'load' || n::text || '@example.test',
              'student','active'
         FROM generate_series(1,1000) n`, [companyA],
    );
    await pool.query(
      `INSERT INTO sophia_runtime.student_operations_students
       (customer_id,student_reference,legal_name,email)
       SELECT $1, u.student_id, u.name, u.email FROM public.users u
        WHERE u.company_id=$2 AND u.name LIKE 'Load Student %'`,
      [tenantA, companyA],
    );
    await pool.query(
      `INSERT INTO sophia_runtime.student_operations_student_user_links
       (customer_id,student_id,company_id,user_id,student_reference)
       SELECT $1,s.student_id,$2,u.id,u.student_id
         FROM sophia_runtime.student_operations_students s
         JOIN public.users u ON u.company_id=$2 AND u.student_id=s.student_reference
        WHERE s.customer_id=$1 AND s.legal_name LIKE 'Load Student %'`,
      [tenantA, companyA],
    );
    await pool.query(
      `INSERT INTO sophia_runtime.student_operations_cases
       (customer_id,student_id,case_reference,case_kind,opened_on)
       SELECT $1,s.student_id,'LOAD-' || s.student_reference,'english',CURRENT_DATE
         FROM sophia_runtime.student_operations_students s
        WHERE s.customer_id=$1 AND s.legal_name LIKE 'Load Student %'`, [tenantA],
    );
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE sophia_runtime_app");
      await client.query("SELECT set_config('sophia.tenant_id',$1,true)", [tenantA]);
      const result = await client.query<{ "QUERY PLAN": Array<{ "Execution Time": number }> }>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${buildStudentRegisterCohortSql("sophia_runtime")}
         SELECT count(*) FROM cohort c`,
        [tenantA, null, null, null, null, null, null],
      );
      const executionMs = result.rows[0]["QUERY PLAN"][0]["Execution Time"];
      expect(Number.isFinite(executionMs)).toBe(true);
      expect(executionMs).toBeLessThan(5000);
      await client.query("ROLLBACK");
    } finally { client.release(); }
  });
});
