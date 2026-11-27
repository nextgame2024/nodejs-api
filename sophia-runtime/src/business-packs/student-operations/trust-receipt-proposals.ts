import { receiptAccount, lockReceiptAccount } from './trust-receipt-account.js';
import { createHash } from 'node:crypto';
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { currentPaymentList,currentTrustInvoice } from './trust-receipt-payment-candidates.js';
import { lockSplitInvoices } from './trust-split-reservations.js';

export const proposalCommand=z.object({
  revision:z.number().int().nonnegative(),requestId:z.uuid(),token:z.string().regex(/^[0-9a-f]{64}$/),
  action:z.enum(['prepare','approve','withdraw']),reason:z.string().trim().min(1).max(500),
}).strict();
type Scope=[string,string,string,string];
export interface Snapshot {
  connection:string;organisation:string;organisationId:string;invoice:string;receipt:string;invoiceNumber:string|null;contactId:string|null;contactName:string|null;
  account:string;date:string;amount:string;due:string;currency:string;bankId:string|null;reference:string;
  mappedAccount?:{id:string;name:string;revision:number};
  invoiceFingerprint:string;
}
export interface ProposalEvent {
  revision:number;actor:string;action:'prepare'|'approve'|'withdraw';reason:string;token:string;
  recordedAt:Date;expiresAt:Date;expired:boolean;snapshot:Snapshot;
}

export interface DispatchReceipt {
  id:string;revision:number;actor:string;reason:string;queuedAt:Date;expiresAt:Date;expired:boolean;
  cancelledAt:Date|null;cancelledBy:string|null;cancelReason:string|null;
}
export async function receiptProposal(db:PoolClient,s:string,scope:Scope,reviewer:string) {
  const {rows:[row]}=await db.query<Snapshot & {blocked:string|null}>(`
    SELECT r.connection_id AS connection,x.tenant_name AS organisation,x.xero_tenant_id AS "organisationId",r.invoice_id AS invoice,r.verification_id AS receipt,i.invoice_number AS "invoiceNumber",
      i.xero_contact_id AS "contactId",ct.legal_name AS "contactName",r.account_label AS account,r.received_on::text AS date,r.amount::text AS amount,
      round(i.amount_due,2)::text AS due,i.currency_code AS currency,r.bank_transaction_id AS "bankId",r.reference,
      encode(sha256(convert_to(jsonb_build_array('single_invoice_receipt',i.line_items,i.settlement,i.invoice_reference,
        i.total,i.invoice_date,i.due_date,extract(epoch FROM i.provider_updated_at),r.payload_hash)::text,'UTF8')),'hex') AS "invoiceFingerprint",
      CASE WHEN EXISTS (SELECT 1 FROM ${s}.student_trust_receipt_payment_links l WHERE l.customer_id=r.customer_id
        AND l.connection_id=r.connection_id AND l.verification_id=r.verification_id) THEN 'This receipt already has a linked Xero payment.'
      WHEN i.invoice_type IS DISTINCT FROM 'ACCREC' OR i.currency_code IS DISTINCT FROM 'AUD' OR i.invoice_status IS DISTINCT FROM 'AUTHORISED'
        OR i.xero_contact_id IS NULL OR NOT ${currentTrustInvoice(s,'i')} THEN 'Review the current authorised AUD sales invoice.'
      WHEN r.bank_transaction_id IS NULL THEN 'The verified receipt needs an identifiable bank transaction.'
      WHEN i.amount_due IS NULL OR r.amount>round(i.amount_due,2) OR round(i.amount_due,2)<>round(r.invoice_due_at_verification,2)
        THEN 'Review the invoice balance or excess deposit before preparing a single payment.'
      WHEN jsonb_typeof(i.settlement->'entries') IS DISTINCT FROM 'array' OR NOT (${currentPaymentList})
        THEN 'Refresh the TRUST import to obtain complete payment details.'
      WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(i.settlement->'entries') e WHERE e->>'kind'='payment'
        AND NOT EXISTS (SELECT 1 FROM ${s}.student_trust_receipt_payment_links l
          JOIN ${s}.student_trust_receipt_verifications v USING(customer_id,connection_id,verification_id)
          WHERE l.customer_id=r.customer_id AND l.connection_id=r.connection_id AND v.invoice_id=r.invoice_id
          AND l.payment_id::text=lower(e->>'id'))) THEN 'Review the imported invoice payment before preparing another.'
      WHEN EXISTS (SELECT 1 FROM ${s}.student_trust_receipt_verifications v WHERE v.customer_id=r.customer_id
        AND v.connection_id=r.connection_id AND v.invoice_id=r.invoice_id AND v.verification_id<>r.verification_id
        AND NOT EXISTS (SELECT 1 FROM ${s}.student_trust_receipt_payment_links l WHERE l.customer_id=v.customer_id
          AND l.connection_id=v.connection_id AND l.verification_id=v.verification_id)) THEN 'Review the other unlinked receipts on this invoice.'
      END AS blocked
    FROM ${s}.student_trust_receipt_verifications r JOIN ${s}.student_operations_xero_invoices i
      ON i.customer_id=r.customer_id AND i.xero_connection_id=r.connection_id AND i.xero_invoice_id=r.invoice_id
    LEFT JOIN ${s}.student_operations_xero_contacts ct ON ct.customer_id=i.customer_id AND ct.xero_connection_id=i.xero_connection_id AND ct.xero_contact_id=i.xero_contact_id
    JOIN ${s}.student_operations_xero_sync_configurations c ON c.customer_id=r.customer_id AND c.xero_connection_id=r.connection_id
    JOIN ${s}.xero_connections x ON x.customer_id=r.customer_id AND x.xero_connection_id=r.connection_id
    WHERE r.customer_id=$1 AND r.connection_id=$2 AND r.invoice_id=$3 AND r.verification_id=$4
      AND c.enabled AND c.organisation_role='trust' AND x.status='active'`,scope);
  if (!row) throw new NotFoundException();
  const {blocked,...snapshot}=row;
  const mapping=await receiptAccount(db,s,scope[0],scope[1]),headMapping=mapping.history[0];
  const accountIssue=!mapping.fresh?'A current bank account import is required.':!headMapping?.accountId?'Select the TRUST receipt account.':
    !mapping.active?'Review the changed TRUST bank account.':
    headMapping.receiptLabel?.trim().toLowerCase()!==snapshot.account.trim().toLowerCase()?'The receipt label differs from the approved mapping.':null;
  if (!accountIssue && headMapping.accountId && headMapping.accountName)
    snapshot.mappedAccount={id:headMapping.accountId,name:headMapping.accountName,revision:headMapping.revision};
  const token=createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  const {rows:history}=await db.query<ProposalEvent>(`SELECT revision,actor,reason,action,evidence_token AS token,snapshot,
    recorded_at AS "recordedAt",expires_at AS "expiresAt",clock_timestamp()>=expires_at AS expired
    FROM ${s}.student_trust_receipt_proposals WHERE customer_id=$1 AND connection_id=$2 AND verification_id=$3
    ORDER BY revision DESC LIMIT 20`,[scope[0],scope[1],scope[3]]);
  const head=history[0];
  const state=!head?'new':head.action==='withdraw'?'withdrawn':blocked || head.token!==token?'stale':
    head.expired?'expired':head.action==='approve'?'approved':'prepared';
  const releaseCheck=blocked || accountIssue || (state!=='approved'?'A current approved proposal is required.':
    head.actor===reviewer?'An independent authorised reviewer must check this approval.':null);
  const {rows:[dispatch]}=await db.query<DispatchReceipt>(`SELECT q.dispatch_id AS id,q.approval_revision AS revision,q.released_by AS actor,
    q.reason,q.queued_at AS "queuedAt",q.expires_at AS "expiresAt",clock_timestamp()>=q.expires_at AS expired,
    c.cancelled_at AS "cancelledAt",c.actor AS "cancelledBy",c.reason AS "cancelReason"
    FROM ${s}.student_trust_payment_dispatches q LEFT JOIN ${s}.student_trust_dispatch_cancellations c USING(customer_id,connection_id,dispatch_id)
    WHERE q.customer_id=$1 AND q.connection_id=$2 AND q.verification_id=$3 ORDER BY q.approval_revision DESC LIMIT 1`,
    [scope[0],scope[1],scope[3]]);
  return {dispatch:dispatch ?? null,state,blocked,accountIssue,releaseCheck,revision:head?.revision ?? 0,snapshot,token,history};
}

