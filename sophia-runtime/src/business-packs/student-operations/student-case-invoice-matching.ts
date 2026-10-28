import {isDeepStrictEqual} from 'node:util';
import type {XeroInvoiceCreate,XeroInvoiceRecord} from '../../connectors/xero/xero.client.js';
import type {InvoiceSnapshot} from './student-case-invoice-drafts.js';

const decimalNumber=(value:string|number|null)=>value===null?null:Math.round(Number(value)*10000);
// Missing optional PENDING may be reconciled to an existing invoice, but is
// never sufficient evidence to advance the case to Awaiting Payment.
const trackingKey=(items:Array<{name:string;option:string}>)=>items
  .filter(item=>!(item.name.trim().toLowerCase()==='payment track'&&item.option.trim().toLowerCase()==='pending'))
  .map(item=>`${item.name.trim().toLowerCase()}=${item.option.trim().toLowerCase()}`).sort().join('|');
const normalizedDescription=(value:string|null)=>value?.replace(/\r\n?/g,'\n').trim()??'';
export function matchesXeroInvoiceHeader(candidate:XeroInvoiceRecord,expected:XeroInvoiceCreate,totalMinor:number){
  return candidate.type==='ACCREC'&&!['DELETED','VOIDED'].includes(candidate.status)&&candidate.contactId===expected.contactId&&candidate.invoiceDate===expected.date&&candidate.dueDate===expected.dueDate&&
    candidate.currencyCode===expected.currencyCode&&(candidate.invoiceReference??null)===(expected.reference??null)&&Math.round(candidate.total*100)===totalMinor;
}
export function matchesXeroInvoice(candidate:XeroInvoiceRecord,expected:XeroInvoiceCreate,totalMinor:number){
  if(!matchesXeroInvoiceHeader(candidate,expected,totalMinor)||candidate.lineItems.length!==expected.lines.length)return false;
  const actual=candidate.lineItems.map(line=>JSON.stringify({description:normalizedDescription(line.description),quantity:decimalNumber(line.quantity),unitAmount:decimalNumber(line.unitAmount),itemCode:line.itemCode??'',
    accountCode:line.accountCode??'',taxType:line.taxType??'',tracking:trackingKey(line.tracking)})).sort();
  const wanted=expected.lines.map(line=>JSON.stringify({description:normalizedDescription(line.description),quantity:decimalNumber(line.quantity),unitAmount:decimalNumber(line.unitAmount),itemCode:line.itemCode??'',
    accountCode:line.accountCode,taxType:line.taxType,tracking:trackingKey(line.tracking)})).sort();
  return isDeepStrictEqual(actual,wanted);
}
export async function exactXeroInvoiceMatches(candidates:XeroInvoiceRecord[],expected:XeroInvoiceCreate,totalMinor:number,read:(invoiceId:string)=>Promise<XeroInvoiceRecord>){
  const complete:XeroInvoiceRecord[]=[];
  for(const candidate of candidates.filter(candidate=>matchesXeroInvoiceHeader(candidate,expected,totalMinor)))complete.push(await read(candidate.invoiceId));
  return complete.filter(candidate=>matchesXeroInvoice(candidate,expected,totalMinor));
}
export function invoiceDraftXeroValue(snapshot:InvoiceSnapshot,invoice:InvoiceSnapshot['invoices'][number],contactId:string):XeroInvoiceCreate{
  const tracking=[{name:'Payment Track',option:'PENDING'},{name:'Sales Representative',option:snapshot.advisorLabel}],first=invoice.lines[0];
  const lines:XeroInvoiceCreate['lines']=invoice.lines.map(line=>({description:line.description,quantity:line.quantity,unitAmount:line.unitPrice??(line.unitAmountMinor/100).toFixed(2),itemCode:line.itemCode,
    accountCode:line.accountCode,taxType:line.taxType,tracking}));
  if(invoice.conditionalFeeMinor>0)lines.push({description:'Conditional transfer fee',quantity:'1',unitAmount:(invoice.conditionalFeeMinor/100).toFixed(2),accountCode:first.accountCode,taxType:'BASEXCLUDED',tracking});
  return {contactId,date:invoice.issueDate,dueDate:invoice.dueDate,reference:snapshot.collegeName||null,currencyCode:snapshot.currency,lines};
}
