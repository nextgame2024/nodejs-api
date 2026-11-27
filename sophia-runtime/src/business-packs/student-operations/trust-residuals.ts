import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';

export const residualQuery=z.object({
  studentId:z.uuid().optional(),q:z.string().trim().max(150).default(''),status:z.enum(['all','assigned','unassigned']).default('all'),
  page:z.coerce.number().int().min(1).max(100000).default(1),limit:z.coerce.number().pipe(z.union([z.literal(25),z.literal(50),z.literal(100)])).default(25),
  sort:z.enum(['date','amount']).default('date'),direction:z.enum(['asc','desc']).default('asc'),
}).strict();
export const residualCommand=z.object({
  reservation:z.number().int().positive(),revision:z.number().int().nonnegative(),requestId:z.uuid(),
  studentId:z.uuid().transform(id=>id.toLowerCase()).nullable(),reason:z.string().trim().min(1).max(500),
}).strict();

// Active allocation rows disappear on release. A later reservation has its own review history.
function active(schema:string,single=false) {
  return `SELECT DISTINCT customer_id,connection_id,deposit_id,revision FROM ${schema}.student_trust_split_allocations
    WHERE customer_id=$1 AND connection_id=$2 ${single?'AND deposit_id=$3':''}`;
}
export async function listResiduals(db:PoolClient,s:string,tenant:string,connection:string,input:z.infer<typeof residualQuery>) {
  const order=input.sort==='amount'?'amount':'date';
  const {rows:[result]}=await db.query(`WITH residual AS (
    SELECT a.deposit_id AS id,a.revision AS reservation,d.bank_transaction_id AS "bankId",d.received_on AS date,
      (now() AT TIME ZONE 'Australia/Brisbane')::date-d.received_on AS days,
      (e.plan->>'unassigned')::numeric AS amount,r.student_name AS student,r.student_reference AS reference,
      r.student_id AS "studentId",coalesce(r.revision,0) AS revision
    FROM (${active(s)}) a JOIN ${s}.student_trust_staged_deposits d USING(customer_id,connection_id,deposit_id)
    JOIN ${s}.student_trust_split_events e USING(customer_id,connection_id,deposit_id,revision)
    LEFT JOIN LATERAL (SELECT * FROM ${s}.student_trust_residual_reviews h WHERE h.customer_id=a.customer_id
      AND h.connection_id=a.connection_id AND h.deposit_id=a.deposit_id AND h.reservation_revision=a.revision
      ORDER BY revision DESC LIMIT 1) r ON true
    WHERE (e.plan->>'unassigned')::numeric>0
  ), filtered AS (
    SELECT * FROM residual WHERE ($7::uuid IS NULL OR "studentId"=$7) AND ($3='all' OR ($3='assigned')=("studentId" IS NOT NULL))
    AND ($4='' OR strpos(lower("bankId"),lower($4))>0 OR strpos(lower(student),lower($4))>0 OR strpos(lower(reference),lower($4))>0)
  ), page AS (SELECT * FROM filtered ORDER BY ${order} ${input.direction},id LIMIT $5 OFFSET $6)
  SELECT count(*)::int AS count,coalesce(sum(amount),0)::numeric(24,2)::text AS total,
    coalesce((SELECT jsonb_agg(to_jsonb(p)||jsonb_build_object('amount',p.amount::text) ORDER BY p.${order} ${input.direction},p.id) FROM page p),'[]') AS rows
    FROM filtered`,[tenant,connection,input.status,input.q,input.limit,(input.page-1)*input.limit,input.studentId ?? null]);
  return result;
}

export async function residualDetail(db:PoolClient,s:string,scope:string[]) {
  const {rows:[current]}=await db.query<{reservation:number;amount:string}>(`SELECT a.revision AS reservation,e.plan->>'unassigned' AS amount
    FROM (${active(s,true)}) a JOIN ${s}.student_trust_split_events e USING(customer_id,connection_id,deposit_id,revision)
    WHERE (e.plan->>'unassigned')::numeric>0`,scope);
  if (!current) throw new NotFoundException('This reservation has no active residual.');
  const choices=await db.query<{id:string;name:string;reference:string}>(`SELECT DISTINCT st.student_id AS id,st.legal_name AS name,st.student_reference AS reference
    FROM ${s}.student_trust_split_allocations a JOIN ${s}.student_operations_xero_invoices i
    ON i.customer_id=a.customer_id AND i.xero_connection_id=a.connection_id AND i.xero_invoice_id=a.invoice_id
    JOIN ${s}.student_operations_xero_candidate_reviews r ON r.customer_id=i.customer_id AND r.xero_connection_id=i.xero_connection_id AND r.xero_contact_id=i.xero_contact_id
    JOIN ${s}.student_operations_students st ON st.customer_id=r.customer_id AND st.student_id=r.student_id
    WHERE a.customer_id=$1 AND a.connection_id=$2 AND a.deposit_id=$3 AND a.revision=$4 AND r.review_status='accepted'
    ORDER BY name,id`,[...scope,current.reservation]);
  const history=await db.query<{revision:number;studentId:string|null;student:string|null;reason:string;reviewer:string;recordedAt:Date}>(`SELECT revision,student_id AS "studentId",student_name AS student,reason,reviewer,recorded_at AS "recordedAt"
    FROM ${s}.student_trust_residual_reviews WHERE customer_id=$1 AND connection_id=$2 AND deposit_id=$3 AND reservation_revision=$4
    ORDER BY revision DESC LIMIT 20`,[...scope,current.reservation]);
  return {...current,choices:choices.rows,history:history.rows,revision:history.rows[0]?.revision ?? 0};
}

export async function recordResidual(db:PoolClient,s:string,scope:string[],reviewer:string,body:z.infer<typeof residualCommand>) {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[scope.join('/').toLowerCase()]);
  const {rows:[prior]}=await db.query(`SELECT revision,reservation_revision,student_id,reviewer,reason FROM ${s}.student_trust_residual_reviews
    WHERE customer_id=$1 AND connection_id=$2 AND deposit_id=$3 AND request_id=$4`,[...scope,body.requestId]);
  if (prior) {
    if (prior.reservation_revision!==body.reservation || prior.revision!==body.revision+1 || prior.student_id!==body.studentId ||
      prior.reason!==body.reason || prior.reviewer!==reviewer) throw new ConflictException('This review request changed.');
    return {revision:prior.revision};
  }
  const detail=await residualDetail(db,s,scope);
  if (body.revision!==detail.revision || body.reservation!==detail.reservation) throw new ConflictException('Refresh the residual review.');
  const selected=detail.choices.find(row=>row.id===body.studentId);
  if (body.studentId && !selected) throw new ConflictException('The student link changed. Refresh the review.');
  if (body.studentId===(detail.history[0]?.studentId ?? null)) throw new BadRequestException('Choose a different attribution.');
  const revision=detail.revision+1;
  await db.query(`INSERT INTO ${s}.student_trust_residual_reviews(customer_id,connection_id,deposit_id,reservation_revision,
    revision,request_id,student_id,student_name,student_reference,amount,reason,reviewer)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[...scope,body.reservation,revision,body.requestId,
    body.studentId,selected?.name ?? null,selected?.reference ?? null,detail.amount,body.reason,reviewer]);
  return {revision};
}
