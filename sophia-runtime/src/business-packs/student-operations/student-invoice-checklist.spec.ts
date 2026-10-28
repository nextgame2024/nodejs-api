import {describe,expect,it} from '@jest/globals';
import {evaluateInvoiceChecklist} from './student-invoice-checklist.js';
import {invoiceDraftXeroValue} from './student-case-invoice-matching.js';
import type {InvoiceSnapshot} from './student-case-invoice-drafts.js';
import type {XeroInvoiceRecord} from '../../connectors/xero/xero.client.js';

function fixture(){
  const snapshot={studentName:'Fixture',advisorLabel:'S15 Advisor',currency:'AUD',collegeName:'College',catalogueConnectionId:'connection',
    invoices:[1,2].map(sequence=>({sequence,invoiceNumber:`INV-${sequence}`,issueDate:'2027-01-01',dueDate:'2027-01-15',conditionalFeeMinor:0,totalMinor:10000,
      lines:[{description:'Tuition',quantity:'1',unitPrice:'100',unitAmountMinor:10000,itemCode:'ELICOS',accountCode:'812',taxType:'BASEXCLUDED'}]}))} as InvoiceSnapshot;
  const receipts=snapshot.invoices.map(invoice=>{
    const value=invoiceDraftXeroValue(snapshot,invoice,'contact');
    return {sequence:invoice.sequence,status:'created',connectionId:'connection',contactId:'contact',invoiceId:`xero-${invoice.sequence}`,invoice:{
      invoiceId:`xero-${invoice.sequence}`,contactId:'contact',type:'ACCREC',status:'DRAFT',invoiceDate:value.date,dueDate:value.dueDate,currencyCode:'AUD',invoiceReference:'College',total:100,paymentTrack:'PENDING',
      lineItems:value.lines.map(line=>({...line,quantity:1,unitAmount:100})),
    } as XeroInvoiceRecord};
  });
  return {snapshot,receipts,run:()=>evaluateInvoiceChecklist(snapshot,[1,2],receipts)};
}
describe('confirmed invoice checklist evidence',()=>{
  it('completes both financial items only with the complete matching batch and actual PENDING lines',()=>{
    expect(fixture().run()).toEqual({invoice_loo_consistency:true,pending_track_status:true});
  });
  for(const status of ['not_attempted','creating','review_required'])it(`does not complete a ${status} batch`,()=>{
    const f=fixture();f.receipts[0].status=status;expect(Object.values(f.run())).toEqual([false,false]);
  });
  it('rejects a partial batch, wrong connection, duplicate invoice or changed source sequences',()=>{
    const partial=fixture();partial.receipts.pop();expect(Object.values(partial.run())).toEqual([false,false]);
    const wrong=fixture();wrong.receipts[0].connectionId='another';expect(Object.values(wrong.run())).toEqual([false,false]);
    const duplicate=fixture();duplicate.receipts[1].invoiceId=duplicate.receipts[0].invoiceId;expect(Object.values(duplicate.run())).toEqual([false,false]);
    const changed=fixture();expect(Object.values(evaluateInvoiceChecklist(changed.snapshot,[1,2,3],changed.receipts))).toEqual([false,false]);
  });
  it('does not treat an aggregate PENDING value or draft default as proof of every line',()=>{
    const f=fixture();f.receipts[0].invoice.lineItems[0].tracking=f.receipts[0].invoice.lineItems[0].tracking.filter(item=>item.name!=='Payment Track');
    expect(f.run()).toEqual({invoice_loo_consistency:true,pending_track_status:false});
    const summary=fixture();summary.receipts[0].invoice.lineItems=[];expect(Object.values(summary.run())).toEqual([false,false]);
  });
  it('rejects financial, date, advisor and tracking differences and deleted/voided invoices',()=>{
    for(const change of [(i:XeroInvoiceRecord)=>{i.total=101;},(i:XeroInvoiceRecord)=>{i.dueDate='2027-01-16';},
      (i:XeroInvoiceRecord)=>{i.lineItems[0].tracking[1].option='Other advisor';},(i:XeroInvoiceRecord)=>{i.lineItems[0].tracking[0].option='Paid out';},
      (i:XeroInvoiceRecord)=>{i.status='VOIDED';},(i:XeroInvoiceRecord)=>{i.status='DELETED';}]){
      const f=fixture();change(f.receipts[0].invoice);expect(f.run().invoice_loo_consistency).toBe(false);
    }
  });
});
