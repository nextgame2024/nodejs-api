import { jest } from '@jest/globals';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { DatabaseService } from './database.service.js';
import { StudentOperationsCaseDocumentsService } from '../business-packs/student-operations/student-operations-case-documents.service.js';
import { StudentDocumentRechecks } from '../business-packs/student-operations/student-document-rechecks.js';

const url=process.env.LOCAL_DOCUMENT_SOURCE_TEST_DATABASE_URL;
if(url && (!['localhost','127.0.0.1'].includes(new URL(url).hostname)
  || !new URL(url).pathname.startsWith('/document_source_test_'))) throw new Error('Disposable local document_source_test_ database required.');
const suite=url?describe:describe.skip;
const tenant='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const connection='33333333-3333-4333-8333-333333333333',source='44444444-4444-4444-8444-444444444444';
const file={attachmentId:'55555555-5555-4555-8555-555555555555',fileName:'document.pdf',mimeType:'application/pdf',sizeBytes:42};
suite('Deduplicated document discovery under PostgreSQL RLS',()=>{
  const pool=new Pool({connectionString:url,max:5}),env={...process.env};let runtime:DatabaseService;
  const attachments=jest.fn<(...args:unknown[])=>Promise<unknown[]>>();
  const docs=()=>new StudentOperationsCaseDocumentsService(runtime,{} as never,{attachments} as never);
  const processOne=()=>docs().processOne(tenant,{dailyBudget:true});
  beforeAll(async()=>{
    await pool.query(`DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='sophia_runtime_app') THEN
      CREATE ROLE sophia_runtime_app NOLOGIN NOBYPASSRLS; END IF; END $$;
      CREATE SCHEMA sophia_runtime; GRANT USAGE ON SCHEMA sophia_runtime TO sophia_runtime_app;
      ALTER DEFAULT PRIVILEGES IN SCHEMA sophia_runtime GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO sophia_runtime_app;
      CREATE TABLE sophia_runtime.customers(customer_id uuid PRIMARY KEY,status text);
      CREATE TABLE sophia_runtime.xero_connections(customer_id uuid,xero_connection_id uuid,status text,UNIQUE(xero_connection_id,customer_id));
      CREATE TABLE sophia_runtime.student_operations_cases(customer_id uuid,case_id uuid,PRIMARY KEY(customer_id,case_id));
      CREATE TABLE sophia_runtime.student_operations_xero_sync_configurations(customer_id uuid,xero_connection_id uuid,
        enabled boolean DEFAULT true,organisation_role text DEFAULT 'trust',last_successful_sync_at timestamptz);
      CREATE TABLE sophia_runtime.student_operations_sync_checkpoints(customer_id uuid,xero_connection_id uuid,source_sync_at timestamptz);
      CREATE TABLE sophia_runtime.student_operations_xero_sync_runs(customer_id uuid,xero_connection_id uuid,status text);
      CREATE TABLE sophia_runtime.student_operations_xero_invoices(customer_id uuid,xero_connection_id uuid,xero_invoice_id uuid,
        xero_contact_id uuid,invoice_type text,invoice_status text,provider_updated_at timestamptz);
      CREATE TABLE sophia_runtime.student_operations_xero_contacts(customer_id uuid,xero_connection_id uuid,xero_contact_id uuid,
        provider_updated_at timestamptz);
      CREATE TABLE sophia_runtime.student_operations_case_invoice_links(customer_id uuid,xero_connection_id uuid,xero_invoice_id uuid,case_id uuid);
      CREATE TABLE sophia_runtime.student_operations_document_jobs(customer_id uuid,job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),case_id uuid,
        xero_connection_id uuid,source_kind text,source_id uuid,status text DEFAULT 'queued',attempts int DEFAULT 0,
        next_attempt_at timestamptz DEFAULT now(),lease_token uuid,lease_expires_at timestamptz,error_code text,updated_at timestamptz DEFAULT now(),
        UNIQUE(customer_id,case_id,xero_connection_id,source_kind,source_id));
      CREATE TABLE sophia_runtime.student_operations_case_documents(document_id uuid DEFAULT gen_random_uuid(),customer_id uuid,case_id uuid,
        xero_connection_id uuid,source_kind text,source_id uuid,attachment_id uuid,file_name text,mime_type text,size_bytes bigint,last_seen_at timestamptz DEFAULT now(),
        UNIQUE(customer_id,case_id,xero_connection_id,source_kind,source_id,attachment_id));`);
    for(const migration of ['081_shared_student_worker_document_budget.sql','082_xero_connection_rate_limits.sql','083_student_document_source_cache.sql','084_xero_quota_admission.sql','085_student_document_rechecks.sql','086_student_sync_permission_hardening.sql'])
      await pool.query((await readFile(new URL(`./migrations/${migration}`,import.meta.url),'utf8')).replaceAll('__SOPHIA_RUNTIME_SCHEMA__','sophia_runtime'));
    for(const table of ['customers','xero_connections','student_operations_cases','student_operations_xero_sync_configurations',
      'student_operations_sync_checkpoints','student_operations_xero_sync_runs','student_operations_xero_invoices','student_operations_xero_contacts',
      'student_operations_case_invoice_links','student_operations_document_jobs','student_operations_case_documents']) {
      await pool.query(`ALTER TABLE sophia_runtime.${table} ENABLE ROW LEVEL SECURITY;
        ALTER TABLE sophia_runtime.${table} FORCE ROW LEVEL SECURITY;
        CREATE POLICY tenant_scope ON sophia_runtime.${table} USING(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid);
        GRANT SELECT,INSERT,UPDATE ON sophia_runtime.${table} TO sophia_runtime_app;`);
    }
    process.env.SOPHIA_RUNTIME_DATABASE_URL=url;process.env.SOPHIA_RUNTIME_DB_SSL='false';
    process.env.SOPHIA_RUNTIME_DATABASE_ROLE='sophia_runtime_app';process.env.STUDENT_SYNC_PIPELINE_ENABLED='true';
    process.env.XERO_SHARED_BACKOFF_ENABLED='true';process.env.STUDENT_DOCUMENT_SOURCE_DEDUP_ENABLED='true';
    runtime=new DatabaseService();
  });
  afterAll(async()=>{
    await runtime?.onModuleDestroy();await pool.end();
    for(const key of ['SOPHIA_RUNTIME_DATABASE_URL','SOPHIA_RUNTIME_DB_SSL','SOPHIA_RUNTIME_DATABASE_ROLE',
      'STUDENT_SYNC_PIPELINE_ENABLED','XERO_SHARED_BACKOFF_ENABLED','STUDENT_DOCUMENT_SOURCE_DEDUP_ENABLED','XERO_SHARED_QUOTA_ENABLED','STUDENT_DOCUMENT_RECHECKS_ENABLED']) {
      if(env[key]===undefined) delete process.env[key];else process.env[key]=env[key];
    }
  });
  beforeEach(async()=>{
    delete process.env.XERO_SHARED_QUOTA_ENABLED;
    delete process.env.STUDENT_DOCUMENT_RECHECKS_ENABLED;
    attachments.mockReset();attachments.mockResolvedValue([file]);
    await pool.query(`TRUNCATE sophia_runtime.student_document_recheck_budgets,sophia_runtime.student_operations_xero_contacts,
      sophia_runtime.xero_quota_admission,sophia_runtime.student_operations_document_sources,sophia_runtime.student_operations_document_daily_budgets,
      sophia_runtime.xero_connection_rate_limits,sophia_runtime.student_operations_document_jobs,sophia_runtime.student_operations_case_documents,
      sophia_runtime.student_operations_case_invoice_links,sophia_runtime.student_operations_xero_invoices,sophia_runtime.student_operations_cases,
      sophia_runtime.student_operations_sync_checkpoints,sophia_runtime.student_operations_xero_sync_runs,
      sophia_runtime.student_operations_xero_sync_configurations,sophia_runtime.xero_connections,sophia_runtime.customers;
      INSERT INTO sophia_runtime.customers VALUES('${tenant}','active'),('${other}','active');
      INSERT INTO sophia_runtime.xero_connections VALUES('${tenant}','${connection}','active'),('${other}','${connection}','active');
      INSERT INTO sophia_runtime.student_operations_xero_sync_configurations VALUES('${tenant}','${connection}',true,'trust','2026-10-20Z');
      INSERT INTO sophia_runtime.student_operations_sync_checkpoints VALUES('${tenant}','${connection}','2026-10-20Z');
      CREATE OR REPLACE FUNCTION sophia_runtime.student_operations_document_window(at_time timestamptz DEFAULT now())
        RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT true $$;`);
  });
  async function addCase(customer=tenant,kind='Contacts',sourceId=source,conn=connection) {
    const id=(await pool.query('SELECT gen_random_uuid() id')).rows[0].id;
    const invoice=kind==='Contacts'?(await pool.query('SELECT gen_random_uuid() id')).rows[0].id:sourceId;
    await pool.query('INSERT INTO sophia_runtime.student_operations_cases VALUES($1,$2)',[customer,id]);
    await pool.query(`INSERT INTO sophia_runtime.student_operations_xero_invoices(customer_id,xero_connection_id,xero_invoice_id,xero_contact_id,invoice_type,invoice_status) VALUES($1,$2,$3,$4,$5,'DRAFT')`,
      [customer,conn,invoice,kind==='Contacts'?sourceId:source,kind==='CreditNotes'?'ACCRECCREDIT':'ACCREC']);
    await pool.query('INSERT INTO sophia_runtime.student_operations_case_invoice_links VALUES($1,$2,$3,$4)',[customer,conn,invoice,id]);
    await pool.query(`INSERT INTO sophia_runtime.student_operations_document_jobs(customer_id,case_id,xero_connection_id,source_kind,source_id)
      VALUES($1,$2,$3,$4,$5)`,[customer,id,conn,kind,sourceId]);
    return id;
  }
  async function budget(){return (await pool.query('SELECT attempted_sources FROM sophia_runtime.student_operations_document_daily_budgets')).rows;}
  it('removes inherited deletion grants from all five protected stores without changing unrelated defaults',async()=>{
    for(const table of ['student_operations_document_daily_budgets','xero_connection_rate_limits',
      'student_operations_document_sources','xero_quota_admission','student_document_recheck_budgets']) {
      expect((await pool.query("SELECT has_table_privilege('sophia_runtime_app',$1,'DELETE') AS allowed",[`sophia_runtime.${table}`])).rows[0].allowed).toBe(false);
    }
    expect((await pool.query("SELECT has_table_privilege('sophia_runtime_app','sophia_runtime.customers','DELETE') AS allowed")).rows[0].allowed).toBe(true);
  });
  it('fetches one shared contact once and fans out only to linked cases in the same tenant',async()=>{
    await addCase();await addCase();await addCase(other);
    // An orphaned case job with the same source identity must not receive files.
    const orphan=await addCase();await pool.query('DELETE FROM sophia_runtime.student_operations_case_invoice_links WHERE case_id=$1',[orphan]);
    expect(await processOne()).toBe(true);expect(attachments).toHaveBeenCalledTimes(1);
    expect((await pool.query('SELECT case_id,customer_id FROM sophia_runtime.student_operations_case_documents')).rows)
      .toHaveLength(2);
    expect((await pool.query("SELECT count(*)::int n FROM sophia_runtime.student_operations_document_jobs WHERE status='succeeded'")).rows[0].n).toBe(2);
    expect(await budget()).toEqual([{attempted_sources:1}]);
  });
  it('reuses persisted metadata after restart for a newly linked case without another source attempt',async()=>{
    await addCase();await processOne();const added=await addCase();
    expect(await docs().processOne(tenant,{dailyBudget:true})).toBe(true);
    expect(attachments).toHaveBeenCalledTimes(1);expect(await budget()).toEqual([{attempted_sources:1}]);
    expect((await pool.query('SELECT * FROM sophia_runtime.student_operations_case_documents WHERE case_id=$1',[added])).rows).toHaveLength(1);
  });
  it('persists empty discovery and reuses it without treating it as unprocessed',async()=>{
    attachments.mockResolvedValue([]);await addCase();await processOne();await addCase();await processOne();
    expect(attachments).toHaveBeenCalledTimes(1);
    expect((await pool.query('SELECT attachments,status FROM sophia_runtime.student_operations_document_sources')).rows[0])
      .toEqual({attachments:[],status:'succeeded'});
    expect((await pool.query("SELECT count(*)::int n FROM sophia_runtime.student_operations_document_jobs WHERE status='succeeded'")).rows[0].n).toBe(2);
  });
  it('coalesces concurrent workers while the provider request is in flight',async()=>{
    await addCase();await addCase();let release!:(files:unknown[])=>void,entered!:()=>void;
    const started=new Promise<void>(resolve=>{entered=resolve;});
    attachments.mockImplementation(()=>{entered();return new Promise(resolve=>{release=resolve;});});
    const first=processOne();await started;
    expect(await docs().processOne(tenant,{dailyBudget:true})).toBe(false);
    release([file]);expect(await first).toBe(true);expect(attachments).toHaveBeenCalledTimes(1);
    expect(await budget()).toEqual([{attempted_sources:1}]);
  });
  it('expires old cache and honors an explicit refresh request with microsecond precision',async()=>{
    await addCase();await processOne();
    await pool.query(`UPDATE sophia_runtime.student_operations_document_jobs SET status='queued',attempts=0,
      refresh_requested_at=(SELECT checked_at+interval '1 microsecond' FROM sophia_runtime.student_operations_document_sources)`);
    await processOne();expect(attachments).toHaveBeenCalledTimes(2);
    expect((await pool.query('SELECT status FROM sophia_runtime.student_operations_document_jobs')).rows[0].status).toBe('succeeded');
    await addCase();await pool.query("UPDATE sophia_runtime.student_operations_document_sources SET checked_at=now()-interval '25 hours'");
    await processOne();expect(attachments).toHaveBeenCalledTimes(3);
  });
  it('refreshes metadata on already-completed linked cases without refetching per case',async()=>{
    const first=await addCase();await addCase();await processOne();
    await pool.query(`UPDATE sophia_runtime.student_operations_document_jobs SET status='queued',attempts=0,refresh_requested_at=now()
      WHERE case_id=$1`,[first]);
    attachments.mockResolvedValue([{...file,fileName:'updated.pdf'}, {...file,fileName:'updated.pdf'}]);
    await processOne();expect(attachments).toHaveBeenCalledTimes(2);
    expect((await pool.query('SELECT file_name FROM sophia_runtime.student_operations_case_documents')).rows)
      .toEqual([{file_name:'updated.pdf'},{file_name:'updated.pdf'}]);
  });
  it('the existing authorized enqueue marks a completed source for fresh discovery',async()=>{
    const id=await addCase();await processOne();
    const service=new StudentOperationsCaseDocumentsService(runtime,{
      authorizedCase:async()=>{},activity:async()=>{},
    } as never,{attachments} as never);
    const result=await service.enqueue({tenantId:tenant,role:'chief_executive'} as never,id);
    expect(result.queued).toBe(2); // Linked invoice plus the existing contact.
    expect((await pool.query("SELECT refresh_requested_at IS NOT NULL AS forced FROM sophia_runtime.student_operations_document_jobs WHERE source_kind='Contacts'")).rows[0].forced).toBe(true);
    await processOne();await processOne();
    expect(attachments.mock.calls.filter(call=>call[2]==='Contacts')).toHaveLength(2);
  });
  it('fails closed if deduplication is invoked outside the shared daily-budget path',async()=>{
    await expect(docs().processOne(tenant)).rejects.toThrow('requires the shared worker daily budget');
    expect(attachments).not.toHaveBeenCalled();
  });
  it('rechecks source links and dependency checkpoints after the provider call',async()=>{
    const id=await addCase();
    attachments.mockImplementation(async()=>{await pool.query('DELETE FROM sophia_runtime.student_operations_case_invoice_links WHERE case_id=$1',[id]);return [file];});
    await processOne();expect((await pool.query('SELECT * FROM sophia_runtime.student_operations_case_documents')).rows).toHaveLength(0);
    expect((await pool.query('SELECT status,error_code FROM sophia_runtime.student_operations_document_jobs')).rows[0])
      .toEqual({status:'failed',error_code:'source_not_linked'});
  });
  it('holds publication if a new import starts, then replays locally after reconciliation',async()=>{
    await addCase();attachments.mockImplementation(async()=>{
      await pool.query(`INSERT INTO sophia_runtime.student_operations_xero_sync_runs VALUES('${tenant}','${connection}','processing')`);return [file];});
    await processOne();expect((await pool.query('SELECT * FROM sophia_runtime.student_operations_case_documents')).rows).toHaveLength(0);
    expect((await pool.query('SELECT status FROM sophia_runtime.student_operations_document_jobs')).rows[0].status).toBe('queued');
    await pool.query("UPDATE sophia_runtime.student_operations_xero_sync_runs SET status='succeeded'");
    await processOne();expect(attachments).toHaveBeenCalledTimes(1);
    expect((await pool.query('SELECT * FROM sophia_runtime.student_operations_case_documents')).rows).toHaveLength(1);
  });
  it('respects cooldown, source cap, deadline and document window without provider attempts',async()=>{
    await addCase();
    await pool.query(`INSERT INTO sophia_runtime.xero_connection_rate_limits(customer_id,xero_connection_id,blocked_until)
      VALUES('${tenant}','${connection}',now()+interval '1 hour')`);
    expect(await processOne()).toBe(false);expect(await budget()).toHaveLength(0);
    await pool.query('TRUNCATE sophia_runtime.xero_connection_rate_limits');
    await pool.query(`INSERT INTO sophia_runtime.student_operations_document_daily_budgets(customer_id,business_date,attempted_sources)
      VALUES('${tenant}',(now() AT TIME ZONE 'Australia/Brisbane')::date,500)`);
    expect(await processOne()).toBe(false);
    await pool.query("UPDATE sophia_runtime.student_operations_document_daily_budgets SET attempted_sources=0,started_at=now()-interval '31 minutes'");
    expect(await processOne()).toBe(false);
    await pool.query(`UPDATE sophia_runtime.student_operations_document_daily_budgets SET started_at=now();
      CREATE OR REPLACE FUNCTION sophia_runtime.student_operations_document_window(at_time timestamptz DEFAULT now())
      RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT false $$`);
    expect(await processOne()).toBe(false);expect(attachments).not.toHaveBeenCalled();
  });
  it('does not exceed the shared source cap when different sources are claimed concurrently',async()=>{
    await addCase();await addCase(tenant,'Invoices');
    await pool.query(`INSERT INTO sophia_runtime.student_operations_document_daily_budgets(customer_id,business_date,attempted_sources)
      VALUES('${tenant}',(now() AT TIME ZONE 'Australia/Brisbane')::date,499)`);
    await Promise.all([processOne(),processOne()]);
    expect(attachments).toHaveBeenCalledTimes(1);expect(await budget()).toEqual([{attempted_sources:500}]);
  });
  it('reuses local metadata even when the provider budget is exhausted',async()=>{
    await addCase();await processOne();await addCase();
    await pool.query(`UPDATE sophia_runtime.student_operations_document_daily_budgets SET attempted_sources=500;
      INSERT INTO sophia_runtime.xero_connection_rate_limits(customer_id,xero_connection_id,blocked_until)
      VALUES('${tenant}','${connection}',now()+interval '1 hour')`);
    expect(await processOne()).toBe(true);expect(attachments).toHaveBeenCalledTimes(1);
    expect(await budget()).toEqual([{attempted_sources:500}]);
  });
  async function quotaState(remaining=200) {
    process.env.XERO_SHARED_QUOTA_ENABLED='true';
    await pool.query(`INSERT INTO sophia_runtime.xero_quota_admission(customer_id,xero_connection_id,remaining,refresh_after)
      VALUES($1,$2,$3,now()+interval '1 hour')`,[tenant,connection,remaining]);
  }
  const schedule=()=>new StudentDocumentRechecks(runtime).schedule(tenant);
  async function enableRechecks(remaining=500) {
    await quotaState(remaining);process.env.STUDENT_DOCUMENT_RECHECKS_ENABLED='true';
  }
  async function oldCompleted(kind='Contacts') {
    await addCase(tenant,kind);await processOne();
    await pool.query("UPDATE sophia_runtime.student_operations_document_sources SET checked_at=now()-interval '8 days'");
  }
  it('does not schedule rechecks unless explicitly enabled with all protections',async()=>{
    await oldCompleted();expect(await schedule()).toBe(0);
    process.env.STUDENT_DOCUMENT_RECHECKS_ENABLED='true';
    await expect(schedule()).rejects.toThrow('require quota');
    expect((await pool.query('SELECT * FROM sophia_runtime.student_document_recheck_budgets')).rows).toHaveLength(0);
  });
  it('queues one representative per expired source and fans out a genuinely fresh result',async()=>{
    await addCase();await oldCompleted();await enableRechecks();
    expect(await schedule()).toBe(1);expect(await schedule()).toBe(0);
    expect(attachments).toHaveBeenCalledTimes(1);expect(await budget()).toEqual([{attempted_sources:1}]);
    expect((await pool.query("SELECT count(*)::int n FROM sophia_runtime.student_operations_document_jobs WHERE status='queued'")).rows[0].n).toBe(1);
    attachments.mockResolvedValue([{...file,fileName:'updated.pdf'}]);
    await processOne();expect(attachments).toHaveBeenCalledTimes(2);
    expect((await pool.query('SELECT file_name FROM sophia_runtime.student_operations_case_documents')).rows)
      .toEqual([{file_name:'updated.pdf'},{file_name:'updated.pdf'}]);
    expect(await schedule()).toBe(0);
  });
  it.each(['Contacts','Invoices','CreditNotes'])('queues imported changes for %s without relying on local upsert timestamps',async kind=>{
    await addCase(tenant,kind);await processOne();await enableRechecks();
    expect(await schedule()).toBe(0);
    await pool.query("UPDATE sophia_runtime.student_operations_document_sources SET checked_at=now()-interval '2 hours'");
    if(kind==='Contacts') await pool.query(`INSERT INTO sophia_runtime.student_operations_xero_contacts VALUES($1,$2,$3,now()-interval '1 hour')`,[tenant,connection,source]);
    else await pool.query("UPDATE sophia_runtime.student_operations_xero_invoices SET provider_updated_at=now()-interval '1 hour'");
    expect(await schedule()).toBe(1);expect(await schedule()).toBe(0);
    expect(attachments).toHaveBeenCalledTimes(1);
    await processOne();expect(attachments).toHaveBeenCalledTimes(2);expect(await schedule()).toBe(0);
  });
  it('periodically rechecks successful empty results',async()=>{
    attachments.mockResolvedValue([]);await oldCompleted();await enableRechecks();
    expect(await schedule()).toBe(1);await processOne();
    expect(attachments).toHaveBeenCalledTimes(2);
    expect((await pool.query('SELECT attachments FROM sophia_runtime.student_operations_document_sources')).rows[0].attachments).toEqual([]);
  });
  it.each(['window','quota','unknown','cooldown','import','checkpoint','unlinked','inactive'])('does not queue rechecks while %s blocks eligibility',async gate=>{
    await oldCompleted();await enableRechecks();
    if(gate==='window') await pool.query("CREATE OR REPLACE FUNCTION sophia_runtime.student_operations_document_window(at_time timestamptz DEFAULT now()) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT false $$");
    if(gate==='quota') await pool.query('UPDATE sophia_runtime.xero_quota_admission SET remaining=200');
    if(gate==='unknown') await pool.query('UPDATE sophia_runtime.xero_quota_admission SET remaining=NULL');
    if(gate==='cooldown') await pool.query(`INSERT INTO sophia_runtime.xero_connection_rate_limits(customer_id,xero_connection_id,blocked_until) VALUES($1,$2,now()+interval '1 hour')`,[tenant,connection]);
    if(gate==='import') await pool.query('INSERT INTO sophia_runtime.student_operations_xero_sync_runs VALUES($1,$2,\'processing\')',[tenant,connection]);
    if(gate==='checkpoint') await pool.query("UPDATE sophia_runtime.student_operations_sync_checkpoints SET source_sync_at='2026-10-19Z'");
    if(gate==='unlinked') await pool.query('DELETE FROM sophia_runtime.student_operations_case_invoice_links');
    if(gate==='inactive') await pool.query("UPDATE sophia_runtime.xero_connections SET status='inactive'");
    expect(await schedule()).toBe(0);expect(attachments).toHaveBeenCalledTimes(1);
    expect((await pool.query("SELECT status FROM sophia_runtime.student_operations_document_jobs")).rows[0].status).toBe('succeeded');
  });
  it('serializes recheck scheduling across replicas and persists the 25-source daily cap after restart',async()=>{
    for(let i=0;i<30;i++) await addCase(tenant,'Invoices',(await pool.query('SELECT gen_random_uuid() id')).rows[0].id);
    await pool.query(`INSERT INTO sophia_runtime.student_operations_document_sources(customer_id,xero_connection_id,source_kind,source_id,status,checked_at,attachments)
      SELECT customer_id,xero_connection_id,source_kind,source_id,'succeeded',now()-interval '8 days','[]'::jsonb FROM sophia_runtime.student_operations_document_jobs;
      UPDATE sophia_runtime.student_operations_document_jobs SET status='succeeded'`);
    await enableRechecks();
    const result=await Promise.all([schedule(),schedule()]);expect(result.reduce((a,b)=>a+b,0)).toBe(25);
    expect(await schedule()).toBe(0);expect(attachments).not.toHaveBeenCalled();expect(await budget()).toHaveLength(0);
    expect((await pool.query('SELECT scheduled_sources FROM sophia_runtime.student_document_recheck_budgets')).rows[0].scheduled_sources).toBe(25);
    // A new Brisbane business day allows another bounded set, not duplicates.
    await pool.query("UPDATE sophia_runtime.student_document_recheck_budgets SET business_date=business_date-1");
    expect(await schedule()).toBe(5);
  });
  it('does not restart a spent fetch deadline or reset an active retry',async()=>{
    await oldCompleted();await enableRechecks();
    await pool.query("UPDATE sophia_runtime.student_operations_document_daily_budgets SET started_at=now()-interval '31 minutes'");
    expect(await schedule()).toBe(1);expect(await processOne()).toBe(false);expect(attachments).toHaveBeenCalledTimes(1);
    await pool.query('UPDATE sophia_runtime.student_operations_document_daily_budgets SET started_at=now()');
    attachments.mockRejectedValue(new Error('temporary'));await processOne();
    const before=(await pool.query('SELECT attempts,status FROM sophia_runtime.student_operations_document_sources')).rows[0];
    expect(await schedule()).toBe(0);
    expect((await pool.query('SELECT attempts,status FROM sophia_runtime.student_operations_document_sources')).rows[0]).toEqual(before);
  });
  it('isolates recheck budgets and denies cross-tenant writes and deletion',async()=>{
    await oldCompleted();await enableRechecks();await schedule();
    expect((await runtime.tenantReadTransaction(other,db=>db.query('SELECT * FROM sophia_runtime.student_document_recheck_budgets'))).rows).toHaveLength(0);
    await expect(runtime.tenantTransaction(other,db=>db.query('INSERT INTO sophia_runtime.student_document_recheck_budgets(customer_id,business_date) VALUES($1,current_date)',[tenant]))).rejects.toMatchObject({code:'42501'});
    await expect(runtime.tenantTransaction(tenant,db=>db.query('DELETE FROM sophia_runtime.student_document_recheck_budgets'))).rejects.toMatchObject({code:'42501'});
  });
  it('holds unknown or reserved quota before consuming a source attempt',async()=>{
    await addCase();process.env.XERO_SHARED_QUOTA_ENABLED='true';
    expect(await processOne()).toBe(false);expect(await budget()).toHaveLength(0);
    await quotaState();expect(await processOne()).toBe(false);
    expect(attachments).not.toHaveBeenCalled();expect(await budget()).toHaveLength(0);
  });
  it('keeps cache-only fan-out available when quota is reserved for operations',async()=>{
    await addCase();await processOne();await addCase();await quotaState();
    expect(await processOne()).toBe(true);expect(attachments).toHaveBeenCalledTimes(1);
    expect(await budget()).toEqual([{attempted_sources:1}]);
  });
  it.each([false,true])('handles a local quota race with upstreamAttempted=%s',async sent=>{
    await addCase();await quotaState(201);
    attachments.mockRejectedValue({getResponse:()=>({errorCode:'xero_quota_reserved',localQuotaDenial:true,upstreamAttempted:sent,retryAfterSeconds:600})});
    expect(await processOne()).toBe(false);
    expect(await budget()).toEqual([{attempted_sources:sent?1:0}]);
    expect((await pool.query('SELECT status,attempts FROM sophia_runtime.student_operations_document_jobs')).rows[0])
      .toEqual({status:'queued',attempts:sent?1:0});
    expect((await pool.query('SELECT attempts FROM sophia_runtime.student_operations_document_sources')).rows[0].attempts).toBe(sent?1:0);
  });
  it('clears orphaned queue work only after dependencies are ready, without a source attempt',async()=>{
    const id=await addCase();
    await pool.query('DELETE FROM sophia_runtime.student_operations_case_invoice_links WHERE case_id=$1',[id]);
    await pool.query(`INSERT INTO sophia_runtime.student_operations_xero_sync_runs VALUES('${tenant}','${connection}','processing')`);
    expect(await processOne()).toBe(false);
    expect((await pool.query('SELECT status FROM sophia_runtime.student_operations_document_jobs')).rows[0].status).toBe('queued');
    await pool.query("UPDATE sophia_runtime.student_operations_xero_sync_runs SET status='succeeded'");
    expect(await processOne()).toBe(true);expect(attachments).not.toHaveBeenCalled();expect(await budget()).toHaveLength(0);
    expect((await pool.query('SELECT status,error_code FROM sophia_runtime.student_operations_document_jobs')).rows[0])
      .toEqual({status:'failed',error_code:'source_not_linked'});
  });
  it('bounds cached fan-out to 25 jobs and drains the remainder without refetching',async()=>{
    for(let i=0;i<28;i++) await addCase();
    await processOne();
    expect((await pool.query("SELECT count(*)::int n FROM sophia_runtime.student_operations_document_jobs WHERE status='succeeded'")).rows[0].n).toBe(25);
    await processOne();expect(attachments).toHaveBeenCalledTimes(1);
    expect((await pool.query("SELECT count(*)::int n FROM sophia_runtime.student_operations_document_jobs WHERE status='succeeded'")).rows[0].n).toBe(28);
  });
  it('fences late results from an expired source lease',async()=>{
    await addCase();attachments.mockImplementation(async()=>{
      await pool.query("UPDATE sophia_runtime.student_operations_document_sources SET lease_token=gen_random_uuid(),lease_expires_at=now()+interval '2 minutes'");return [file];});
    await processOne();expect((await pool.query('SELECT * FROM sophia_runtime.student_operations_case_documents')).rows).toHaveLength(0);
    expect((await pool.query('SELECT checked_at FROM sophia_runtime.student_operations_document_sources')).rows[0].checked_at).toBeNull();
  });
  it('shares provider retry state across duplicate case jobs',async()=>{
    await addCase();await addCase();attachments.mockRejectedValue({getResponse:()=>({errorCode:'xero_rate_limited',retryAfterSeconds:120})});
    expect(await processOne()).toBe(false);expect(await processOne()).toBe(false);
    expect(attachments).toHaveBeenCalledTimes(1);expect(await budget()).toEqual([{attempted_sources:1}]);
  });
  it.each(['result','error'])('recovers an expired lease and ignores the old provider %s',async outcome=>{
    await addCase();let release!:(files:unknown[])=>void,reject!:(error:unknown)=>void,entered!:()=>void;
    const started=new Promise<void>(resolve=>{entered=resolve;});
    attachments.mockImplementationOnce(()=>{entered();return new Promise((resolve,fail)=>{release=resolve;reject=fail;});})
      .mockResolvedValue([{...file,fileName:'new-worker.pdf'}]);
    const old=processOne();await started;
    await pool.query(`UPDATE sophia_runtime.student_operations_document_sources SET lease_expires_at=now()-interval '1 minute';
      UPDATE sophia_runtime.student_operations_document_jobs SET lease_expires_at=now()-interval '1 minute'`);
    expect(await processOne()).toBe(true);
    if(outcome==='result') release([{...file,fileName:'old-worker.pdf'}]);
    else reject({getResponse:()=>({errorCode:'xero_rate_limited',retryAfterSeconds:86400})});
    await old;
    expect((await pool.query('SELECT file_name FROM sophia_runtime.student_operations_case_documents')).rows).toEqual([{file_name:'new-worker.pdf'}]);
    expect((await pool.query('SELECT blocked_until FROM sophia_runtime.student_operations_document_daily_budgets')).rows[0].blocked_until).toBeNull();
    expect(await budget()).toEqual([{attempted_sources:2}]);
  });
  it('keys cache by source kind and connection as well as source ID',async()=>{
    const second='66666666-6666-4666-8666-666666666666';
    await pool.query(`INSERT INTO sophia_runtime.xero_connections VALUES('${tenant}','${second}','active');
      INSERT INTO sophia_runtime.student_operations_xero_sync_configurations VALUES('${tenant}','${second}',true,'trust','2026-10-20Z');
      INSERT INTO sophia_runtime.student_operations_sync_checkpoints VALUES('${tenant}','${second}','2026-10-20Z');`);
    await addCase();await addCase(tenant,'Invoices');await addCase(tenant,'Contacts',source,second);
    await processOne();await processOne();await processOne();
    expect(attachments).toHaveBeenCalledTimes(3);
    expect((await pool.query('SELECT * FROM sophia_runtime.student_operations_document_sources')).rows).toHaveLength(3);
  });
  it('finishes a successful fifth attempt, but never starts a sixth attempt',async()=>{
    await addCase();await pool.query('UPDATE sophia_runtime.student_operations_document_jobs SET attempts=4');
    await processOne();expect((await pool.query('SELECT status,attempts FROM sophia_runtime.student_operations_document_jobs')).rows[0])
      .toEqual({status:'succeeded',attempts:5});
    await pool.query(`UPDATE sophia_runtime.student_operations_document_jobs SET status='queued';
      UPDATE sophia_runtime.student_operations_document_sources SET status='queued',attachments=NULL,checked_at=NULL,attempts=5;`);
    await processOne();expect(attachments).toHaveBeenCalledTimes(1);
    expect((await pool.query('SELECT status FROM sophia_runtime.student_operations_document_jobs')).rows[0].status).toBe('failed');
  });
  it('enforces source-cache tenant isolation and denies cross-tenant writes/deletion',async()=>{
    await addCase();await processOne();
    expect((await runtime.tenantReadTransaction(other,db=>db.query('SELECT * FROM sophia_runtime.student_operations_document_sources'))).rows).toHaveLength(0);
    expect((await runtime.query('SELECT * FROM sophia_runtime.student_operations_document_sources')).rows).toHaveLength(0);
    await expect(runtime.tenantTransaction(other,db=>db.query(`INSERT INTO sophia_runtime.student_operations_document_sources
      (customer_id,xero_connection_id,source_kind,source_id) VALUES($1,$2,'Contacts',$3)`,[tenant,connection,source])))
      .rejects.toMatchObject({code:'42501'});
    await expect(runtime.tenantTransaction(tenant,db=>db.query('DELETE FROM sophia_runtime.student_operations_document_sources')))
      .rejects.toMatchObject({code:'42501'});
  });
});
