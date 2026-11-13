import { afterEach,describe,expect,it,jest } from '@jest/globals';
import { BadGatewayException, ConflictException } from '@nestjs/common';
import { StudentCaseInvoiceDraftsService,exactXeroInvoiceMatches,invoiceDraftRequest,lineTotal,matchesXeroInvoice,validateDraftSchedule,xeroPreflightFailure,type InvoiceDraftRequest } from './student-case-invoice-drafts.js';
import { analysisVerdict } from './student-document-analysis-state.js';
import type { OfferExtraction } from './student-case-offers.js';

const source:OfferExtraction={kind:'letter_of_offer',studentName:'Fixture Student',collegeName:'Fixture College',abn:null,cricosProviderCode:null,currency:'AUD',statedTotalMinor:97000,issues:[],evidence:[],courses:[],fees:[],
  instalments:[{sequence:1,dueOn:'2026-11-01',dueTerm:null,totalMinor:99500,includedConditionalFeeMinor:2500,components:[]}]};
function request():InvoiceDraftRequest{return {offerId:'11111111-1111-4111-8111-111111111111',offerVersion:1,caseVersion:1,advisorId:'22222222-2222-4222-8222-222222222222',catalogueConnectionId:'33333333-3333-4333-8333-333333333333',catalogueRevision:1,reviewNote:'',invoices:[{sequence:1,issueDate:'2026-10-26',dueDate:'2026-11-01',conditionalFeeApplies:false,conditionalFeeMinor:0,
  lines:[{kind:'tuition',description:'Tuition',itemId:'44444444-4444-4444-8444-444444444444',itemCode:'ELICOS ON-SHORE',quantity:'1',unitAmountMinor:97000,amountMinor:97000,accountCode:'812',taxType:'BASEXCLUDED'}]}]};}
