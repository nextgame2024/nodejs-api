import { afterEach,describe,expect,it } from '@jest/globals';
import { invoiceDraftRequest,lineTotal,validateDraftSchedule,type InvoiceDraftRequest } from './student-case-invoice-drafts.js';
import { analysisVerdict } from './student-document-analysis-state.js';
import type { OfferExtraction } from './student-case-offers.js';

const source:OfferExtraction={kind:'letter_of_offer',studentName:'Fixture Student',collegeName:'Fixture College',abn:null,cricosProviderCode:null,currency:'AUD',statedTotalMinor:97000,issues:[],evidence:[],courses:[],fees:[],
  instalments:[{sequence:1,dueOn:'2026-11-01',dueTerm:null,totalMinor:99500,includedConditionalFeeMinor:2500,components:[]}]};
function request():InvoiceDraftRequest{return {offerId:'11111111-1111-4111-8111-111111111111',offerVersion:1,caseVersion:1,advisorId:'22222222-2222-4222-8222-222222222222',catalogueConnectionId:'33333333-3333-4333-8333-333333333333',catalogueRevision:1,reviewNote:'',invoices:[{sequence:1,issueDate:'2026-10-26',dueDate:'2026-11-01',conditionalFeeApplies:false,conditionalFeeMinor:0,
  lines:[{kind:'tuition',description:'Tuition',itemId:'44444444-4444-4444-8444-444444444444',itemCode:'ELICOS ON-SHORE',quantity:'1',unitAmountMinor:97000,amountMinor:97000,accountCode:'812',taxType:'BASEXCLUDED'}]}]};}
describe('Sophia-only invoice draft contract',()=>{
  it('keeps the 970 base and 995 with transfer fee without double-counting',()=>{
    const v=request();expect(validateDraftSchedule(source,v)[0]).toMatchObject({totalMinor:97000,sourceTotalMinor:99500,differenceMinor:0,status:'DRAFT',paymentTrack:'PENDING',invoiceNumber:'INV-1'});
    v.invoices[0].conditionalFeeApplies=true;v.invoices[0].conditionalFeeMinor=2500;
    expect(validateDraftSchedule(source,v)[0]).toMatchObject({totalMinor:99500,differenceMinor:0});expect(source.instalments[0].totalMinor).toBe(99500);
  });
  it('requires an explicit boolean fee decision and rejects authority/provider fields',()=>{
    const v=request() as any;delete v.invoices[0].conditionalFeeApplies;expect(invoiceDraftRequest.safeParse(v).success).toBe(false);
    expect(invoiceDraftRequest.safeParse({...request(),customerId:'foreign',xeroContactId:'foreign'}).success).toBe(false);
  });
  it('requires one and only one draft per offer instalment',()=>{
    const v=request();v.invoices.push({...v.invoices[0]});expect(()=>validateDraftSchedule(source,v)).toThrow('exactly one');
    v.invoices[0].sequence=9;expect(()=>validateDraftSchedule(source,v)).toThrow('exactly one');
  });
  it('requires an explanation for amount or source-date changes',()=>{
    const v=request();v.invoices[0].dueDate='2026-11-02';expect(()=>validateDraftSchedule(source,v)).toThrow('Explain');v.reviewNote='Client confirmed revised date';expect(validateDraftSchedule(source,v)[0].sourceDueDate).toBe('2026-11-01');
    v.reviewNote='';v.invoices[0].dueDate='2026-11-01';v.invoices[0].lines[0].amountMinor=98000;v.invoices[0].lines[0].unitAmountMinor=98000;expect(()=>validateDraftSchedule(source,v)).toThrow('Explain');
  });
  it('rejects incorrect line maths, invalid dates and removed category/location inputs',()=>{
    const v=request();v.invoices[0].lines[0].amountMinor=1;expect(()=>validateDraftSchedule(source,v)).toThrow('quantities');
    const d=request();d.invoices[0].dueDate='2026-10-01';expect(()=>validateDraftSchedule(source,d)).toThrow('Due dates');
    expect(invoiceDraftRequest.safeParse({...request(),category:'VET',location:'ON-SHORE'}).success).toBe(false);
  });
  it('rounds fractional quantities exactly once using integer minor units',()=>{expect(lineTotal('4',18000)).toBe(72000);expect(lineTotal('1.0001',5000)).toBe(5001);expect(lineTotal('0.5',1)).toBe(1);});
});
describe('Initial document workflow manual-review gate',()=>{
  const previous=process.env.STUDENT_DOCUMENT_WORKFLOW_ENABLED;
  afterEach(()=>{if(previous===undefined)delete process.env.STUDENT_DOCUMENT_WORKFLOW_ENABLED;else process.env.STUDENT_DOCUMENT_WORKFLOW_ENABLED=previous;});
  it('never replaces manual approval with an invented signature confidence score',()=>{
    process.env.STUDENT_DOCUMENT_WORKFLOW_ENABLED='true';
    const row={status:'succeeded',result_id:'result',extraction:{kind:'passport',studentName:'Fixture Student',evidence:[{page:1,quote:'Synthetic expiry'}],issues:[],expiresOn:'2035-01-01',mrzExpiryMatches:true}};
    expect(analysisVerdict(row,'Fixture Student','2026-10-26').status).toBe('needs_review');
    expect(analysisVerdict({...row,review_result_id:'result',decision:'confirmed'},'Fixture Student','2026-10-26').status).toBe('passed');
    expect(analysisVerdict({...row,review_result_id:'result',decision:'rejected'},'Fixture Student','2026-10-26').status).toBe('invalid');
  });
});
