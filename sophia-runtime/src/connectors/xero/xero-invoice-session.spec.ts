import {afterEach,beforeEach,describe,expect,it,jest} from '@jest/globals';
import {XeroConnectorService} from './xero-connector.service.js';

const settings={XERO_INVOICE_CREATION_ENABLED:'true',XERO_INVOICE_BRANDING_THEME_NAME:'Trust Open for Australia acc',XERO_SHARED_BACKOFF_ENABLED:'true',XERO_SHARED_QUOTA_ENABLED:'false',XERO_CLIENT_ID:'fixture',XERO_CLIENT_SECRET:'fixture',
  XERO_REDIRECT_URI:'https://example.test/callback',XERO_RETURN_URL:'https://example.test/return',XERO_OAUTH_STATE_SECRET:'x'.repeat(32),XERO_TOKEN_ENCRYPTION_KEY:Buffer.alloc(32).toString('base64'),SOPHIA_RUNTIME_DATABASE_URL:'postgresql://example.invalid/runtime'};
const previous=Object.fromEntries(Object.keys(settings).map(key=>[key,process.env[key]]));
const value={contactId:'contact',date:'2026-10-28',dueDate:'2026-10-28',reference:null,currencyCode:'AUD',lines:[]};
describe('request-scoped Xero invoice session',()=>{
  beforeEach(()=>{Object.assign(process.env,settings);});
  afterEach(()=>{jest.restoreAllMocks();for(const [key,old] of Object.entries(previous)){if(old===undefined)delete process.env[key];else process.env[key]=old;}});
  function fixture(){
    let scopes=['accounting.invoices','accounting.settings.read'];
    const query=jest.fn(async(sql:string,params:unknown[])=>({rows:sql.includes('token_ciphertext')
      ?[{token_ciphertext:params[0],token_expires_at:new Date(Date.now()+1800_000),status:'active'}]
      :[{xero_authorization_id:'authorization',xero_tenant_id:`provider-${params[0]}`,status:'active',granted_scopes:scopes}]}));
    const transact=jest.fn(async(_tenant:string,work:(db:unknown)=>Promise<unknown>)=>work({query}));
    const client={createInvoice:jest.fn(async()=>({invoiceId:'created'})),invoiceById:jest.fn(async()=>({invoiceId:'created'})),brandingThemes:jest.fn(async()=>[{brandingThemeId:'11111111-1111-4111-8111-111111111111',name:'Trust Open for Australia acc'}]),
      trackingCategories:jest.fn(async()=>[{trackingCategoryId:'22222222-2222-4222-8222-222222222222',name:'Payment Track',options:[{trackingOptionId:'33333333-3333-4333-8333-333333333333',name:'Pending'}]}]),
      withRequestPolicy:jest.fn(async(_policy:unknown,work:()=>Promise<unknown>)=>work())};
    const crypto={open:(cipher:string)=>JSON.stringify({accessToken:`token-${cipher}`,refreshToken:'refresh'})};
    const service=new XeroConnectorService({tenantTransaction:transact,tenantReadTransaction:transact} as never,client as never,crypto as never);
    return {service,client,query,revoke:()=>{scopes=[];},revokeSettings:()=>{scopes=['accounting.invoices'];}};
  }
  it('shares connection/token work within a batch while every call keeps its own rate-limit policy',async()=>{
    const f=fixture(),session=await f.service.invoiceCreationSession('tenant-a','connection-a');
    await Promise.all([session.createInvoice(value,'key-1'),session.createInvoice(value,'key-2'),session.invoiceById('created')]);
    expect(f.query).toHaveBeenCalledTimes(2);expect(f.client.withRequestPolicy).toHaveBeenCalledTimes(5);expect(f.client.brandingThemes).toHaveBeenCalledTimes(1);expect(f.client.trackingCategories).toHaveBeenCalledTimes(1);
    expect(f.client.createInvoice).toHaveBeenCalledWith('token-tenant-a','provider-tenant-a',{...value,brandingThemeId:'11111111-1111-4111-8111-111111111111'},'key-1');
    const other=await f.service.invoiceCreationSession('tenant-b','connection-b');await other.createInvoice(value,'key-3');
    expect(f.query).toHaveBeenCalledTimes(4);expect(f.client.createInvoice).toHaveBeenLastCalledWith('token-tenant-b','provider-tenant-b',{...value,brandingThemeId:'11111111-1111-4111-8111-111111111111'},'key-3');expect(f.client.brandingThemes).toHaveBeenCalledTimes(2);
  });
  it('refreshes the batch context once after a minute and respects revoked authorization',async()=>{
    const f=fixture(),clock=jest.spyOn(Date,'now'),started=Date.now(),session=await f.service.invoiceCreationSession('tenant-a','connection-a');
    clock.mockReturnValue(started+61_000);
    await Promise.all([session.createInvoice(value,'key-1'),session.createInvoice(value,'key-2'),session.invoiceById('created')]);
    expect(f.query).toHaveBeenCalledTimes(4);
    f.revoke();clock.mockReturnValue(started+122_000);
    await expect(session.createInvoice(value,'key-3')).rejects.toThrow('authorize invoice creation');expect(f.client.createInvoice).toHaveBeenCalledTimes(2);
  });
  it('enforces the creation feature flag even on an already prepared session',async()=>{
    const f=fixture(),session=await f.service.invoiceCreationSession('tenant-a','connection-a');process.env.XERO_INVOICE_CREATION_ENABLED='false';
    await expect(session.createInvoice(value,'key-1')).rejects.toThrow('enable Xero invoice creation');expect(f.client.createInvoice).not.toHaveBeenCalled();
  });
  it('blocks all sends for missing, ambiguous or unavailable branding without using a caller-supplied theme',async()=>{
    for(const failure of ['missing','duplicate','unavailable']){
      const f=fixture(),theme={brandingThemeId:'11111111-1111-4111-8111-111111111111',name:'Trust Open for Australia acc'};
      if(failure==='unavailable')f.client.brandingThemes.mockRejectedValue(new Error('sensitive provider detail'));
      else f.client.brandingThemes.mockResolvedValue(failure==='missing'?[]:[theme,theme]);
      const session=await f.service.invoiceCreationSession('tenant-a','connection-a');
      const results=await Promise.allSettled([session.createInvoice({...value,brandingThemeId:'wrong'},'key-1'),session.createInvoice(value,'key-2')]);
      expect(results.every(r=>r.status==='rejected')).toBe(true);expect(f.client.createInvoice).not.toHaveBeenCalled();expect(f.client.brandingThemes).toHaveBeenCalledTimes(1);
    }
  });
  it('requires settings-read scope before looking up branding and sends nothing when it is missing',async()=>{
    const f=fixture();f.revokeSettings();const session=await f.service.invoiceCreationSession('tenant-a','connection-a');
    await expect(session.createInvoice(value,'key')).rejects.toThrow('settings access');expect(f.client.brandingThemes).not.toHaveBeenCalled();expect(f.client.createInvoice).not.toHaveBeenCalled();
  });
  it('uses Xero exact Pending spelling/category/option IDs on every line and retains advisor tracking',async()=>{
    const f=fixture(),session=await f.service.invoiceCreationSession('tenant-a','connection-a');
    const tracking=[{name:'Payment Track',option:'PENDING'},{name:'Sales Representative',option:'S15 Advisor'}];
    const input={...value,lines:[{description:'Tuition',quantity:'1',unitAmount:'100',accountCode:'812',taxType:'BASEXCLUDED',tracking}]};
    await Promise.all([session.createInvoice(input,'one'),session.createInvoice(input,'two')]);
    expect(f.client.trackingCategories).toHaveBeenCalledTimes(1);
    const sent=(f.client.createInvoice.mock.calls as unknown as Array<[string,string,typeof input]>)[0][2];
    expect(sent.lines[0].tracking).toEqual([{name:'Payment Track',option:'Pending',trackingCategoryId:'22222222-2222-4222-8222-222222222222',trackingOptionId:'33333333-3333-4333-8333-333333333333'},{name:'Sales Representative',option:'S15 Advisor'}]);
    expect(input.lines[0].tracking[0].option).toBe('PENDING');
  });
  it('blocks sending when the active Payment Track Pending option is missing or ambiguous',async()=>{
    for(const options of [[],[{trackingOptionId:'33333333-3333-4333-8333-333333333333',name:'Pending'},{trackingOptionId:'44444444-4444-4444-8444-444444444444',name:'Pending'}]]){
      const f=fixture();f.client.trackingCategories.mockResolvedValue([{trackingCategoryId:'22222222-2222-4222-8222-222222222222',name:'Payment Track',options}]);
      const session=await f.service.invoiceCreationSession('tenant-a','connection-a');await expect(session.createInvoice(value,'key')).rejects.toThrow('active Pending option');expect(f.client.createInvoice).not.toHaveBeenCalled();
    }
  });
});
