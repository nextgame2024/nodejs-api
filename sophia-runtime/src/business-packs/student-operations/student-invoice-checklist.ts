import type {PoolClient} from 'pg';
import type {InvoiceSnapshot} from './student-case-invoice-drafts.js';
import type {XeroInvoiceRecord} from '../../connectors/xero/xero.client.js';
import {invoiceDraftXeroValue,matchesXeroInvoice} from './student-case-invoice-matching.js';

export const INVOICE_CHECKLIST_KEYS=['invoice_loo_consistency','pending_track_status'] as const;
type Receipt={sequence:number;status:string;connectionId:string;contactId:string;invoiceId:string|null;invoice:XeroInvoiceRecord|null};

/** No provider calls or inferred PENDING: require all receipts and full cached details. */
export function evaluateInvoiceChecklist(snapshot:InvoiceSnapshot,sequences:number[],receipts:Receipt[]){
  const invoices=snapshot.invoices;
  const complete=invoices.length>0&&invoices.length===sequences.length&&new Set(invoices.map(i=>i.sequence)).size===sequences.length&&
    sequences.every(sequence=>invoices.some(i=>i.sequence===sequence))&&receipts.length===invoices.length&&
    new Set(receipts.map(r=>r.invoiceId)).size===invoices.length&&invoices.every(invoice=>{
      const receipt=receipts.find(r=>r.sequence===invoice.sequence);
      return receipt?.status==='created'&&receipt.connectionId===snapshot.catalogueConnectionId&&receipt.invoiceId&&receipt.invoice?.invoiceId===receipt.invoiceId;
    });
  return {
    invoice_loo_consistency:Boolean(complete&&invoices.every(invoice=>{
      const receipt=receipts.find(r=>r.sequence===invoice.sequence)!;
      return matchesXeroInvoice(receipt.invoice!,invoiceDraftXeroValue(snapshot,invoice,receipt.contactId),invoice.totalMinor);
    })),
    pending_track_status:Boolean(complete&&receipts.every(({invoice})=>invoice!.paymentTrack?.trim().toUpperCase()==='PENDING'&&invoice!.lineItems.length>0&&
      invoice!.lineItems.every(line=>line.tracking.some(item=>item.name.trim().toLowerCase()==='payment track'&&item.option.trim().toUpperCase()==='PENDING')))),
  };
}

export async function invoiceChecklistEvidence(db:PoolClient,tenant:string,id:string,schema:string){
  // Schema is repository-owned, never a request parameter. Current approved offer
  // and tenant/case joins exclude historical/superseded or another case's batches.
  const batch=(await db.query(`SELECT b.batch_id,b.snapshot,ARRAY(SELECT sequence FROM ${schema}.student_case_offer_instalments
      WHERE customer_id=b.customer_id AND offer_id=b.offer_id ORDER BY sequence) AS sequences
    FROM ${schema}.student_case_invoice_draft_batches b JOIN ${schema}.student_case_offers o
      ON o.customer_id=b.customer_id AND o.case_id=b.case_id AND o.offer_id=b.offer_id AND o.is_current AND o.status='confirmed'
    WHERE b.customer_id=$1 AND b.case_id=$2`,[tenant,id])).rows[0];
  if(!batch)return null; // Imported cases retain their existing manual checklist.
  const rows=(await db.query(`SELECT e.sequence,e.status,e.projection_attempts,e.xero_connection_id AS "connectionId",e.xero_contact_id AS "contactId",e.xero_invoice_id AS "invoiceId",
      i.xero_invoice_id AS "cachedInvoiceId",i.xero_contact_id AS "cachedContactId",i.invoice_type,i.invoice_status,i.invoice_date::text,i.due_date::text,
      i.currency_code,i.invoice_reference,i.total,i.payment_track,i.line_items
    FROM ${schema}.student_case_xero_invoice_exports e LEFT JOIN ${schema}.student_operations_xero_invoices i
      ON i.customer_id=e.customer_id AND i.xero_connection_id=e.xero_connection_id AND i.xero_invoice_id=e.xero_invoice_id
    WHERE e.customer_id=$1 AND e.case_id=$2 AND e.batch_id=$3`,[tenant,id,batch.batch_id])).rows;
  const receipts:Receipt[]=rows.map(row=>({...row,invoice:row.cachedInvoiceId?{
    invoiceId:row.cachedInvoiceId,contactId:row.cachedContactId,type:row.invoice_type,status:row.invoice_status,invoiceDate:row.invoice_date,dueDate:row.due_date,
    currencyCode:row.currency_code,invoiceReference:row.invoice_reference,total:Number(row.total),paymentTrack:row.payment_track,lineItems:row.line_items,
  } as XeroInvoiceRecord:null}));
  const result=evaluateInvoiceChecklist(batch.snapshot,batch.sequences,receipts);
  const awaitingInvoices=receipts.length!==batch.sequences.length||receipts.some(r=>r.status!=='created');
  const awaitingDetails=receipts.some(r=>!r.invoice||!r.invoice.lineItems.length);
  const exhausted=rows.some(row=>row.projection_attempts>=8&&(!row.cachedInvoiceId||!row.line_items?.length));
  return {...result,state:awaitingInvoices?'waiting_invoices':exhausted?'indexing_failed':awaitingDetails?'awaiting_sync':result.invoice_loo_consistency&&result.pending_track_status?'passed':'needs_review'};
}

export async function readInvoiceChecklist(db:PoolClient,tenant:string,id:string,schema:string){
  const row=(await db.query(`SELECT v.invoice_result,v.invoice_dirty FROM ${schema}.student_document_checklist_evaluations v WHERE v.customer_id=$1 AND v.case_id=$2`,[tenant,id])).rows[0];
  if(row?.invoice_result&&!row.invoice_dirty)return row.invoice_result as NonNullable<Awaited<ReturnType<typeof invoiceChecklistEvidence>>>;
  const exists=await db.query(`SELECT 1 FROM ${schema}.student_case_invoice_draft_batches b JOIN ${schema}.student_case_offers o USING(customer_id,offer_id)
    WHERE b.customer_id=$1 AND b.case_id=$2 AND o.is_current AND o.status='confirmed'`,[tenant,id]);
  return exists.rowCount?{invoice_loo_consistency:false,pending_track_status:false,state:'pending_evaluation'}:null;
}

export async function reconcileInvoiceChecklist(db:PoolClient,tenant:string,id:string,schema:string){
  const row=(await db.query(`SELECT invoice_result,invoice_dirty FROM ${schema}.student_document_checklist_evaluations WHERE customer_id=$1 AND case_id=$2 FOR UPDATE`,[tenant,id])).rows[0];
  if(row&&!row.invoice_dirty)return row.invoice_result as Awaited<ReturnType<typeof invoiceChecklistEvidence>>;
  const result=await invoiceChecklistEvidence(db,tenant,id,schema);
  await db.query(`INSERT INTO ${schema}.student_document_checklist_evaluations(customer_id,case_id,evidence,invoice_dirty,invoice_result,invoice_checked_at)
    VALUES($1,$2,'[]',false,$3,now()) ON CONFLICT(customer_id,case_id) DO UPDATE SET invoice_dirty=false,invoice_result=excluded.invoice_result,invoice_checked_at=now()`,[tenant,id,result?JSON.stringify(result):null]);
  return result;
}
