import 'dotenv/config';
import { Pool } from 'pg';
import { writeFile } from 'node:fs/promises';
import { matchCollege, normalizedCollege } from '../src/business-packs/student-operations/student-case-matching.js';

const MIGRATION='existing_students_v1';
const schema=process.env.SOPHIA_RUNTIME_SCHEMA?.trim() || 'sophia_runtime';
if(!/^[a-z_][a-z0-9_]*$/i.test(schema)) throw new Error('Invalid schema');
type Student={user_id:string;student_reference:string;profile_id:string|null;account_status:string};
type Invoice={xero_connection_id:string;xero_invoice_id:string;xero_contact_id:string;student_id:string|null;invoice_number:string|null;invoice_type:string;invoice_status:string;invoice_date:string|null;advisor_name:string|null;invoice_reference:string|null;college_name:string|null};
type College={college_id:string;college_name:string};
type Advisor={user_id:string;display_name:string};
const advisorKey=(name:string)=>normalizedCollege(name).replace(/^[sc]\d+\s+/,'');
export function buildCasePlan(students:Student[],invoices:Invoice[],colleges:College[],advisors:Advisor[]) {
  const eligible=invoices.filter(i=>['DRAFT','SUBMITTED','AUTHORISED','PAID'].includes(i.invoice_status));
  const known=new Set(students.map(s=>s.student_reference));
  const unlinked=eligible.filter(i=>!i.student_id || !known.has(i.student_id)).map(i=>({invoiceId:i.xero_invoice_id,connectionId:i.xero_connection_id,invoiceNumber:i.invoice_number,type:i.invoice_type,status:i.invoice_status,reason:i.student_id?'unknown_student_id':'missing_student_id'}));
  const cases=students.map(student=>{
    const linked=eligible.filter(i=>i.student_id===student.student_reference).sort((a,b)=>String(a.invoice_date || '9999').localeCompare(String(b.invoice_date || '9999')) || a.xero_invoice_id.localeCompare(b.xero_invoice_id));
    const firstAdvisor=linked.find(i=>i.advisor_name?.trim())?.advisor_name || null;
    const matchingAdvisors=firstAdvisor ? advisors.filter(a=>advisorKey(a.display_name)===advisorKey(firstAdvisor)) : [];
    const references=[...new Set(linked.map(i=>i.invoice_reference || i.college_name).filter((v):v is string=>!!v))];
    const decisions=references.map(reference=>({reference,...matchCollege(reference,colleges)}));
    const matches=decisions.flatMap(d=>d.match ? [d.match] : []);
    const collegeConflicts=[...new Set(matches.map(m=>m.college_id))].length>1;
    return {student, invoices:linked,advisorName:firstAdvisor,advisorUserId:matchingAdvisors.length===1?matchingAdvisors[0].user_id:null,
      advisorNeedsReview:!!firstAdvisor && matchingAdvisors.length!==1,college:collegeConflicts?null:matches[0]??null,
      collegeConflicts,collegeDecisions:decisions};
  });
  return {cases,unlinked,excludedTransactions:invoices.length-eligible.length};
}