describe('Sophia-only invoice draft contract',()=>{
  it('hides preparation for a completed paired batch without loading catalogues or document evidence',async()=>{
    const before=process.env.STUDENT_DOCUMENT_WORKFLOW_ENABLED;process.env.STUDENT_DOCUMENT_WORKFLOW_ENABLED='true';
    try{
      const query=jest.fn(async(sql:string)=>({rows:sql.includes(' AS exports')?[{currentOffer:true}]:[{ready:false}]}));
      const database={tenantReadTransaction:async(_tenant:string,work:any)=>work({query})};
      const cases={authorizedCase:async()=>({lifecycle_status:'pre_sale',current_stage:'awaiting_payment'})};
      const service=new StudentCaseInvoiceDraftsService(database as never,cases as never,{} as never);
      const result=await service.list({tenantId:'tenant',role:'chief_executive'} as never,'case');
      expect(result.preparation).toBeNull();expect(query).toHaveBeenCalledTimes(2);
      const [sql,values]=query.mock.calls[1] as unknown as [string,unknown[]];
      expect(sql).toContain('e.batch_id=b.batch_id');expect(sql).toContain("e.status='created'");expect(sql).toContain('b.case_id=$3');expect(values[2]).toBe('case');
    }finally{if(before===undefined)delete process.env.STUDENT_DOCUMENT_WORKFLOW_ENABLED;else process.env.STUDENT_DOCUMENT_WORKFLOW_ENABLED=before;}
  });
  it('still checks preparation evidence when PTY invoices remain unfinished after TRUST creation',async()=>{
    const before=process.env.STUDENT_DOCUMENT_WORKFLOW_ENABLED;process.env.STUDENT_DOCUMENT_WORKFLOW_ENABLED='true';
    try{
      const query=jest.fn(async(sql:string)=>({rows:sql.includes(' AS exports')?[{currentOffer:true}]:sql.includes(' AS ready')?[{ready:true}]:[]}));
      const database={tenantReadTransaction:async(_tenant:string,work:any)=>work({query})};
      const cases={authorizedCase:async()=>({lifecycle_status:'pre_sale',current_stage:'awaiting_payment'})};
      const service=new StudentCaseInvoiceDraftsService(database as never,cases as never,{} as never);
      await service.list({tenantId:'tenant',role:'chief_executive'} as never,'case');
      expect(query.mock.calls.some(([sql])=>sql.includes('student_operations_status_document_requirements'))).toBe(true);
    }finally{if(before===undefined)delete process.env.STUDENT_DOCUMENT_WORKFLOW_ENABLED;else process.env.STUDENT_DOCUMENT_WORKFLOW_ENABLED=before;}
  });
  it('keeps the 970 base and 995 with transfer fee without double-counting',()=>{
    const v=request();expect(validateDraftSchedule(source,v)[0]).toMatchObject({totalMinor:97000,sourceTotalMinor:99500,differenceMinor:0,status:'DRAFT',paymentTrack:'PENDING',invoiceNumber:'INV-1'});
    v.invoices[0].conditionalFeeApplies=true;v.invoices[0].conditionalFeeMinor=2500;
    expect(validateDraftSchedule(source,v)[0]).toMatchObject({totalMinor:99500,differenceMinor:0});expect(source.instalments[0].totalMinor).toBe(99500);
  });
  it('treats itemized instalment fees as additional without changing tuition or materials',()=>{
    const totals=[144000,113000,108000,113000,108000,113000,108000];
    for(const [index,total] of totals.entries()){
      const materials=total===113000?5000:0;
      const offer={...source,instalments:[{...source.instalments[0],sequence:index+2,totalMinor:total,components:[{label:'Tuition fee',amountMinor:total-materials},{label:'Materials fee',amountMinor:materials}]}]};
      const v=request();v.invoices[0].sequence=index+2;
      v.invoices[0].lines=[{...v.invoices[0].lines[0],amountMinor:total,unitAmountMinor:total}];
      expect(validateDraftSchedule(offer,v)[0]).toMatchObject({totalMinor:total,differenceMinor:0,sourceIncludedConditionalFeeMinor:0});
      v.invoices[0].conditionalFeeApplies=true;v.invoices[0].conditionalFeeMinor=2500;
      expect(validateDraftSchedule(offer,v)[0]).toMatchObject({totalMinor:total+2500,differenceMinor:0});
      expect(offer.instalments[0].includedConditionalFeeMinor).toBe(2500);
    }
  });
  it('preserves included fees and does not infer inclusion from ambiguous components',()=>{
    const v=request();
    const included={...source,instalments:[{...source.instalments[0],components:[{label:'Tuition',amountMinor:72000},{label:'Material',amountMinor:5000}]}]};
    expect(validateDraftSchedule(included,v)[0]).toMatchObject({totalMinor:97000,sourceIncludedConditionalFeeMinor:2500});
    const ambiguous={...source,instalments:[{...source.instalments[0],components:[{label:'Total',amountMinor:99500}]}]};
    expect(validateDraftSchedule(ambiguous,v)[0].sourceIncludedConditionalFeeMinor).toBe(2500);
  });
  it('requires an explicit boolean fee decision and rejects authority/provider fields',()=>{
    const v=request() as any;delete v.invoices[0].conditionalFeeApplies;expect(invoiceDraftRequest.safeParse(v).success).toBe(false);
    expect(invoiceDraftRequest.safeParse({...request(),customerId:'foreign',xeroContactId:'foreign'}).success).toBe(false);
  });
  it('requires one and only one draft per offer instalment',()=>{
    const v=request();v.invoices.push({...v.invoices[0]});expect(()=>validateDraftSchedule(source,v)).toThrow('exactly one');
    v.invoices[0].sequence=9;expect(()=>validateDraftSchedule(source,v)).toThrow('exactly one');
  });
  it('identifies the payment and conditional fee mismatch without changing approved amounts',()=>{
    const v=request();v.invoices[0].sequence=2;v.invoices[0].lines=[{...v.invoices[0].lines[0],quantity:'1',unitAmountMinor:144000,amountMinor:144000}];
    const offer={...source,instalments:[{...source.instalments[0],sequence:2,totalMinor:144000,includedConditionalFeeMinor:2500}]};
    try{validateDraftSchedule(offer,v);throw new Error('Expected review requirement');}catch(error){
      expect((error as any).getResponse()).toMatchObject({errorCode:'invoice_review_note_required',sequence:2,totalMinor:144000,expectedTotalMinor:141500,differenceMinor:2500,sourceIncludedConditionalFeeMinor:2500});
      expect((error as Error).message).toContain('INV-2 (TRUST)');
    }
    v.reviewNote='Reviewed payment against the approved offer';
    expect(validateDraftSchedule(offer,v)[0]).toMatchObject({totalMinor:144000,differenceMinor:2500});
  });
  it('requires an explanation for amount or source-date changes',()=>{
    const v=request();v.invoices[0].dueDate='2026-11-02';expect(()=>validateDraftSchedule(source,v)).toThrow('Explain');v.reviewNote='Client confirmed revised date';expect(validateDraftSchedule(source,v)[0].sourceDueDate).toBe('2026-11-01');
    v.reviewNote='';v.invoices[0].dueDate='2026-11-01';v.invoices[0].lines[0].amountMinor=98000;v.invoices[0].lines[0].unitAmountMinor=98000;expect(()=>validateDraftSchedule(source,v)).toThrow('Explain');
  });
  it('accepts the server-generated current-date defaults without a review note',()=>{
    const v=request();v.invoices[0].issueDate='2026-10-27';v.invoices[0].dueDate='2026-10-27';
    expect(validateDraftSchedule(source,v,()=>0,'2026-10-27')[0]).toMatchObject({issueDate:'2026-10-27',dueDate:'2026-10-27',differenceMinor:0});
    v.invoices[0].issueDate='2026-10-28';v.invoices[0].dueDate='2026-10-28';
    expect(()=>validateDraftSchedule(source,v,()=>0,'2026-10-27')).toThrow('Explain');
  });
  it('rejects incorrect line maths, invalid dates and removed category/location inputs',()=>{
    const v=request();v.invoices[0].lines[0].amountMinor=1;expect(()=>validateDraftSchedule(source,v)).toThrow('quantities');
    const d=request();d.invoices[0].dueDate='2026-10-01';expect(()=>validateDraftSchedule(source,d)).toThrow('Due dates');
    expect(invoiceDraftRequest.safeParse({...request(),category:'VET',location:'ON-SHORE'}).success).toBe(false);
  });
  it('preserves saved default dates on the next day without changing frozen invoice snapshots',()=>{
    const v=request();v.invoices[0].issueDate='2026-10-27';v.invoices[0].dueDate='2026-10-27';
    const saved=validateDraftSchedule(source,v,()=>0,'2026-10-27');
    expect(()=>validateDraftSchedule(source,v,()=>0,'2026-10-28')).toThrow('Explain');
    expect(validateDraftSchedule(source,v,()=>0,'2026-10-28',saved)).toEqual(saved);
    v.invoices[0].dueDate='2026-10-29';
    expect(()=>validateDraftSchedule(source,v,()=>0,'2026-10-28',saved)).toThrow('Explain');
    v.invoices[0].dueDate='2026-10-27';v.invoices[0].lines[0].unitAmountMinor=98000;v.invoices[0].lines[0].amountMinor=98000;
    expect(()=>validateDraftSchedule(source,v,()=>0,'2026-10-28',saved)).toThrow('Explain');
  });
  it('rounds fractional quantities exactly once using integer minor units',()=>{expect(lineTotal('4',18000)).toBe(72000);expect(lineTotal('1.0001',5000)).toBe(5001);expect(lineTotal('0.5',1)).toBe(1);});
  it('reconciles only one exact Xero invoice payload, including lines and tracking',()=>{
    const value={contactId:'11111111-1111-4111-8111-111111111111',date:'2026-10-27',dueDate:'2026-10-27',reference:'Fixture College',currencyCode:'AUD',lines:[{description:'Tuition',quantity:'5.00',unitAmount:'144.00',itemCode:'ELICOS ON-SHORE',accountCode:'812',taxType:'BASEXCLUDED',tracking:[{name:'Payment Track',option:'PENDING'}]}]};
    const candidate={invoiceId:'22222222-2222-4222-8222-222222222222',contactId:value.contactId,invoiceNumber:'INV-10577',invoiceReference:value.reference,concept:'Tuition',advisorName:null,collegeName:value.reference,paymentTrack:'PENDING',sentToContact:false,
      lineItems:[{lineItemId:null,itemCode:'ELICOS ON-SHORE',description:'Tuition',quantity:5,unitAmount:144,discountRate:null,accountCode:'812',taxType:'BASEXCLUDED',taxAmount:0,lineAmount:720,tracking:[{name:'Payment Track',option:'PENDING'}]}],
      type:'ACCREC',status:'DRAFT',invoiceDate:value.date,dueDate:value.dueDate,currencyCode:'AUD',total:720,amountPaid:0,amountDue:720,updatedAt:null};
    expect(matchesXeroInvoice(candidate,value,72000)).toBe(true);expect(matchesXeroInvoice({...candidate,total:721},value,72000)).toBe(false);
    expect(matchesXeroInvoice({...candidate,lineItems:[{...candidate.lineItems[0],description:'Different'}]},value,72000)).toBe(false);
    const advisor={name:'Sales Representative',option:'S15 Fixture Advisor'};
    const expected={...value,lines:[{...value.lines[0],tracking:[...value.lines[0].tracking,advisor]}]};
    const unassigned={...candidate,paymentTrack:null,lineItems:[{...candidate.lineItems[0],tracking:[advisor]}]};
    // Regression: Xero accepted all financial fields and the advisor but omitted
    // the optional PENDING category, as observed on the affected invoice.
    expect(matchesXeroInvoice(unassigned,expected,72000)).toBe(true);
    expect(matchesXeroInvoice({...unassigned,lineItems:[{...unassigned.lineItems[0],tracking:[]}]},expected,72000)).toBe(false);
    expect(matchesXeroInvoice({...unassigned,lineItems:[{...unassigned.lineItems[0],tracking:[advisor,{name:'Payment Track',option:'Paid out'}]}]},expected,72000)).toBe(false);
    expect(matchesXeroInvoice({...unassigned,lineItems:[{...unassigned.lineItems[0],unitAmount:145}]},expected,72000)).toBe(false);
    expect(matchesXeroInvoice({...unassigned,contactId:'different'},expected,72000)).toBe(false);
  });
  it('hydrates plausible summary candidates by invoice ID before exact reconciliation',async()=>{
    const value={contactId:'11111111-1111-4111-8111-111111111111',date:'2026-10-27',dueDate:'2026-10-27',reference:'Fixture College',currencyCode:'AUD',lines:[{description:'Tuition\nline two',quantity:'5.00',unitAmount:'144.00',itemCode:'ELICOS ON-SHORE',accountCode:'812',taxType:'BASEXCLUDED',tracking:[{name:'Payment Track',option:'PENDING'}]}]};
    const summary={invoiceId:'22222222-2222-4222-8222-222222222222',contactId:value.contactId,invoiceNumber:'INV-10577',invoiceReference:value.reference,concept:null,advisorName:null,collegeName:value.reference,paymentTrack:null,sentToContact:false,lineItems:[],type:'ACCREC',status:'DRAFT',invoiceDate:value.date,dueDate:value.dueDate,currencyCode:'AUD',total:720,amountPaid:0,amountDue:720,updatedAt:null};
    const read=jest.fn(async()=>({...summary,lineItems:[{lineItemId:null,itemCode:'ELICOS ON-SHORE',description:'Tuition\r\nline two',quantity:5,unitAmount:144,discountRate:null,accountCode:'812',taxType:'BASEXCLUDED',taxAmount:0,lineAmount:720,tracking:[{name:'Payment Track',option:'PENDING'}]}]}));
    await expect(exactXeroInvoiceMatches([summary],value,72000,read)).resolves.toHaveLength(1);expect(read).toHaveBeenCalledWith(summary.invoiceId);
    await expect(exactXeroInvoiceMatches([{...summary,total:721}],value,72000,read)).resolves.toHaveLength(0);expect(read).toHaveBeenCalledTimes(1);
  });
  it('returns a safe actionable reason when Xero rejects the request before sending',()=>{
    expect(xeroPreflightFailure(new ConflictException({errorCode:'xero_invoice_write_scope_missing',message:'Reconnect Xero.'}))).toEqual({errorCode:'xero_invoice_write_scope_missing',message:'Reconnect Xero.'});
    expect(xeroPreflightFailure(new BadGatewayException({errorCode:'xero_invoice_idempotency_conflict',message:'Review Xero.'}))).toEqual({errorCode:'xero_invoice_idempotency_conflict',message:'Review Xero.'});
    expect(xeroPreflightFailure(new Error('provider detail'))).toEqual({});
  });
});
describe('Deterministic document workflow validation',()=>{
  const previous=process.env.STUDENT_DOCUMENT_WORKFLOW_ENABLED;
  afterEach(()=>{if(previous===undefined)delete process.env.STUDENT_DOCUMENT_WORKFLOW_ENABLED;else process.env.STUDENT_DOCUMENT_WORKFLOW_ENABLED=previous;});
  it('automatically accepts a valid passport while preserving explicit rejection',()=>{
    process.env.STUDENT_DOCUMENT_WORKFLOW_ENABLED='true';
    const row={status:'succeeded',result_id:'result',extraction:{kind:'passport',studentName:'Fixture Student',evidence:[{page:1,quote:'Synthetic expiry'}],issues:[],expiresOn:'2035-01-01',mrzExpiryMatches:true}};
    expect(analysisVerdict(row,'Fixture Student','2026-10-26').status).toBe('passed');
    expect(analysisVerdict({...row,review_result_id:'result',decision:'confirmed'},'Fixture Student','2026-10-26').status).toBe('passed');
    expect(analysisVerdict({...row,review_result_id:'result',decision:'rejected'},'Fixture Student','2026-10-26').status).toBe('invalid');
  });
});
