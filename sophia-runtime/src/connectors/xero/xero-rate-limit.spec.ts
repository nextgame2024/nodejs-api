import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { xeroRateObservation, XeroSharedBackoff } from './xero-rate-limit.js';
import { XeroClient } from './xero.client.js';
import { XeroConnectorService } from './xero-connector.service.js';

afterEach(()=>jest.restoreAllMocks());
describe('Xero shared backoff',()=>{
  it('accepts zero allowances, but rejects malformed, negative and unsafe numbers',()=>{
    expect(xeroRateObservation(new Response('',{headers:{'X-DayLimit-Remaining':'0','X-MinLimit-Remaining':'-1',
      'X-AppMinLimit-Remaining':'999999999999999999999'}}))).toMatchObject({day:0,minute:null,appMinute:null,blockSeconds:86400});
    expect(xeroRateObservation(new Response('',{headers:{'X-DayLimit-Remaining':'', 'X-MinLimit-Remaining':'NaN'}})))
      .toMatchObject({day:null,minute:null,blockSeconds:0});
  });
  it.each([['day',null,86400],['minute',null,60],['app',null,60],['concurrent',null,60],['unknown',null,86400],
    ['day','123',123],['minute','0',1],['day','999999999',604800]])('429 %s Retry-After=%s waits %s seconds', (problem,retry,delay)=>{
    const headers:Record<string,string>={'X-Rate-Limit-Problem':problem};
    if(retry!==null) headers['Retry-After']=retry;
    expect(xeroRateObservation(new Response('',{status:429,headers})).blockSeconds).toBe(delay);
  });
  it('observes successful minute/app exhaustion without inventing a daily allowance',()=>{
    expect(xeroRateObservation(new Response('',{headers:{'X-AppMinLimit-Remaining':'0'}})))
      .toMatchObject({day:null,appMinute:0,blockSeconds:60});
  });
  it('does not treat an error response with zero headers as a successful allowance observation',()=>{
    expect(xeroRateObservation(new Response('',{status:503,headers:{'X-DayLimit-Remaining':'0'}})).blockSeconds).toBe(0);
  });
  it('does not fetch when admission fails, including binary downloads',async()=>{
    const fetchMock=jest.spyOn(globalThis,'fetch');
    const client=new XeroClient();
    const policy={beforeRequest:async()=>{throw new Error('cooldown');},observe:async()=>{}};
    await expect(client.withRequestPolicy(policy,()=>client.contactPage('secret','provider',1))).rejects.toThrow('cooldown');
    const id='11111111-1111-4111-8111-111111111111';
    await expect(client.withRequestPolicy(policy,()=>client.attachmentContent('secret','provider','Contacts',id,id))).rejects.toThrow('cooldown');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('persists a short 429 once and does not immediately retry it',async()=>{
    const fetchMock=jest.spyOn(globalThis,'fetch').mockResolvedValue(new Response('secret upstream body',
      {status:429,headers:{'Retry-After':'1','X-Rate-Limit-Problem':'minute'}}));
    const observe=jest.fn(async(_response:Response)=>{});
    const client=new XeroClient();
    await expect(client.withRequestPolicy({beforeRequest:async()=>{},observe},()=>client.contactPage('secret','provider',1)))
      .rejects.toMatchObject({response:expect.objectContaining({errorCode:'xero_rate_limited',retryAfterSeconds:1,rateLimitProblem:'minute'})});
    expect(fetchMock).toHaveBeenCalledTimes(1);expect(observe).toHaveBeenCalledTimes(1);
  });
  it('does not rapidly retry a 429 with missing Retry-After even without the feature flag',async()=>{
    const fetchMock=jest.spyOn(globalThis,'fetch').mockResolvedValue(new Response('',{status:429}));
    await expect(new XeroClient().contactPage('secret','provider',1))
      .rejects.toMatchObject({response:expect.objectContaining({errorCode:'xero_rate_limited',retryAfterSeconds:86400})});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('observes binary response headers as well as metadata responses',async()=>{
    jest.spyOn(globalThis,'fetch').mockResolvedValue(new Response('file',{headers:{'X-DayLimit-Remaining':'17'}}));
    const observe=jest.fn(async(_response:Response)=>{});
    const id='11111111-1111-4111-8111-111111111111',client=new XeroClient();
    const result=await client.withRequestPolicy({beforeRequest:async()=>{},observe},
      ()=>client.attachmentContent('secret','provider','Contacts',id,id));
    expect(result.toString()).toBe('file');expect(observe).toHaveBeenCalledTimes(1);
    expect(xeroRateObservation(observe.mock.calls[0][0]).day).toBe(17);
  });
  it.each(['syncContactPage','syncInvoicePage','syncCreditNotePage','syncPrepaymentPage','syncOverpaymentPage','attachments','attachmentContent'] as const)
    ('connector %s uses the shared guard when enabled',async method=>{
      const previous=process.env.XERO_SHARED_BACKOFF_ENABLED,oldUrl=process.env.SOPHIA_RUNTIME_DATABASE_URL;
      process.env.XERO_SHARED_BACKOFF_ENABLED='true';process.env.SOPHIA_RUNTIME_DATABASE_URL='postgresql://example.invalid/runtime';
      try {
        const fetchMock=jest.spyOn(globalThis,'fetch');
        const database={tenantReadTransaction:async(_tenant:string,work:(db:unknown)=>Promise<unknown>)=>
          work({query:async()=>({rows:[{seconds:60}]})})};
        const service=new XeroConnectorService(database as never,new XeroClient(),{} as never);
        Object.assign(service,{syncAccess:async()=>({connection:{xero_tenant_id:'provider'},accessToken:'secret'}),
          attachmentAccess:async()=>({connection:{xero_tenant_id:'provider'},accessToken:'secret'})});
        const id='11111111-1111-4111-8111-111111111111';
        const request=method==='attachments' ? service.attachments('tenant',id,'Contacts',id)
          : method==='attachmentContent' ? service.attachmentContent('tenant',id,'Contacts',id,id)
          : service[method]('tenant',id,1);
        await expect(request).rejects.toMatchObject({response:expect.objectContaining({errorCode:'xero_rate_limited'})});
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        if(previous===undefined) delete process.env.XERO_SHARED_BACKOFF_ENABLED;else process.env.XERO_SHARED_BACKOFF_ENABLED=previous;
        if(oldUrl===undefined) delete process.env.SOPHIA_RUNTIME_DATABASE_URL;else process.env.SOPHIA_RUNTIME_DATABASE_URL=oldUrl;
      }
    });
  it('keeps concurrent request policies isolated',async()=>{
    jest.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>{
      const tenant=(init?.headers as Record<string,string>)['xero-tenant-id'];
      return new Response(JSON.stringify({Contacts:[]}),{headers:{'X-DayLimit-Remaining':tenant==='a'?'12':'34'}});
    });
    const seenA:number[]=[],seenB:number[]=[];
    const client=new XeroClient();
    await Promise.all([['a',seenA],['b',seenB]].map(([tenant,seen])=>client.withRequestPolicy({
      beforeRequest:async()=>{},observe:async r=>{(seen as number[]).push(xeroRateObservation(r).day!);},
    },()=>client.contactPage('secret',tenant as string,1))));
    expect(seenA).toEqual([12]);expect(seenB).toEqual([34]);
  });
  it('fails closed if the observation store is unavailable',async()=>{
    const fetchMock=jest.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({Contacts:[]}),
      {headers:{'X-DayLimit-Remaining':'99'}}));
    const policy={beforeRequest:async()=>{},observe:async()=>{throw new Error('store unavailable');}};
    const client=new XeroClient();
    await expect(client.withRequestPolicy(policy,()=>client.contactPage('secret','provider',1))).rejects.toThrow('store unavailable');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('checks the tenant-scoped store before requests and emits only safe cooldown fields',async()=>{
    const oldUrl=process.env.SOPHIA_RUNTIME_DATABASE_URL;
    process.env.SOPHIA_RUNTIME_DATABASE_URL='postgresql://example.invalid/runtime';
    try {
      const query=jest.fn(async()=>({rows:[{seconds:42}]}));
      const database={tenantReadTransaction:jest.fn(async(_tenant:string,work:(db:unknown)=>Promise<unknown>)=>work({query}))};
      const policy=new XeroSharedBackoff(database as never).policy('customer','connection');
      await expect(policy.beforeRequest()).rejects.toMatchObject({response:{
        message:expect.any(String),errorCode:'xero_rate_limited',providerStatus:429,retryAfterSeconds:42,
      }});
      expect(database.tenantReadTransaction).toHaveBeenCalledWith('customer',expect.any(Function));
      expect(query).toHaveBeenCalledWith(expect.stringContaining('blocked_until>now()'),['customer','connection']);
    } finally {if(oldUrl===undefined) delete process.env.SOPHIA_RUNTIME_DATABASE_URL;else process.env.SOPHIA_RUNTIME_DATABASE_URL=oldUrl;}
  });
});
