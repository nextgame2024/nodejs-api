import {afterEach,beforeEach,describe,expect,it,jest} from '@jest/globals';
import {BadGatewayException,BadRequestException,Logger} from '@nestjs/common';
import {StudentCaseInvoiceDraftsService} from './student-case-invoice-drafts.js';
import type {XeroInvoiceCreate,XeroInvoiceRecord} from '../../connectors/xero/xero.client.js';

const tenant='11111111-1111-4111-8111-111111111111',batch='22222222-2222-4222-8222-222222222222',connection='33333333-3333-4333-8333-333333333333',contact='44444444-4444-4444-8444-444444444444';
const principal={tenantId:tenant,identityUserId:'fixture-actor',role:'chief_executive'};
function record(value:XeroInvoiceCreate,index:number):XeroInvoiceRecord{return {
  invoiceId:`55555555-5555-4555-8555-${String(index).padStart(12,'0')}`,invoiceNumber:`INV-${10000+index}`,contactId:contact,
  invoiceReference:value.reference,concept:'Tuition',advisorName:'Fixture Advisor',collegeName:value.reference,paymentTrack:'PENDING',sentToContact:false,
  type:'ACCREC',status:'DRAFT',invoiceDate:value.date,dueDate:value.dueDate,currencyCode:'AUD',total:100,amountPaid:0,amountDue:100,updatedAt:null,
  lineItems:value.lines.map(line=>({lineItemId:null,itemCode:line.itemCode??null,description:line.description,quantity:Number(line.quantity),unitAmount:Number(line.unitAmount),
    discountRate:null,accountCode:line.accountCode,taxType:line.taxType,taxAmount:0,lineAmount:100,tracking:line.tracking})),
};}
function fixture(count=7){
  const snapshot={studentName:'Fixture Student',advisorLabel:'Fixture Advisor',currency:'AUD',collegeName:'Fixture College',catalogueConnectionId:connection,
    invoices:Array.from({length:count},(_,index)=>({sequence:index+1,invoiceNumber:`INV-${index+1}`,issueDate:'2026-10-28',dueDate:'2026-10-28',conditionalFeeMinor:0,totalMinor:10000,
      lines:[{description:'Tuition',quantity:'1',unitPrice:'100.00',unitAmountMinor:10000,itemCode:'TUITION',accountCode:'812',taxType:'BASEXCLUDED'}]}))};
  const exports=new Map<number,{status:string;provider_key:string}>();let projectionFails=false;
  const query=jest.fn(async(sql:string,params:unknown[]=[])=>{
    if(sql.includes('SELECT b.snapshot'))return {rows:[{snapshot,offer_id:'offer',is_current:true}]};
    if(sql.includes('SELECT 1 FROM')&&sql.includes('xero_connections'))return {rows:[{}]};
    if(sql.includes('coalesce(primary_contact'))return {rows:[{xero_contact_id:contact}]};
    if(sql.includes('INSERT INTO')&&sql.includes('student_case_xero_invoice_exports')){
      const sequence=params[3] as number;if(exports.has(sequence))return {rows:[],rowCount:0};
      exports.set(sequence,{status:'creating',provider_key:params[6] as string});return {rows:[{}],rowCount:1};
    }
    if(sql.includes('SELECT status,provider_key'))return {rows:[exports.get(params[2] as number)]};
    if(sql.includes('UPDATE')&&sql.includes('student_case_xero_invoice_exports')){
      exports.get(params[2] as number)!.status=sql.includes("SET status='created'")?'created':params[3] as string;
      return {rows:[{}],rowCount:1};
    }
    if(sql.includes('INSERT INTO')&&sql.includes('student_operations_xero_invoices')&&projectionFails)throw Object.assign(new Error('sensitive SQL detail'),{code:'23503'});
    return {rows:[],rowCount:1};
  });
  const transaction=jest.fn(async(_tenant:string,work:(db:unknown)=>Promise<unknown>)=>work({query}));
  const createInvoice=jest.fn(async(value:XeroInvoiceCreate,_key:string)=>{
    const invoice=record(value,createInvoice.mock.calls.length);
    return {invoiceId:invoice.invoiceId,invoiceNumber:invoice.invoiceNumber,status:invoice.status,total:invoice.total,invoice};
  });
  const invoiceById=jest.fn(async(_id:string)=>record({contactId:contact,date:'2026-10-28',dueDate:'2026-10-28',reference:'Fixture College',currencyCode:'AUD',lines:[{description:'Tuition',quantity:'1',unitAmount:'100',itemCode:'TUITION',accountCode:'812',taxType:'BASEXCLUDED',tracking:[{name:'Payment Track',option:'PENDING'},{name:'Sales Representative',option:'Fixture Advisor'}]}]},1));
  const invoiceCreationSession=jest.fn(async()=>({createInvoice,invoiceById}));
  const cases={authorizedCase:jest.fn(async()=>({student_id:'student-uuid',student_reference:'STD-FIXTURE'})),activity:jest.fn(async()=>{})};
  const service=new StudentCaseInvoiceDraftsService({tenantTransaction:transaction} as never,cases as never,{invoiceCreationSession} as never);
  const run=()=>service.createXero(principal as never,'fixture-case',batch,{sequences:snapshot.invoices.map(invoice=>invoice.sequence),confirmed:true});
  return {service,run,snapshot,query,exports,createInvoice,invoiceById,invoiceCreationSession,projectionFailure:()=>{projectionFails=true;}};
}
describe('bounded Xero invoice creation',()=>{
  const previous={enabled:process.env.XERO_INVOICE_CREATION_ENABLED,url:process.env.SOPHIA_RUNTIME_DATABASE_URL};
  beforeEach(()=>{process.env.XERO_INVOICE_CREATION_ENABLED='true';process.env.SOPHIA_RUNTIME_DATABASE_URL='postgresql://example.invalid/runtime';jest.spyOn(Logger.prototype,'log').mockImplementation(()=>{});jest.spyOn(Logger.prototype,'warn').mockImplementation(()=>{});});
  afterEach(()=>{jest.useRealTimers();jest.restoreAllMocks();for(const [key,value] of [['XERO_INVOICE_CREATION_ENABLED',previous.enabled],['SOPHIA_RUNTIME_DATABASE_URL',previous.url]]){if(value===undefined)delete process.env[key!];else process.env[key!]=value;}});
  it('creates seven invoices in three waves, keeps result order and shares one connection session',async()=>{
    jest.useFakeTimers();const f=fixture();let active=0,peak=0;
    f.createInvoice.mockImplementation(async(value,_key)=>{const sequence=f.createInvoice.mock.calls.length;active++;peak=Math.max(peak,active);
      await new Promise(resolve=>setTimeout(resolve,sequence===1?120:100));active--;const invoice=record(value,sequence);return {invoiceId:invoice.invoiceId,invoiceNumber:invoice.invoiceNumber,status:invoice.status,total:invoice.total,invoice};});
    const done=f.run();await jest.advanceTimersByTimeAsync(300);
    expect((await done).results.map(result=>result.sequence)).toEqual([1,2,3,4,5,6,7]);expect(peak).toBe(3);expect(active).toBe(0);
    expect(f.invoiceCreationSession).toHaveBeenCalledTimes(1);expect(f.invoiceCreationSession).toHaveBeenCalledWith(tenant,connection);expect(f.invoiceById).not.toHaveBeenCalled();
    const keys=f.createInvoice.mock.calls.map(call=>call[1]);expect(new Set(keys).size).toBe(7);expect(keys.every(key=>/^[a-f0-9]{64}$/.test(key))).toBe(true);
    expect(await f.run()).toMatchObject({created:0,skipped:7});expect(f.createInvoice).toHaveBeenCalledTimes(7);
  });
  it('reads the exact invoice by ID when create details are incomplete or do not match',async()=>{
    const f=fixture(1);f.createInvoice.mockImplementationOnce(async(value)=>{const invoice=record(value,1);return {invoiceId:invoice.invoiceId,invoiceNumber:invoice.invoiceNumber,status:invoice.status,total:100,invoice:{...invoice,total:101}};});
    expect(await f.run()).toMatchObject({created:1,skipped:0});expect(f.invoiceById).toHaveBeenCalledTimes(1);
    expect(f.query.mock.calls.find(([sql])=>sql.includes('student_operations_case_invoice_links'))?.[1]).toEqual([tenant,'fixture-case','student-uuid','STD-FIXTURE',connection,expect.any(String),'fixture-actor']);
  });
  it('sends each saved issue/due date and PENDING tracking on every line, including the first invoice and fee',async()=>{
    const f=fixture(3);
    f.snapshot.invoices.forEach((invoice,index)=>{invoice.issueDate=`2027-0${index+1}-01`;invoice.dueDate=`2027-0${index+1}-15`;});
    f.snapshot.invoices[0].conditionalFeeMinor=2500;f.snapshot.invoices[0].totalMinor=12500;
    await f.run();
    expect(f.createInvoice).toHaveBeenCalledTimes(3);
    f.createInvoice.mock.calls.forEach(([value],index)=>{
      expect(value.date).toBe(f.snapshot.invoices[index].issueDate);expect(value.dueDate).toBe(f.snapshot.invoices[index].dueDate);
      for(const line of value.lines)expect(line.tracking).toEqual([{name:'Payment Track',option:'PENDING'},{name:'Sales Representative',option:'Fixture Advisor'}]);
    });
    expect(f.createInvoice.mock.calls[0][0].lines).toHaveLength(2);
  });
  it('retains confirmed receipts and queues indexing if projection fails without exposing SQL detail',async()=>{
    const f=fixture(1);f.projectionFailure();expect(await f.run()).toMatchObject({created:1,results:[{status:'created',message:expect.stringContaining('register refresh')}]});
    expect(f.exports.get(1)?.status).toBe('created');expect(f.query.mock.calls.some(([sql])=>sql.includes('SET next_sync_at=now()'))).toBe(true);
    expect(Logger.prototype.warn).toHaveBeenCalledWith({event:'xero_invoice_projection_pending',code:'23503'});
  });
  it('seeds verified payment amounts and unassigned tracking without inventing draft defaults',async()=>{
    const f=fixture(1);f.createInvoice.mockImplementationOnce(async(value)=>{const invoice={...record(value,1),status:'PAID',amountPaid:100,amountDue:0,paymentTrack:null};
      return {invoiceId:invoice.invoiceId,invoiceNumber:invoice.invoiceNumber,status:invoice.status,total:100,invoice};});
    expect(await f.run()).toMatchObject({created:1});
    const params=f.query.mock.calls.find(([sql])=>sql.includes('INSERT INTO')&&sql.includes('student_operations_xero_invoices'))![1]!;
    expect(params[6]).toBe('PAID');expect(params.slice(16,19)).toEqual([null,100,0]);
  });
  it('isolates validation failures and ambiguous sends while completing the other invoices',async()=>{
    const f=fixture(3);f.createInvoice.mockRejectedValueOnce(new BadRequestException('Invalid item')).mockRejectedValueOnce(new BadGatewayException('timeout'));
    expect(await f.run()).toMatchObject({created:1,skipped:2,results:[{sequence:1,status:'not_attempted'},{sequence:2,status:'review_required'},{sequence:3,status:'created'}]});
    expect(f.exports.get(1)?.status).toBe('not_attempted');expect(f.exports.get(2)?.status).toBe('review_required');expect(f.exports.get(3)?.status).toBe('created');
  });
  it('drains in-flight invoices and stops scheduling new sends after a fatal receipt-storage failure',async()=>{
    jest.useFakeTimers();const f=fixture(),query=f.query.getMockImplementation()!;
    f.query.mockImplementation(async(sql,params=[])=>{
      if(sql.includes('UPDATE')&&sql.includes('student_case_xero_invoice_exports')&&params[2]===1)throw new Error('Synthetic storage failure');
      return query(sql,params);
    });
    f.createInvoice.mockImplementation(async(value,_key)=>{const sequence=f.createInvoice.mock.calls.length;
      await new Promise(resolve=>setTimeout(resolve,sequence*100));const invoice=record(value,sequence);return {invoiceId:invoice.invoiceId,invoiceNumber:invoice.invoiceNumber,status:invoice.status,total:100,invoice};});
    let finished=false;const done=f.run().catch(error=>{finished=true;return error;});
    await jest.advanceTimersByTimeAsync(150);expect(finished).toBe(false);
    await jest.advanceTimersByTimeAsync(150);expect(await done).toBeInstanceOf(Error);expect(finished).toBe(true);
    expect(f.createInvoice).toHaveBeenCalledTimes(3);expect(f.exports.get(1)?.status).toBe('creating');expect(f.exports.get(2)?.status).toBe('created');expect(f.exports.get(3)?.status).toBe('created');
  });
});
