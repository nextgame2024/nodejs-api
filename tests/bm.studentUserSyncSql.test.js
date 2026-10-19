import {
  beforeAll,
  afterAll,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import pg from "pg";
import { readFile } from "node:fs/promises";
import bcrypt from "bcryptjs";

// Dedicated disposable local database ONLY. Never points at DATABASE_URL.
const url = process.env.LOCAL_STUDENT_SYNC_TEST_DATABASE_URL;
if (url && !["localhost", "127.0.0.1"].includes(new URL(url).hostname))
  throw new Error("Local database required");
const pool = new pg.Pool({ connectionString: url, max: 5 });
jest.unstable_mockModule("../src/config/db.js", () => ({ default: pool }));
const { enqueueSync, processSyncBatch, syncOverview, resolveCandidate } =
  await import("../src/services/bm.studentUserSync.service.js");
const company = "11111111-1111-4111-8111-111111111111",
  customer = "22222222-2222-4222-8222-222222222222";
const actor = "33333333-3333-4333-8333-333333333333",
  connection = "44444444-4444-4444-8444-444444444444";
const source = "55555555-5555-4555-8555-555555555555";
const suite = url ? describe : describe.skip;
suite("Student user sync — isolated PostgreSQL", () => {
  beforeAll(async () => {
    await pool.query(`CREATE SCHEMA sophia_runtime;
      CREATE TABLE bm_company(company_id uuid PRIMARY KEY,workspace_profile text,status text);
      CREATE TABLE users(id uuid PRIMARY KEY,company_id uuid,email text UNIQUE NOT NULL,username text UNIQUE NOT NULL,password text,name text,type text,status text,student_id text UNIQUE,student_name_in_xero text,image text,bio text);
      CREATE TABLE bm_student_id_counter(id boolean PRIMARY KEY,last_value bigint);
      INSERT INTO bm_student_id_counter VALUES(true,0);
      CREATE TABLE bm_navigation_links(navigation_link_id uuid DEFAULT gen_random_uuid(),company_id uuid,user_id uuid,navigation_type text,navigation_label text,active boolean);
      CREATE TABLE sophia_runtime.customers(customer_id uuid PRIMARY KEY,external_company_id text,status text);
      CREATE TABLE sophia_runtime.business_pack_entitlements(customer_id uuid,identity_user_id text,pack_id text,status text,role_key text);
      CREATE TABLE sophia_runtime.student_operations_xero_sync_configurations(customer_id uuid,xero_connection_id uuid,enabled boolean,organisation_role text,last_successful_sync_at timestamptz);
      CREATE TABLE sophia_runtime.student_operations_xero_sync_runs(sync_run_id uuid PRIMARY KEY,customer_id uuid,xero_connection_id uuid,status text,mode text,created_at timestamptz);
      CREATE TABLE sophia_runtime.student_operations_xero_contacts(customer_id uuid,xero_connection_id uuid,xero_contact_id uuid,legal_name text,email text);
      CREATE TABLE sophia_runtime.student_operations_xero_invoices(customer_id uuid,xero_connection_id uuid,xero_invoice_id uuid DEFAULT gen_random_uuid(),xero_contact_id uuid,invoice_type text,invoice_status text,last_seen_sync_run_id uuid);`);
    await pool.query(`
      DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='sophia_runtime_app') THEN CREATE ROLE sophia_runtime_app; END IF; END $$;
      ALTER TABLE sophia_runtime.student_operations_xero_invoices ADD COLUMN invoice_date date, ADD COLUMN advisor_name text;
      CREATE TABLE sophia_runtime.student_operations_students(customer_id uuid,student_id uuid,advisor_id uuid,updated_at timestamptz,record_version int DEFAULT 1);
      CREATE TABLE sophia_runtime.student_operations_student_audit_events(customer_id uuid,student_id uuid,actor_identity_user_id text,event_type text,record_version int,changed_fields text[],correlation_id text);
      CREATE TABLE sophia_runtime.student_operations_student_user_links(customer_id uuid,student_id uuid,student_reference text);
      CREATE TABLE sophia_runtime.student_operations_case_invoice_links(customer_id uuid,student_id uuid,xero_connection_id uuid,xero_invoice_id uuid);
      CREATE TABLE sophia_runtime.student_operations_advisor_directory(customer_id uuid,advisor_id uuid,code text,name text,xero_label text,status text);
    `);
    await pool.query(
      await readFile(
        new URL(
          "../scripts/sql/bm_xero_student_user_sync.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    await pool.query("INSERT INTO bm_company VALUES($1,$2,$3)", [
      company,
      "student_operations",
      "active",
    ]);
    await pool.query(await readFile(new URL('../scripts/sql/bm_xero_student_sync_schedule.sql', import.meta.url), 'utf8'));
    await pool.query((await readFile(new URL('../sophia-runtime/src/database/migrations/078_latest_invoice_advisors.sql',import.meta.url),'utf8')).replaceAll('__SOPHIA_RUNTIME_SCHEMA__','sophia_runtime'));
    await pool.query("INSERT INTO sophia_runtime.customers VALUES($1,$2,$3)", [
      customer,
      company,
      "active",
    ]);
    await pool.query(
      "INSERT INTO users(id,company_id,email,username,name,type,status) VALUES($1,$2,'ce@example.test','chief','Chief Executive','employee','active')",
      [actor, company],
    );
    await pool.query(
      "INSERT INTO sophia_runtime.business_pack_entitlements VALUES($1,$2,'student-operations','active','chief_executive')",
      [customer, actor],
    );
    await pool.query(
      "INSERT INTO sophia_runtime.student_operations_xero_sync_configurations VALUES($1,$2,true,'trust',now())",
      [customer, connection],
    );
    await pool.query(
      "INSERT INTO sophia_runtime.student_operations_xero_sync_runs VALUES($1,$2,$3,'succeeded','initial',now())",
      [source, customer, connection],
    );
    for (const [name, email] of [
      ["S15 - Fabian Andres Lopez Patino", "fabian@example.test"],
      ["C90-S40 Fabian Andres Lopez Patino", "fabian@example.test"],
      ["O10 Fabian Andres Other", "other@example.test"],
      ["M30 Missing Email", null],
      ["C31 Shared One", "shared@example.test"],
      ["B21 Shared Two", "shared@example.test"],
      ["Greenwich College", "college@example.test"],
    ])
      await addContact(name, email);
  });
  afterAll(async () => {
    await pool.end();
  });
  async function addContact(name, email) {
    const id = (await pool.query("SELECT gen_random_uuid() id")).rows[0].id;
    await pool.query(
      "INSERT INTO sophia_runtime.student_operations_xero_contacts VALUES($1,$2,$3,$4,$5)",
      [customer, connection, id, name, email],
    );
    await pool.query(
      "INSERT INTO sophia_runtime.student_operations_xero_invoices(customer_id,xero_connection_id,xero_contact_id,invoice_type,invoice_status,last_seen_sync_run_id) VALUES($1,$2,$3,'ACCREC','DRAFT',$4)",
      [customer, connection, id, source],
    );
    return id;
  }
  async function drain() {
    for (let i = 0; i < 8; i++) {
      await processSyncBatch();
      const running = await pool.query(
        "SELECT 1 FROM bm_xero_student_sync_runs WHERE status IN ('queued','processing')",
      );
      if (!running.rowCount) break;
    }
  }
  test("preview creates no users and exposes pending reasons", async () => {
    await enqueueSync(actor, "preview");
    await drain();
    const result = await syncOverview(actor);
    expect(result.counts).toEqual({ pending: 6 });
    expect(result.total).toBe(6);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM users WHERE type='student'",
        )
      ).rows[0].n,
    ).toBe(0);
  });
  test("apply deduplicates, handles username collisions, hashes passwords and links invoices", async () => {
    await enqueueSync(actor, "apply");
    await drain();
    const result = await syncOverview(actor);
    expect(result.runs[0].status).toBe("succeeded");
    const users = (
      await pool.query(
        "SELECT * FROM users WHERE type='student' ORDER BY username",
      )
    ).rows;
    expect(users).toHaveLength(2);
    expect(users.map((u) => u.username)).toEqual([
      "fabian.andres",
      "fabian.andres2",
    ]);
    expect(await bcrypt.compare("openAustralia*", users[0].password)).toBe(
      true,
    );
    expect(users[0].password).not.toBe(users[1].password);
    expect(users.every((u) => /^STD-\d+$/.test(u.student_id))).toBe(true);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM sophia_runtime.student_operations_xero_invoices WHERE student_id IS NOT NULL",
        )
      ).rows[0].n,
    ).toBe(3);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM sophia_runtime.business_pack_entitlements",
        )
      ).rows[0].n,
    ).toBe(1);
  });
  test("reruns and new prefixed contacts reuse IDs without resetting passwords", async () => {
    const before = (
      await pool.query(
        "SELECT id,password,student_id FROM users WHERE type='student' ORDER BY id",
      )
    ).rows;
    await addContact(
      "M30-S15 FABIAN ANDRES LOPEZ PATINO",
      "fabian@example.test",
    );
    await enqueueSync(actor, "apply");
    await drain();
    expect(
      (
        await pool.query(
          "SELECT id,password,student_id FROM users WHERE type='student' ORDER BY id",
        )
      ).rows,
    ).toEqual(before);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM sophia_runtime.student_operations_xero_invoices WHERE student_id IS NOT NULL",
        )
      ).rows[0].n,
    ).toBe(4);
  });
  test("correct, exclude, and explicit link persist across reruns", async () => {
    let rows = (await syncOverview(actor)).records;
    const missing = rows.find((r) => r.display_name === "Missing Email");
    await resolveCandidate(actor, missing.id, {
      action: "correct",
      name: "Missing Email",
      email: "missing@example.test",
    });
    await resolveCandidate(
      actor,
      rows.find((r) => r.display_name === "Greenwich College").id,
      { action: "exclude" },
    );
    const studentId = (
      await pool.query(
        "SELECT student_id FROM users WHERE username='fabian.andres'",
      )
    ).rows[0].student_id;
    await resolveCandidate(
      actor,
      rows.find((r) => r.display_name === "Shared One").id,
      { action: "link", studentId },
    );
    await enqueueSync(actor, "apply");
    await drain();
    rows = (await syncOverview(actor)).records;
    expect(rows.find((r) => r.id === missing.id).status).toBe("linked");
    expect(
      rows.find((r) => r.display_name === "Greenwich College").status,
    ).toBe("excluded");
    expect(rows.find((r) => r.display_name === "Shared One").student_id).toBe(
      studentId,
    );
    // Shared Two cannot silently acquire an email associated with another source identity.
    expect(rows.find((r) => r.display_name === "Shared Two").status).toBe(
      "pending",
    );
  });
  test("Xero refresh queues review without creating accounts; nightly apply links eligible invoices", async () => {
    const id = await addContact("C90 New Student", "new@example.test");
    const total = (
      await pool.query(
        "SELECT count(*)::int n FROM sophia_runtime.student_operations_xero_invoices",
      )
    ).rows[0].n;
    // Existing installations may still have the former automatic flag enabled.
    await pool.query(
      "UPDATE bm_xero_student_sync_config SET automatic=true WHERE customer_id=$1",
      [customer],
    );
    await pool.query(
      "UPDATE sophia_runtime.student_operations_xero_sync_configurations SET last_successful_sync_at=now()",
    );
    const runsBefore = (
      await pool.query("SELECT count(*)::int n FROM bm_xero_student_sync_runs")
    ).rows[0].n;
    await processSyncBatch();
    expect(
      (
        await pool.query("SELECT count(*)::int n FROM bm_xero_student_sync_runs")
      ).rows[0].n,
    ).toBe(runsBefore + 1);
    expect((await syncOverview(actor)).automatic).toBe(true);
    expect(
      (
        await pool.query(
          "SELECT student_id FROM sophia_runtime.student_operations_xero_invoices WHERE xero_contact_id=$1",
          [id],
        )
      ).rows[0].student_id,
    ).toBeNull();
    await pool.query("UPDATE bm_xero_student_sync_config SET next_nightly_at=now()-interval '1 minute'");
    await drain();
    expect(
      (
        await pool.query(
          "SELECT automatic FROM bm_xero_student_sync_config WHERE customer_id=$1",
          [customer],
        )
      ).rows[0].automatic,
    ).toBe(true);
    expect(
      (
        await pool.query(
          "SELECT student_id FROM sophia_runtime.student_operations_xero_invoices WHERE xero_contact_id=$1",
          [id],
        )
      ).rows[0].student_id,
    ).toMatch(/^STD-/);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM sophia_runtime.student_operations_xero_invoices",
        )
      ).rows[0].n,
    ).toBe(total);
  });
  test("new same-name contacts with conflicting emails remain pending", async () => {
    const id = await addContact(
      "C31 Fabian Andres Lopez Patino",
      "different@example.test",
    );
    await enqueueSync(actor, "apply");
    await drain();
    const row = (await syncOverview(actor)).records.find(
      (r) => r.display_name === "Fabian Andres Lopez Patino",
    );
    expect(row.status).toBe("pending");
    expect(row.reason).toContain("different email");
    expect(
      (
        await pool.query(
          "SELECT student_id FROM sophia_runtime.student_operations_xero_invoices WHERE xero_contact_id=$1",
          [id],
        )
      ).rows[0].student_id,
    ).toBeNull();
    await resolveCandidate(actor, row.id, {
      action: "correct",
      name: row.display_name,
      email: "fabian@example.test",
    });
    await enqueueSync(actor, "apply");
    await drain();
    expect(
      (
        await pool.query(
          "SELECT student_id FROM sophia_runtime.student_operations_xero_invoices WHERE xero_contact_id=$1",
          [id],
        )
      ).rows[0].student_id,
    ).toBe(row.student_id);
  });
  test("concurrent run requests coalesce and workers do not duplicate accounts", async () => {
    const before = (
      await pool.query("SELECT count(*)::int n FROM users WHERE type='student'")
    ).rows[0].n;
    const queued = await Promise.all([
      enqueueSync(actor, "apply"),
      enqueueSync(actor, "apply"),
    ]);
    expect(queued.filter((r) => r.queued)).toHaveLength(1);
    await Promise.all([processSyncBatch(), processSyncBatch()]);
    await drain();
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM users WHERE type='student'",
        )
      ).rows[0].n,
    ).toBe(before);
  });
  test("non-Chief Executives cannot inspect or run sync", async () => {
    const id = (
      await pool.query("SELECT id FROM users WHERE type='student' LIMIT 1")
    ).rows[0].id;
    await expect(syncOverview(id)).rejects.toMatchObject({ status: 403 });
    await expect(enqueueSync(id, "apply")).rejects.toMatchObject({
      status: 403,
    });
  });
  test('missing contacts and old unseen invoices remain pending and can be explicitly linked', async () => {
    const id = await addContact('Unknown Contact', null);
    await pool.query('DELETE FROM sophia_runtime.student_operations_xero_contacts WHERE xero_contact_id=$1',[id]);
    await enqueueSync(actor,'preview'); await drain();
    const row = (await syncOverview(actor)).records.find(r => r.display_name==='');
    expect(row.status).toBe('pending');
    const student = (await pool.query("SELECT student_id FROM users WHERE type='student' LIMIT 1")).rows[0];
    await resolveCandidate(actor,row.id,{action:'link',studentId:student.student_id});
    expect((await pool.query('SELECT student_id FROM sophia_runtime.student_operations_xero_invoices WHERE xero_contact_id=$1',[id])).rows[0].student_id).toBe(student.student_id);
  });
  test('latest dated draft wins; advisor changes and blanks reconcile idempotently and tenant-scoped', async () => {
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('sophia.tenant_id',$1,true)",[customer]);
      const profile='66666666-6666-4666-8666-666666666666';
      const advisor='77777777-7777-4777-8777-777777777777';
      await client.query('INSERT INTO sophia_runtime.student_operations_students(customer_id,student_id) VALUES($1,$2)',[customer,profile]);
      await client.query("INSERT INTO sophia_runtime.student_operations_advisor_directory VALUES($1,$2,'S69','Pedro Muñoz','S69 Pedro Muñoz','active')",[customer,advisor]);
      const invoice=(await client.query('SELECT xero_invoice_id FROM sophia_runtime.student_operations_xero_invoices WHERE student_id IS NOT NULL LIMIT 1')).rows[0].xero_invoice_id;
      await client.query('INSERT INTO sophia_runtime.student_operations_student_user_links SELECT $1,$2,student_id FROM sophia_runtime.student_operations_xero_invoices WHERE xero_invoice_id=$3',[customer,profile,invoice]);
      await client.query("UPDATE sophia_runtime.student_operations_xero_invoices SET invoice_date='2029-10-01',advisor_name='S69 Pedro Munoz' WHERE xero_invoice_id=$1",[invoice]);
      await client.query('SELECT sophia_runtime.reconcile_latest_invoice_advisors($1)',[customer]);
      expect((await client.query('SELECT advisor_id,record_version FROM sophia_runtime.student_operations_students')).rows[0]).toEqual({advisor_id:advisor,record_version:2});
      await client.query('SELECT sophia_runtime.reconcile_latest_invoice_advisors($1)',[customer]);
      expect((await client.query('SELECT record_version FROM sophia_runtime.student_operations_students')).rows[0].record_version).toBe(2);
      await client.query("UPDATE sophia_runtime.student_operations_xero_invoices SET advisor_name=NULL WHERE xero_invoice_id=$1",[invoice]);
      await client.query('SELECT sophia_runtime.reconcile_latest_invoice_advisors($1)',[customer]);
      expect((await client.query('SELECT advisor_id FROM sophia_runtime.student_operations_students')).rows[0].advisor_id).toBeNull();
      await client.query("SELECT set_config('sophia.tenant_id',$1,true)",[actor]);
      expect((await client.query('SELECT * FROM sophia_runtime.student_operations_latest_invoice_advisors')).rows).toHaveLength(0);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
});
