import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { XeroClient } from "./xero.client.js";
import type { XeroConfig } from "./xero.config.js";

const config: XeroConfig = {
  clientId: "client-id",
  clientSecret: "client-secret",
  redirectUri: "https://runtime.example/api/connectors/xero/v1/oauth/callback",
  returnUrl: "https://app.example/manager/company",
  stateSecret: "state-secret-that-is-longer-than-thirty-two-characters",
  encryptionKey: Buffer.alloc(32, 1),
};

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("XeroClient", () => {
  it.each(['DELETED','VOIDED'] as const)('confirms an exact %s status update with a stable key',async status=>{
    const id='11111111-1111-4111-8111-111111111111',contact='22222222-2222-4222-8222-222222222222';
    const fetch=jest.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({Invoices:[{InvoiceID:id,Contact:{ContactID:contact},Type:'ACCREC',Status:status,Total:100,AmountPaid:0,AmountDue:0}]})));
    expect(await new XeroClient().removeInvoice('token','tenant',id,status,'a'.repeat(64))).toMatchObject({invoiceId:id,status});
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({Invoices:[{InvoiceID:id,Status:status}]});
    expect(fetch.mock.calls[0][1]?.headers).toMatchObject({'Idempotency-Key':'a'.repeat(64)});
  });
  it('does not report an unconfirmed deletion as successful',async()=>{
    const id='11111111-1111-4111-8111-111111111111';
    jest.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({Invoices:[{InvoiceID:id,Contact:{ContactID:id},Type:'ACCREC',Status:'DRAFT',Total:100}]})));
    await expect(new XeroClient().removeInvoice('token','tenant',id,'DELETED','a'.repeat(64))).rejects.toThrow('could not be confirmed');
  });
  it('reads only active tracking options and sends exact option names with their IDs',async()=>{
    const category='22222222-2222-4222-8222-222222222222',option='33333333-3333-4333-8333-333333333333',id='11111111-1111-4111-8111-111111111111';
    const fetchMock=jest.spyOn(globalThis,'fetch').mockResolvedValueOnce(new Response(JSON.stringify({TrackingCategories:[{TrackingCategoryID:category,Name:'Payment Track',Status:'ACTIVE',Options:[{TrackingOptionID:option,Name:'Pending',Status:'ACTIVE'},{TrackingOptionID:id,Name:'Old pending',Status:'ARCHIVED'}]}]})))
      .mockResolvedValueOnce(new Response(JSON.stringify({Invoices:[{InvoiceID:id,InvoiceNumber:'INV-42',Status:'DRAFT',Total:100}]})));
    const client=new XeroClient();expect(await client.trackingCategories('token','organisation')).toEqual([{trackingCategoryId:category,name:'Payment Track',options:[{trackingOptionId:option,name:'Pending'}]}]);
    await client.createInvoice('token','organisation',{contactId:id,date:'2027-01-01',dueDate:'2027-01-15',reference:null,currencyCode:'AUD',lines:[{description:'Tuition',quantity:'1',unitAmount:'100',accountCode:'812',taxType:'BASEXCLUDED',tracking:[{name:'Payment Track',option:'Pending',trackingCategoryId:category,trackingOptionId:option}]}]},'b'.repeat(64));
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).Invoices[0].LineItems[0].Tracking).toEqual([{Name:'Payment Track',Option:'Pending',TrackingCategoryID:category,TrackingOptionID:option}]);
  });
  it('reads organisation-scoped invoice themes and serializes the explicit branding ID',async()=>{
    const theme='22222222-2222-4222-8222-222222222222',id='11111111-1111-4111-8111-111111111111';
    const fetchMock=jest.spyOn(globalThis,'fetch').mockResolvedValueOnce(new Response(JSON.stringify({BrandingThemes:[{BrandingThemeID:theme,Name:'Trust Open for Australia acc',SortOrder:1,Type:'INVOICE'}]})))
      .mockResolvedValueOnce(new Response(JSON.stringify({Invoices:[{InvoiceID:id,InvoiceNumber:'INV-42',Status:'DRAFT',Total:100}]})));
    const client=new XeroClient();expect(await client.brandingThemes('token','organisation')).toEqual([{brandingThemeId:theme,name:'Trust Open for Australia acc'}]);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.xero.com/api.xro/2.0/BrandingThemes');
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({'xero-tenant-id':'organisation'});
    await client.createInvoice('token','organisation',{contactId:id,date:'2027-01-01',dueDate:'2027-01-15',reference:null,currencyCode:'AUD',brandingThemeId:theme,lines:[]},'b'.repeat(64));
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).Invoices[0].BrandingThemeID).toBe(theme);
  });
  it('rejects invalid branding responses and malformed branding IDs before sending an invoice',async()=>{
    const fetchMock=jest.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({BrandingThemes:[{BrandingThemeID:'not-an-id',Name:'Trust Open for Australia acc'}]})));
    await expect(new XeroClient().brandingThemes('token','tenant')).rejects.toThrow('invalid branding theme identifier');
    fetchMock.mockClear();await expect(new XeroClient().createInvoice('token','tenant',{contactId:'11111111-1111-4111-8111-111111111111',date:'2027-01-01',dueDate:'2027-01-15',reference:null,currencyCode:'AUD',brandingThemeId:'bad',lines:[]},'b'.repeat(64))).rejects.toThrow('branding theme');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('creates one unsent Xero draft with reviewed lines, tracking and provider idempotency',async()=>{
    const id='11111111-1111-4111-8111-111111111111',key='b'.repeat(64);
    const fetchMock=jest.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({Invoices:[{InvoiceID:id,InvoiceNumber:'INV-42',Status:'DRAFT',Total:720}]})));
    await expect(new XeroClient().createInvoice('token','tenant',{contactId:id,date:'2027-01-01',dueDate:'2027-01-15',reference:'Example College',currencyCode:'AUD',lines:[{description:'Course Name: GENERAL ENGLISH - 48 weeks',quantity:'4',unitAmount:'180.0000',itemCode:'ELICOS ON-SHORE',accountCode:'812',taxType:'BASEXCLUDED',tracking:[{name:'Payment Track',option:'PENDING'},{name:'Sales Representative',option:'S15 Advisor'}]}]},key)).resolves.toEqual({invoiceId:id,invoiceNumber:'INV-42',status:'DRAFT',total:720});
    const [url,options]=fetchMock.mock.calls[0];expect(url).toBe('https://api.xero.com/api.xro/2.0/Invoices?unitdp=4');expect(options).toMatchObject({method:'PUT',redirect:'error',headers:{'Idempotency-Key':key}});
    const body=JSON.parse(String(options?.body));expect(body.Invoices[0]).toMatchObject({Type:'ACCREC',Status:'DRAFT',Contact:{ContactID:id},Date:'2027-01-01',DueDate:'2027-01-15',Reference:'Example College',LineAmountTypes:'Exclusive'});expect(body.Invoices[0].LineItems[0].Tracking).toEqual([{Name:'Payment Track',Option:'PENDING'},{Name:'Sales Representative',Option:'S15 Advisor'}]);
  });
  it('retries an unreadable create response immediately with the identical idempotency key',async()=>{
    const id='11111111-1111-4111-8111-111111111111',key='c'.repeat(64),fetchMock=jest.spyOn(globalThis,'fetch').mockRejectedValueOnce(new TypeError('connection closed'))
      .mockResolvedValueOnce(new Response(JSON.stringify({Invoices:[{InvoiceID:id,InvoiceNumber:'INV-10577',Status:'DRAFT',Total:970}]})));
    await expect(new XeroClient().createInvoice('token','tenant',{contactId:id,date:'2026-10-27',dueDate:'2026-10-27',reference:'Fixture College',currencyCode:'AUD',lines:[{description:'Tuition',quantity:'1',unitAmount:'970.00',accountCode:'812',taxType:'BASEXCLUDED',tracking:[]}]},key)).resolves.toMatchObject({invoiceId:id,invoiceNumber:'INV-10577'});
    expect(fetchMock).toHaveBeenCalledTimes(2);expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({'Idempotency-Key':key});expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({'Idempotency-Key':key});
  });
  it('returns full create-response details for confirmation without requiring another provider read',async()=>{
    const id='11111111-1111-4111-8111-111111111111',contact='22222222-2222-4222-8222-222222222222';
    const fetchMock=jest.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({Invoices:[{InvoiceID:id,InvoiceNumber:'INV-42',Type:'ACCREC',Status:'DRAFT',Total:100,Contact:{ContactID:contact},
      DateString:'2026-10-28',DueDateString:'2026-11-01',CurrencyCode:'AUD',Reference:'Fixture College',LineItems:[{Description:'Tuition',Quantity:1,UnitAmount:100,AccountCode:'812',TaxType:'BASEXCLUDED',LineAmount:100,TaxAmount:0,Tracking:[]}]}]})));
    expect(await new XeroClient().createInvoice('token','tenant',{contactId:contact,date:'2026-10-28',dueDate:'2026-11-01',reference:'Fixture College',currencyCode:'AUD',lines:[{description:'Tuition',quantity:'1',unitAmount:'100',accountCode:'812',taxType:'BASEXCLUDED',tracking:[]}]},'a'.repeat(64)))
      .toMatchObject({invoiceId:id,invoice:{invoiceId:id,contactId:contact,invoiceDate:'2026-10-28',dueDate:'2026-11-01',lineItems:[{description:'Tuition',quantity:1,unitAmount:100,accountCode:'812'}]}});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('reads a created invoice by id and finds bounded same-day app-created candidates for reconciliation',async()=>{
    const invoiceId='11111111-1111-4111-8111-111111111111',contactId='22222222-2222-4222-8222-222222222222',payload={Invoices:[{InvoiceID:invoiceId,InvoiceNumber:'INV-10577',Type:'ACCREC',Status:'DRAFT',Contact:{ContactID:contactId},DateString:'2026-10-27',DueDateString:'2026-10-27',CurrencyCode:'AUD',Reference:'Fixture College',Total:970,LineItems:[]}]};
    const fetchMock=jest.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response(JSON.stringify(payload)));
    const client=new XeroClient();await expect(client.invoiceById('token','tenant',invoiceId)).resolves.toMatchObject({invoiceId,invoiceNumber:'INV-10577',contactId,total:970});
    await expect(client.invoiceCandidates('token','tenant',contactId,'2026-10-27')).resolves.toHaveLength(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`https://api.xero.com/api.xro/2.0/Invoices/${invoiceId}`);
    const candidateUrl=new URL(String(fetchMock.mock.calls[1]?.[0]));expect(candidateUrl.searchParams.get('ContactIDs')).toBe(contactId);expect(candidateUrl.searchParams.has('createdByMyApp')).toBe(false);expect(candidateUrl.searchParams.get('summaryOnly')).toBe('true');expect(candidateUrl.searchParams.get('pageSize')).toBe('100');expect(candidateUrl.searchParams.get('where')).toContain('DateTime(2026,10,27)');
  });
  it('classifies a confirmed Xero invoice validation failure as correctable without calling it a duplicate',async()=>{
    const id='11111111-1111-4111-8111-111111111111';jest.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({Invoices:[{HasValidationErrors:true,ValidationErrors:[{Message:'Tracking option is invalid'}]}]})));
    await expect(new XeroClient().createInvoice('token','tenant',{contactId:id,date:'2026-10-27',dueDate:'2026-10-27',reference:null,currencyCode:'AUD',lines:[{description:'Tuition',quantity:'1',unitAmount:'100.00',accountCode:'812',taxType:'BASEXCLUDED',tracking:[]}]},'b'.repeat(64)))
      .rejects.toMatchObject({response:expect.objectContaining({errorCode:'xero_invoice_validation_failed',message:'Xero rejected the invoice: Tracking option is invalid'})});
  });
  it('keeps an idempotency conflict in review without exposing the provider key',async()=>{
    const id='11111111-1111-4111-8111-111111111111',key='b'.repeat(64);jest.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({Invoices:[{HasValidationErrors:true,ValidationErrors:[{Message:`Idempotency Key: ${key} is used with a different request.`}]}]})));
    await expect(new XeroClient().createInvoice('token','tenant',{contactId:id,date:'2026-10-27',dueDate:'2026-10-27',reference:null,currencyCode:'AUD',lines:[{description:'Tuition',quantity:'1',unitAmount:'100.00',accountCode:'812',taxType:'BASEXCLUDED',tracking:[]}]},key))
      .rejects.toMatchObject({response:expect.objectContaining({errorCode:'xero_invoice_idempotency_conflict',message:expect.not.stringContaining(key)})});
  });
  it('imports sales Items, account names and effective tax rates with read-only GETs and no bank details',async()=>{
    const item='11111111-1111-4111-8111-111111111111';
    const fetchMock=jest.spyOn(globalThis,'fetch').mockResolvedValueOnce(new Response(JSON.stringify({Items:[{ItemID:item,Code:'ELICOS ON-SHORE',Name:'English',IsSold:true,SalesDetails:{UnitPrice:180.0001,AccountCode:'812',TaxType:'BASEXCLUDED'}}]})))
      .mockResolvedValueOnce(new Response(JSON.stringify({Accounts:[{Code:'812',Name:'Tuition fee',Status:'ACTIVE',TaxType:'BASEXCLUDED',BankAccountNumber:'must-not-store'}]})))
      .mockResolvedValueOnce(new Response(JSON.stringify({TaxRates:[{Name:'BAS Excluded',TaxType:'BASEXCLUDED',Status:'ACTIVE',EffectiveRate:0}]})));
    const result=await new XeroClient().salesCatalogue('test-token','test-tenant');expect(result.items[0]).toMatchObject({code:'ELICOS ON-SHORE',unitPrice:'180.0001',accountCode:'812'});expect(result.taxRates[0].rate).toBe('0');expect(JSON.stringify(result)).not.toContain('must-not-store');
    expect(fetchMock).toHaveBeenCalledTimes(3);for(const [url,options] of fetchMock.mock.calls){expect(String(url)).toMatch(/\/(Items|Accounts|TaxRates)/);expect(options?.method).toBeUndefined();expect(options?.headers).toMatchObject({'xero-tenant-id':'test-tenant'});}
  });
  it('does not publish a malformed or partial item catalogue',async()=>{
    jest.spyOn(globalThis,'fetch').mockResolvedValueOnce(new Response(JSON.stringify({Items:[{ItemID:'invalid',Code:'bad'}]})))
      .mockResolvedValueOnce(new Response(JSON.stringify({Accounts:[]}))).mockResolvedValueOnce(new Response(JSON.stringify({TaxRates:[]})));
    await expect(new XeroClient().salesCatalogue('test-token','test-tenant')).rejects.toThrow('invalid sales catalogue');
  });
  it('uploads raw bytes only to Contacts with a stable idempotency key and observes quota headers',async()=>{
    const id='11111111-1111-4111-8111-111111111111',bytes=Buffer.from('%PDF-1.7\n%%EOF'),key='a'.repeat(64);
    const fetchMock=jest.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({Attachments:[{AttachmentID:id,FileName:'unique-passport.pdf',ContentLength:bytes.length}]}),{headers:{'x-daylimit-remaining':'20'}}));
    const observe=jest.fn(async()=>{}),beforeRequest=jest.fn(async()=>{});
    const client=new XeroClient();
    await expect(client.withRequestPolicy({beforeRequest,observe},()=>client.uploadAttachment('secret','tenant','Contacts',id,'unique-passport.pdf','application/pdf',bytes,key))).resolves.toEqual({attachmentId:id,fileName:'unique-passport.pdf',mimeType:'application/pdf',sizeBytes:bytes.length});
    const [url,options]=fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.xero.com/api.xro/2.0/Contacts/${id}/Attachments/unique-passport.pdf`);
    expect(options).toMatchObject({method:'PUT',redirect:'error',headers:{'Content-Type':'application/pdf','Idempotency-Key':key}});
    expect(Buffer.from(options?.body as Uint8Array).equals(bytes)).toBe(true);
    expect(beforeRequest).toHaveBeenCalledTimes(1);expect(observe).toHaveBeenCalledTimes(1);
    await expect(client.uploadAttachment('secret','tenant','Invoices',id,'passport.pdf','application/pdf',bytes,key)).rejects.toThrow('Contact');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('replaces legacy attachment bytes by filename with POST and provider idempotency',async()=>{
    const source='11111111-1111-4111-8111-111111111111',attachment='22222222-2222-4222-8222-222222222222',bytes=Buffer.from('%PDF-1.7\n%%EOF'),key='d'.repeat(64);
    const fetchMock=jest.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({Attachments:[{AttachmentID:attachment,FileName:'offer.pdf',ContentLength:bytes.length}]})));
    await expect(new XeroClient().replaceAttachment('token','tenant','Contacts',source,'offer.pdf','application/pdf',bytes,key)).resolves.toEqual({attachmentId:attachment,fileName:'offer.pdf',mimeType:'application/pdf',sizeBytes:bytes.length});
    expect(fetchMock.mock.calls[0]).toEqual([`https://api.xero.com/api.xro/2.0/Contacts/${source}/Attachments/offer.pdf`,expect.objectContaining({method:'POST',redirect:'error',headers:expect.objectContaining({'Idempotency-Key':key,'Content-Type':'application/pdf'})})]);
  });
  it('uploads, associates, reads and idempotently deletes a Xero Files document',async()=>{
    const fileId='11111111-1111-4111-8111-111111111111',contactId='22222222-2222-4222-8222-222222222222',bytes=Buffer.from('%PDF-1.7\n%%EOF'),key='e'.repeat(64);
    const fetchMock=jest.spyOn(globalThis,'fetch').mockResolvedValueOnce(new Response(JSON.stringify({Id:fileId,Name:'offer.pdf',MimeType:'application/pdf',Size:bytes.length}),{status:201}))
      .mockResolvedValueOnce(new Response(JSON.stringify({FileId:fileId,ObjectId:contactId,ObjectGroup:'Contact',ObjectType:'Business'}),{status:201}))
      .mockResolvedValueOnce(new Response(bytes,{status:200})).mockResolvedValueOnce(new Response(null,{status:204})).mockResolvedValueOnce(new Response(null,{status:404}));
    const client=new XeroClient();await expect(client.uploadFile('token','tenant','offer.pdf','application/pdf',bytes,key)).resolves.toMatchObject({fileId,fileName:'offer.pdf'});
    const uploadBody=fetchMock.mock.calls[0][1]?.body as FormData;
    expect(uploadBody).toBeInstanceOf(FormData);
    expect(uploadBody.get('body')).toBeNull();
    expect(uploadBody.get('name')).toBe('offer.pdf');expect(uploadBody.get('filename')).toBe('offer.pdf');expect(uploadBody.get('mimeType')).toBe('application/pdf');
    const uploadedPart=uploadBody.get('offer.pdf');expect(uploadedPart).toBeInstanceOf(Blob);
    expect(Buffer.from(await (uploadedPart as Blob).arrayBuffer()).equals(bytes)).toBe(true);
    await expect(client.associateFileWithContact('token','tenant',fileId,contactId,key)).resolves.toBeUndefined();
    expect((await client.fileContent('token','tenant',fileId)).equals(bytes)).toBe(true);await expect(client.deleteFile('token','tenant',fileId)).resolves.toBeUndefined();await expect(client.deleteFile('token','tenant',fileId)).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.map(call=>[call[0],call[1]?.method])).toEqual([
      ['https://api.xero.com/files.xro/1.0/Files','POST'],[`https://api.xero.com/files.xro/1.0/Files/${fileId}/Associations`,'POST'],[`https://api.xero.com/files.xro/1.0/Files/${fileId}/Content`,undefined],[`https://api.xero.com/files.xro/1.0/Files/${fileId}`,'DELETE'],[`https://api.xero.com/files.xro/1.0/Files/${fileId}`,'DELETE'],
    ]);
  });
  it('never retries a failed upstream mutation and does not expose raw provider errors',async()=>{
    const id='11111111-1111-4111-8111-111111111111';
    const fetchMock=jest.spyOn(globalThis,'fetch').mockResolvedValue(new Response('private provider body',{status:429,headers:{'retry-after':'60'}}));
    await expect(new XeroClient().uploadAttachment('secret','tenant','Contacts',id,'passport.pdf','application/pdf',Buffer.from('bytes'),'a'.repeat(64))).rejects.toMatchObject({response:expect.objectContaining({errorCode:'xero_rate_limited',retryAfterSeconds:60})});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('lists attachment metadata by source identity without exposing provider URLs', async () => {
    const id='11111111-1111-4111-8111-111111111111';
    const fetchMock=jest.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({Attachments:[{AttachmentID:id,FileName:'passport.pdf',MimeType:'application/pdf',ContentLength:42,Url:'https://untrusted.example/file'}]}),{status:200}));
    await expect(new XeroClient().attachments('token','tenant','Contacts',id)).resolves.toEqual([{attachmentId:id,fileName:'passport.pdf',mimeType:'application/pdf',sizeBytes:42}]);
    expect(fetchMock.mock.calls[0][0]).toBe(`https://api.xero.com/api.xro/2.0/Contacts/${id}/Attachments`);
    await expect(new XeroClient().attachments('token','tenant','Contacts','../other')).rejects.toThrow('identity');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('downloads bounded binary content and rejects provider errors', async () => {
    const id='11111111-1111-4111-8111-111111111111';
    jest.spyOn(globalThis,'fetch').mockResolvedValueOnce(new Response('pdf-content',{status:200}))
      .mockResolvedValueOnce(new Response('private upstream error',{status:403}));
    expect((await new XeroClient().attachmentContent('token','tenant','Invoices',id,id)).toString()).toBe('pdf-content');
    await expect(new XeroClient().attachmentContent('token','tenant','Invoices',id,id)).rejects.toThrow('authorization requires attention');
  });

  it("exchanges an authorization code server-side with PKCE", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      access_token: "access",
      refresh_token: "refresh",
      expires_in: 1800,
      scope: "offline_access accounting.settings.read",
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(new XeroClient().exchangeCode("code", "verifier", config)).resolves.toEqual({
      accessToken: "access",
      refreshToken: "refresh",
      expiresIn: 1800,
      scopes: ["offline_access", "accounting.settings.read"],
    });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`,
    });
    expect(String(init?.body)).toContain("code_verifier=verifier");
  });

  it("classifies a Xero token transport timeout instead of returning a generic server error", async () => {
    jest.spyOn(globalThis,"fetch").mockRejectedValueOnce(new DOMException("timed out","TimeoutError"));
    await expect(new XeroClient().refresh("refresh-token",config)).rejects.toMatchObject({
      status:502,response:expect.objectContaining({errorCode:"xero_unavailable",retryAfterSeconds:300}),
    });
  });

  it("passes the explicit Xero tenant and returns only bank accounts", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      Accounts: [
        { AccountID: "bank-1", Name: "Agency bank", Type: "BANK", Status: "ACTIVE" },
        { AccountID: "expense-1", Name: "Expenses", Type: "EXPENSE", Status: "ACTIVE" },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(new XeroClient().bankAccounts("access", "tenant-1")).resolves.toEqual([
      expect.objectContaining({ accountId: "bank-1", name: "Agency bank" }),
    ]);
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.headers).toMatchObject({ "xero-tenant-id": "tenant-1" });
  });

  it("does not expose provider response details when authorization fails", async () => {
    jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      error: "invalid_client",
      client_secret: "must-not-leak",
    }), { status: 401, headers: { "content-type": "application/json" } }));
    await expect(new XeroClient().exchangeCode("code", "verifier", config))
      .rejects.toThrow("Xero authorization could not be completed.");
  });

  it("classifies a non-JSON provider failure before attempting to parse it", async () => {
    jest.useFakeTimers();
    jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response("upstream gateway", {
      status: 502,
      headers: { "content-type": "text/html", "xero-correlation-id": "correlation-1" },
    }));

    const request = new XeroClient().invoicePage("access", "tenant-1", 1);
    const expectation = expect(request)
      .rejects.toMatchObject({ response: expect.objectContaining({
        errorCode: "xero_unavailable",
        providerStatus: 502,
        correlationId: "correlation-1",
      }) });
    await jest.runAllTimersAsync();
    await expectation;
  });

  it("retries a transient Xero invoice failure and uses bounded invoice pages", async () => {
    jest.useFakeTimers();
    const fetchMock = jest.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("temporary Xero failure", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ Invoices: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));

    const request = new XeroClient().invoicePage("access", "tenant-1", 1);
    await jest.runAllTimersAsync();

    await expect(request).resolves.toEqual({ items: [], page: 1, pageCount: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const requestUrl = String(fetchMock.mock.calls[1]?.[0]);
    expect(requestUrl).toContain("pageSize=100");
    expect(requestUrl).not.toContain("summaryOnly=");
    expect(requestUrl).toContain("where=Type%3D%3D%22ACCREC%22");
    expect(requestUrl).not.toContain("Statuses=");
    expect(requestUrl).toContain("order=UpdatedDateUTC+ASC");
  });

  it("requests the exact Xero sales register states for a full reconciliation", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      Pagination: { PageNumber: 1, PageSize: 100, PageCount: 78, ItemCount: 7793 },
      Invoices: [],
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(new XeroClient().invoicePage(
      "access", "tenant-1", 1, undefined, true,
    )).resolves.toEqual(expect.objectContaining({ pageCount: 78, itemCount: 7793 }));

    const requestUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(requestUrl).toContain("Statuses=DRAFT%2CSUBMITTED%2CAUTHORISED%2CPAID");
    expect(requestUrl).toContain("where=Type%3D%3D%22ACCREC%22");
    expect(requestUrl).toContain("order=UpdatedDateUTC+ASC");
  });

  it("filters the unfiltered invoice page locally", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      Invoices: [
        {
          Type: "ACCREC", Status: "AUTHORISED", InvoiceID: "invoice-1",
          Contact: { ContactID: "contact-1" }, InvoiceNumber: "INV-1", Reference: "STUDENT-REF",
          LineItems: [{
            Description: "Diploma tuition",
            Tracking: [
              { Name: "Sales Representative", Option: "Maria Lopez" },
              { Name: "Payment Track", Option: "Pending" },
            ],
          }],
          Total: 100, SentToContact: true,
        },
        {
          Type: "ACCPAY", Status: "AUTHORISED", InvoiceID: "invoice-2",
          Contact: { ContactID: "contact-1" }, Total: 50,
        },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await new XeroClient().invoicePage("access", "tenant-1", 1);

    const requestUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(requestUrl).toContain("page=1");
    expect(requestUrl).toContain("where=Type%3D%3D%22ACCREC%22");
    expect(requestUrl).not.toContain("Statuses=");
    expect(requestUrl).toContain("pageSize=100");
    expect(requestUrl).not.toContain("summaryOnly=");
    expect(result.items).toEqual([expect.objectContaining({
      invoiceId: "invoice-1",
      type: "ACCREC",
      invoiceReference: "STUDENT-REF",
      concept: "Diploma tuition",
      advisorName: "Maria Lopez",
      collegeName: "STUDENT-REF",
      paymentTrack: "Pending",
      sentToContact: true,
      lineItems: [expect.objectContaining({
        description: "Diploma tuition",
        tracking: expect.arrayContaining([
          { name: "Sales Representative", option: "Maria Lopez" },
          { name: "Payment Track", option: "Pending" },
        ]),
      })],
    })]);
  });

  it("maps receivable credit notes from the Xero sales register", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      Pagination: { PageNumber: 1, PageSize: 100, PageCount: 1, ItemCount: 1 },
      CreditNotes: [{
        Type: "ACCRECCREDIT", Status: "AUTHORISED",
        CreditNoteID: "credit-note-1", CreditNoteNumber: "CN-248", Reference: "ATI",
        Contact: { ContactID: "contact-1" }, DateString: "2026-10-01T00:00:00",
        Total: 250, RemainingCredit: 100, CurrencyCode: "AUD", SentToContact: true,
        LineItems: [{
          Description: "Tuition adjustment",
          Tracking: [{ Name: "Sales Representative", Option: "Maria Lopez" }],
        }],
      }],
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(new XeroClient().creditNotePage("access", "tenant-1", 1)).resolves.toEqual({
      items: [expect.objectContaining({
        invoiceId: "credit-note-1", invoiceNumber: "CN-248", type: "ACCRECCREDIT",
        amountPaid: 150, amountDue: 100, advisorName: "Maria Lopez",
      })],
      page: 1,
      pageCount: 1,
      itemCount: 1,
    });

    const requestUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(requestUrl).toContain("/CreditNotes?");
    expect(requestUrl).toContain("where=Type%3D%3D%22ACCRECCREDIT%22");
    expect(requestUrl).toContain("order=UpdatedDateUTC+ASC");
  });

  it("maps receive prepayments and overpayments from the Xero sales register", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        Pagination: { PageNumber: 1, PageSize: 100, PageCount: 1, ItemCount: 1 },
        Prepayments: [{
          Type: "RECEIVE-PREPAYMENT", Status: "AUTHORISED", PrepaymentID: "prepayment-1",
          InvoiceNumber: "PP-100", Reference: "legacy-number", Contact: { ContactID: "contact-1" },
          DateString: "2026-10-01T00:00:00", Total: 500, RemainingCredit: 200,
          CurrencyCode: "AUD", LineItems: [{ Description: "Tuition deposit" }],
        }],
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        Pagination: { PageNumber: 1, PageSize: 100, PageCount: 1, ItemCount: 1 },
        Overpayments: [{
          Type: "RECEIVE-OVERPAYMENT", Status: "PAID", OverpaymentID: "overpayment-1",
          Reference: "Bank receipt 10", Contact: { ContactID: "contact-2" },
          DateString: "2026-10-02T00:00:00", Total: 300, RemainingCredit: 0,
          CurrencyCode: "AUD", LineItems: [],
        }],
      }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(new XeroClient().prepaymentPage("access", "tenant-1", 1)).resolves.toEqual({
      items: [expect.objectContaining({
        invoiceId: "prepayment-1", invoiceNumber: "PP-100", invoiceReference: null,
        type: "RECEIVE-PREPAYMENT", amountPaid: 300, amountDue: 200,
      })],
      page: 1,
      pageCount: 1,
      itemCount: 1,
    });
    await expect(new XeroClient().overpaymentPage("access", "tenant-1", 1)).resolves.toEqual({
      items: [expect.objectContaining({
        invoiceId: "overpayment-1", invoiceNumber: "Bank receipt 10",
        type: "RECEIVE-OVERPAYMENT", amountPaid: 300, amountDue: 0,
      })],
      page: 1,
      pageCount: 1,
      itemCount: 1,
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/Prepayments?");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("RECEIVE-PREPAYMENT");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/Overpayments?");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("RECEIVE-OVERPAYMENT");
  });

  it("uses incremental headers and stable paging for contacts", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      pagination: { page: 2, pageSize: 100, pageCount: 2, itemCount: 200 },
      Contacts: [{ ContactID: "44444444-4444-4444-8444-444444444444", Name: "Student One" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(new XeroClient().contactPage(
      "access", "tenant-1", 2, new Date("2026-10-10T00:00:00Z"),
    )).resolves.toEqual(expect.objectContaining({ page: 2, pageCount: 2 }));
    const requestUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(requestUrl).toContain("page=2");
    expect(requestUrl).toContain("pageSize=100");
    expect(requestUrl).toContain("summaryOnly=true");
    expect(requestUrl).not.toContain("order=");
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      "If-Modified-Since": "Sat, 10 Oct 2026 00:00:00 GMT",
    });
  });

  it("derives reviewable student candidates from sales invoices and Xero contacts", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        Pagination: { PageNumber: 1, PageSize: 500, PageCount: 1, ItemCount: 3 },
        Invoices: [
          {
            Type: "ACCREC", Status: "PAID", InvoiceID: "invoice-1", InvoiceNumber: "TRUST-001",
            DateString: "2026-09-01T00:00:00", DueDateString: "2026-09-10T00:00:00",
            Total: 1000, AmountPaid: 1000, AmountDue: 0, CurrencyCode: "AUD",
            Contact: { ContactID: "contact-1", Name: "Student One" },
          },
          {
            Type: "ACCREC", Status: "AUTHORISED", InvoiceID: "invoice-2", InvoiceNumber: "TRUST-002",
            DateString: "2099-10-01T00:00:00", DueDateString: "2099-10-20T00:00:00",
            Total: "500", AmountPaid: "100", AmountDue: "400", CurrencyCode: "AUD",
            Contact: { ContactID: "contact-1", Name: "Student One" },
          },
          {
            Type: "ACCPAY", Status: "PAID", InvoiceID: "bill-1", Total: 200,
            Contact: { ContactID: "supplier-1", Name: "College Supplier" },
          },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        Contacts: [{
          ContactID: "contact-1", ContactNumber: "STU-100", Name: "Student One",
          EmailAddress: "student.one@example.invalid",
        }],
      }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await new XeroClient().studentCandidates("access", "tenant-1");

    expect(result).toEqual({
      candidates: [expect.objectContaining({
        xeroContactId: "contact-1",
        legalName: "Student One",
        email: "student.one@example.invalid",
        suggestedStudentReference: "STU-100",
        invoiceCount: 2,
        latestInvoiceNumber: "TRUST-002",
        totalInvoiced: 1500,
        totalPaid: 1100,
        amountDue: 400,
        paymentStatus: "due",
      })],
      invoiceCount: 2,
      truncated: false,
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("summaryOnly=true");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("Contacts");
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ "xero-tenant-id": "tenant-1" });
  });
});