export async function runCaseMigration(pool:Pool,tenantId:string,apply=false) {
  const db=await pool.connect();
  try {
    await db.query(apply?'BEGIN':'BEGIN READ ONLY');
    await db.query("SELECT set_config('sophia.tenant_id',$1,true)",[tenantId]);
    const tenant=await db.query(`SELECT external_company_id FROM ${schema}.customers WHERE customer_id=$1 AND status='active'`,[tenantId]);
    if(tenant.rows.length!==1) throw new Error('Active tenant not found');
    if(apply) await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`student-case-migration:${tenantId}`]);
    const students=await db.query<Student>(`SELECT user_id,student_reference,profile_id,account_status FROM ${schema}.student_operations_student_roster WHERE customer_id=$1 ORDER BY student_reference,user_id`,[tenantId]);
    const invoices=await db.query<Invoice>(`SELECT xero_connection_id,xero_invoice_id,xero_contact_id,student_id,invoice_number,invoice_type,invoice_status,invoice_date::text,advisor_name,invoice_reference,college_name FROM ${schema}.student_operations_xero_invoices WHERE customer_id=$1`,[tenantId]);
    const colleges=await db.query<College>('SELECT college_id,college_name FROM public.bm_colleges WHERE company_id=$1 AND status=\'active\' ORDER BY college_id',[tenant.rows[0].external_company_id]);
    const advisors=await db.query<Advisor>(`SELECT user_id,display_name FROM ${schema}.student_operations_advisor_roster WHERE customer_id=$1`,[tenantId]);
    const existing=await db.query(`SELECT c.case_id,l.user_id FROM ${schema}.student_operations_cases c JOIN ${schema}.student_operations_student_user_links l ON l.customer_id=c.customer_id AND l.student_id=c.student_id WHERE c.customer_id=$1`,[tenantId]);
    const existingUsers=new Set(existing.rows.map(r=>r.user_id));
    const blocked=await db.query(`SELECT r.user_id,
      CASE WHEN nullif(btrim(r.legal_name),'') IS NULL OR nullif(btrim(r.email),'') IS NULL THEN 'missing_name_or_email' ELSE 'existing_profile_requires_review' END reason
      FROM ${schema}.student_operations_student_roster r WHERE r.customer_id=$1 AND r.profile_id IS NULL AND (
        nullif(btrim(r.legal_name),'') IS NULL OR nullif(btrim(r.email),'') IS NULL OR EXISTS(
          SELECT 1 FROM ${schema}.student_operations_students p WHERE p.customer_id=r.customer_id AND
          (p.student_reference=r.student_reference OR lower(btrim(p.email))=lower(btrim(r.email)) OR
           lower(regexp_replace(btrim(p.legal_name),'[[:space:]]+',' ','g'))=lower(regexp_replace(btrim(r.legal_name),'[[:space:]]+',' ','g')))))`,[tenantId]);
    const blockedUsers=new Map(blocked.rows.map(r=>[r.user_id,r.reason]));
    const plan=buildCasePlan(students.rows,invoices.rows,colleges.rows,advisors.rows);
    const results:Array<Record<string,unknown>>=[];
    for(const item of plan.cases) {
      const base={studentId:item.student.student_reference,userId:item.student.user_id,invoiceCount:item.invoices.length,collegeId:item.college?.college_id??null,collegeScore:item.college?.score??null,advisorNeedsReview:item.advisorNeedsReview,collegeConflicts:item.collegeConflicts};
      if(existingUsers.has(item.student.user_id)) {results.push({...base,result:'already_has_case'});continue;}
      if(item.student.account_status==='archived') {results.push({...base,result:'archived_requires_review'});continue;}
      if(blockedUsers.has(item.student.user_id)) {results.push({...base,result:'profile_requires_review',reason:blockedUsers.get(item.student.user_id)});continue;}
      if(!apply) {results.push({...base,result:'planned',collegeDecisions:item.collegeDecisions});continue;}
      await db.query('SAVEPOINT one_student');
      try {
        const profile=item.student.profile_id || (await db.query(`SELECT ${schema}.ensure_student_operations_profile($1) id`,[item.student.user_id])).rows[0].id;
        const row=await db.query(`INSERT INTO ${schema}.student_operations_cases(customer_id,student_id,case_reference,case_kind,title,lifecycle_status,current_stage,advisor_name,migration_key)
          VALUES($1,$2,'CASE-' || nextval('${schema}.student_operations_case_number_seq')::text,'student_operations','Imported student case','open','imported_pending_review',$3,$4) RETURNING case_id,case_reference`,[tenantId,profile,item.advisorName,MIGRATION]);
        const caseId=row.rows[0].case_id;
        if(item.advisorUserId) await db.query(`INSERT INTO ${schema}.student_operations_case_advisors(customer_id,case_id,company_id,advisor_user_id,is_primary) VALUES($1,$2,$3,$4,true)`,[tenantId,caseId,tenant.rows[0].external_company_id,item.advisorUserId]);
        if(item.college) {
          await db.query(`INSERT INTO ${schema}.student_operations_colleges(customer_id,college_id,college_name) VALUES($1,$2,$3) ON CONFLICT(customer_id,college_id) DO UPDATE SET college_name=excluded.college_name`,[tenantId,item.college.college_id,item.college.college_name]);
          await db.query(`INSERT INTO ${schema}.student_operations_case_colleges(customer_id,case_id,college_id,is_primary) VALUES($1,$2,$3,true)`,[tenantId,caseId,item.college.college_id]);
        }
        // Insert only verified student-reference links; constraints enforce that
        // an invoice cannot silently be moved between students or cases.
        for(const invoice of item.invoices) await db.query(`INSERT INTO ${schema}.student_operations_case_invoice_links(customer_id,case_id,student_id,student_reference,xero_connection_id,xero_invoice_id,linked_by_identity) VALUES($1,$2,$3,$4,$5,$6,$7)`,[tenantId,caseId,profile,item.student.student_reference,invoice.xero_connection_id,invoice.xero_invoice_id,`migration:${MIGRATION}`]);
        await db.query(`INSERT INTO ${schema}.student_operations_case_activity(customer_id,case_id,actor_identity_user_id,event_type,summary,detail) VALUES($1,$2,$3,'case.migrated','Existing student imported; workflow requires review',$4::jsonb)`,[tenantId,caseId,`migration:${MIGRATION}`,JSON.stringify({invoiceCount:item.invoices.length,collegeScore:item.college?.score??null,collegeConflicts:item.collegeConflicts,advisorNeedsReview:item.advisorNeedsReview})]);
        results.push({...base,result:'created',caseId,caseNumber:row.rows[0].case_reference});
        await db.query('RELEASE SAVEPOINT one_student');
      } catch(error) {
        await db.query('ROLLBACK TO SAVEPOINT one_student');
        await db.query('RELEASE SAVEPOINT one_student');
        results.push({...base,result:'requires_review',reason:error && typeof error==='object' && 'code' in error ? String(error.code) : 'profile_or_case_validation_failed'});
      }
    }
    let documentJobsQueued=0;
    if(apply) {
      const jobs=await db.query(`INSERT INTO ${schema}.student_operations_document_jobs(customer_id,case_id,xero_connection_id,source_kind,source_id)
        SELECT DISTINCT l.customer_id,l.case_id,i.xero_connection_id,source.kind,source.id
        FROM ${schema}.student_operations_case_invoice_links l
        JOIN ${schema}.student_operations_cases c ON c.customer_id=l.customer_id AND c.case_id=l.case_id
        JOIN ${schema}.student_operations_xero_invoices i ON i.customer_id=l.customer_id AND i.xero_connection_id=l.xero_connection_id AND i.xero_invoice_id=l.xero_invoice_id
        CROSS JOIN LATERAL (VALUES(CASE i.invoice_type WHEN 'ACCREC' THEN 'Invoices' WHEN 'ACCRECCREDIT' THEN 'CreditNotes' END,i.xero_invoice_id),('Contacts',i.xero_contact_id)) source(kind,id)
        WHERE l.customer_id=$1 AND c.migration_key=$2 AND source.kind IS NOT NULL
        ON CONFLICT DO NOTHING`,[tenantId,MIGRATION]);
      documentJobsQueued=jobs.rowCount??0;
    }
    const report={mode:apply?'apply':'preview',tenantId,generatedAt:new Date().toISOString(),students:students.rows.length,existingCases:existing.rows.length,documentJobsQueued,
      counts:results.reduce<Record<string,number>>((acc,row)=>{const key=String(row.result);acc[key]=(acc[key]||0)+1;return acc;},{}),
      unlinkedTransactions:plan.unlinked,excludedDeletedOrVoided:plan.excludedTransactions,results};
    await db.query(apply?'COMMIT':'ROLLBACK');
    return report;
  } catch(error) {await db.query('ROLLBACK');throw error;} finally {db.release();}
}

if(process.argv[1]?.endsWith('migrate-student-cases.ts')) {
  const args=process.argv.slice(2),tenantId=args[args.indexOf('--customer-id')+1],reportPath=args[args.indexOf('--report')+1];
  if(!args.includes('--customer-id') || !/^[0-9a-f-]{36}$/i.test(tenantId||'') || !args.includes('--report')) throw new Error('Usage: migrate-student-cases.ts --customer-id UUID --report PATH [--apply] (default: preview)');
  if(!process.env.OWNER_DATABASE_URL && !process.env.DATABASE_URL) throw new Error('An explicit database connection is required');
  const pool=new Pool({connectionString:process.env.OWNER_DATABASE_URL || process.env.DATABASE_URL,max:1});
  try {
    const report=await runCaseMigration(pool,tenantId,args.includes('--apply'));
    await writeFile(reportPath,JSON.stringify(report,null,2),{mode:0o600});
    console.log(JSON.stringify({mode:report.mode,students:report.students,counts:report.counts,unlinkedTransactions:report.unlinkedTransactions.length,reportPath}));
  } finally {await pool.end();}
}
