import { afterEach,describe,expect,it,jest } from '@jest/globals';
import { XeroClient } from './xero.client.js';

afterEach(()=>jest.restoreAllMocks());
const contactId='11111111-1111-4111-8111-111111111111';
const value={contactNumber:`sophia:${contactId}`,name:'Example Student (STD-1)',email:'student@example.test'},key='a'.repeat(64);
const contact={ContactID:contactId,ContactNumber:value.contactNumber,ContactStatus:'ACTIVE'};
const response=(contacts:unknown[])=>new Response(JSON.stringify({Contacts:contacts}),{status:200,headers:{'Content-Type':'application/json'}});

describe('student Contact provisioning',()=>{
  it('supports explicit overflow references but rejects malformed or first-bucket aliases',async()=>{
    const overflow={...value,contactNumber:`${value.contactNumber}:docs:2`,name:'Example Student — Documents 2',email:null};
    const fetch=jest.spyOn(globalThis,'fetch').mockResolvedValue(response([{...contact,ContactNumber:overflow.contactNumber}]));
    expect(await new XeroClient().ensureStudentContact('fake','organisation',overflow,key)).toEqual({contactId});
    for(const suffix of [':docs:1',':docs:0',':docs:02',':docs:1000000',':docs:2"'])
      await expect(new XeroClient().ensureStudentContact('fake','organisation',{...value,contactNumber:value.contactNumber+suffix},key)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('reconciles by exact external reference before creating, without matching names or emails',async()=>{
    const fetch=jest.spyOn(globalThis,'fetch').mockResolvedValue(response([contact]));
    expect(await new XeroClient().ensureStudentContact('fake','organisation',value,key)).toEqual({contactId});
    expect(fetch).toHaveBeenCalledTimes(1);
    const url=new URL(String(fetch.mock.calls[0][0]));
    expect(url.origin+url.pathname).toBe('https://api.xero.com/api.xro/2.0/Contacts');
    expect(url.searchParams.get('where')).toBe(`ContactNumber=="${value.contactNumber}"`);
    expect(url.searchParams.get('includeArchived')).toBe('true');
  });
  it('creates only when absent, using the durable snapshot, key and shared per-request admission',async()=>{
    const fetch=jest.spyOn(globalThis,'fetch').mockResolvedValueOnce(response([])).mockResolvedValueOnce(response([contact]));
    const beforeRequest=jest.fn(async()=>undefined),observe=jest.fn(async()=>{}),client=new XeroClient();
    expect(await client.withRequestPolicy({beforeRequest,observe},()=>client.ensureStudentContact('fake','organisation',value,key))).toEqual({contactId});
    expect(beforeRequest).toHaveBeenCalledTimes(2);expect(observe).toHaveBeenCalledTimes(2);
    const options=fetch.mock.calls[1][1]!;
    expect(options.method).toBe('PUT');expect(options.redirect).toBe('error');
    expect(options.headers).toMatchObject({'Idempotency-Key':key,'xero-tenant-id':'organisation'});
    expect(JSON.parse(String(options.body))).toEqual({Contacts:[{Name:value.name,ContactNumber:value.contactNumber,EmailAddress:value.email}]});
  });
  it('does not blindly retry writes and recovers a timeout through lookup even after key expiry',async()=>{
    const fetch=jest.spyOn(globalThis,'fetch').mockResolvedValueOnce(response([])).mockRejectedValueOnce(new Error('timeout'));
    const client=new XeroClient();await expect(client.ensureStudentContact('fake','organisation',value,key)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
    fetch.mockResolvedValueOnce(response([contact]));
    expect(await client.ensureStudentContact('fake','organisation',value,key)).toEqual({contactId});
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  for(const contacts of [[{...contact,ContactStatus:'ARCHIVED'}],[{...contact,ContactNumber:'another-student'}],[contact,contact],[{...contact,HasValidationErrors:true}]])
    it('fails closed for archived, mismatched, ambiguous or invalid lookup results',async()=>{
      const fetch=jest.spyOn(globalThis,'fetch').mockResolvedValue(response(contacts));
      await expect(new XeroClient().ensureStudentContact('fake','organisation',value,key)).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  it('classifies provider errors before reading the body and does not retry a rejected write',async()=>{
    const fetch=jest.spyOn(globalThis,'fetch').mockResolvedValueOnce(response([])).mockResolvedValueOnce(new Response('private financial details',{status:429,headers:{'Retry-After':'120'}}));
    await expect(new XeroClient().ensureStudentContact('fake','organisation',value,key)).rejects.toMatchObject({response:expect.objectContaining({errorCode:'xero_rate_limited'})});
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
