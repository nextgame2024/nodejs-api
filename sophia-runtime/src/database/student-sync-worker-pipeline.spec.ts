import { jest } from '@jest/globals';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { DatabaseService } from './database.service.js';
import { StudentOperationsCaseDocumentsService } from '../business-packs/student-operations/student-operations-case-documents.service.js';

const url=process.env.LOCAL_STUDENT_PIPELINE_TEST_DATABASE_URL;
if(url && (!['localhost','127.0.0.1'].includes(new URL(url).hostname)
  || !new URL(url).pathname.startsWith('/student_pipeline_test_'))) throw new Error('Disposable local student_pipeline_test_ database required.');
const suite=url?describe:describe.skip;
const tenant='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const connection='33333333-3333-4333-8333-333333333333';
suite('Nightly pipeline migration and document dependency under PostgreSQL',()=>{
  const pool=new Pool({connectionString:url,max:2});let runtime:DatabaseService;
  const env={...process.env};
  beforeAll(async()=>{
    await pool.query(`DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='sophia_runtime_app') THEN
      CREATE ROLE sophia_runtime_app NOLOGIN NOBYPASSRLS; END IF; END $$;
      CREATE SCHEMA sophia_runtime;GRANT USAGE ON SCHEMA sophia_runtime TO sophia_runtime_app;
      CREATE TABLE sophia_runtime.customers(customer_id uuid PRIMARY KEY,status text);
      INSERT INTO sophia_runtime.customers VALUES('${tenant}','active'),('${other}','active');
      CREATE TABLE sophia_runtime.xero_connections(customer_id uuid,xero_connection_id uuid,status text,UNIQUE(xero_connection_id,customer_id));
      INSERT INTO sophia_runtime.xero_connections VALUES('${tenant}','${connection}','active'),('${other}','${connection}','active');
      CREATE TABLE sophia_runtime.student_operations_xero_sync_configurations(customer_id uuid,xero_connection_id uuid,
        enabled boolean DEFAULT true,organisation_role text DEFAULT 'trust',last_successful_sync_at timestamptz,
        last_reconciliation_sync_at timestamptz,reconciliation_interval interval DEFAULT '12 hours',next_sync_at timestamptz DEFAULT now());
      CREATE TABLE sophia_runtime.student_operations_xero_sync_runs(customer_id uuid,xero_connection_id uuid,
        sync_run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),mode text,trigger_type text,modified_since timestamptz,
        status text DEFAULT 'queued',created_at timestamptz DEFAULT now(),lease_expires_at timestamptz);
      CREATE UNIQUE INDEX active_run ON sophia_runtime.student_operations_xero_sync_runs(customer_id,xero_connection_id)
        WHERE status IN ('queued','processing');
      CREATE TABLE sophia_runtime.student_operations_document_jobs(customer_id uuid,job_id uuid DEFAULT gen_random_uuid(),case_id uuid,
        xero_connection_id uuid,source_kind text,source_id uuid,status text DEFAULT 'queued',attempts int DEFAULT 0,
        next_attempt_at timestamptz DEFAULT now(),lease_token uuid,lease_expires_at timestamptz,error_code text,updated_at timestamptz);
      CREATE TABLE sophia_runtime.student_operations_case_documents(customer_id uuid,case_id uuid,xero_connection_id uuid,source_kind text,
        source_id uuid,attachment_id uuid,file_name text,mime_type text,size_bytes bigint,last_seen_at timestamptz);`);
    await pool.query((await readFile(new URL('./migrations/080_student_sync_worker_pipeline.sql',import.meta.url),'utf8')).replaceAll('__SOPHIA_RUNTIME_SCHEMA__','sophia_runtime'));
    for(const table of ['customers','xero_connections','student_operations_xero_sync_configurations','student_operations_xero_sync_runs',
      'student_operations_document_jobs','student_operations_case_documents']) {
      await pool.query(`ALTER TABLE sophia_runtime.${table} ENABLE ROW LEVEL SECURITY;
        ALTER TABLE sophia_runtime.${table} FORCE ROW LEVEL SECURITY;
        CREATE POLICY tenant_scope ON sophia_runtime.${table} USING(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid);
        GRANT SELECT,UPDATE,INSERT ON sophia_runtime.${table} TO sophia_runtime_app;`);
    }
    process.env.SOPHIA_RUNTIME_DATABASE_URL=url;process.env.SOPHIA_RUNTIME_DB_SSL='false';
    process.env.SOPHIA_RUNTIME_DATABASE_ROLE='sophia_runtime_app';process.env.STUDENT_SYNC_PIPELINE_ENABLED='true';
    runtime=new DatabaseService();
  });
  afterAll(async()=>{
    await runtime?.onModuleDestroy();await pool.end();
    for(const key of ['SOPHIA_RUNTIME_DATABASE_URL','SOPHIA_RUNTIME_DB_SSL','SOPHIA_RUNTIME_DATABASE_ROLE','STUDENT_SYNC_PIPELINE_ENABLED']) {
      if(env[key]===undefined) delete process.env[key];else process.env[key]=env[key];
    }
  });
  beforeEach(async()=>{
    await pool.query(`TRUNCATE sophia_runtime.student_operations_xero_sync_configurations,
      sophia_runtime.student_operations_xero_sync_runs,sophia_runtime.student_operations_sync_checkpoints,
      sophia_runtime.student_operations_document_jobs;
      UPDATE sophia_runtime.customers SET status='active';UPDATE sophia_runtime.xero_connections SET status='active';
      INSERT INTO sophia_runtime.student_operations_xero_sync_configurations(customer_id,xero_connection_id)
      VALUES('${tenant}','${connection}');`);
  });
  async function window(open:boolean) {
    // Fixture-only clock override. Production function uses database time.
    await pool.query(`CREATE OR REPLACE FUNCTION sophia_runtime.student_operations_automatic_window(at_time timestamptz DEFAULT now())
      RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT ${open?'true':'false'} $$`);
  }
  async function claim(){return runtime.query('SELECT * FROM sophia_runtime.claim_due_student_operations_xero_worker_runs(1)');}
  it('uses Brisbane, not UTC or daylight-saving Sydney, at both boundaries',async()=>{
    const result=await pool.query(`SELECT sophia_runtime.student_operations_automatic_window(t) AS allowed
      FROM unnest(ARRAY['2026-10-20 14:59:59Z','2026-10-20 15:00:00Z','2026-10-20 19:59:59Z','2026-10-20 20:00:00Z']::timestamptz[]) t`);
    expect(result.rows.map(row=>row.allowed)).toEqual([false,true,true,false]);
  });
  it('does not enqueue or consume automatic work during the day; manual remains available',async()=>{
    await window(false);expect((await claim()).rows).toHaveLength(0);
    await pool.query(`INSERT INTO sophia_runtime.student_operations_xero_sync_runs(customer_id,xero_connection_id,mode,trigger_type)
      VALUES('${tenant}','${connection}','incremental','webhook')`);
    expect((await claim()).rows).toHaveLength(0);
    await pool.query("UPDATE sophia_runtime.student_operations_xero_sync_runs SET trigger_type='manual'");
    expect((await claim()).rows).toHaveLength(1);
  });
  it('coalesces concurrent schedule attempts into one durable run',async()=>{
    await window(true);await Promise.all([claim(),claim()]);
    expect((await pool.query('SELECT count(*)::int n FROM sophia_runtime.student_operations_xero_sync_runs')).rows[0].n).toBe(1);
  });
  it('does not start disabled tenants, connections or configurations',async()=>{
    await window(true);
    for(const sql of ["UPDATE sophia_runtime.customers SET status='disabled'", "UPDATE sophia_runtime.xero_connections SET status='revoked'", 
      'UPDATE sophia_runtime.student_operations_xero_sync_configurations SET enabled=false']) {
      await pool.query(sql);expect((await claim()).rows).toHaveLength(0);
      await pool.query("UPDATE sophia_runtime.customers SET status='active';UPDATE sophia_runtime.xero_connections SET status='active'");
    }
  });
  it('upgrades a queued webhook when a full reconciliation is due',async()=>{
    await window(true);await pool.query(`UPDATE sophia_runtime.student_operations_xero_sync_configurations
      SET last_successful_sync_at=now()-interval '1 day';
      INSERT INTO sophia_runtime.student_operations_xero_sync_runs(customer_id,xero_connection_id,mode,trigger_type,modified_since)
      VALUES('${tenant}','${connection}','incremental','webhook',now())`);
    await claim();expect((await pool.query('SELECT mode,modified_since FROM sophia_runtime.student_operations_xero_sync_runs')).rows[0])
      .toEqual({mode:'reconciliation',modified_since:null});
  });
  it('recovers an expired lease but leaves a live lease untouched',async()=>{
    await window(false);await pool.query(`INSERT INTO sophia_runtime.student_operations_xero_sync_runs
      (customer_id,xero_connection_id,mode,trigger_type,status,lease_expires_at)
      VALUES('${tenant}','${connection}','initial','manual','processing',now()+interval '1 minute')`);
    expect((await claim()).rows).toHaveLength(0);
    await pool.query("UPDATE sophia_runtime.student_operations_xero_sync_runs SET lease_expires_at=now()-interval '1 minute'");
    expect((await claim()).rows).toHaveLength(1);
  });
  it('keeps checkpoints tenant-scoped and read-only to Runtime',async()=>{
    await pool.query(`INSERT INTO sophia_runtime.student_operations_sync_checkpoints VALUES
      ('${tenant}','${connection}',now(),now()),('${other}','${connection}',now(),now())`);
    expect((await runtime.tenantReadTransaction(tenant,db=>db.query('SELECT * FROM sophia_runtime.student_operations_sync_checkpoints'))).rows).toHaveLength(1);
    expect((await runtime.query('SELECT * FROM sophia_runtime.student_operations_sync_checkpoints')).rows).toHaveLength(0);
    await expect(runtime.tenantTransaction(tenant,db=>db.query(`INSERT INTO sophia_runtime.student_operations_sync_checkpoints
      VALUES($1,$2,now(),now())`,[tenant,connection]))).rejects.toThrow(/permission denied/);
  });
  it('does not claim documents before reconciliation, during import, or for an inactive tenant',async()=>{
    const attachments=jest.fn(async()=>[]);
    const documents=new StudentOperationsCaseDocumentsService(runtime,{} as never,{attachments} as never);
    await pool.query(`UPDATE sophia_runtime.student_operations_xero_sync_configurations SET last_successful_sync_at='2026-10-20 01:00Z';
      INSERT INTO sophia_runtime.student_operations_document_jobs(customer_id,case_id,xero_connection_id,source_kind,source_id)
      VALUES('${tenant}','${other}','${connection}','Invoices','${other}')`);
    expect(await documents.processOne(tenant)).toBe(false);expect(attachments).not.toHaveBeenCalled();
    await pool.query(`INSERT INTO sophia_runtime.student_operations_sync_checkpoints VALUES
      ('${tenant}','${connection}','2026-10-19 01:00Z',now())`);
    expect(await documents.processOne(tenant)).toBe(false);
    await pool.query("UPDATE sophia_runtime.student_operations_sync_checkpoints SET source_sync_at='2026-10-20 01:00Z'");
    await pool.query(`INSERT INTO sophia_runtime.student_operations_xero_sync_runs(customer_id,xero_connection_id,mode,trigger_type)
      VALUES('${tenant}','${connection}','initial','manual')`);
    expect(await documents.processOne(tenant)).toBe(false);
    await pool.query("UPDATE sophia_runtime.student_operations_xero_sync_runs SET status='succeeded';UPDATE sophia_runtime.customers SET status='disabled'");
    expect(await documents.processOne(tenant)).toBe(false);
    await pool.query("UPDATE sophia_runtime.customers SET status='active'");
    expect(await documents.processOne(tenant)).toBe(true);expect(attachments).toHaveBeenCalledTimes(1);
    expect((await pool.query('SELECT status FROM sophia_runtime.student_operations_document_jobs')).rows[0].status).toBe('succeeded');
  });
});
