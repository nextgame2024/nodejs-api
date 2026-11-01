import {invoiceCanEdit,matchesEditedInvoice} from './student-invoice-edit-policy.js';
import type {XeroInvoiceRecord,XeroInvoiceUpdate} from '../../connectors/xero/xero.client.js';
const invoice={type:'ACCREC',status:'DRAFT',amountPaid:0,amountDue:100,total:100};
describe('full invoice editor eligibility',()=>{
  it.each(['DRAFT','SUBMITTED','AUTHORISED'])('permits unpaid %s sales invoices',status=>expect(invoiceCanEdit({...invoice,status})).toBe(true));
  it.each([{status:'PAID'},{status:'DELETED'},{status:'VOIDED'},{type:'ACCPAY'},{amountPaid:1},{amountCredited:1},{amountDue:90},{amountPaid:null},{total:undefined}])('rejects restricted invoice %o',change=>expect(invoiceCanEdit({...invoice,...change})).toBe(false));
  it('requires payment tracking and original line identities when confirming an update',()=>{
    const tracking=[{name:'Payment Track',option:'Pending'}],line={lineItemId:'line',itemCode:'FEE',description:'Fee',quantity:1,unitAmount:100,discountRate:null,accountCode:'812',taxType:'BASEXCLUDED',taxAmount:0,lineAmount:100,tracking};
    const actual={...invoice,invoiceId:'invoice',contactId:'contact',invoiceNumber:'INV-1',invoiceReference:'Ref',concept:null,advisorName:null,collegeName:'Ref',paymentTrack:'Pending',sentToContact:false,invoiceDate:'2026-11-01',dueDate:'2026-11-02',currencyCode:'AUD',updatedAt:null,lineItems:[line]} as XeroInvoiceRecord;
    const desired={contactId:'contact',date:'2026-11-01',dueDate:'2026-11-02',reference:'Ref',currencyCode:'AUD',status:'DRAFT',lines:[{...line,quantity:'1',unitAmount:'100'}]} as XeroInvoiceUpdate;
    expect(matchesEditedInvoice(actual,desired,10000)).toBe(true);
    expect(matchesEditedInvoice({...actual,lineItems:[{...line,tracking:[]}]},desired,10000)).toBe(false);
    expect(matchesEditedInvoice({...actual,lineItems:[{...line,lineItemId:'recreated'}]},desired,10000)).toBe(false);
  });
});