export async function recordProposal(db:PoolClient,s:string,scope:Scope,actor:string,input:z.infer<typeof proposalCommand>) {
  const [tenant,connection,invoice,receipt]=scope;
  await lockSplitInvoices(db,tenant,connection,[invoice]);
  await lockReceiptAccount(db,s,tenant,connection,'read');
  const detail=await receiptProposal(db,s,scope,actor);
  const table=s+'.student_trust_receipt_proposals';
  const prior=(await db.query(`SELECT revision,actor,action,reason,evidence_token FROM ${table}
    WHERE customer_id=$1 AND connection_id=$2 AND verification_id=$3 AND request_id=$4`,
    [tenant,connection,receipt,input.requestId])).rows[0];
  if (prior) {
    if (prior.revision!==input.revision+1 || prior.actor!==actor || prior.action!==input.action ||
        prior.reason!==input.reason || prior.evidence_token!==input.token) throw new ConflictException('This request was already used with different details.');
    return {revision:prior.revision};
  }
  const head=detail.history[0], withdraw=input.action==='withdraw';
  if (input.revision!==detail.revision || input.token!==(withdraw?head?.token:detail.token))
    throw new ConflictException('Refresh the proposal and review the evidence again.');
  if (withdraw ? !head || head.action==='withdraw' : detail.blocked || (input.action==='approve'
    ? detail.state!=='prepared' : ['prepared','approved'].includes(detail.state))) throw new ConflictException('This action is unavailable for the current proposal.');
  const revision=detail.revision+1;
  const result=await db.query(`INSERT INTO ${table}
    (customer_id,connection_id,verification_id,revision,request_id,action,evidence_token,snapshot,actor,reason,expires_at)
    SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,coalesce($11::timestamptz,clock_timestamp()+interval '24 hours')
    WHERE $6<>'approve' OR clock_timestamp()<$11::timestamptz RETURNING revision`,
    [tenant,connection,receipt,revision,input.requestId,input.action,input.token,JSON.stringify(withdraw?head.snapshot:detail.snapshot),
     actor,input.reason,input.action==='prepare'?null:head.expiresAt]);
  if (!result.rowCount) throw new ConflictException('The proposal expired. Refresh before continuing.');
  if (detail.dispatch && !detail.dispatch.cancelledAt) {
    await db.query(`INSERT INTO ${s}.student_trust_dispatch_cancellations(customer_id,connection_id,dispatch_id,actor,reason)
      VALUES($1,$2,$3,$4,$5)`,[tenant,connection,detail.dispatch.id,actor,'Proposal superseded by revision '+revision]);
  }
  return {revision};
}
