import { ConflictException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { receiptProposal } from './trust-receipt-proposals.js';
import { lockReceiptAccount } from './trust-receipt-account.js';
import { lockSplitInvoices } from './trust-split-reservations.js';

export const enqueueFields=z.object({
  revision:z.number().int().positive(),token:z.string().regex(/^[a-f0-9]{64}$/),requestId:z.uuid(),reason:z.string().trim().min(1).max(500),
}).strict();
export const cancelFields=z.object({dispatchId:z.uuid(),reason:z.string().trim().min(1).max(500)}).strict();

export async function enqueuePayment(db:PoolClient,s:string,scope:[string,string,string,string],actor:string,input:z.infer<typeof enqueueFields>) {
  const [tenant,connection,invoice,receipt]=scope;
  await lockSplitInvoices(db,tenant,connection,[invoice]);
  await lockReceiptAccount(db,s,tenant,connection,'read');
  const detail=await receiptProposal(db,s,scope,actor);
  const table=s+'.student_trust_payment_dispatches';
  const {rows:[prior]}=await db.query(`SELECT dispatch_id AS id,approval_revision,request_id,evidence_token,released_by,reason
    FROM ${table} WHERE customer_id=$1 AND connection_id=$2 AND verification_id=$3 AND request_id=$4`,
    [tenant,connection,receipt,input.requestId]);
  if (prior) {
    if (prior.approval_revision!==input.revision || prior.evidence_token!==input.token || prior.released_by!==actor || prior.reason!==input.reason)
      throw new ConflictException('This dispatch request changed.');
    return {id:prior.id as string};
  }
  if (detail.releaseCheck || detail.revision!==input.revision || detail.token!==input.token || !detail.snapshot.mappedAccount)
    throw new ConflictException('Refresh the proposal and review the release checks.');
  const result=await db.query<{id:string}>(`INSERT INTO ${table}
    (customer_id,connection_id,verification_id,approval_revision,request_id,evidence_token,snapshot,approver,released_by,reason,expires_at)
    SELECT customer_id,connection_id,verification_id,revision,$5,evidence_token,snapshot,actor,$6,$7,expires_at
    FROM ${s}.student_trust_receipt_proposals WHERE customer_id=$1 AND connection_id=$2 AND verification_id=$3 AND revision=$4
      AND action='approve' AND evidence_token=$8 AND actor<>$6 AND clock_timestamp()<expires_at
    ON CONFLICT DO NOTHING RETURNING dispatch_id AS id`,[tenant,connection,receipt,input.revision,input.requestId,actor,input.reason,input.token]);
  if (!result.rowCount) throw new ConflictException('The approval expired or already has a dispatch record.');
  return result.rows[0];
}

export async function cancelPayment(db:PoolClient,s:string,scope:[string,string,string,string],actor:string,input:z.infer<typeof cancelFields>) {
  const [tenant,connection,invoice,receipt]=scope;
  await lockSplitInvoices(db,tenant,connection,[invoice]);
  const detail=await receiptProposal(db,s,scope,actor);
  const prior=(await db.query(`SELECT c.actor,c.reason FROM ${s}.student_trust_dispatch_cancellations c
    JOIN ${s}.student_trust_payment_dispatches q USING(customer_id,connection_id,dispatch_id)
    WHERE q.customer_id=$1 AND q.connection_id=$2 AND q.verification_id=$3 AND q.dispatch_id=$4`,
    [tenant,connection,receipt,input.dispatchId])).rows[0];
  if (prior) {
    if (prior.actor===actor && prior.reason===input.reason) return {id:input.dispatchId};
    throw new ConflictException('This dispatch has already been cancelled.');
  }
  if (detail.dispatch?.submitted) throw new ConflictException('The payment submission has started. Review its result.');
  if (detail.dispatch?.id!==input.dispatchId) throw new ConflictException('Refresh the dispatch record.');
  await db.query(`INSERT INTO ${s}.student_trust_dispatch_cancellations(customer_id,connection_id,dispatch_id,actor,reason)
    VALUES($1,$2,$3,$4,$5)`,[tenant,connection,input.dispatchId,actor,input.reason]);
  return {id:input.dispatchId};
}

export const dispatchQuery=z.object({q:z.string().trim().max(150).default(''),page:z.coerce.number().int().min(1).max(100000).default(1),
  limit:z.coerce.number().pipe(z.union([z.literal(25),z.literal(50),z.literal(100)])).default(25),
  direction:z.enum(['asc','desc']).default('desc'),status:z.enum(['all','recorded','cancelled','expired','submitted','investigating','review_closed','confirmed','bank_pending','bank_reconciled','bank_review','bank_unchecked','bank_stale']).default('all')}).strict();

export async function dispatchRegister(db:PoolClient,s:string,tenant:string,connection:string,input:z.infer<typeof dispatchQuery>) {
  const result=await db.query(`WITH entries AS (
    SELECT q.dispatch_id AS id,q.queued_at AS "queuedAt",q.snapshot->>'invoice' AS invoice,q.snapshot->>'invoiceNumber' AS "invoiceNumber",
      q.snapshot->>'bankId' AS "bankId",q.snapshot->>'amount' AS amount,q.approver,q.released_by AS reviewer,
      q.verification_id AS receipt,coalesce(r.revision,0) AS "reviewRevision",ack.payment_id AS "acknowledgedId",a.started_at AS "submittedAt",f.payment_id AS "paymentId",b.outcome AS "bankOutcome",b.checked_at AS "bankCheckedAt",
      (b.checked_at < statement_timestamp()-interval '25 hours') IS TRUE AS "bankStale",
      floor(extract(epoch FROM statement_timestamp()-f.verified_at)/86400)::int AS "daysSinceConfirmation",
      claim.claim_id IS NOT NULL AS assigned,owner.display_name AS "bankOwner",
      att.reported_reconciled_on AS "staffReportedOn",att.checked_at AS "staffCheckedAt",
      CASE WHEN f.payment_id IS NOT NULL THEN 'confirmed' WHEN r.action='close' THEN 'review_closed' WHEN r.action='investigate' THEN 'investigating' WHEN a.dispatch_id IS NOT NULL THEN 'submitted' WHEN c.dispatch_id IS NOT NULL THEN 'cancelled' WHEN q.expires_at<=statement_timestamp() THEN 'expired' ELSE 'recorded' END AS status
    FROM ${s}.student_trust_payment_dispatches q LEFT JOIN ${s}.student_trust_dispatch_cancellations c USING(customer_id,connection_id,dispatch_id)
    LEFT JOIN ${s}.student_trust_payment_submissions a USING(customer_id,connection_id,dispatch_id)
    LEFT JOIN ${s}.student_trust_submission_acknowledgements ack USING(customer_id,connection_id,dispatch_id)
    LEFT JOIN LATERAL (SELECT revision,action FROM ${s}.student_trust_submission_reviews rv
      WHERE (rv.customer_id,rv.connection_id,rv.dispatch_id)=(q.customer_id,q.connection_id,q.dispatch_id)
      ORDER BY revision DESC LIMIT 1) r ON true
    LEFT JOIN ${s}.student_trust_submission_confirmations f USING(customer_id,connection_id,dispatch_id)
    LEFT JOIN ${s}.student_trust_payment_reconciliation_checks att ON
      (att.customer_id,att.connection_id,att.payment_id)=(f.customer_id,f.connection_id,f.payment_id)
    LEFT JOIN ${s}.student_trust_reconciliation_claims claim ON claim.customer_id=f.customer_id AND claim.connection_id=f.connection_id
      AND claim.payment_id=f.payment_id AND claim.released_at IS NULL
    LEFT JOIN ${s}.student_operations_advisor_roster owner ON owner.customer_id=claim.customer_id AND owner.user_id::text=claim.claimed_by
    LEFT JOIN LATERAL (SELECT outcome,checked_at FROM ${s}.student_trust_bank_check_results b WHERE
      (b.customer_id,b.connection_id,b.dispatch_id)=(f.customer_id,f.connection_id,f.dispatch_id)
      ORDER BY attempt DESC LIMIT 1) b ON true
    WHERE q.customer_id=$1 AND q.connection_id=$2
  ), filtered AS (SELECT * FROM entries WHERE ($3='all' OR status=$3 OR (status='confirmed' AND $3=CASE
    WHEN "bankStale" THEN 'bank_stale' WHEN "bankOutcome" IS NULL THEN 'bank_unchecked' WHEN "bankOutcome"='pending' THEN 'bank_pending'
    WHEN "bankOutcome"='reconciled' THEN 'bank_reconciled' ELSE 'bank_review' END)) AND ($4='' OR strpos(lower("invoiceNumber"),lower($4))>0
    OR strpos(lower("bankId"),lower($4))>0 OR id::text=lower($4) OR "paymentId"::text=lower($4) OR "acknowledgedId"::text=lower($4))),
  page AS (SELECT * FROM filtered ORDER BY "queuedAt" ${input.direction},id LIMIT $5 OFFSET $6)
  SELECT count(*)::int AS count,coalesce((SELECT jsonb_agg(to_jsonb(p)||jsonb_build_object('workerCheck',w.check,'bankHistory',h.history) ORDER BY "queuedAt" ${input.direction},id)
    FROM page p LEFT JOIN LATERAL (
      SELECT jsonb_build_object('attempt',a.attempt,'at',coalesce(r.checked_at,a.claimed_at),'detail',r.detail,
        'status',CASE WHEN r.outcome IN ('matched','review') THEN r.outcome
          WHEN r.outcome IS NULL AND a.lease_until>statement_timestamp() THEN 'checking'
          WHEN a.attempt>=3 THEN 'exhausted' ELSE 'retry' END) AS check
      FROM ${s}.student_trust_dispatch_attempts a LEFT JOIN ${s}.student_trust_dispatch_results r
        USING(customer_id,connection_id,dispatch_id,attempt)
      WHERE a.customer_id=$1 AND a.connection_id=$2 AND a.dispatch_id=p.id ORDER BY a.attempt DESC LIMIT 1
    ) w ON true LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('outcome',outcome,'checkedAt',checked_at) ORDER BY attempt DESC) AS history
        FROM (SELECT attempt,outcome,checked_at FROM ${s}.student_trust_bank_check_results b
          WHERE b.customer_id=$1 AND b.connection_id=$2 AND b.dispatch_id=p.id ORDER BY attempt DESC LIMIT 5) recent
    ) h ON true),'[]') AS rows
  FROM filtered`,[tenant,connection,input.status,input.q,input.limit,(input.page-1)*input.limit]);
  return result.rows[0];
}
