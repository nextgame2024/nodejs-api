import {jest} from '@jest/globals';
import {StudentSyncHealth} from './student-sync-health.js';

const customer='11111111-1111-4111-8111-111111111111';
const env={...process.env};
const base={connection_id:'33333333-3333-4333-8333-333333333333',document_window:true,dependency_ready:true,
  import_pending:false,import_error:false,queued:'3',processing:'0',succeeded:'10',failed:'0',cached_sources:'4',failed_sources:'0',
  attempted_sources:4,batch_closed:false,quota_known:true,remaining:500,discovery_reserve:200,cooling_down:false,
  last_successful_sync_at:new Date('2026-10-21T00:00:00Z'),last_source_check_at:null,observed_at:null,refresh_after:null,blocked_until:null};
const query=jest.fn<(...args:unknown[])=>Promise<unknown>>();
const read=jest.fn(async(_customer:string,work:(client:unknown)=>Promise<unknown>)=>work({query}));
const service=new StudentSyncHealth({tenantReadTransaction:read} as never);
beforeAll(()=>{process.env.SOPHIA_RUNTIME_DATABASE_URL='postgresql://example.invalid/runtime';});
afterAll(()=>{for(const key of ['STUDENT_SYNC_HEALTH_LOGS_ENABLED','SOPHIA_RUNTIME_DATABASE_URL']) {
  if(env[key]===undefined) delete process.env[key];else process.env[key]=env[key];
}});
beforeEach(()=>{process.env.STUDENT_SYNC_HEALTH_LOGS_ENABLED='true';jest.clearAllMocks();
  query.mockReset();query.mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[base]});});
it('is disabled by default and performs no database work',async()=>{
  delete process.env.STUDENT_SYNC_HEALTH_LOGS_ENABLED;
  expect(await service.report(customer)).toBeNull();expect(read).not.toHaveBeenCalled();
});
it('reports bounded allowlisted observations, not a completed-backlog guarantee',async()=>{
  const result=await service.report(customer);
  expect(result).toMatchObject({status:'observed',signals:[],pauses:[],counts:{queued:3,succeeded:10},quota:{remaining:500,reserve:200}});
  expect(read).toHaveBeenCalledWith(customer,expect.any(Function));
  expect(query.mock.calls[0]).toEqual(["SET LOCAL statement_timeout='5s'"]);
  expect(query.mock.calls[1][1]).toEqual([customer,30]);
});
it.each([
  [{document_window:false},'outside_document_window'],[{import_pending:true},'import_pending'],
  [{dependency_ready:false},'reconciliation_pending'],[{cooling_down:true},'provider_cooldown'],
  [{quota_known:false},'quota_unknown'],[{remaining:200},'discovery_quota_reserved'],[{batch_closed:true},'document_batch_closed'],
])('distinguishes expected pauses from failed work (%s)',async(overrides,reason)=>{
  query.mockReset();query.mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{...base,...overrides}]});
  const result=await service.report(customer);expect(result).toMatchObject({status:'paused',signals:[],pauses:[reason]});
  if(reason==='quota_unknown') expect(result).toMatchObject({quota:{remaining:null}});
});
it.each([[{failed:'2'},'document_jobs_failed'],[{failed_sources:'1'},'document_sources_failed'],[{import_error:true},'invoice_sync_error']])
  ('emits actionable failure signals (%s)',async(overrides,signal)=>{
    query.mockReset();query.mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{...base,...overrides}]});
    expect(await service.report(customer)).toMatchObject({status:'attention',signals:[signal]});
  });
it('does not claim health without an active tenant-scoped TRUST connection',async()=>{
  query.mockReset();query.mockResolvedValue({rows:[]});
  expect(await service.report(customer)).toEqual({customerId:customer,status:'unknown',signals:['no_active_trust_connection']});
});
it('never spreads extra DB/provider fields into logs',async()=>{
  query.mockReset();query.mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{...base,
    email:'private-secret',file_name:'private-secret',provider_body:'private-secret',access_token:'private-secret'}]});
  expect(JSON.stringify(await service.report(customer))).not.toContain('private-secret');
});
it('propagates a read failure to the coordinator without constructing a false healthy report',async()=>{
  query.mockReset();query.mockRejectedValue(new Error('private-secret'));
  await expect(service.report(customer)).rejects.toThrow('private-secret');
});
