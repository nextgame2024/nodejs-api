import { afterEach,describe,expect,it,jest } from '@jest/globals';
import { XeroConnectorService } from './xero-connector.service.js';
import { XeroClient } from './xero.client.js';

const names=['XERO_CLIENT_ID','XERO_CLIENT_SECRET','XERO_REDIRECT_URI','XERO_RETURN_URL','XERO_OAUTH_STATE_SECRET','XERO_TOKEN_ENCRYPTION_KEY','XERO_ATTACHMENT_UPLOAD_ENABLED','XERO_CONTACT_CREATION_ENABLED','XERO_SHARED_BACKOFF_ENABLED','SOPHIA_RUNTIME_DATABASE_URL'] as const;
const original=Object.fromEntries(names.map(name=>[name,process.env[name]]));
afterEach(()=>{jest.restoreAllMocks();for(const name of names){if(original[name]===undefined)delete process.env[name];else process.env[name]=original[name];}});
function setup(scopes:string[]) {
  Object.assign(process.env,{XERO_CLIENT_ID:'test-id',XERO_CLIENT_SECRET:'test-secret',XERO_REDIRECT_URI:'https://example.test/callback',XERO_RETURN_URL:'https://example.test/company',XERO_OAUTH_STATE_SECRET:'test-state-secret-at-least-thirty-two-characters',XERO_TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,1).toString('base64'),XERO_ATTACHMENT_UPLOAD_ENABLED:'true',XERO_SHARED_BACKOFF_ENABLED:'true',SOPHIA_RUNTIME_DATABASE_URL:'postgresql://example.invalid/test'});
  const database={tenantReadTransaction:async(_tenant:string,work:(db:unknown)=>Promise<unknown>)=>work({query:async()=>({rows:[{seconds:60}]})})};
  const service=new XeroConnectorService(database as never,new XeroClient(),{} as never);
  const accessToken=jest.fn(async()=>'fake-access');
  Object.assign(service,{loadConnection:async()=>({granted_scopes:scopes,xero_tenant_id:'provider',xero_authorization_id:'authorization'}),accessToken});
  return {service,accessToken};
}
describe('Xero Contact attachment write boundary',()=>{
  const id='11111111-1111-4111-8111-111111111111';
  it('requires contact read scope for exact-ID recovery and retains shared quota admission',async()=>{
    const denied=setup(['accounting.invoices']);
    const fetchMock=jest.spyOn(globalThis,'fetch');
    await expect(denied.service.contactById('tenant',id,id)).rejects.toMatchObject({response:expect.objectContaining({errorCode:'xero_contact_read_scope_missing'})});
    expect(denied.accessToken).not.toHaveBeenCalled();
    const allowed=setup(['accounting.contacts.read']);
    delete process.env.XERO_CONTACT_CREATION_ENABLED;delete process.env.XERO_ATTACHMENT_UPLOAD_ENABLED;
    await expect(allowed.service.contactById('tenant',id,id)).rejects.toMatchObject({response:expect.objectContaining({errorCode:'xero_rate_limited'})});
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('requires explicit enablement and attachment write scope before obtaining a token',async()=>{
    const {service,accessToken}=setup(['accounting.attachments.read']);
    const fetchMock=jest.spyOn(globalThis,'fetch');
    await expect(service.uploadAttachment('tenant',id,'Contacts',id,'file.pdf','application/pdf',Buffer.from('pdf'),'a'.repeat(64))).rejects.toMatchObject({response:expect.objectContaining({errorCode:'xero_attachment_write_scope_missing'})});
    expect(accessToken).not.toHaveBeenCalled();
    delete process.env.XERO_ATTACHMENT_UPLOAD_ENABLED;
    await expect(service.uploadAttachment('tenant',id,'Contacts',id,'file.pdf','application/pdf',Buffer.from('pdf'),'a'.repeat(64))).rejects.toMatchObject({response:expect.objectContaining({errorCode:'xero_attachment_upload_disabled'})});
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('uses shared cooldown/admission before sending Contact file bytes and rejects invoice writes',async()=>{
    const {service}=setup(['accounting.attachments']);const fetchMock=jest.spyOn(globalThis,'fetch');
    await expect(service.uploadAttachment('tenant',id,'Contacts',id,'file.pdf','application/pdf',Buffer.from('pdf'),'a'.repeat(64))).rejects.toMatchObject({response:expect.objectContaining({errorCode:'xero_rate_limited'})});
    await expect(service.uploadAttachment('tenant',id,'Invoices',id,'file.pdf','application/pdf',Buffer.from('pdf'),'a'.repeat(64))).rejects.toThrow('Contact');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('requires explicit Contact creation and both write scopes before obtaining a token',async()=>{
    const {service,accessToken}=setup(['accounting.contacts.read','accounting.attachments']);
    const value={contactNumber:`sophia:${id}`,name:'Student',email:null};
    delete process.env.XERO_CONTACT_CREATION_ENABLED;
    await expect(service.ensureStudentContact('tenant',id,value,'a'.repeat(64))).rejects.toMatchObject({response:expect.objectContaining({errorCode:'student_document_setup_required'})});
    process.env.XERO_CONTACT_CREATION_ENABLED='true';
    await expect(service.ensureStudentContact('tenant',id,value,'a'.repeat(64))).rejects.toMatchObject({response:expect.objectContaining({errorCode:'xero_contact_write_scope_missing'})});
    expect(accessToken).not.toHaveBeenCalled();
  });
  it('applies shared cooldown before Contact lookup or creation',async()=>{
    const {service}=setup(['accounting.contacts','accounting.attachments']);process.env.XERO_CONTACT_CREATION_ENABLED='true';
    const fetchMock=jest.spyOn(globalThis,'fetch');
    await expect(service.ensureStudentContact('tenant',id,{contactNumber:`sophia:${id}`,name:'Student',email:null},'a'.repeat(64))).rejects.toMatchObject({response:expect.objectContaining({errorCode:'xero_rate_limited'})});
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('reports a full Contact without overwriting another file, but permits an exact durable filename retry',async()=>{
    const {service}=setup(['accounting.attachments']);process.env.XERO_SHARED_BACKOFF_ENABLED='false';
    const client={attachments:jest.fn(async()=>Array.from({length:10},(_,i)=>({fileName:`${i}.pdf`,attachmentId:id,sizeBytes:3}))),attachmentContent:jest.fn(async()=>Buffer.from('pdf')),uploadAttachment:jest.fn(async()=>({attachmentId:id}))};
    Object.assign(service,{client});
    await expect(service.uploadAttachment('tenant',id,'Contacts',id,'new.pdf','application/pdf',Buffer.from('pdf'),'a'.repeat(64))).rejects.toMatchObject({response:expect.objectContaining({errorCode:'student_document_storage_full'})});
    expect(client.uploadAttachment).not.toHaveBeenCalled();
    expect(await service.uploadAttachment('tenant',id,'Contacts',id,'0.pdf','application/pdf',Buffer.from('pdf'),'a'.repeat(64))).toMatchObject({attachmentId:id});
    expect(client.uploadAttachment).not.toHaveBeenCalled();
  });
  it('uses operational admission for capacity reads and fences the upload before byte PUT',async()=>{
    const {service}=setup(['accounting.attachments']),fetchMock=jest.spyOn(globalThis,'fetch');
    await expect(service.documentContactAttachments('tenant',id,id)).rejects.toMatchObject({response:expect.objectContaining({errorCode:'xero_rate_limited'})});
    expect(fetchMock).not.toHaveBeenCalled();
    process.env.XERO_SHARED_BACKOFF_ENABLED='false';
    fetchMock.mockResolvedValue(new Response(JSON.stringify({Attachments:[]}),{status:200,headers:{'Content-Type':'application/json'}}));
    const fence=jest.fn(async()=>{throw new Error('Lease expired');});
    await expect(service.uploadAttachment('tenant',id,'Contacts',id,'new.pdf','application/pdf',Buffer.from('pdf'),'a'.repeat(64),fence)).rejects.toThrow('Lease expired');
    expect(fence).toHaveBeenCalledTimes(1);expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('never overwrites or reroutes a stored filename with different bytes during recovery',async()=>{
    const {service}=setup(['accounting.attachments']);process.env.XERO_SHARED_BACKOFF_ENABLED='false';
    const client={attachments:jest.fn(async()=>[{attachmentId:id,fileName:'durable.pdf',sizeBytes:3}]),attachmentContent:jest.fn(async()=>Buffer.from('bad')),uploadAttachment:jest.fn()};
    Object.assign(service,{client});
    await expect(service.uploadAttachment('tenant',id,'Contacts',id,'durable.pdf','application/pdf',Buffer.from('pdf'),'a'.repeat(64))).rejects.toMatchObject({response:expect.objectContaining({errorCode:'student_document_storage_review_required'})});
    expect(client.uploadAttachment).not.toHaveBeenCalled();
  });
  it('does not mark a write attempted when operational admission denies before HTTP',async()=>{
    const client=new XeroClient(),fence=jest.fn(async()=>{}),fetchMock=jest.spyOn(globalThis,'fetch');
    await expect(client.withRequestPolicy({beforeRequest:async()=>{throw new Error('Quota reserved');},observe:async()=>{}},
      ()=>client.uploadAttachment('fake','organisation','Contacts',id,'new.pdf','application/pdf',Buffer.from('pdf'),'a'.repeat(64),fence))).rejects.toThrow('Quota reserved');
    expect(fence).not.toHaveBeenCalled();expect(fetchMock).not.toHaveBeenCalled();
  });
});
