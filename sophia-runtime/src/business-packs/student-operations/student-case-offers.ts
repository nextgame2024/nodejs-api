import type { PoolClient } from 'pg';
import { z } from 'zod';
import { caseSchema } from './student-operations-cases.service.js';
import { offerExtraction } from './student-document-analysis.contracts.js';
import { isLatestTypedDocument } from './student-document-checklist.js';

export type OfferExtraction=z.infer<typeof offerExtraction>;
export interface OfferCollege { collegeId:string;name:string;abn:string|null; }
const normalized=(s:string)=>s.normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase('en');
const digits=(s:string)=>s.replace(/\D/g,'');
export function matchOfferColleges(name:string|null,abn:string|null,colleges:OfferCollege[]) {
  const exact=name?colleges.filter(c=>normalized(c.name)===normalized(name)):[];
  const conflict=(c:OfferCollege)=>Boolean(abn&&(digits(abn).length!==11||(c.abn&&digits(abn)!==digits(c.abn))));
  const tokens=(s:string)=>normalized(s).replace(/[^\p{L}\p{N}]+/gu,' ').split(' ').filter(t=>t.length>2&&!['college','pty','ltd','the'].includes(t));
  const terms=tokens(name??'');
  const partial=colleges.filter(c=>!exact.includes(c)&&terms.some(t=>tokens(c.name).includes(t)))
    .sort((a,b)=>terms.filter(t=>tokens(b.name).includes(t)).length-terms.filter(t=>tokens(a.name).includes(t)).length||a.name.localeCompare(b.name));
  return {resolution:exact.length>1?'multiple_exact':exact.length===1?(conflict(exact[0])?'identifier_conflict':'exact'):partial.length?'partial':'none',
    exactCollegeId:exact.length===1&&!conflict(exact[0])?exact[0].collegeId:null,
    candidates:[...exact,...partial].slice(0,20)};
}
export async function offerCollegeDirectory(db:PoolClient,tenant:string):Promise<OfferCollege[]> {
  return (await db.query(`SELECT college_id AS "collegeId",college_name AS name,abn FROM ${caseSchema()}.student_operations_offer_college_directory
    WHERE customer_id=$1 ORDER BY lower(college_name),college_id`,[tenant])).rows;
}
export function offerConfirmationProblems(value:OfferExtraction) {
  const problems:string[]=[];
  if(!value.studentName||!value.collegeName||!value.courses.length||!value.fees.length||!value.instalments.length||value.statedTotalMinor===null)problems.push('Complete the student, college, courses, fees, total and instalments.');
  const sequences=new Set<number>();
  for(const item of value.instalments){
    if(sequences.has(item.sequence))problems.push('Each instalment needs a unique number.');sequences.add(item.sequence);
    if(item.includedConditionalFeeMinor>item.totalMinor)problems.push('The included conditional fee cannot exceed its payment.');
    if(!item.dueOn&&!item.dueTerm)problems.push('Each instalment needs a due date or a payment term.');
  }
  for(const course of value.courses)if(course.startsOn&&course.endsOn&&course.endsOn<course.startsOn)problems.push('Course end dates must follow their start dates.');
  return [...new Set(problems)];
}
export function offerTotals(value:OfferExtraction){
  const instalmentTotalMinor=value.instalments.reduce((n,i)=>n+i.totalMinor,0);
  const includedConditionalFeesMinor=value.instalments.reduce((n,i)=>n+i.includedConditionalFeeMinor,0);
  return {statedTotalMinor:value.statedTotalMinor,instalmentTotalMinor,includedConditionalFeesMinor,
    baseInstalmentTotalMinor:instalmentTotalMinor-includedConditionalFeesMinor,
    unexplainedDifference:value.statedTotalMinor!==null&&value.statedTotalMinor!==instalmentTotalMinor&&value.statedTotalMinor!==instalmentTotalMinor-includedConditionalFeesMinor};
}
export async function assignOfferCollege(db:PoolClient,tenant:string,caseId:string,college:OfferCollege) {
  const s=caseSchema();
  await db.query(`INSERT INTO ${s}.student_operations_colleges(customer_id,college_id,college_name) VALUES($1,$2,$3)
    ON CONFLICT(customer_id,college_id) DO UPDATE SET college_name=excluded.college_name`,[tenant,college.collegeId,college.name]);
  await db.query(`UPDATE ${s}.student_operations_case_colleges SET is_primary=false WHERE customer_id=$1 AND case_id=$2`,[tenant,caseId]);
  await db.query(`INSERT INTO ${s}.student_operations_case_colleges(customer_id,case_id,college_id,is_primary) VALUES($1,$2,$3,true)
    ON CONFLICT(customer_id,case_id,college_id) DO UPDATE SET is_primary=true`,[tenant,caseId,college.collegeId]);
}
/** Caller holds the case lock. Projection rows never replace source extraction. */
export async function persistOffer(db:PoolClient,tenant:string,caseId:string,documentId:string,resultId:string,
  value:OfferExtraction,review?:{id:string;version:number;collegeId:string}) {
  const s=caseSchema();
  const directory=await offerCollegeDirectory(db,tenant),match=matchOfferColleges(value.collegeName,value.abn,directory);
  const primary=(await db.query(`SELECT college_id FROM ${s}.student_operations_case_colleges WHERE customer_id=$1 AND case_id=$2 AND is_primary`,[tenant,caseId])).rows[0];
  const student=(await db.query(`SELECT s.legal_name FROM ${s}.student_operations_cases c JOIN ${s}.student_operations_students s
    ON s.customer_id=c.customer_id AND s.student_id=c.student_id WHERE c.customer_id=$1 AND c.case_id=$2`,[tenant,caseId])).rows[0];
  const identity=value.studentName&&student?.legal_name&&normalized(value.studentName)===normalized(student.legal_name);
  const latest=await isLatestTypedDocument(db,tenant,caseId,documentId);
  const auto=latest&&!review&&!primary&&identity&&!value.issues.length&&value.evidence.length&&match.exactCollegeId?directory.find(c=>c.collegeId===match.exactCollegeId):null;
  if(auto){await assignOfferCollege(db,tenant,caseId,auto);
    await db.query(`UPDATE ${s}.student_operations_cases SET record_version=record_version+1,updated_at=now() WHERE customer_id=$1 AND case_id=$2`,[tenant,caseId]);
    await db.query(`INSERT INTO ${s}.student_operations_case_activity(customer_id,case_id,actor_identity_user_id,event_type,summary,detail)
      VALUES($1,$2,'system:document-analysis','case.college_matched','College matched from Letter of Offer',jsonb_build_object('actorKind','automation','actorName','SophiaAi'))`,[tenant,caseId]);}
  if(review)await db.query(`UPDATE ${s}.student_case_offers SET is_current=false,status='superseded',record_version=record_version+1 WHERE customer_id=$1 AND case_id=$2 AND is_current`,[tenant,caseId]);
  const header=await db.query(`INSERT INTO ${s}.student_case_offers(customer_id,case_id,document_id,result_id,provider_name,resolved_college_id,currency,stated_total_minor,review_version,review_id,status,is_current)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING offer_id`,[tenant,caseId,documentId,resultId,value.collegeName,review?.collegeId??auto?.collegeId??null,value.currency,value.statedTotalMinor,review?.version??0,review?.id??null,review?'confirmed':'proposed',Boolean(review)]);
  const offerId=header.rows[0].offer_id;
  // Preserve uncertain source data in immutable extraction, then let review fix
  // invalid dates/duplicate rows before creating usable financial projections.
  if(!review&&offerConfirmationProblems(value).length)return offerId as string;
  await db.query(`INSERT INTO ${s}.student_case_offer_courses(customer_id,offer_id,sort_order,name,code,starts_on,ends_on,duration)
    SELECT $1::uuid,$2::uuid,x.* FROM jsonb_to_recordset($3::jsonb) AS x(sort_order integer,name text,code text,starts_on date,ends_on date,duration text)`,
    [tenant,offerId,JSON.stringify(value.courses.map((c,index)=>({sort_order:index,name:c.name,code:c.code,starts_on:c.startsOn,ends_on:c.endsOn,duration:c.duration})))]);
  await db.query(`INSERT INTO ${s}.student_case_offer_fees(customer_id,offer_id,label,amount_minor,conditional,condition)
    SELECT $1::uuid,$2::uuid,x.* FROM jsonb_to_recordset($3::jsonb) AS x(label text,amount_minor bigint,conditional boolean,condition text)`,
    [tenant,offerId,JSON.stringify(value.fees.map(f=>({label:f.label,amount_minor:f.amountMinor,conditional:f.conditional,condition:f.condition})))]);
  await db.query(`INSERT INTO ${s}.student_case_offer_instalments(customer_id,offer_id,sequence,due_term,due_on,total_minor,included_conditional_fee_minor,components)
    SELECT $1::uuid,$2::uuid,x.* FROM jsonb_to_recordset($3::jsonb) AS x(sequence integer,due_term text,due_on date,total_minor bigint,included_conditional_fee_minor bigint,components jsonb)`,
    [tenant,offerId,JSON.stringify(value.instalments.map(i=>({sequence:i.sequence,due_term:i.dueTerm,due_on:i.dueOn,total_minor:i.totalMinor,included_conditional_fee_minor:i.includedConditionalFeeMinor,components:i.components??[]})))]);
  return offerId as string;
}
