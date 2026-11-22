import { BadRequestException, ConflictException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { runtimeConfig } from '../../config/runtime-config.js';

export function studentNameKey(value:string){
  return value.normalize('NFC').trim().replace(/\s+/gu,' ').replace(/^(?:[a-z]+\d+\b[\s\-–—]*)+/iu,'').trim().toLocaleLowerCase('en');
}
export function uniqueStudentMatch(name:string,students:Array<{user_id:string;name:string}>){
  const key=studentNameKey(name);if(!key)return null;
  const matches=students.filter(student=>studentNameKey(student.name)===key);
  return matches.length===1?matches[0].user_id:null;
}

// All callers hold a tenant transaction. Neither recipient nor provider data is changed.
export async function linkStudentInvoice(db:PoolClient,tenant:string,connection:string,invoiceId:string,userId:string,actor:string,caseId?:string){
  const s=runtimeConfig().schema;
  const student=(await db.query(`SELECT * FROM ${s}.student_invoice_link_directory WHERE customer_id=$1 AND user_id=$2`,[tenant,userId])).rows[0];
  if(!student)throw new BadRequestException('Select an available student.');
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`student-invoice-link:${tenant}:${userId}`]);
  const invoice=(await db.query(`SELECT student_id FROM ${s}.student_operations_xero_invoices WHERE customer_id=$1 AND xero_connection_id=$2 AND xero_invoice_id=$3 AND invoice_type IN ('ACCREC','ACCRECCREDIT','RECEIVE-PREPAYMENT','RECEIVE-OVERPAYMENT') AND invoice_status IN ('DRAFT','SUBMITTED','AUTHORISED','PAID') FOR UPDATE`,[tenant,connection,invoiceId])).rows[0];
  if(!invoice)throw new BadRequestException('This sales transaction is unavailable.');
  if(invoice.student_id&&invoice.student_id!==student.student_reference)throw new ConflictException('This invoice is already linked to another student.');
  await db.query(`SELECT ${s}.ensure_review_student_identity($1)`,[userId]);
  await db.query(`UPDATE ${s}.student_operations_xero_invoices SET student_id=$4 WHERE customer_id=$1 AND xero_connection_id=$2 AND xero_invoice_id=$3 AND student_id IS NULL`,[tenant,connection,invoiceId,student.student_reference]);
  await db.query(`SELECT ${s}.ensure_synced_student_case($1,$2)`,[student.student_reference,actor]);
  const cases=(await db.query(`SELECT c.case_id,c.student_id,l.student_reference FROM ${s}.student_operations_cases c JOIN ${s}.student_operations_student_user_links l USING(customer_id,student_id) WHERE c.customer_id=$1 AND l.user_id=$2 AND NOT EXISTS(SELECT 1 FROM ${s}.student_case_deletions d WHERE d.customer_id=c.customer_id AND d.case_id=c.case_id) ORDER BY c.case_id`,[tenant,userId])).rows;
  const target=caseId?cases.find(c=>c.case_id===caseId):cases.length===1?cases[0]:null;
  if(caseId&&!target)throw new BadRequestException('Select a case belonging to this student.');
  const existing=(await db.query(`SELECT case_id FROM ${s}.student_operations_case_invoice_links WHERE customer_id=$1 AND xero_connection_id=$2 AND xero_invoice_id=$3`,[tenant,connection,invoiceId])).rows[0];
  if(existing&&target&&existing.case_id!==target.case_id)throw new ConflictException('This invoice is already linked to another case.');
  if(target&&!existing){
    await db.query(`INSERT INTO ${s}.student_operations_case_invoice_links(customer_id,case_id,student_id,student_reference,xero_connection_id,xero_invoice_id,linked_by_identity) VALUES($1,$2,$3,$4,$5,$6,$7)`,[tenant,target.case_id,target.student_id,student.student_reference,connection,invoiceId,actor]);
    await db.query(`INSERT INTO ${s}.student_operations_case_activity(customer_id,case_id,actor_identity_user_id,event_type,summary,detail) VALUES($1,$2,$3,'case.invoice_linked','Imported sales transaction linked to student',jsonb_build_object('connectionId',$4::text,'invoiceId',$5::text))`,[tenant,target.case_id,actor,connection,invoiceId]);
  }
  return {studentUserId:userId,caseId:existing?.case_id??target?.case_id??null,caseSelectionRequired:!existing&&!target};
}

