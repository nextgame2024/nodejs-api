import { ConflictException,NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { lockSplitInvoices } from './trust-split-reservations.js';

export const submissionReview=z.object({
  action:z.enum(['investigate','close']),revision:z.number().int().nonnegative(),
  evidence:z.string().trim().min(1).max(1000),requestId:z.uuid(),
}).strict();
export const reviewPage=z.object({before:z.coerce.number().int().positive().optional()}).strict();

export async function reviewSubmission(db:PoolClient,s:string,ids:[string,string,string],actor:string,input:z.infer<typeof submissionReview>) {
  const where='customer_id=$1 AND connection_id=$2 AND dispatch_id=$3';
  const table=s+'.student_trust_submission_reviews';
  const {rows:[submission]}=await db.query(`SELECT q.snapshot->>'invoice' AS invoice FROM ${s}.student_trust_payment_submissions a
    JOIN ${s}.student_trust_payment_dispatches q USING(customer_id,connection_id,dispatch_id) WHERE a.customer_id=$1 AND a.connection_id=$2 AND a.dispatch_id=$3`,ids);
  if (!submission) throw new NotFoundException('Submitted dispatch unavailable.');
  // The confirmation worker holds this same invoice lock until the verified link commits.
  await lockSplitInvoices(db,ids[0],ids[1],[submission.invoice]);
  const {rows:[prior]}=await db.query(`SELECT revision,action,evidence,actor FROM ${table} WHERE ${where} AND request_id=$4`,[...ids,input.requestId]);
  if (prior) {
    if (prior.revision===input.revision+1 && prior.action===input.action && prior.evidence===input.evidence && prior.actor===actor) return {revision:prior.revision};
    throw new ConflictException('This review request was already used with different details.');
  }
  const {rows:[last]}=await db.query(`SELECT revision,action FROM ${table} WHERE ${where} ORDER BY revision DESC LIMIT 1`,ids);
  if (input.revision!==(last?.revision??0) || (last?.action==='close' && input.action==='close'))
    throw new ConflictException('Refresh the dispatch before recording another review.');
  if ((await db.query(`SELECT 1 FROM ${s}.student_trust_submission_confirmations WHERE ${where}`,ids)).rowCount)
    throw new ConflictException('Xero has confirmed this payment. Refresh the dispatch.');
  await db.query(`INSERT INTO ${table}(customer_id,connection_id,dispatch_id,revision,request_id,actor,action,evidence)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[...ids,input.revision+1,input.requestId,actor,input.action,input.evidence]);
  return {revision:input.revision+1};
}

export async function submissionHistory(db:PoolClient,s:string,ids:[string,string,string],before?:number) {
  const {rows}=await db.query(`SELECT revision,action,evidence,actor,recorded_at AS "recordedAt" FROM ${s}.student_trust_submission_reviews
    WHERE customer_id=$1 AND connection_id=$2 AND dispatch_id=$3 AND ($4::integer IS NULL OR revision<$4)
    ORDER BY revision DESC LIMIT 21`,[...ids,before??null]);
  return {entries:rows.slice(0,20),next:rows.length>20?rows[19].revision:null};
}
