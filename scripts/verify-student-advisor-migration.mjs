import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// Run only on a newly created, disposable local database with the saved audit
// snapshot present in exports/. Creates fixture tables; never drops any data.
const root = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const audit = JSON.parse(await readFile(`${root}/exports/student_advisor_audit_2026-10-19.json`, 'utf8'));
const migration = (await readFile(`${root}/backend/sophia-runtime/src/database/migrations/077_reconcile_student_advisors_to_xero.sql`, 'utf8'))
  .replaceAll('__SOPHIA_RUNTIME_SCHEMA__', 'sophia_runtime');
const url = process.env.LOCAL_STUDENT_ADVISOR_TEST_DATABASE_URL;
if (!url) throw new Error('Set LOCAL_STUDENT_ADVISOR_TEST_DATABASE_URL to a fresh disposable local database.');
const parsed = new URL(url);
if (!['localhost', '127.0.0.1'].includes(parsed.hostname) ||
    parsed.pathname !== '/sophia_advisor_migration_test') {
  throw new Error('Verification requires the disposable local sophia_advisor_migration_test database.');
}
const db = new pg.Client({ connectionString: url });
await db.connect();
try {
  await db.query(`CREATE SCHEMA sophia_runtime;
    CREATE TABLE sophia_runtime.customers(customer_id uuid PRIMARY KEY, external_company_id text, status text);
    CREATE TABLE public.users(id uuid PRIMARY KEY,company_id uuid,student_id text,type text,status text);
    CREATE TABLE sophia_runtime.student_operations_advisor_directory(advisor_id uuid PRIMARY KEY,customer_id uuid,code text,status text);
    CREATE TABLE sophia_runtime.student_operations_students(student_id uuid PRIMARY KEY,customer_id uuid,advisor_id uuid,
      updated_at timestamptz DEFAULT now(),record_version integer DEFAULT 1);
    CREATE TABLE sophia_runtime.student_operations_student_user_links(customer_id uuid,student_id uuid,student_reference text,user_id uuid,company_id uuid);
    CREATE TABLE sophia_runtime.student_operations_cases(case_id uuid PRIMARY KEY,customer_id uuid,student_id uuid,advisor_name text,created_at timestamptz DEFAULT now());
    CREATE TABLE sophia_runtime.student_operations_xero_invoices(customer_id uuid,xero_connection_id uuid,xero_invoice_id uuid,student_id text,
      invoice_status text,invoice_date date,advisor_name text,invoice_reference text,college_name text);
    CREATE TABLE sophia_runtime.student_operations_case_invoice_links(customer_id uuid,case_id uuid,student_id uuid,xero_connection_id uuid,xero_invoice_id uuid);
    CREATE TABLE sophia_runtime.student_operations_student_audit_events(customer_id uuid,student_id uuid,
      actor_identity_user_id text,event_type text,record_version integer,changed_fields text[],correlation_id text);`);
  await db.query('INSERT INTO sophia_runtime.customers VALUES($1,$2,$3)', [audit.tenantId,audit.companyId,'active']);
  for (const advisor of audit.directory) await db.query('INSERT INTO sophia_runtime.student_operations_advisor_directory VALUES($1,$2,$3,$4)',[advisor.advisor_id,audit.tenantId,advisor.code,advisor.status]);
  assert.equal(audit.rows.length,1068);
  assert.equal(audit.rows.filter(row=>row.resolution==='update_advisor').length,159);
  for (const row of audit.rows) {
    assert.ok(row.profile_id);
    await db.query('INSERT INTO public.users VALUES($1,$2,$3,$4,$5)',[row.user_id,audit.companyId,row.student_reference,'student','active']);
    await db.query('INSERT INTO sophia_runtime.student_operations_students(student_id,customer_id,advisor_id) VALUES($1,$2,$3)',[row.profile_id,audit.tenantId,row.advisor_id]);
    await db.query('INSERT INTO sophia_runtime.student_operations_student_user_links VALUES($1,$2,$3,$4,$5)',[audit.tenantId,row.profile_id,row.student_reference,row.user_id,audit.companyId]);
    if (row.case_id) await db.query('INSERT INTO sophia_runtime.student_operations_cases(case_id,customer_id,student_id,advisor_name) VALUES($1,$2,$3,$4)',[row.case_id,audit.tenantId,row.profile_id,row.advisor_xero_name]);
  }
  const example=audit.rows.find(row=>row.student_reference==='STD-578');
  // A contradictory newest invoice must not replace the displayed case label.
  const connection='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const invoice='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  await db.query('INSERT INTO sophia_runtime.student_operations_xero_invoices(customer_id,xero_connection_id,xero_invoice_id,student_id,invoice_status,invoice_date,advisor_name) VALUES($1,$2,$3,$4,$5,$6,$7)',[audit.tenantId,connection,invoice,example.student_reference,'PAID','2030-01-01','S15 Paulina Aguillon']);
  await db.query('INSERT INTO sophia_runtime.student_operations_case_invoice_links VALUES($1,$2,$3,$4,$5)',[audit.tenantId,example.case_id,example.profile_id,connection,invoice]);
  const sourceBefore=JSON.stringify((await db.query('SELECT * FROM sophia_runtime.student_operations_cases ORDER BY case_id')).rows);

  await db.query('BEGIN');
  const applied=await db.query(migration);
  assert.equal(applied.rowCount,159,'all audited corrections must apply');
  const profiles=(await db.query('SELECT * FROM sophia_runtime.student_operations_students')).rows;
  for (const row of audit.rows) {
    const profile=profiles.find(item=>item.student_id===row.profile_id);
    assert.equal(profile.advisor_id,row.expected_advisor_id ?? row.advisor_id,row.student_reference);
    assert.equal(profile.record_version,row.resolution==='update_advisor'?2:1);
  }
  assert.equal(JSON.stringify((await db.query('SELECT * FROM sophia_runtime.student_operations_cases ORDER BY case_id')).rows),sourceBefore);
  assert.equal((await db.query('SELECT advisor_name FROM sophia_runtime.student_operations_xero_invoices')).rows[0].advisor_name,'S15 Paulina Aguillon');
  assert.equal((await db.query(migration)).rowCount,0,'rerunning must be idempotent');
  assert.equal((await db.query('SELECT count(*)::int n FROM sophia_runtime.student_operations_student_audit_events')).rows[0].n,159);
  await db.query('ROLLBACK');
  console.log('PASS: 159 corrections; 907 matching and 2 missing-source students preserved; Xero fields unchanged; rerun adds no writes.');

  await db.query('BEGIN');
  const changedSource=audit.rows.find(row=>row.student_reference==='STD-586');
  const archived=audit.rows.find(row=>row.student_reference==='STD-589');
  const other=audit.directory.find(row=>row.advisor_id!==example.advisor_id && row.advisor_id!==example.expected_advisor_id);
  await db.query('UPDATE sophia_runtime.student_operations_students SET advisor_id=$2 WHERE student_id=$1',[example.profile_id,other.advisor_id]);
  await db.query('UPDATE sophia_runtime.student_operations_cases SET advisor_name=$2 WHERE case_id=$1',[changedSource.case_id,'Changed after audit']);
  await db.query('UPDATE public.users SET status=$2 WHERE id=$1',[archived.user_id,'archived']);
  const pedro=audit.directory.find(row=>row.code==='S69');
  await db.query('UPDATE sophia_runtime.student_operations_advisor_directory SET status=$2 WHERE advisor_id=$1',[pedro.advisor_id,'inactive']);
  const inactiveCount=audit.rows.filter(row=>row.resolution==='update_advisor' && row.expected_advisor_id===pedro.advisor_id).length;
  assert.equal((await db.query(migration)).rowCount,159-3-inactiveCount);
  assert.equal((await db.query('SELECT advisor_id FROM sophia_runtime.student_operations_students WHERE student_id=$1',[example.profile_id])).rows[0].advisor_id,other.advisor_id);
  await db.query('ROLLBACK');
  console.log('PASS: later assignment/source changes, archived students and inactive targets are skipped.');

  // Verify the two source fallbacks separately against the same audited row.
  for (const kind of ['case_invoice','student_invoice']) {
    await db.query('BEGIN');
    await db.query('UPDATE sophia_runtime.student_operations_xero_invoices SET advisor_name=$2 WHERE xero_invoice_id=$1',[invoice,example.advisor_xero_name]);
    if (kind==='case_invoice') await db.query('UPDATE sophia_runtime.student_operations_cases SET advisor_name=NULL WHERE case_id=$1',[example.case_id]);
    else await db.query('DELETE FROM sophia_runtime.student_operations_cases WHERE case_id=$1',[example.case_id]);
    assert.equal((await db.query(migration)).rowCount,159);
    assert.equal((await db.query('SELECT advisor_id FROM sophia_runtime.student_operations_students WHERE student_id=$1',[example.profile_id])).rows[0].advisor_id,example.expected_advisor_id);
    await db.query('ROLLBACK');
  }
  console.log('PASS: case-invoice and no-case student-invoice source fallbacks.');

  await db.query('BEGIN');
  const tenantB='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  await db.query('UPDATE sophia_runtime.student_operations_students SET customer_id=$2 WHERE student_id=$1',[example.profile_id,tenantB]);
  assert.equal((await db.query(migration)).rowCount,158);
  await db.query('ROLLBACK');
  console.log('PASS: tenant scope excludes a profile moved outside the audited customer.');
} finally { await db.end(); }