export async function autoMatchStudentInvoices(db:PoolClient,tenant:string,connection:string){
  const s=runtimeConfig().schema;
  const operating=await db.query(`SELECT 1 FROM ${s}.student_operations_xero_sync_configurations WHERE customer_id=$1 AND xero_connection_id=$2 AND organisation_role='operating' AND enabled`,[tenant,connection]);
  if(!operating.rowCount)return {linked:0};
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`college-auto-match:${tenant}:${connection}`]);
  const students=(await db.query(`SELECT * FROM ${s}.student_invoice_link_directory WHERE customer_id=$1 ORDER BY user_id LIMIT 20001`,[tenant])).rows;
  if(students.length>20000)return {linked:0,capacityReview:true};
  const names=new Map<string,string|null>();
  const references=new Map(students.map(student=>[student.student_reference,student.user_id]));
  for(const student of students){const key=studentNameKey(student.name);if(key)names.set(key,names.has(key)?null:student.user_id);}
  const matchName=(value:string)=>names.get(studentNameKey(value))??null;
  const contacts=(await db.query(`SELECT c.xero_contact_id,c.legal_name,m.classification,m.student_user_id FROM ${s}.student_operations_xero_contacts c LEFT JOIN ${s}.student_college_xero_contact_links m USING(customer_id,xero_connection_id,xero_contact_id) WHERE c.customer_id=$1 AND c.xero_connection_id=$2 ORDER BY c.xero_contact_id LIMIT 20001`,[tenant,connection])).rows;
  if(contacts.length>20000)return {linked:0,capacityReview:true};
  for(const contact of contacts){
    // Existing decisions are never replaced. Only explicitly coded contacts auto-classify.
    if(contact.classification||!/^\s*[cs]\d+\b/i.test(contact.legal_name??''))continue;
    const userId=matchName(contact.legal_name);if(!userId)continue;
    const added=await db.query(`WITH added AS (INSERT INTO ${s}.student_college_xero_contact_links(customer_id,xero_connection_id,xero_contact_id,classification,student_user_id,reviewed_by) VALUES($1,$2,$3,'student',$4,'system:student-name-match') ON CONFLICT DO NOTHING RETURNING *) INSERT INTO ${s}.student_college_xero_mapping_events(customer_id,xero_connection_id,xero_contact_id,actor_identity,previous_value,confirmed_value) SELECT customer_id,xero_connection_id,xero_contact_id,reviewed_by,NULL,jsonb_build_object('classification',classification,'student_user_id',student_user_id,'revision',revision) FROM added RETURNING event_id`,[tenant,connection,contact.xero_contact_id,userId]);
    if(!added.rowCount)continue;
    contact.student_user_id=userId;contact.classification='student';
  }
  const byContact=new Map(contacts.map(c=>[c.xero_contact_id,c]));
  const invoices=(await db.query(`SELECT i.xero_invoice_id,i.xero_contact_id,i.invoice_reference,i.student_id FROM ${s}.student_operations_xero_invoices i WHERE i.customer_id=$1 AND i.xero_connection_id=$2 AND i.invoice_type IN ('ACCREC','ACCRECCREDIT','RECEIVE-PREPAYMENT','RECEIVE-OVERPAYMENT') AND i.invoice_status IN ('DRAFT','SUBMITTED','AUTHORISED','PAID') AND EXISTS(SELECT 1 FROM ${s}.student_operations_xero_sync_runs seen WHERE seen.customer_id=i.customer_id AND seen.sync_run_id=i.last_seen_sync_run_id AND seen.created_at >= COALESCE((SELECT max(f.created_at) FROM ${s}.student_operations_xero_sync_runs f WHERE f.customer_id=i.customer_id AND f.xero_connection_id=i.xero_connection_id AND f.status='succeeded' AND f.mode IN ('initial','reconciliation')),seen.created_at)) AND NOT EXISTS(SELECT 1 FROM ${s}.student_operations_case_invoice_links l WHERE l.customer_id=i.customer_id AND l.xero_connection_id=i.xero_connection_id AND l.xero_invoice_id=i.xero_invoice_id) ORDER BY i.xero_invoice_id LIMIT 20001`,[tenant,connection])).rows;
  if(invoices.length>20000)return {linked:0,capacityReview:true};
  let linked=0;
  for(const invoice of invoices){
    const contact=byContact.get(invoice.xero_contact_id);
    const fromReference=matchName(invoice.invoice_reference??'');
    const fromContact=contact?.classification==='student'?contact.student_user_id:null;
    if(fromReference&&fromContact&&fromReference!==fromContact)continue;
    const existing=invoice.student_id?references.get(invoice.student_id):null;
    if(invoice.student_id&&!existing)continue;
    const userId=existing??fromContact??fromReference;if(!userId)continue;
    const result=await linkStudentInvoice(db,tenant,connection,invoice.xero_invoice_id,userId,'system:student-name-match');
    if(result.caseId)linked++;
  }
  return {linked};
}
