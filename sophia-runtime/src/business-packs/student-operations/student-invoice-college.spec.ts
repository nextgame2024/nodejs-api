import {afterEach,beforeEach,describe,expect,it,jest} from '@jest/globals';
import {StudentCaseInvoiceDraftsService} from './student-case-invoice-drafts.js';
import {invoiceDraftXeroValue} from './student-case-invoice-matching.js';

const tenant='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
const offerId='33333333-3333-4333-8333-333333333333',advisorId='44444444-4444-4444-8444-444444444444';
const connection='55555555-5555-4555-8555-555555555555',itemId='66666666-6666-4666-8666-666666666666';
const caseCollege='77777777-7777-4777-8777-777777777777',otherCollege='88888888-8888-4888-8888-888888888888';
const batchId='99999999-9999-4999-8999-999999999999';
const principal={tenantId:tenant,identityUserId:'fixture-actor',role:'chief_executive'};
function fixture(){
  const colleges=[{collegeId:caseCollege,name:'Australian College of Commerce & Information Technology Pty Ltd',isPrimary:true},
    {collegeId:otherCollege,name:'East Coast College Pty. Ltd',isPrimary:false}];
  const source={kind:'letter_of_offer',studentName:'Fixture Student',collegeName:colleges[1].name,abn:null,cricosProviderCode:null,currency:'AUD',statedTotalMinor:20000,
    evidence:[{page:1,quote:'Synthetic offer'}],issues:[],courses:[],fees:[],instalments:[1,2].map(sequence=>({sequence,dueTerm:null,dueOn:'2027-01-01',totalMinor:10000,includedConditionalFeeMinor:0}))};
  const engagement={kind:'engagement_letter',studentName:'Fixture Student',signerName:'Fixture Student',status:'signed',completed:true,signedAt:'2026-01-01T00:00:00Z',documentIdMatches:true,evidence:[{page:1,quote:'Signed'}],issues:[]};
  const state:{batch:any;frozen:Array<{sequence:number;status:string}>}={batch:null,frozen:[]};
  const query=jest.fn(async(sql:string,params:unknown[]=[])=>{
    if(sql.includes('SELECT q.requirement_key'))return {rows:[{requirement_key:'engagement_letter',required:true,type_status:'active',status:'succeeded',document_kind:'engagement_letter',result_id:'result',extraction:engagement,legal_name:'Fixture Student'}]};
    if(sql.includes('SELECT o.*,v.corrections'))return {rows:[{offer_id:offerId,record_version:1,extraction:source}]};
    if(sql.includes('student_operations_college_directory'))return {rows:colleges};
    if(sql.includes('student_operations_advisor_directory'))return {rows:[{advisorId,code:'A1',name:'Advisor'}]};
    if(sql.includes('SELECT legal_name'))return {rows:[{legal_name:'Fixture Student',name:'Fixture Student',advisorId}]};
    if(sql.includes('FROM sophia_runtime.student_xero_sales_catalogues'))return {rows:[{connectionId:connection,revision:1,lastSyncedAt:'2026-11-10',snapshot:{
      items:[{itemId,code:'TUITION',accountCode:'812',taxType:'BASEXCLUDED'}],accounts:[{code:'812'}],taxRates:[{taxType:'BASEXCLUDED',rate:'0'}]}}]};
    if(sql.includes('SELECT b.batch_id AS'))return {rows:state.batch?[{batchId,offerId,advisorId,revision:state.batch.revision,snapshot:state.batch.snapshot,exports:Object.fromEntries(state.frozen.map(r=>[r.sequence,{status:r.status}]))}]:[]};
    if(sql.includes('SELECT batch_id,advisor_id,revision,snapshot'))return {rows:state.batch?[state.batch]:[]};
    if(sql.includes('SELECT sequence,status'))return {rows:state.frozen};
    if(sql.includes('INSERT INTO sophia_runtime.student_case_invoice_draft_batches')){
      state.batch={batch_id:batchId,advisor_id:advisorId,revision:1,snapshot:JSON.parse(params[5] as string)};return {rows:[state.batch]};
    }
    if(sql.includes('UPDATE sophia_runtime.student_case_invoice_draft_batches')){
      state.batch.snapshot=JSON.parse(params[5] as string);state.batch.revision++;return {rows:[{revision:state.batch.revision}]};
    }
    throw new Error(`Unexpected fixture query: ${sql}`);
  });
  const transaction=jest.fn(async(_tenant:string,work:(db:any)=>Promise<any>)=>work({query}));
  const cases={authorizedCase:jest.fn(async()=>({student_id:'student',record_version:1,lifecycle_status:'pre_sale',current_stage:'checklist_complete'})),
    write:jest.fn(async(_p:unknown,_op:string,_input:unknown,_key:unknown,work:(db:any)=>Promise<any>)=>work({query})),activity:jest.fn(async()=>{})};
  const service=new StudentCaseInvoiceDraftsService({tenantReadTransaction:transaction} as never,cases as never,{} as never);
  const payload={offerId,offerVersion:1,caseVersion:1,advisorId,catalogueConnectionId:connection,catalogueRevision:1,reviewNote:'',
    invoices:[1,2].map(sequence=>({sequence,issueDate:'2027-01-01',dueDate:'2027-01-01',conditionalFeeApplies:false,conditionalFeeMinor:0,
      lines:[{kind:'tuition',description:'Tuition',itemId,itemCode:'TUITION',quantity:'1',unitPrice:'100.00',amountMinor:10000,accountCode:'812',taxType:'BASEXCLUDED'}]}))};
  const save=(extra:Record<string,unknown>={})=>service.prepare(principal as never,id,{...payload,...(state.batch?{draftBatchId:batchId,draftRevision:state.batch.revision}:{}),...extra},'fixture-key');
  return {service,colleges,query,state,save,transaction,cases};
}
describe('Offer invoice college selection',()=>{
  const old={workflow:process.env.STUDENT_DOCUMENT_WORKFLOW_ENABLED,url:process.env.SOPHIA_RUNTIME_DATABASE_URL};
  beforeEach(()=>{process.env.STUDENT_DOCUMENT_WORKFLOW_ENABLED='true';process.env.SOPHIA_RUNTIME_DATABASE_URL='postgresql://example.invalid/runtime';});
  afterEach(()=>{for(const [key,value] of [['STUDENT_DOCUMENT_WORKFLOW_ENABLED',old.workflow],['SOPHIA_RUNTIME_DATABASE_URL',old.url]]){
    if(value===undefined)delete process.env[key!];else process.env[key!]=value;
  }});
  it('loads the full tenant college directory and marks the case default independently of the offer text',async()=>{
    const f=fixture(),result=await f.service.list(principal as never,id);
    expect(result.preparation?.colleges).toEqual(f.colleges);expect(result.preparation?.source.collegeName).toBe(f.colleges[1].name);
    expect(f.transaction).toHaveBeenCalledWith(tenant,expect.any(Function));
    expect(f.query.mock.calls.find(([sql])=>sql.includes('student_operations_college_directory'))?.[1]).toEqual([tenant,id]);
  });
  it('defaults older clients to the case college and sends the selected name to Xero',async()=>{
    const f=fixture();await f.save();
    expect(f.state.batch.snapshot).toMatchObject({collegeId:caseCollege,collegeName:f.colleges[0].name});
    await f.save({collegeId:otherCollege});
    const snapshot=f.state.batch.snapshot;
    expect(snapshot).toMatchObject({collegeId:otherCollege,collegeName:f.colleges[1].name});
    expect(invoiceDraftXeroValue(snapshot,snapshot.invoices[0],'contact').reference).toBe(f.colleges[1].name);
    await f.save();expect(f.state.batch.snapshot.collegeId).toBe(otherCollege);
    expect((await f.service.list(principal as never,id)).preparation?.savedBatch?.snapshot.collegeId).toBe(otherCollege);
    expect(f.query.mock.calls.some(([sql])=>/UPDATE.*student_operations_case_colleges/.test(sql))).toBe(false);
  });
  it('rejects a college outside the available tenant directory and does not choose the first when no case default exists',async()=>{
    const f=fixture();await expect(f.save({collegeId:connection})).rejects.toThrow('Select an available college');
    f.colleges.forEach(c=>c.isPrimary=false);await expect(f.save()).rejects.toThrow('Select an available college');
    expect(f.state.batch).toBeNull();await expect(f.save({collegeId:otherCollege})).resolves.toMatchObject({count:2});
  });
  it.each(['created','creating','review_required'])('preserves %s invoice references while changing the unsent invoices',async status=>{
    const f=fixture();await f.save();f.state.frozen=[{sequence:1,status}];
    // Include batches from before per-invoice references were stored.
    delete f.state.batch.snapshot.invoices[0].collegeName;
    await f.save({collegeId:otherCollege});const snapshot=f.state.batch.snapshot;
    expect(invoiceDraftXeroValue(snapshot,snapshot.invoices[0],'contact').reference).toBe(f.colleges[0].name);
    expect(invoiceDraftXeroValue(snapshot,snapshot.invoices[1],'contact').reference).toBe(f.colleges[1].name);
    await f.save({collegeId:caseCollege});
    expect(f.state.batch.snapshot.invoices[0].collegeName).toBe(f.colleges[0].name);
  });
  it('still enforces financial permissions',async()=>{
    const f=fixture();await expect(f.service.list({...principal,role:'advisor'} as never,id)).rejects.toThrow();
    expect(f.query).not.toHaveBeenCalled();
  });
  it('does not permit changing a sent invoice line when changing the college for unsent invoices',async()=>{
    const f=fixture();await f.save();f.state.frozen=[{sequence:1,status:'created'}];
    const invoices=f.state.batch.snapshot.invoices.map((invoice:any)=>({sequence:invoice.sequence,issueDate:invoice.issueDate,dueDate:invoice.dueDate,
      conditionalFeeApplies:false,conditionalFeeMinor:0,lines:invoice.lines.map((line:any)=>({kind:line.kind,description:'Changed tuition',itemId:line.itemId,itemCode:line.itemCode,
        quantity:line.quantity,unitPrice:line.unitPrice,amountMinor:line.amountMinor,accountCode:line.accountCode,taxType:line.taxType}))}));
    await expect(f.save({collegeId:otherCollege,invoices})).rejects.toThrow('read-only');
    expect(f.state.batch.snapshot.collegeId).toBe(caseCollege);
  });
});
