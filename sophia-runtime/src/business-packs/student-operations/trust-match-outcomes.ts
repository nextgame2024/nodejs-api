import type { PoolClient } from 'pg';
import { z } from 'zod';

export const outcomeQuery=z.object({
  from:z.iso.date(), to:z.iso.date(),
  outcome:z.enum(['all','unreviewed','dismissed','awaiting_receipt','same_invoice','different_invoice','no_acceptance','conflict']).default('all'),
  sort:z.enum(['date','amount']).default('date'),direction:z.enum(['asc','desc']).default('desc'),
  page:z.coerce.number().int().min(1).max(100000).default(1),
  limit:z.coerce.number().pipe(z.union([z.literal(10),z.literal(25),z.literal(50)])).default(25),
}).strict().refine(q=>q.from<=q.to && Date.parse(q.to)-Date.parse(q.from)<=365*86400000);

export async function matchOutcomes(db:PoolClient,schema:string,tenant:string,connection:string,q:z.infer<typeof outcomeQuery>) {
  // A dismissal of the latest accepted invoice never reactivates a superseded acceptance.
  const order=(q.sort==='amount'?'amount::numeric':'date')+(q.direction==='asc'?' ASC':' DESC')+',id';
  const result=await db.query(`WITH cohort AS MATERIALIZED (
    SELECT d.deposit_id AS id,d.received_on AS date,d.bank_transaction_id AS "transactionId",d.amount::text,
      first_review.reviewed_at AS first_reviewed_at,
      extract(epoch FROM (first_review.reviewed_at-d.staged_at))/60 AS review_minutes,
      accepted.invoice_id AS "acceptedId", accepted.evidence->>'invoiceNumber' AS "acceptedNumber",
      accepted.evidence->>'lookup' AS lookup,accepted.evidence->>'score' AS score,accepted.rule_version AS version,
      CASE WHEN bank.records=1 AND bank.exact THEN bank.invoice_id END AS "verifiedId",
      CASE WHEN bank.records=1 AND bank.exact THEN bank.invoice_number END AS "verifiedNumber",
      CASE WHEN bank.records>1 OR (bank.records=1 AND NOT bank.exact) THEN 'conflict'
        WHEN bank.records=1 AND accepted.invoice_id IS NULL THEN 'no_acceptance'
        WHEN bank.records=1 AND bank.invoice_id=accepted.invoice_id THEN 'same_invoice'
        WHEN bank.records=1 THEN 'different_invoice'
        WHEN accepted.invoice_id IS NOT NULL THEN 'awaiting_receipt'
        WHEN first_review.reviewed_at IS NOT NULL THEN 'dismissed'
        ELSE 'unreviewed' END AS outcome
    FROM ${schema}.student_trust_staged_deposits d
    LEFT JOIN LATERAL (SELECT m.reviewed_at FROM ${schema}.student_trust_invoice_match_decisions m
      WHERE (m.customer_id,m.connection_id,m.deposit_id)=(d.customer_id,d.connection_id,d.deposit_id)
      ORDER BY revision LIMIT 1) first_review ON true
    LEFT JOIN LATERAL (SELECT m.invoice_id,m.evidence,m.revision,m.rule_version
      FROM ${schema}.student_trust_invoice_match_decisions m
      WHERE (m.customer_id,m.connection_id,m.deposit_id)=(d.customer_id,d.connection_id,d.deposit_id)
        AND m.decision='accepted' ORDER BY revision DESC LIMIT 1) accepted
      ON NOT EXISTS (SELECT 1 FROM ${schema}.student_trust_invoice_match_decisions later
        WHERE (later.customer_id,later.connection_id,later.deposit_id)=(d.customer_id,d.connection_id,d.deposit_id)
          AND later.invoice_id=accepted.invoice_id AND later.revision>accepted.revision AND later.decision='dismissed')
    CROSS JOIN LATERAL (SELECT count(*) AS records,
        bool_and(lower(r.account_label)=lower(d.account_label) AND r.bank_transaction_id IS NOT DISTINCT FROM d.bank_transaction_id
          AND r.amount=d.amount AND r.received_on=d.received_on) AS exact,
        min(r.invoice_id::text)::uuid AS invoice_id,min(i.invoice_number) AS invoice_number
      FROM ${schema}.student_trust_receipt_verifications r
      LEFT JOIN ${schema}.student_operations_xero_invoices i ON (i.customer_id,i.xero_connection_id,i.xero_invoice_id)=(r.customer_id,r.connection_id,r.invoice_id)
      WHERE r.customer_id=d.customer_id AND r.connection_id=d.connection_id
        AND ((lower(r.account_label)=lower(d.account_label) AND r.bank_transaction_id=d.bank_transaction_id)
          OR (r.statement_file_sha256=d.statement_file_sha256 AND r.statement_record=d.statement_record))) bank
    WHERE d.customer_id=$1 AND d.connection_id=$2 AND d.received_on BETWEEN $3::date AND $4::date
  ), counts AS (SELECT outcome,count(*) AS n FROM cohort GROUP BY outcome),
  bands AS (SELECT version,lookup,score::integer,count(*)::integer AS verified,
      count(*) FILTER (WHERE outcome='same_invoice')::integer AS agreed
    FROM cohort WHERE outcome IN ('same_invoice','different_invoice') GROUP BY version,lookup,score),
  filtered AS (SELECT * FROM cohort WHERE $5='all' OR outcome=$5),
  page_rows AS (SELECT id,date::text,"transactionId",amount,"acceptedId","acceptedNumber","verifiedId","verifiedNumber",outcome
    FROM filtered ORDER BY ${order} LIMIT $6 OFFSET $7)
  SELECT count(*)::integer AS total,count(first_reviewed_at)::integer AS reviewed,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY review_minutes) AS "medianReviewMinutes",
    coalesce((SELECT jsonb_object_agg(outcome,n) FROM counts),'{}') AS counts,
    coalesce((SELECT jsonb_agg(b ORDER BY version,lookup,score DESC) FROM bands b),'[]') AS bands,
    (SELECT count(*)::integer FROM filtered) AS "filteredTotal",
    coalesce((SELECT jsonb_agg(r ORDER BY ${order}) FROM page_rows r),'[]') AS deposits FROM cohort`,
    [tenant,connection,q.from,q.to,q.outcome,q.limit,(q.page-1)*q.limit]);
  return {...result.rows[0],page:q.page,limit:q.limit};
}
