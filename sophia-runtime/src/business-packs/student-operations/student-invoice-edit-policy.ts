import {createHash} from 'node:crypto';
import type {XeroInvoiceRecord,XeroInvoiceUpdate} from '../../connectors/xero/xero.client.js';
import {matchesXeroInvoice} from './student-case-invoice-matching.js';

/** The full editor changes quantities and prices, so settlements must be absent. */
export function invoiceCanEdit(invoice:{type:string;status:string;amountPaid:unknown;amountDue:unknown;total:unknown;amountCredited?:unknown}){
  return invoice.type==='ACCREC'&&['DRAFT','SUBMITTED','AUTHORISED'].includes(invoice.status)&&
    invoice.amountPaid!=null&&Number(invoice.amountPaid)===0&&Number(invoice.amountCredited??0)===0&&
    invoice.total!=null&&invoice.amountDue!=null&&Number.isFinite(Number(invoice.total))&&Number(invoice.amountDue)===Number(invoice.total);
}
export function invoiceEditFingerprint(invoice:XeroInvoiceRecord){
  return createHash('sha256').update(JSON.stringify(invoice)).digest('hex');
}
export function matchesEditedInvoice(invoice:XeroInvoiceRecord,value:XeroInvoiceUpdate,totalMinor:number){
  if(invoice.status!==value.status||!matchesXeroInvoice(invoice,value,totalMinor))return false;
  const tracking=(items:Array<{name:string;option:string}>)=>items.map(t=>`${t.name.trim().toLowerCase()}=${t.option.trim().toLowerCase()}`).sort().join('|');
  if(value.lines.some(line=>line.lineItemId&&!invoice.lineItems.some(actual=>actual.lineItemId===line.lineItemId&&tracking(actual.tracking)===tracking(line.tracking))))return false;
  return JSON.stringify(invoice.lineItems.map(l=>tracking(l.tracking)).sort())===JSON.stringify(value.lines.map(l=>tracking(l.tracking)).sort());
}
