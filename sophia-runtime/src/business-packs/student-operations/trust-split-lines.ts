import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { currentTrustInvoice } from './trust-receipt-payment-candidates.js';

export function cents(amount:string) {
  const [whole,fraction='']=amount.split('.');
  return BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
}
export function aud(value:bigint) {
  return (value/100n).toString()+'.'+(value%100n).toString().padStart(2,'0');
}
function exact(value:unknown) {
  const raw=String(value);
  return /^(0|[1-9]\d{0,13})(\.\d{1,2})?$/.test(raw) ? cents(raw) : null;
}
export interface LineOption {lineId:string;label:string;gross:string;available:string;token:string}
interface Invoice {id:string;balance:string;total:string;items:unknown}
function options(invoice:Invoice,reserved:Map<string,bigint>):LineOption[] {
  const {items}=invoice;
  const total=exact(invoice.total);
  if (!Array.isArray(items) || !items.length || items.length>100 || total===null || exact(invoice.balance)!==total) return [];
  const lines=[];
  const ids=new Set<string>();
  let net=0n,tax=0n;
  for (const item of items) {
    const id=String(item?.lineItemId ?? '').toLowerCase();
    const amount=exact(item?.lineAmount), taxAmount=exact(item?.taxAmount);
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id) || ids.has(id) || amount===null || taxAmount===null) return [];
    ids.add(id); net+=amount; tax+=taxAmount;
    const label=String(item.description || item.itemCode || id).slice(0,240);
    lines.push({id,label,amount,taxAmount,item});
  }
  if (net!==total && net+tax!==total) return [];
  return lines.map(({id,label,amount,taxAmount,item})=>{
    const gross=net===total?amount:amount+taxAmount;
    const left=gross-(reserved.get(invoice.id+'/'+id) ?? 0n);
    const token=createHash('sha256').update(JSON.stringify([invoice.id,item,aud(gross)])).digest('hex');
    return {lineId:id,label,gross:aud(gross),available:aud(left>0n?left:0n),token};
  });
}

export async function splitLineOptions(db:PoolClient,schema:string,tenant:string,connection:string,ids:string[]) {
  const params=[tenant,connection,ids];
  const invoices=await db.query<Invoice>(`SELECT i.xero_invoice_id AS id,round(i.amount_due,2)::text AS balance,
    round(i.total,2)::text AS total,CASE WHEN jsonb_typeof(i.line_items)='array' THEN
      CASE WHEN jsonb_array_length(i.line_items)<=100 THEN i.line_items END END AS items
    FROM ${schema}.student_operations_xero_invoices i WHERE i.customer_id=$1 AND i.xero_connection_id=$2
    AND i.xero_invoice_id=ANY($3::uuid[]) AND i.invoice_type='ACCREC' AND i.invoice_status='AUTHORISED'
    AND i.currency_code='AUD' AND i.amount_due>0 AND ${currentTrustInvoice(schema,'i')}`,params);
  const held=await db.query<{key:string;amount:string}>(`SELECT invoice_id::text||'/'||line_id::text AS key,sum(amount)::text AS amount
    FROM ${schema}.student_trust_split_line_allocations WHERE customer_id=$1 AND connection_id=$2
    AND invoice_id=ANY($3::uuid[]) GROUP BY invoice_id,line_id`,params);
  const reserved=new Map(held.rows.map(row=>[row.key,cents(row.amount)]));
  return new Map(invoices.rows.map(invoice=>[invoice.id,options(invoice,reserved)]));
}

export function assignLinePurposes(choices:{lineId:string;token:string;amount:string}[],options:LineOption[],amount:bigint) {
  const seen=new Set<string>();
  let assigned=0n;
  const lines=choices.map(choice=>{
    if (seen.has(choice.lineId)) throw new BadRequestException('Assign each invoice line once.');
    seen.add(choice.lineId);
    const line=options.find(row=>row.lineId===choice.lineId);
    if (!line || line.token!==choice.token || cents(choice.amount)>cents(line.available))
      throw new ConflictException('Refresh the invoice lines and review their available amounts.');
    assigned+=cents(choice.amount);
    return {lineId:line.lineId,label:line.label,gross:line.gross,amount:aud(cents(choice.amount)),token:line.token};
  });
  if (assigned>amount) throw new BadRequestException('Line purposes exceed the invoice allocation.');
  return {lines,purposeUnassigned:aud(amount-assigned)};
}
