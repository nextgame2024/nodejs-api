import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { DatabaseService } from './database.service.js';
import { StudentOperationsWorkspaceService } from '../business-packs/student-operations/student-operations-workspace.service.js';
import { buildStudentRegisterMetadataSql } from '../business-packs/student-operations/student-operations-register.service.js';

const url = process.env.LOCAL_STUDENT_PERFORMANCE_TEST_DATABASE_URL;
if (url && (!['localhost','127.0.0.1'].includes(new URL(url).hostname)
  || !new URL(url).pathname.startsWith('/student_performance_test_'))) throw new Error('A disposable local student_performance_test_ database is required.');
const suite = url ? describe : describe.skip;
const tenant = '11111111-1111-4111-8111-111111111111';
const otherTenant = '22222222-2222-4222-8222-222222222222';
const s1 = '33333333-3333-4333-8333-333333333331', s2 = '33333333-3333-4333-8333-333333333332';
const s3 = '33333333-3333-4333-8333-333333333333';
const c1 = '44444444-4444-4444-8444-444444444441', c2 = '44444444-4444-4444-8444-444444444442';
const c3 = '44444444-4444-4444-8444-444444444443';
const a1 = '55555555-5555-4555-8555-555555555551', a2 = '55555555-5555-4555-8555-555555555552';
const k1 = '66666666-6666-4666-8666-666666666661', k2 = '66666666-6666-4666-8666-666666666662';

