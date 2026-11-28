import type {PoolClient} from 'pg';
import {z} from 'zod';
import {currentTrustInvoice,currentPaymentList,trustReceiptPaymentCandidates} from './trust-receipt-payment-candidates.js';

export const exceptionQuery=z.object({
  page:z.coerce.number().int().min(1).max(100000).default(1),
  limit:z.coerce.number().pipe(z.union([z.literal(25),z.literal(50),z.literal(100)])).default(25),
  q:z.string().trim().max(150).default(''),direction:z.enum(['asc','desc']).default('asc'),
  owner:z.enum(['all','mine','unassigned']).default('all'),
  reason:z.enum(['all','reversed','conflicting','changed','historical','stale','pending','unknown']).default('all'),
}).strict();

// Every confirmed dispatch already has a receipt payment link, which gives both sources one row per payment.
export function exceptionEvidence(s:string,onePayment=false) {
  return `WITH evidence AS (
    SELECT l.payment_id AS payment,l.verification_id AS receipt,r.invoice_id AS invoice,i.invoice_number AS "invoiceNumber",
      r.bank_transaction_id AS "bankId",l.payment_amount::text AS amount,l.linked_at AS "linkedAt",
      (now() AT TIME ZONE 'Australia/Brisbane')::date-(l.linked_at AT TIME ZONE 'Australia/Brisbane')::date AS days,
      c.dispatch_id AS dispatch,b.outcome AS direct,substantive.outcome AS "lastKnown",substantive.checked_at AS "lastKnownAt",b.checked_at AS "checkedAt",seen.created_at AS "importedAt",
      ck.checked_at AS "staffAt",ck.reported_reconciled_on AS "staffDate",claim.claim_id AS "claimId",claim.claimed_by AS owner,
      nullif(trim(staff.display_name),'') AS "ownerLabel",
      i.invoice_status IN ('VOIDED','DELETED') OR NOT ${currentTrustInvoice(s,'i')} AS historical,
      CASE WHEN i.settlement->'entries' IS NULL OR NOT (${currentPaymentList}) THEN 'unknown'
        WHEN m.id IS NULL AND c.verified_at>=seen.created_at AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(i.settlement->'entries') item WHERE item->>'kind'='payment' AND lower(item->>'id')=l.payment_id::text
        ) THEN 'awaiting_import'
        WHEN m.id IS NULL THEN 'mismatch' WHEN m."conflictingFlags" THEN 'conflicting' WHEN m."isReconciled" IS TRUE THEN 'reconciled'
        WHEN m."isReconciled" IS FALSE THEN 'pending' ELSE 'unknown' END AS snapshot_status,
      EXISTS(SELECT 1 FROM ${s}.student_xero_payment_observations o WHERE o.customer_id=l.customer_id
        AND o.xero_connection_id=l.connection_id AND o.xero_invoice_id=r.invoice_id AND o.payment_id=l.payment_id
        AND o.is_reconciled AND o.amount=l.payment_amount AND o.currency_code='AUD' AND o.payment_date=r.received_on
        AND o.first_seen_at<=coalesce(seen.created_at,now())) AS "previousImportReconciled",
      EXISTS(SELECT 1 FROM ${s}.student_trust_bank_check_results older WHERE older.customer_id=c.customer_id
        AND older.connection_id=c.connection_id AND older.dispatch_id=c.dispatch_id AND older.attempt<substantive.attempt AND older.outcome='reconciled') AS "previousDirectReconciled"
    FROM ${s}.student_trust_receipt_payment_links l
    JOIN ${s}.student_trust_receipt_verifications r USING(customer_id,connection_id,verification_id)
    JOIN ${s}.student_operations_xero_invoices i ON (i.customer_id,i.xero_connection_id,i.xero_invoice_id)=(r.customer_id,r.connection_id,r.invoice_id)
    LEFT JOIN ${s}.student_operations_xero_sync_runs seen ON (seen.customer_id,seen.xero_connection_id,seen.sync_run_id)=(i.customer_id,i.xero_connection_id,i.last_seen_sync_run_id)
    LEFT JOIN LATERAL (SELECT * FROM (${trustReceiptPaymentCandidates(s)}) candidate WHERE candidate.id=l.payment_id AND candidate.amount=l.payment_amount) m ON true
    LEFT JOIN ${s}.student_trust_submission_confirmations c ON (c.customer_id,c.connection_id,c.payment_id)=(l.customer_id,l.connection_id,l.payment_id)
    LEFT JOIN LATERAL (SELECT attempt,outcome,checked_at FROM ${s}.student_trust_bank_check_results b
      WHERE (b.customer_id,b.connection_id,b.dispatch_id)=(c.customer_id,c.connection_id,c.dispatch_id) ORDER BY attempt DESC LIMIT 1) b ON true
    LEFT JOIN LATERAL (SELECT attempt,outcome,checked_at FROM ${s}.student_trust_bank_check_results prior
      WHERE (prior.customer_id,prior.connection_id,prior.dispatch_id)=(c.customer_id,c.connection_id,c.dispatch_id)
        AND prior.outcome NOT IN ('unknown','unavailable') ORDER BY attempt DESC LIMIT 1) substantive ON true
    LEFT JOIN ${s}.student_trust_payment_reconciliation_checks ck ON (ck.customer_id,ck.connection_id,ck.payment_id)=(l.customer_id,l.connection_id,l.payment_id)
    LEFT JOIN ${s}.student_trust_reconciliation_claims claim ON (claim.customer_id,claim.connection_id,claim.payment_id)=(l.customer_id,l.connection_id,l.payment_id) AND claim.released_at IS NULL
    LEFT JOIN LATERAL (SELECT display_name FROM ${s}.student_operations_advisor_roster roster
      WHERE roster.customer_id=claim.customer_id AND roster.user_id::text=claim.claimed_by LIMIT 1) staff ON true
    WHERE l.customer_id=$1 AND l.connection_id=$2 ${onePayment?'AND l.payment_id=$5':''}
  ), sources AS (
    SELECT *,CASE WHEN historical THEN 'unknown' ELSE snapshot_status END AS imported FROM evidence
  ), classified AS (
    SELECT *,CASE
      WHEN ("lastKnown" IN ('deleted','missing','changed','pending') AND "previousDirectReconciled")
        OR (NOT historical AND imported IN ('pending','mismatch') AND "previousImportReconciled") THEN 'reversed'
      WHEN historical THEN 'historical'
      WHEN "lastKnown" IN ('deleted','missing','changed') OR imported='mismatch' THEN 'changed'
      WHEN imported='conflicting' OR (direct='pending' AND imported='reconciled') OR (direct='reconciled' AND imported='pending')
        OR ("staffAt" IS NOT NULL AND (direct='pending' OR imported='pending')) THEN 'conflicting'
      WHEN "checkedAt"<statement_timestamp()-interval '25 hours' THEN 'stale'
      WHEN dispatch IS NOT NULL AND (direct IS NULL OR direct IN ('unavailable','unknown')) THEN 'unknown'
      WHEN direct='reconciled' OR imported='reconciled' THEN NULL
      WHEN direct='pending' OR imported='pending' THEN 'pending'
      ELSE 'unknown' END AS reason FROM sources
  )`;
}

export async function paymentExceptions(db:PoolClient,s:string,tenant:string,connection:string,actor:string,q:z.infer<typeof exceptionQuery>) {
  const order=`"linkedAt" ${q.direction},payment`;
  const {rows:[result]}=await db.query(`${exceptionEvidence(s)}, filtered AS (
    SELECT *,owner=$3 AS mine FROM classified WHERE reason IS NOT NULL AND ($4='all' OR reason=$4)
      AND ($5='all' OR ($5='mine' AND owner=$3) OR ($5='unassigned' AND owner IS NULL))
      AND ($6='' OR strpos(lower("invoiceNumber"),lower($6))>0 OR strpos(lower("bankId"),lower($6))>0 OR payment::text=lower($6) OR dispatch::text=lower($6))
  ), page AS (SELECT * FROM filtered ORDER BY ${order} LIMIT $7 OFFSET $8)
    SELECT count(*)::int AS count,coalesce((SELECT jsonb_agg(to_jsonb(page)-'owner'-'snapshot_status' ORDER BY ${order}) FROM page),'[]') AS rows FROM filtered`,
    [tenant,connection,actor,q.reason,q.owner,q.q,q.limit,(q.page-1)*q.limit]);
  return result;
}
