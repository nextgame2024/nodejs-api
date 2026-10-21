import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { DatabaseService } from './database.service.js';
import { XeroSharedBackoff } from '../connectors/xero/xero-rate-limit.js';
import { StudentOperationsCaseDocumentsService } from '../business-packs/student-operations/student-operations-case-documents.service.js';
import { jest } from '@jest/globals';

const url=process.env.LOCAL_XERO_BACKOFF_TEST_DATABASE_URL;
if(url && (!['localhost','127.0.0.1'].includes(new URL(url).hostname)
  || !new URL(url).pathname.startsWith('/xero_backoff_test_'))) throw new Error('Disposable local xero_backoff_test_ database required.');
const suite=url?describe:describe.skip;
const tenant='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const connection='33333333-3333-4333-8333-333333333333';
suite('Shared Xero cooldown under non-BYPASSRLS PostgreSQL',()=>{
  const pool=new Pool({connectionString:url,max:3});let runtime:DatabaseService;
  const env={...process.env};
  beforeAll(async()=>{
    await pool.query(`DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='sophia_runtime_app') THEN
      CREATE ROLE sophia_runtime_app NOLOGIN NOBYPASSRLS; END IF; END $$;
      CREATE SCHEMA sophia_runtime; GRANT USAGE ON SCHEMA sophia_runtime TO sophia_runtime_app;
      CREATE TABLE sophia_runtime.xero_connections(customer_id uuid,xero_connection_id uuid,UNIQUE(xero_connection_id,customer_id));
      INSERT INTO sophia_runtime.xero_connections VALUES('${tenant}','${connection}'),('${other}','${connection}');`);
    await pool.query((await readFile(new URL('./migrations/082_xero_connection_rate_limits.sql',import.meta.url),'utf8'))
      .replaceAll('__SOPHIA_RUNTIME_SCHEMA__','sophia_runtime'));
    process.env.SOPHIA_RUNTIME_DATABASE_URL=url;process.env.SOPHIA_RUNTIME_DB_SSL='false';
    process.env.SOPHIA_RUNTIME_DATABASE_ROLE='sophia_runtime_app';process.env.XERO_SHARED_BACKOFF_ENABLED='true';
    runtime=new DatabaseService();
  });
  afterAll(async()=>{
    await runtime?.onModuleDestroy();await pool.end();
    for(const key of ['SOPHIA_RUNTIME_DATABASE_URL','SOPHIA_RUNTIME_DB_SSL','SOPHIA_RUNTIME_DATABASE_ROLE','XERO_SHARED_BACKOFF_ENABLED']) {
      if(env[key]===undefined) delete process.env[key];else process.env[key]=env[key];
    }
  });
  beforeEach(async()=>{await pool.query('TRUNCATE sophia_runtime.xero_connection_rate_limits');});
  it('persists a provider cooldown across separate database clients and policy instances',async()=>{
    const first=new XeroSharedBackoff(runtime).policy(tenant,connection);
    await first.beforeRequest();
    await first.observe(new Response('',{status:429,headers:{'Retry-After':'120','X-Rate-Limit-Problem':'minute'}}));
    const secondRuntime=new DatabaseService();
    try {
      await expect(new XeroSharedBackoff(secondRuntime).policy(tenant,connection).beforeRequest())
        .rejects.toMatchObject({response:expect.objectContaining({errorCode:'xero_rate_limited',retryAfterSeconds:expect.any(Number)})});
    } finally {await secondRuntime.onModuleDestroy();}
    await expect(new XeroSharedBackoff(runtime).policy(other,connection).beforeRequest()).resolves.toBeUndefined();
  });
  it('stores header observations without treating the nightly source cap as a provider quota',async()=>{
    await new XeroSharedBackoff(runtime).policy(tenant,connection).observe(new Response('',{headers:{
      'X-DayLimit-Remaining':'418','X-MinLimit-Remaining':'59','X-AppMinLimit-Remaining':'9000'}}));
    const result=await runtime.tenantReadTransaction(tenant,db=>db.query('SELECT * FROM sophia_runtime.xero_connection_rate_limits'));
    expect(result.rows[0]).toMatchObject({day_remaining:'418',minute_remaining:'59',app_minute_remaining:'9000',blocked_until:null});
  });
  it('a late successful response cannot shorten an already-published cooldown',async()=>{
    const policy=new XeroSharedBackoff(runtime).policy(tenant,connection);
    await policy.observe(new Response('',{status:429,headers:{'Retry-After':'600'}}));
    const before=(await pool.query('SELECT blocked_until FROM sophia_runtime.xero_connection_rate_limits')).rows[0].blocked_until;
    await Promise.all([
      policy.observe(new Response('',{headers:{'X-MinLimit-Remaining':'59'}})),
      policy.observe(new Response('',{status:429,headers:{'Retry-After':'30'}})),
    ]);
    expect((await pool.query('SELECT blocked_until FROM sophia_runtime.xero_connection_rate_limits')).rows[0].blocked_until).toEqual(before);
  });
  it('allows another call after the persisted cooldown expires',async()=>{
    const policy=new XeroSharedBackoff(runtime).policy(tenant,connection);
    await policy.observe(new Response('',{status:429}));
    await runtime.tenantTransaction(tenant,db=>db.query("UPDATE sophia_runtime.xero_connection_rate_limits SET blocked_until=now()-interval '1 second'"));
    await expect(policy.beforeRequest()).resolves.toBeUndefined();
  });
  it('enforces role/tenant isolation, rejects cross-tenant writes and denies deletion',async()=>{
    await new XeroSharedBackoff(runtime).policy(tenant,connection).observe(new Response('',{status:429}));
    expect((await runtime.tenantReadTransaction(other,db=>db.query('SELECT * FROM sophia_runtime.xero_connection_rate_limits'))).rows).toHaveLength(0);
    const role=await runtime.tenantReadTransaction(tenant,db=>db.query('SELECT current_user,rolbypassrls FROM pg_roles WHERE rolname=current_user'));
    expect(role.rows[0]).toEqual({current_user:'sophia_runtime_app',rolbypassrls:false});
    await expect(runtime.tenantTransaction(other,db=>db.query(`INSERT INTO sophia_runtime.xero_connection_rate_limits(customer_id,xero_connection_id) VALUES($1,$2)`,[tenant,connection])))
      .rejects.toMatchObject({code:'42501'});
    await expect(runtime.tenantTransaction(tenant,db=>db.query('DELETE FROM sophia_runtime.xero_connection_rate_limits')))
      .rejects.toMatchObject({code:'42501'});
  });
  it('does not consume a document lease/attempt while a known cooldown is active',async()=>{
    // Thin document fixture isolates the admission guard; no provider is called.
    await pool.query(`CREATE TABLE sophia_runtime.student_operations_document_jobs(customer_id uuid,job_id uuid DEFAULT gen_random_uuid(),
      xero_connection_id uuid,status text DEFAULT 'queued',attempts int DEFAULT 0,next_attempt_at timestamptz DEFAULT now(),
      lease_token uuid,lease_expires_at timestamptz,error_code text,updated_at timestamptz);
      GRANT SELECT,UPDATE ON sophia_runtime.student_operations_document_jobs TO sophia_runtime_app;
      INSERT INTO sophia_runtime.student_operations_document_jobs(customer_id,xero_connection_id) VALUES('${tenant}','${connection}');`);
    const oldPipeline=process.env.STUDENT_SYNC_PIPELINE_ENABLED;delete process.env.STUDENT_SYNC_PIPELINE_ENABLED;
    try {
      await new XeroSharedBackoff(runtime).policy(tenant,connection).observe(new Response('',{status:429}));
      const attachments=jest.fn(async()=>[]);
      const documents=new StudentOperationsCaseDocumentsService(runtime,{} as never,{attachments} as never);
      expect(await documents.processOne(tenant)).toBe(false);
      expect(attachments).not.toHaveBeenCalled();
      expect((await pool.query('SELECT status,attempts,lease_token FROM sophia_runtime.student_operations_document_jobs')).rows[0])
        .toEqual({status:'queued',attempts:0,lease_token:null});
    } finally {if(oldPipeline===undefined) delete process.env.STUDENT_SYNC_PIPELINE_ENABLED;else process.env.STUDENT_SYNC_PIPELINE_ENABLED=oldPipeline;}
  });
});
