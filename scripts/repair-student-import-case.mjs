// Explicit, guarded repair for one confirmed identity-import gap. Preview is
// read-only; --apply requires the exact fingerprint returned by that preview.
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config({path:fileURLToPath(new URL('../.env',import.meta.url)),quiet:true});
const args=process.argv.slice(2),option=name=>args[args.indexOf(name)+1];
const required=['--customer-id','--user-id','--student-id','--invoice-id','--invoice-number'];
if(required.some(name=>!args.includes(name)))throw new Error('Explicit customer, user, student, invoice ID and invoice number are required.');
const tenant=option('--customer-id'),userId=option('--user-id'),reference=option('--student-id'),invoiceId=option('--invoice-id'),number=option('--invoice-number');
if(![tenant,userId,invoiceId].every(id=>/^[a-f0-9-]{36}$/i.test(id))||!/^STD-[0-9]+$/.test(reference))throw new Error('Invalid repair identity.');
const apply=args.includes('--apply'),schema=process.env.SOPHIA_RUNTIME_SCHEMA||'sophia_runtime';
if(!/^[a-z_][a-z0-9_]*$/i.test(schema))throw new Error('Invalid schema');
const actor='system:operator:user-request:student-import-repair';
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:15000,statement_timeout:20000});
let db;
try{
 db=await pool.connect();await db.query(apply?'BEGIN':'BEGIN READ ONLY');
 const account=(await db.query(`SELECT u.id,u.company_id,u.student_id,u.name,u.email,u.status FROM public.users u
   JOIN ${schema}.customers c ON c.customer_id=$1 AND c.external_company_id=u.company_id::text AND c.status='active'
   JOIN public.bm_company b ON b.company_id=u.company_id AND b.workspace_profile='student_operations'
   WHERE u.id=$2 AND u.student_id=$3 AND u.type='student' AND u.status='active' ${apply?'FOR UPDATE OF u':''}`,[tenant,userId,reference])).rows;
 if(account.length!==1)throw new Error('The expected active student account was not found.');
 await db.query('SET LOCAL ROLE sophia_runtime_app');await db.query("SELECT set_config('sophia.tenant_id',$1,true)",[tenant]);
 const existing=(await db.query(`SELECT c.case_id,c.case_reference,l.student_reference FROM ${schema}.student_operations_cases c
   JOIN ${schema}.student_operations_student_user_links l USING(customer_id,student_id) WHERE c.customer_id=$1 AND l.user_id=$2`,[tenant,userId])).rows;
 if(existing.length){
   const linked=(await db.query(`SELECT case_id FROM ${schema}.student_operations_case_invoice_links WHERE customer_id=$1 AND xero_invoice_id=$2`,[tenant,invoiceId])).rows;
   if(existing.length!==1||linked.length!==1||existing[0].case_id!==linked[0].case_id)throw new Error('The student already has cases; review invoice attribution manually.');
   await db.query('ROLLBACK');console.log(JSON.stringify({mode:apply?'apply':'preview',result:'already_repaired',...existing[0]}));
 }else{
   const invoices=(await db.query(`SELECT xero_connection_id,xero_invoice_id,xero_contact_id,invoice_number,invoice_type,invoice_status,
     invoice_date::text,due_date::text,total::text,currency_code,invoice_reference,advisor_name
     FROM ${schema}.student_operations_xero_invoices WHERE customer_id=$1 AND student_id=$2 AND invoice_type='ACCREC'
       AND invoice_status IN ('DRAFT','SUBMITTED','AUTHORISED','PAID') ORDER BY invoice_date NULLS LAST,xero_invoice_id`,[tenant,reference])).rows;
   if(invoices.length!==1||invoices[0].xero_invoice_id!==invoiceId||invoices[0].invoice_number!==number)throw new Error('The expected single invoice no longer matches.');
   const invoice=invoices[0];
   const college=(await db.query(`SELECT college_id,college_name FROM ${schema}.student_operations_college_directory WHERE customer_id=$1 AND lower(btrim(college_name))=lower(btrim($2))`,[tenant,invoice.invoice_reference])).rows;
   const advisor=(await db.query(`SELECT advisor_id,name,xero_label FROM ${schema}.student_operations_advisor_directory WHERE customer_id=$1 AND status='active' AND lower(btrim(xero_label))=lower(btrim($2))`,[tenant,invoice.advisor_name])).rows;
   if(college.length>1||advisor.length!==1)throw new Error('College or advisor is ambiguous and requires manual review.');
   const fingerprint=createHash('sha256').update(JSON.stringify({account:account[0],invoices,college,advisor})).digest('hex');
   const report={mode:apply?'apply':'preview',studentId:reference,name:account[0].name,invoiceNumber:number,invoiceId,invoiceStatus:invoice.invoice_status,total:invoice.total,currency:invoice.currency_code,college:college[0]?.college_name??null,collegeReference:invoice.invoice_reference,collegeNeedsReview:college.length===0,advisor:advisor[0].name,openedOn:invoice.invoice_date,fingerprint};
   if(apply){
     if(option('--expected-fingerprint')!==fingerprint)throw new Error('Repair fingerprint changed or was not supplied. Preview again.');
     const profile=(await db.query(`SELECT ${schema}.ensure_student_operations_profile($1) AS id`,[userId])).rows[0].id;
     await db.query(`SELECT student_id FROM ${schema}.student_operations_students WHERE customer_id=$1 AND student_id=$2 FOR UPDATE`,[tenant,profile]);
     if((await db.query(`SELECT 1 FROM ${schema}.student_operations_cases WHERE customer_id=$1 AND student_id=$2`,[tenant,profile])).rowCount)throw new Error('A case was created concurrently. Retry preview.');
     const changed=await db.query(`UPDATE ${schema}.student_operations_students SET advisor_id=$3,record_version=record_version+1,updated_at=now() WHERE customer_id=$1 AND student_id=$2 AND advisor_id IS DISTINCT FROM $3 RETURNING record_version`,[tenant,profile,advisor[0].advisor_id]);
     if(changed.rowCount)await db.query(`INSERT INTO ${schema}.student_operations_student_audit_events(customer_id,student_id,actor_identity_user_id,event_type,record_version,changed_fields,correlation_id) VALUES($1,$2,$3,'student.updated',$4,ARRAY['advisor_id'],$5)`,[tenant,profile,actor,changed.rows[0].record_version,invoiceId]);
     const created=(await db.query(`INSERT INTO ${schema}.student_operations_cases(customer_id,student_id,case_reference,case_kind,title,current_stage,lifecycle_status,opened_on,advisor_name,migration_key)
       VALUES($1,$2,'CASE-'||nextval('${schema}.student_operations_case_number_seq')::text,'student_operations','Imported student case','imported_pending_review','open',$3,$4,'synced_students_v1') RETURNING case_id,case_reference`,[tenant,profile,invoice.invoice_date,invoice.advisor_name])).rows[0];
     await db.query(`INSERT INTO ${schema}.student_operations_case_invoice_links(customer_id,case_id,student_id,student_reference,xero_connection_id,xero_invoice_id,linked_by_identity) VALUES($1,$2,$3,$4,$5,$6,$7)`,[tenant,created.case_id,profile,reference,invoice.xero_connection_id,invoiceId,actor]);
     if(college.length){await db.query(`INSERT INTO ${schema}.student_operations_colleges(customer_id,college_id,college_name) VALUES($1,$2,$3) ON CONFLICT(customer_id,college_id) DO UPDATE SET college_name=excluded.college_name`,[tenant,college[0].college_id,college[0].college_name]);
     await db.query(`INSERT INTO ${schema}.student_operations_case_colleges(customer_id,case_id,college_id,is_primary) VALUES($1,$2,$3,true)`,[tenant,created.case_id,college[0].college_id]);}
     const logins=(await db.query(`SELECT user_id FROM ${schema}.student_operations_advisor_roster WHERE customer_id=$1 AND lower(btrim(display_name))=lower(btrim($2))`,[tenant,advisor[0].name])).rows;
     if(logins.length===1)await db.query(`INSERT INTO ${schema}.student_operations_case_advisors(customer_id,case_id,company_id,advisor_user_id,is_primary) VALUES($1,$2,$3,$4,true)`,[tenant,created.case_id,account[0].company_id,logins[0].user_id]);
     await db.query(`INSERT INTO ${schema}.student_operations_document_jobs(customer_id,case_id,xero_connection_id,source_kind,source_id) VALUES($1,$2,$3,'Invoices',$4),($1,$2,$3,'Contacts',$5) ON CONFLICT DO NOTHING`,[tenant,created.case_id,invoice.xero_connection_id,invoiceId,invoice.xero_contact_id]);
     await db.query(`INSERT INTO ${schema}.student_operations_case_activity(customer_id,case_id,actor_identity_user_id,event_type,summary,detail) VALUES($1,$2,$3,'case.imported','Missing synced student case repaired; workflow requires review',$4)`,[tenant,created.case_id,actor,JSON.stringify({source:'user-request-repair',studentReference:reference,invoiceId,invoiceNumber:number,reason:'identity_sync_missing_case_bootstrap',collegeNeedsReview:college.length===0})]);
     const verified=(await db.query(`SELECT 1 FROM ${schema}.student_operations_cases c JOIN ${schema}.student_operations_case_invoice_links l USING(customer_id,case_id) WHERE c.customer_id=$1 AND c.case_id=$2 AND l.student_reference=$3 AND l.xero_invoice_id=$4`,[tenant,created.case_id,reference,invoiceId])).rowCount;
     if(verified!==1)throw new Error('Repair verification failed.');
     await db.query('COMMIT');Object.assign(report,{result:'repaired',caseId:created.case_id,caseNumber:created.case_reference});
   }else{await db.query('ROLLBACK');report.result='planned';}
   console.log(JSON.stringify(report));
 }
}catch(error){await db?.query('ROLLBACK').catch(()=>{});console.error(JSON.stringify({result:'failed',code:error.code??'repair_guard',message:error.code?'Repair rolled back.':error.message}));process.exitCode=1;}
finally{db?.release();await pool.end();}
