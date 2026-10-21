import { jest } from '@jest/globals';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { DatabaseService } from './database.service.js';
import { XeroQuotaAdmission } from '../connectors/xero/xero-quota-admission.js';
import { XeroSharedBackoff } from '../connectors/xero/xero-rate-limit.js';
import { XeroClient } from '../connectors/xero/xero.client.js';

const url=process.env.LOCAL_XERO_QUOTA_TEST_DATABASE_URL;
if(url && (!['localhost','127.0.0.1'].includes(new URL(url).hostname)
  || !new URL(url).pathname.startsWith('/xero_quota_test_'))) throw new Error('Disposable local xero_quota_test_ database required.');
const suite=url?describe:describe.skip;
const tenant='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const connection='33333333-3333-4333-8333-333333333333';
suite('Atomic Xero quota admission under PostgreSQL RLS',()=>{
  const pool=new Pool({connectionString:url,max:4}),env={...process.env};let runtime:DatabaseService,quota:XeroQuotaAdmission;
  beforeAll(async()=>{
    await pool.query(`DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='sophia_runtime_app') THEN
      CREATE ROLE sophia_runtime_app NOLOGIN NOBYPASSRLS; END IF; END $$;
      CREATE SCHEMA sophia_runtime;GRANT USAGE ON SCHEMA sophia_runtime TO sophia_runtime_app;
      CREATE TABLE sophia_runtime.xero_connections(customer_id uuid,xero_connection_id uuid,UNIQUE(customer_id,xero_connection_id));
      INSERT INTO sophia_runtime.xero_connections VALUES('${tenant}','${connection}'),('${other}','${connection}');`);
    for(const file of ['082_xero_connection_rate_limits.sql','084_xero_quota_admission.sql'])
      await pool.query((await readFile(new URL(`./migrations/${file}`,import.meta.url),'utf8')).replaceAll('__SOPHIA_RUNTIME_SCHEMA__','sophia_runtime'));
    process.env.SOPHIA_RUNTIME_DATABASE_URL=url;process.env.SOPHIA_RUNTIME_DB_SSL='false';process.env.SOPHIA_RUNTIME_DATABASE_ROLE='sophia_runtime_app';
    process.env.XERO_SHARED_QUOTA_ENABLED='true';process.env.XERO_SHARED_BACKOFF_ENABLED='true';
    runtime=new DatabaseService();quota=new XeroQuotaAdmission(runtime);
  });
  afterAll(async()=>{
    await runtime?.onModuleDestroy();await pool.end();
    for(const key of ['SOPHIA_RUNTIME_DATABASE_URL','SOPHIA_RUNTIME_DB_SSL','SOPHIA_RUNTIME_DATABASE_ROLE','XERO_SHARED_QUOTA_ENABLED','XERO_SHARED_BACKOFF_ENABLED']) {
      if(env[key]===undefined) delete process.env[key];else process.env[key]=env[key];
    }
  });
  beforeEach(async()=>{await pool.query('TRUNCATE sophia_runtime.xero_quota_admission,sophia_runtime.xero_connection_rate_limits');});
  afterEach(()=>jest.restoreAllMocks());
  const state=async()=>(await pool.query('SELECT * FROM sophia_runtime.xero_quota_admission WHERE customer_id=$1',[tenant])).rows[0];
  async function ready(remaining=999) {
    const ticket=await quota.reserve(tenant,connection,'operational');
    await quota.observe(tenant,connection,ticket,{day:remaining,problem:null,retryAfterSeconds:null},200);
    return ticket;
  }
  it('holds unknown discovery but permits one real operational request to establish allowance',async()=>{
    await expect(quota.reserve(tenant,connection,'discovery')).rejects.toMatchObject({response:expect.objectContaining({errorCode:'xero_quota_unknown'})});
    const ticket=await quota.reserve(tenant,connection,'operational');
    await expect(quota.reserve(tenant,connection,'operational')).rejects.toMatchObject({response:expect.objectContaining({errorCode:'xero_quota_unknown'})});
    await quota.observe(tenant,connection,ticket,{day:450,problem:null,retryAfterSeconds:null},200);
    await expect(quota.reserve(tenant,connection,'discovery')).resolves.toBeDefined();
    expect((await state()).remaining).toBe(449);
  });
  it('reserves exactly one of the last backlog credits under concurrent admission',async()=>{
    await ready(201);
    const results=await Promise.allSettled(Array.from({length:6},()=>quota.reserve(tenant,connection,'discovery')));
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    expect(await state()).toMatchObject({remaining:200,discovery_admissions:'1',operational_admissions:'1'});
    await quota.reserve(tenant,connection,'operational');expect((await state()).remaining).toBe(199);
  });
  it('prevents operational requests from exceeding the remaining allowance',async()=>{
    await ready(1);
    const result=await Promise.allSettled([quota.reserve(tenant,connection,'operational'),quota.reserve(tenant,connection,'operational')]);
    expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect((await state()).remaining).toBe(0);
  });
  it('never replenishes credits from late high headers and subtracts later admissions',async()=>{
    await ready(500);const a=await quota.reserve(tenant,connection,'operational'),b=await quota.reserve(tenant,connection,'operational');
    await quota.observe(tenant,connection,b,{day:498,problem:null,retryAfterSeconds:null},200);
    await quota.observe(tenant,connection,a,{day:499,problem:null,retryAfterSeconds:null},200);
    expect((await state()).remaining).toBe(498);
    await quota.observe(tenant,connection,b,{day:999,problem:null,retryAfterSeconds:null},200);
    expect((await state()).remaining).toBe(498);
  });
  it('clamps header credit by the configured cap and all admissions in the generation',async()=>{
    await ready(5000);expect((await state()).remaining).toBe(999);
    await pool.query('UPDATE sophia_runtime.xero_quota_admission SET remaining=900,generation_admissions=1000');
    await expect(quota.reserve(tenant,connection,'operational')).rejects.toMatchObject({response:expect.objectContaining({errorCode:'xero_quota_exhausted'})});
  });
  it('honors a provider daily reset hint without resetting at Brisbane midnight',async()=>{
    const ticket=await ready();
    await quota.observe(tenant,connection,ticket,{day:0,problem:'day',retryAfterSeconds:120},429);
    const seconds=(await pool.query('SELECT extract(epoch FROM refresh_after-now())::int n FROM sophia_runtime.xero_quota_admission')).rows[0].n;
    expect(seconds).toBeGreaterThan(110);expect(seconds).toBeLessThanOrEqual(120);
    await expect(quota.reserve(tenant,connection,'operational')).rejects.toMatchObject({response:expect.objectContaining({errorCode:'xero_quota_exhausted'})});
  });
  it('fences old-generation responses after the next real request re-establishes allowance',async()=>{
    const old=await ready(10);await pool.query("UPDATE sophia_runtime.xero_quota_admission SET refresh_after=now()-interval '1 second'");
    const current=await quota.reserve(tenant,connection,'operational');
    await quota.observe(tenant,connection,old,{day:999,problem:null,retryAfterSeconds:null},200);
    expect((await state()).remaining).toBeNull();
    await quota.observe(tenant,connection,current,{day:950,problem:null,retryAfterSeconds:null},200);
    expect((await state()).remaining).toBe(950);
  });
  it('carries a known provider reset cadence forward without blindly granting a new allowance',async()=>{
    await ready();
    await pool.query("UPDATE sophia_runtime.xero_quota_admission SET remaining=0,refresh_after=now()-interval '1 hour',provider_reset_at=now()-interval '1 hour'");
    await expect(quota.reserve(tenant,connection,'discovery')).rejects.toThrow();
    expect((await state()).remaining).toBeNull();
    const seconds=(await pool.query('SELECT extract(epoch FROM refresh_after-now())::int n FROM sophia_runtime.xero_quota_admission')).rows[0].n;
    expect(seconds).toBeGreaterThan(82790);expect(seconds).toBeLessThanOrEqual(82800);
    await expect(quota.reserve(tenant,connection,'operational')).resolves.toBeDefined();
  });
  it('uses a known provider reset instead of extending a successful zero-balance response to 24 hours',async()=>{
    await ready(1);
    await pool.query("UPDATE sophia_runtime.xero_quota_admission SET refresh_after=now()+interval '1 hour',provider_reset_at=now()-interval '23 hours'");
    const policy=new XeroSharedBackoff(runtime).policy(tenant,connection);
    const ticket=await policy.beforeRequest();
    await policy.observe(new Response('',{headers:{'X-DayLimit-Remaining':'0'}}),ticket);
    const seconds=(await pool.query('SELECT extract(epoch FROM blocked_until-now())::int n FROM sophia_runtime.xero_connection_rate_limits')).rows[0].n;
    expect(seconds).toBeGreaterThan(3590);expect(seconds).toBeLessThanOrEqual(3601);
  });
  it('keeps missing responses charged and rate-limits unknown-balance recovery',async()=>{
    await quota.reserve(tenant,connection,'operational');
    await expect(quota.reserve(tenant,connection,'operational')).rejects.toThrow();
    await pool.query("UPDATE sophia_runtime.xero_quota_admission SET probe_until=now()-interval '1 second'");
    await quota.reserve(tenant,connection,'operational');
    expect(await state()).toMatchObject({remaining:null,generation_admissions:2,operational_admissions:'2'});
  });
  it('shares counters after a service restart and isolates another customer',async()=>{
    await ready(201);await quota.reserve(tenant,connection,'discovery');
    const restarted=new DatabaseService();
    try {
      await expect(new XeroQuotaAdmission(restarted).reserve(tenant,connection,'discovery')).rejects.toMatchObject({response:expect.objectContaining({errorCode:'xero_quota_reserved'})});
      await expect(new XeroQuotaAdmission(restarted).reserve(other,connection,'operational')).resolves.toBeDefined();
    } finally {await restarted.onModuleDestroy();}
  });
  it('denies application changes to headroom/configuration, cross-tenant writes and deletion',async()=>{
    await ready();
    expect((await runtime.tenantReadTransaction(other,db=>db.query('SELECT * FROM sophia_runtime.xero_quota_admission'))).rows).toHaveLength(0);
    await expect(runtime.tenantTransaction(tenant,db=>db.query('UPDATE sophia_runtime.xero_quota_admission SET discovery_reserve=0'))).rejects.toMatchObject({code:'42501'});
    await expect(runtime.tenantTransaction(other,db=>db.query('INSERT INTO sophia_runtime.xero_quota_admission(customer_id,xero_connection_id) VALUES($1,$2)',[tenant,connection]))).rejects.toMatchObject({code:'42501'});
    await expect(runtime.tenantTransaction(tenant,db=>db.query('DELETE FROM sophia_runtime.xero_quota_admission'))).rejects.toMatchObject({code:'42501'});
  });
  it('budgets each binary download through the real client policy',async()=>{
    await ready(500);
    const fetchMock=jest.spyOn(globalThis,'fetch').mockResolvedValue(new Response('file',{headers:{'X-DayLimit-Remaining':'499'}}));
    const client=new XeroClient(),id='44444444-4444-4444-8444-444444444444';
    await client.withRequestPolicy(new XeroSharedBackoff(runtime).policy(tenant,connection),()=>client.attachmentContent('secret','provider','Contacts',id,id));
    expect(fetchMock).toHaveBeenCalledTimes(1);expect(await state()).toMatchObject({remaining:499,operational_admissions:'2'});
  });
  it('charges every HTTP retry and preserves headroom when a retry cannot be admitted',async()=>{
    await ready(201);
    const fetchMock=jest.spyOn(globalThis,'fetch').mockResolvedValue(new Response('',{status:503,headers:{'X-DayLimit-Remaining':'200'}}));
    const client=new XeroClient(),id='44444444-4444-4444-8444-444444444444';
    await expect(client.withRequestPolicy(new XeroSharedBackoff(runtime).policy(tenant,connection,'discovery'),()=>client.attachments('secret','provider','Contacts',id)))
      .rejects.toMatchObject({response:expect.objectContaining({errorCode:'xero_quota_reserved',upstreamAttempted:true})});
    expect(fetchMock).toHaveBeenCalledTimes(1);expect((await state()).discovery_admissions).toBe('1');
  });
  it('charges two actual requests when a transient failure is retried successfully',async()=>{
    await ready(500);
    const fetchMock=jest.spyOn(globalThis,'fetch').mockResolvedValueOnce(new Response('',{status:503,headers:{'X-DayLimit-Remaining':'499'}}))
      .mockResolvedValueOnce(new Response(JSON.stringify({Attachments:[]}),{headers:{'X-DayLimit-Remaining':'498'}}));
    const client=new XeroClient(),id='44444444-4444-4444-8444-444444444444';
    await client.withRequestPolicy(new XeroSharedBackoff(runtime).policy(tenant,connection,'discovery'),()=>client.attachments('secret','provider','Contacts',id));
    expect(fetchMock).toHaveBeenCalledTimes(2);expect(await state()).toMatchObject({remaining:498,discovery_admissions:'2'});
  });
});
