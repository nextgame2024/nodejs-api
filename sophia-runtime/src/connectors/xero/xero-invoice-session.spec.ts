import {afterEach,beforeEach,describe,expect,it,jest} from '@jest/globals';
import {XeroConnectorService} from './xero-connector.service.js';

const settings={XERO_INVOICE_CREATION_ENABLED:'true',XERO_INVOICE_BRANDING_THEME_NAME:'Trust Open for Australia acc',XERO_SHARED_BACKOFF_ENABLED:'true',XERO_SHARED_QUOTA_ENABLED:'false',XERO_CLIENT_ID:'fixture',XERO_CLIENT_SECRET:'fixture',
  XERO_REDIRECT_URI:'https://example.test/callback',XERO_RETURN_URL:'https://example.test/return',XERO_OAUTH_STATE_SECRET:'x'.repeat(32),XERO_TOKEN_ENCRYPTION_KEY:Buffer.alloc(32).toString('base64'),SOPHIA_RUNTIME_DATABASE_URL:'postgresql://example.invalid/runtime'};
const previous=Object.fromEntries(Object.keys(settings).map(key=>[key,process.env[key]]));
const value={contactId:'contact',date:'2026-10-28',dueDate:'2026-10-28',reference:null,currencyCode:'AUD',lines:[]};
describe('request-scoped Xero invoice session',()=>{
  beforeEach(()=>{Object.assign(process.env,settings);});
  afterEach(()=>{jest.restoreAllMocks();for(const [key,old] of Object.entries(previous)){if(old===undefined)delete process.env[key];else process.env[key]=old;}});
  function fixture(operating=true){
    let scopes=['accounting.invoices','accounting.invoices.read','accounting.settings.read'];
    const query=jest.fn(async(sql:string,params:unknown[])=>({rowCount:sql.includes('student_operations_xero_sync_configurations')?(operating?1:0):1,rows:sql.includes('token_ciphertext')
      ?[{token_ciphertext:params[0],token_expires_at:new Date(Date.now()+1800_000),status:'active'}]
      :[{xero_authorization_id:'authorization',xero_tenant_id:`provider-${params[0]}`,status:'active',granted_scopes:scopes}]}));
    const transact=jest.fn(async(_tenant:string,work:(db:unknown)=>Promise<unknown>)=>work({query}));
    const client={salesCatalogue:jest.fn(async()=>({items:[],accounts:[],taxRates:[]})),removeInvoice:jest.fn(async()=>({invoiceId:'created',status:'DELETED'})),createInvoice:jest.fn(async()=>({invoiceId:'created'})),invoiceById:jest.fn(async()=>({invoiceId:'created'})),brandingThemes:jest.fn(async()=>[{brandingThemeId:'11111111-1111-4111-8111-111111111111',name:'Trust Open for Australia acc'}]),
      trackingCategories:jest.fn(async()=>[{trackingCategoryId:'22222222-2222-4222-8222-222222222222',name:'Payment Track',options:[{trackingOptionId:'33333333-3333-4333-8333-333333333333',name:'Pending'}]}]),
      withRequestPolicy:jest.fn(async(_policy:unknown,work:()=>Promise<unknown>)=>work())};
    const crypto={open:(cipher:string)=>JSON.stringify({accessToken:`token-${cipher}`,refreshToken:'refresh'})};
    const service=new XeroConnectorService({tenantTransaction:transact,tenantReadTransaction:transact} as never,client as never,crypto as never);
    return {service,client,query,revoke:()=>{scopes=[];},revokeSettings:()=>{scopes=['accounting.invoices'];}};
  }
  it('reuses recently loaded form branding for creation but rechecks authorization',async()=>{
    const f=fixture();await f.service.invoiceBrandingThemes('tenant-a','connection-a');
    await (await f.service.invoiceCreationSession('tenant-a','connection-a')).createInvoice(value,'one');
    expect(f.client.brandingThemes).toHaveBeenCalledTimes(1);
    f.revokeSettings();await expect(f.service.invoiceBrandingThemes('tenant-a','connection-a')).rejects.toThrow('settings access');
  });
  it('shares removal credentials while keeping the live read and write under quota controls',async()=>{
    const f=fixture(),session=await f.service.invoiceRemovalSession('tenant-a','connection-a');
    await session.invoiceById('created');await session.removeInvoice('created','DELETED','key');
    expect(f.query).toHaveBeenCalledTimes(2);expect(f.client.withRequestPolicy).toHaveBeenCalledTimes(2);
    expect(f.client.removeInvoice).toHaveBeenCalledWith('token-tenant-a','provider-tenant-a','created','DELETED','key');
    f.revoke();await expect(f.service.invoiceRemovalSession('tenant-a','connection-a')).rejects.toThrow('authorize invoice');
  });
  it('expires cached branding and does not retain failures',async()=>{
    const f=fixture(),clock=jest.spyOn(Date,'now'),started=Date.now();
    await f.service.invoiceBrandingThemes('tenant-a','connection-a');clock.mockReturnValue(started+301_000);
    f.client.brandingThemes.mockRejectedValueOnce(new Error('Unavailable'));
    await expect(f.service.invoiceBrandingThemes('tenant-a','connection-a')).rejects.toThrow();
    await f.service.invoiceBrandingThemes('tenant-a','connection-a');expect(f.client.brandingThemes).toHaveBeenCalledTimes(3);
  });
  it('shares connection/token work within a batch while every call keeps its own rate-limit policy',async()=>{
    const f=fixture(),session=await f.service.invoiceCreationSession('tenant-a','connection-a');
    await Promise.all([session.createInvoice(value,'key-1'),session.createInvoice(value,'key-2'),session.invoiceById('created')]);
    expect(f.query).toHaveBeenCalledTimes(2);expect(f.client.withRequestPolicy).toHaveBeenCalledTimes(5);expect(f.client.brandingThemes).toHaveBeenCalledTimes(1);expect(f.client.trackingCategories).toHaveBeenCalledTimes(1);
    expect(f.client.createInvoice).toHaveBeenCalledWith('token-tenant-a','provider-tenant-a',{...value,brandingThemeId:'11111111-1111-4111-8111-111111111111'},'key-1');
    const other=await f.service.invoiceCreationSession('tenant-b','connection-b');await other.createInvoice(value,'key-3');
    expect(f.query).toHaveBeenCalledTimes(4);expect(f.client.createInvoice).toHaveBeenLastCalledWith('token-tenant-b','provider-tenant-b',{...value,brandingThemeId:'11111111-1111-4111-8111-111111111111'},'key-3');expect(f.client.brandingThemes).toHaveBeenCalledTimes(2);
  });
  it('honours a selected theme only after verifying it belongs to the connected organisation',async()=>{
    const f=fixture(),selected='44444444-4444-4444-8444-444444444444';
    f.client.brandingThemes.mockResolvedValue([{brandingThemeId:selected,name:'VIKINGO'}]);
    const session=await f.service.invoiceCreationSession('tenant-a','connection-a');
    await session.createInvoice({...value,brandingThemeId:selected},'key-selected');
    expect(f.client.createInvoice).toHaveBeenCalledWith(expect.anything(),expect.anything(),expect.objectContaining({brandingThemeId:selected}),'key-selected');
    await expect(session.createInvoice({...value,brandingThemeId:'55555555-5555-4555-8555-555555555555'},'key-foreign')).rejects.toThrow('available invoice branding');
    expect(f.client.createInvoice).toHaveBeenCalledTimes(1);
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
  it('uses the PTY theme and Instalment category without inheriting TRUST Payment Track',async()=>{
    const f=fixture(),theme='11111111-1111-4111-8111-111111111111';
    f.client.brandingThemes.mockResolvedValue([{brandingThemeId:theme,name:'PTY Open for Australia Account'}]);
    f.client.trackingCategories.mockResolvedValue([{trackingCategoryId:'22222222-2222-4222-8222-222222222222',name:'Type of Sale',options:[{trackingOptionId:'33333333-3333-4333-8333-333333333333',name:'Instalment'}]}]);
    const session=await f.service.invoiceCreationSession('tenant-a','connection-a','operating');
    const input={...value,reference:'Example Student',lines:[{description:'Commission',quantity:'1',unitAmount:'472.50',accountCode:'200',taxType:'OUTPUT',tracking:[{name:'Payment Track',option:'PENDING'}]}]};
    await session.createInvoice(input,'key');
    expect(f.client.createInvoice).toHaveBeenCalledWith('token-tenant-a','provider-tenant-a',expect.objectContaining({brandingThemeId:theme,reference:'Example Student',lines:[expect.objectContaining({tracking:[{name:'Type of Sale',option:'Instalment',trackingCategoryId:'22222222-2222-4222-8222-222222222222',trackingOptionId:'33333333-3333-4333-8333-333333333333'}]})]}),'key');
    expect(input.lines[0].tracking[0].name).toBe('Payment Track');
    expect(f.query).toHaveBeenCalledWith(expect.stringContaining("organisation_role='operating'"),['tenant-a','connection-a']);
  });
  it('preserves different active PTY Type of Sale choices while loading Xero tracking once',async()=>{
    const f=fixture(),category='22222222-2222-4222-8222-222222222222',instalment='33333333-3333-4333-8333-333333333333',marketing='44444444-4444-4444-8444-444444444444';
    f.client.brandingThemes.mockResolvedValue([{brandingThemeId:'11111111-1111-4111-8111-111111111111',name:'PTY Open for Australia Account'}]);
    f.client.trackingCategories.mockResolvedValue([{trackingCategoryId:category,name:'Type of Sale',options:[{trackingOptionId:instalment,name:'Instalment'},{trackingOptionId:marketing,name:'Marketing'}]}]);
    const session=await f.service.invoiceCreationSession('tenant-a','connection-a','operating');
    const line={description:'Commission',quantity:'12',unitAmount:'80.00',accountCode:'200',taxType:'OUTPUT'};
    await session.createInvoice({...value,lines:[{...line,tracking:[{name:'Type of Sale',option:'Instalment',trackingCategoryId:category,trackingOptionId:instalment}]}]},'one');
    await session.createInvoice({...value,lines:[{...line,tracking:[{name:'Type of Sale',option:'Marketing',trackingCategoryId:category,trackingOptionId:marketing}]}]},'two');
    expect(f.client.trackingCategories).toHaveBeenCalledTimes(1);
    expect(f.client.createInvoice.mock.calls[1]).toEqual(expect.arrayContaining([expect.objectContaining({lines:[expect.objectContaining({tracking:[{name:'Type of Sale',option:'Marketing',trackingCategoryId:category,trackingOptionId:marketing}]})]})]));
    await expect(session.createInvoice({...value,lines:[{...line,tracking:[{name:'Type of Sale',option:'Archived'}]}]},'invalid')).rejects.toThrow('active Type of Sale');
    expect(f.client.createInvoice).toHaveBeenCalledTimes(2);
  });
  it('imports active tracking metadata with the existing catalogue request',async()=>{
    const f=fixture();f.client.trackingCategories.mockResolvedValue([{trackingCategoryId:'22222222-2222-4222-8222-222222222222',name:'Type of Sale',options:[{trackingOptionId:'33333333-3333-4333-8333-333333333333',name:'Instalment'}]}]);const result=await f.service.salesCatalogue('tenant-a','connection-a');
    expect(result.trackingCategories?.[0].name).toBe('Type of Sale');expect(f.client.trackingCategories).toHaveBeenCalledTimes(1);expect(f.client.salesCatalogue).toHaveBeenCalledTimes(1);
  });
  it('rejects PTY creation on an unassigned or disabled organisation',async()=>{
    const f=fixture(false);
    await expect(f.service.invoiceCreationSession('tenant-a','connection-a','operating')).rejects.toThrow('PTY organisation is not available');
    expect(f.client.createInvoice).not.toHaveBeenCalled();
  });
  it('cannot override the required PTY branding with a selected TRUST theme',async()=>{
    const f=fixture(),theme='11111111-1111-4111-8111-111111111111';
    f.client.trackingCategories.mockResolvedValue([{trackingCategoryId:'22222222-2222-4222-8222-222222222222',name:'Type of Sale',options:[{trackingOptionId:'33333333-3333-4333-8333-333333333333',name:'Instalment'}]}]);
    const session=await f.service.invoiceCreationSession('tenant-a','connection-a','operating');
    await expect(session.createInvoice({...value,brandingThemeId:theme},'key')).rejects.toThrow('available invoice branding');
    expect(f.client.createInvoice).not.toHaveBeenCalled();
  });
  it('blocks sending when the active Payment Track Pending option is missing or ambiguous',async()=>{
    for(const options of [[],[{trackingOptionId:'33333333-3333-4333-8333-333333333333',name:'Pending'},{trackingOptionId:'44444444-4444-4444-8444-444444444444',name:'Pending'}]]){
      const f=fixture();f.client.trackingCategories.mockResolvedValue([{trackingCategoryId:'22222222-2222-4222-8222-222222222222',name:'Payment Track',options}]);
      const session=await f.service.invoiceCreationSession('tenant-a','connection-a');await expect(session.createInvoice(value,'key')).rejects.toThrow('active Pending option');expect(f.client.createInvoice).not.toHaveBeenCalled();
    }
  });
});