suite('Batched student reads and access checks under PostgreSQL RLS', () => {
  const pool = new Pool({ connectionString: url, max: 1 });
  const original = { url: process.env.SOPHIA_RUNTIME_DATABASE_URL, ssl: process.env.SOPHIA_RUNTIME_DB_SSL,
    role: process.env.SOPHIA_RUNTIME_DATABASE_ROLE, size: process.env.SOPHIA_RUNTIME_DB_POOL_SIZE };
  let runtime: DatabaseService;
  let workspace: StudentOperationsWorkspaceService;
  beforeAll(async () => {
    await pool.query(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='sophia_runtime_app') THEN CREATE ROLE sophia_runtime_app NOLOGIN NOBYPASSRLS; END IF; END $$;
      CREATE SCHEMA sophia_runtime;
      GRANT USAGE ON SCHEMA sophia_runtime TO sophia_runtime_app;
      CREATE TABLE sophia_runtime.customers(customer_id uuid PRIMARY KEY,external_company_id text,status text);
      GRANT SELECT ON sophia_runtime.customers TO sophia_runtime_app;`);
    const foundation = await readFile(new URL('./migrations/060_business_pack_workspace_entitlements.sql', import.meta.url),'utf8');
    await pool.query(foundation.replaceAll('__SOPHIA_RUNTIME_SCHEMA__','sophia_runtime'));
    await pool.query(`ALTER TABLE sophia_runtime.business_pack_entitlements ADD COLUMN role_key text;
      INSERT INTO sophia_runtime.customers VALUES
        ('${tenant}','company-one','active'),('${otherTenant}','company-two','active'),
        ('77777777-7777-4777-8777-777777777771','ambiguous','active'),
        ('77777777-7777-4777-8777-777777777772','ambiguous','active');
      INSERT INTO sophia_runtime.business_pack_entitlements(customer_id,identity_user_id,pack_id,role_key) VALUES
        ('${tenant}','shared-user','student-operations','chief_executive'),
        ('${otherTenant}','shared-user','student-operations','advisor');
      CREATE TABLE sophia_runtime.student_operations_cases(customer_id uuid,student_id uuid,case_id uuid,case_reference text,lifecycle_status text,opened_on date,created_at timestamptz);
      CREATE TABLE sophia_runtime.student_operations_student_user_links(customer_id uuid,student_id uuid,user_id text);
      CREATE TABLE sophia_runtime.student_operations_case_advisors(customer_id uuid,case_id uuid,advisor_user_id text,is_primary boolean);
      CREATE TABLE sophia_runtime.student_operations_students(customer_id uuid,student_id uuid,advisor_id uuid);
      CREATE TABLE sophia_runtime.student_operations_advisor_directory(customer_id uuid,advisor_id uuid,code text,name text,status text);
      CREATE TABLE sophia_runtime.student_operations_colleges(customer_id uuid,college_id uuid,college_name text);
      CREATE TABLE sophia_runtime.student_operations_case_colleges(customer_id uuid,case_id uuid,college_id uuid);
      CREATE TABLE sophia_runtime.student_operations_student_roster(customer_id uuid,user_id text,student_reference text,account_status text);
      CREATE TABLE sophia_runtime.student_operations_xero_invoices(customer_id uuid,student_id text,invoice_reference text,college_name text,invoice_status text);
      INSERT INTO sophia_runtime.student_operations_cases VALUES
        ('${tenant}','${s1}','${c1}','CASE-1','open','2021-01-01','2021-01-01'),
        ('${tenant}','${s2}','${c2}','CASE-2','open','2022-01-01','2022-01-01'),
        ('${otherTenant}','${s3}','${c3}','FOREIGN','open','2023-01-01','2023-01-01');
      INSERT INTO sophia_runtime.student_operations_student_user_links VALUES ('${tenant}','${s1}','user-1'),('${tenant}','${s2}','user-2'),('${otherTenant}','${s3}','foreign-user');
      INSERT INTO sophia_runtime.student_operations_case_advisors VALUES ('${tenant}','${c1}','advisor-a',true),('${tenant}','${c2}','advisor-b',true),('${otherTenant}','${c3}','advisor-a',true);
      INSERT INTO sophia_runtime.student_operations_students VALUES ('${tenant}','${s1}','${a1}'),('${tenant}','${s2}','${a2}'),('${otherTenant}','${s3}','${a1}');
      INSERT INTO sophia_runtime.student_operations_advisor_directory VALUES ('${tenant}','${a1}','S15','Alice','active'),('${tenant}','${a2}','S69','Bob','active'),('${otherTenant}','${a1}','S15','Foreign advisor','active');
      INSERT INTO sophia_runtime.student_operations_colleges VALUES ('${tenant}','${k1}','Alpha'),('${tenant}','${k2}','Beta'),('${otherTenant}','${k1}','Foreign college');
      INSERT INTO sophia_runtime.student_operations_case_colleges VALUES ('${tenant}','${c1}','${k1}'),('${tenant}','${c2}','${k2}'),('${otherTenant}','${c3}','${k1}');
      INSERT INTO sophia_runtime.student_operations_student_roster VALUES ('${tenant}','user-1','STD-1','active'),('${tenant}','user-2','STD-2','active'),('${otherTenant}','foreign-user','STD-3','active');
      INSERT INTO sophia_runtime.student_operations_xero_invoices VALUES ('${tenant}','STD-1','Imported Alpha',null,'PAID'),('${tenant}','STD-2','Voided reference',null,'VOIDED'),('${otherTenant}','STD-3','Foreign reference',null,'PAID');`);
    for (const table of ['student_operations_cases','student_operations_student_user_links','student_operations_case_advisors',
      'student_operations_students','student_operations_advisor_directory','student_operations_colleges','student_operations_case_colleges',
      'student_operations_student_roster','student_operations_xero_invoices']) {
      await pool.query(`ALTER TABLE sophia_runtime.${table} ENABLE ROW LEVEL SECURITY;
        ALTER TABLE sophia_runtime.${table} FORCE ROW LEVEL SECURITY;
        CREATE POLICY tenant_isolation ON sophia_runtime.${table} USING(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid);
        GRANT SELECT ON sophia_runtime.${table} TO sophia_runtime_app;`);
    }
    process.env.SOPHIA_RUNTIME_DATABASE_URL = url;
    process.env.SOPHIA_RUNTIME_DB_SSL = 'false';
    process.env.SOPHIA_RUNTIME_DATABASE_ROLE = 'sophia_runtime_app';
    process.env.SOPHIA_RUNTIME_DB_POOL_SIZE = '1';
    runtime = new DatabaseService(); workspace = new StudentOperationsWorkspaceService(runtime);
  });
  afterAll(async () => {
    await runtime?.onModuleDestroy(); await pool.end();
    for (const [key,value] of Object.entries({ SOPHIA_RUNTIME_DATABASE_URL: original.url, SOPHIA_RUNTIME_DB_SSL: original.ssl,
      SOPHIA_RUNTIME_DATABASE_ROLE: original.role, SOPHIA_RUNTIME_DB_POOL_SIZE: original.size })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  it('resolves a shared identity separately for each verified company and audits once', async () => {
    for (const [companyId,expectedTenant,role] of [['company-one',tenant,'chief_executive'],['company-two',otherTenant,'advisor']]) {
      expect(await workspace.resolvePrincipal({ userId: 'shared-user', companyId, status: 'active' },`access-${companyId}`))
        .toMatchObject({ tenantId: expectedTenant, role });
      const audit = await pool.query('SELECT outcome,count(*)::int total FROM sophia_runtime.business_pack_access_audit_events WHERE correlation_id=$1 GROUP BY outcome',[`access-${companyId}`]);
      expect(audit.rows).toEqual([{ outcome: 'allowed', total: 1 }]);
    }
  });

  it('retains exactly one denial audit for a missing entitlement', async () => {
    await expect(workspace.resolvePrincipal({ userId: 'unentitled', companyId: 'company-one', status: 'active' },'denied-1')).rejects.toThrow('workspace entitlement');
    expect((await pool.query("SELECT outcome,metadata FROM sophia_runtime.business_pack_access_audit_events WHERE correlation_id='denied-1'")).rows)
      .toEqual([{ outcome: 'denied', metadata: { reason: 'entitlement_missing' } }]);
  });

  it('rejects ambiguous or absent company bindings before assigning a tenant', async () => {
    for (const companyId of ['ambiguous','absent']) await expect(workspace.resolvePrincipal({ userId: 'shared-user', companyId, status: 'active' },'bad-binding')).rejects.toThrow('unambiguous');
    expect((await pool.query("SELECT count(*)::int total FROM sophia_runtime.business_pack_access_audit_events WHERE correlation_id='bad-binding'")).rows[0].total).toBe(0);
  });

  it('clears tenant context on reuse and enforces non-bypass roles', async () => {
    const result = await runtime.transaction(client => client.query("SELECT current_user,current_setting('sophia.tenant_id',true) tenant,rolbypassrls FROM pg_roles WHERE rolname=current_user"));
    expect(result.rows[0]).toMatchObject({ current_user: 'sophia_runtime_app', rolbypassrls: false });
    expect([null,'']).toContain(result.rows[0].tenant);
  });

  it('aggregates page cases and directory choices without crossing tenant scope', async () => {
    const result = await runtime.tenantReadTransaction(tenant, client => client.query(buildStudentRegisterMetadataSql('sophia_runtime'),[tenant,null,[s1,s2,s3]]));
    expect(result.rows[0].cases.map((c: {case_reference:string}) => c.case_reference)).toEqual(['CASE-2','CASE-1']);
    expect(result.rows[0].advisors.map((a: {name:string}) => a.name)).toEqual(['Alice','Bob']);
    expect(result.rows[0].colleges.map((c: {college_name:string}) => c.college_name)).toEqual(['Alpha','Beta','Imported Alpha']);
  });

  it('limits advisor metadata to assigned cases and directory choices', async () => {
    const result = await runtime.tenantReadTransaction(tenant, client => client.query(buildStudentRegisterMetadataSql('sophia_runtime'),[tenant,'advisor-a',[s1,s2,s3]]));
    expect(result.rows[0].cases.map((c: {case_reference:string}) => c.case_reference)).toEqual(['CASE-1']);
    expect(result.rows[0].advisors.map((a: {name:string}) => a.name)).toEqual(['Alice']);
    expect(result.rows[0].colleges.map((c: {college_name:string}) => c.college_name)).toEqual(['Alpha']);
  });

  it('keeps filter choices available for an empty filtered page', async () => {
    const result = await runtime.tenantReadTransaction(tenant, client => client.query(buildStudentRegisterMetadataSql('sophia_runtime'),[tenant,null,[]]));
    expect(result.rows[0].cases).toEqual([]); expect(result.rows[0].advisors).toHaveLength(2);
  });

  it('fails closed if the audit cannot be written and clears context on rollback', async () => {
    await pool.query('REVOKE INSERT ON sophia_runtime.business_pack_access_audit_events FROM sophia_runtime_app');
    try { await expect(workspace.resolvePrincipal({ userId: 'shared-user', companyId: 'company-one', status: 'active' },'audit-fails')).rejects.toThrow(); }
    finally { await pool.query('GRANT INSERT ON sophia_runtime.business_pack_access_audit_events TO sophia_runtime_app'); }
    const result = await runtime.transaction(client => client.query("SELECT current_setting('sophia.tenant_id',true) tenant"));
    expect([null,'']).toContain(result.rows[0].tenant);
  });
});
