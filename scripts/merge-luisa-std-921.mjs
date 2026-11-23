// User-requested repair, 2026-11-23. Default rehearses all writes then rolls back.
import dotenv from 'dotenv';
import pg from 'pg';
import {fileURLToPath} from 'node:url';
dotenv.config({path:fileURLToPath(new URL('../.env',import.meta.url)),quiet:true});
const apply=process.argv.includes('--apply');
const tenant='33ed40a6-7f2b-407c-aab2-de76b1cb45a8';
const old='43ee8807-ef25-4df3-89c5-4a53a66c4af7',keep='078fba3f-59bc-40f0-9015-329af3323541';
const oldUser='b311800e-f112-4966-b8d6-a05d605db364',keepUser='adbd9c5d-5772-430e-9645-f0c6af26beb4';
const oldCase='ef756aa2-45aa-4d25-822c-d9fa6a6aa3ba',keepCase='5ef3f641-8d91-4842-9eb9-950139780d02';
const connection='a10fef7f-8451-42aa-94b9-6238d1929470',contact='3238e194-7e35-4b37-916f-dcf936438ff0';
const invoice='9f207bb0-a2dd-461b-91b4-e0373e9c38b3',actor='system:user-request:merge-STD-921-into-STD-565';
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:15000});
const db=await pool.connect();
const q=(sql,args=[])=>db.query(sql,args);
const check=(ok,message)=>{if(!ok)throw new Error(message);};
const one=async(sql,args)=>{const r=await q(sql,args);check(r.rowCount===1,'Expected exactly one changed row');return r.rows[0];};
try{
 await q('BEGIN');await q("SET LOCAL lock_timeout='5s'");await q("SET LOCAL statement_timeout='30s'");
 await q("SELECT pg_advisory_xact_lock(hashtext($1))",[`student-sync:${tenant}`]);
 check(!(await q("SELECT 1 FROM public.bm_xero_student_sync_runs WHERE customer_id=$1 AND status IN ('queued','processing')",[tenant])).rowCount,'Student sync is active');
 const users=(await q("SELECT id,student_id,name,status,company_id FROM public.users WHERE id=ANY($1::uuid[]) AND type='student' FOR UPDATE",[[oldUser,keepUser]])).rows;
 check(users.length===2&&users.every(u=>u.status==='active'&&u.company_id==='80d5e42f-2de1-4792-86b5-54c7cdeb2660')&&users.some(u=>u.id===oldUser&&u.student_id==='STD-921'&&u.name==='Luisa María Lenis Peña')&&users.some(u=>u.id===keepUser&&u.student_id==='STD-565'&&u.name.normalize('NFD').replace(/\p{M}/gu,'')==='Luisa Maria Lenis Pena'),'Student identity changed');
 await q('SET LOCAL ROLE sophia_runtime_app');await q("SELECT set_config('sophia.tenant_id',$1,true)",[tenant]);
 await q('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`college-auto-match:${tenant}:${connection}`]);
 const profiles=(await q('SELECT student_id,status FROM sophia_runtime.student_operations_students WHERE customer_id=$1 AND student_id=ANY($2::uuid[]) FOR UPDATE',[tenant,[old,keep]])).rows;
 check(profiles.length===2&&profiles.every(p=>p.status==='active'),'Profile state changed');
 const cases=(await q('SELECT case_id,student_id,current_stage,archived_at,deleting_at FROM sophia_runtime.student_operations_cases WHERE customer_id=$1 AND student_id=ANY($2::uuid[]) FOR UPDATE',[tenant,[old,keep]])).rows;
 check(cases.length===2&&cases.every(c=>!c.archived_at&&!c.deleting_at)&&cases.some(c=>c.case_id===oldCase&&c.student_id===old&&c.current_stage==='imported_pending_review')&&cases.some(c=>c.case_id===keepCase&&c.student_id===keep),'Case state changed');
 for(const table of ['student_operations_document_uploads','student_operations_document_replacements','student_operations_document_deletions','student_case_xero_invoice_exports','student_commission_exports','student_case_invoice_edits','student_case_invoice_removals','student_case_deletions'])check(!(await q(`SELECT 1 FROM sophia_runtime.${table} WHERE customer_id=$1 AND case_id=$2`,[tenant,oldCase])).rowCount,`Review case operations in ${table}`);
 for(const table of ['student_operations_primary_xero_contacts','student_operations_document_contacts','student_operations_xero_candidate_reviews'])check(!(await q(`SELECT 1 FROM sophia_runtime.${table} WHERE customer_id=$1 AND student_id=$2`,[tenant,old])).rowCount,`Review extra identity links in ${table}`);
 check(!(await q("SELECT 1 FROM sophia_runtime.business_pack_entitlements WHERE customer_id=$1 AND identity_user_id=$2 AND status='active'",[tenant,oldUser])).rowCount,'Duplicate has active workspace access');
 const invoices=(await q("SELECT xero_invoice_id,invoice_number,xero_contact_id FROM sophia_runtime.student_operations_xero_invoices WHERE customer_id=$1 AND student_id='STD-921' FOR UPDATE",[tenant])).rows;
 check(invoices.length===1&&invoices[0].xero_invoice_id===invoice&&invoices[0].invoice_number==='INV-3449'&&invoices[0].xero_contact_id===contact,'Invoice set changed');
 check(!(await q("SELECT 1 FROM sophia_runtime.student_operations_xero_invoices WHERE customer_id=$1 AND xero_connection_id=$2 AND xero_contact_id=$3 AND student_id IS DISTINCT FROM 'STD-921'",[tenant,connection,contact])).rowCount,'Contact has conflicting invoices');
 const previous=(await q('SELECT * FROM sophia_runtime.student_college_xero_contact_links WHERE customer_id=$1 AND xero_connection_id=$2 AND xero_contact_id=$3 FOR UPDATE',[tenant,connection,contact])).rows[0];
 check(!previous||previous.classification==='unresolved'||(previous.classification==='student'&&[oldUser,keepUser].includes(previous.student_user_id)),'Contact has a conflicting review');
 // Public identity tables use the owner connection; Runtime writes remain tenant-scoped.
 await q('RESET ROLE');
 await one("UPDATE public.bm_xero_student_contact_links SET student_id='STD-565' WHERE customer_id=$1 AND student_id='STD-921' AND connection_id=$2 AND contact_id=$3 RETURNING contact_id",[tenant,connection,contact]);
 await one("UPDATE public.bm_xero_student_sync_candidates SET student_id='STD-565',reason=NULL WHERE customer_id=$1 AND student_id='STD-921' AND status='linked' AND connection_id=$2 AND contact_ids=ARRAY[$3::uuid] RETURNING id",[tenant,connection,contact]);
 // One-off owner repair: remove/reinsert the same association because its FK is ON UPDATE RESTRICT.
 const priorLink=await one('DELETE FROM sophia_runtime.student_operations_case_invoice_links WHERE customer_id=$1 AND student_id=$2 AND case_id=$3 AND xero_invoice_id=$4 RETURNING *',[tenant,old,oldCase,invoice]);
 await q('SET LOCAL ROLE sophia_runtime_app');
 await one("UPDATE sophia_runtime.student_operations_xero_invoices SET student_id='STD-565' WHERE customer_id=$1 AND student_id='STD-921' AND xero_invoice_id=$2 RETURNING xero_invoice_id",[tenant,invoice]);
 await one("INSERT INTO sophia_runtime.student_operations_case_invoice_links(case_invoice_link_id,customer_id,case_id,student_id,student_reference,xero_connection_id,xero_invoice_id,linked_by_identity,linked_at) VALUES($1,$2,$3,$4,'STD-565',$5,$6,$7,$8) RETURNING case_id",[priorLink.case_invoice_link_id,tenant,keepCase,keep,connection,invoice,actor,priorLink.linked_at]);
 const operating=(await q("SELECT 1 FROM sophia_runtime.student_operations_xero_sync_configurations WHERE customer_id=$1 AND xero_connection_id=$2 AND organisation_role='operating' AND enabled",[tenant,connection])).rowCount;
 if(operating){
 const mapping=await one(`INSERT INTO sophia_runtime.student_college_xero_contact_links(customer_id,xero_connection_id,xero_contact_id,classification,student_user_id,reviewed_by) VALUES($1,$2,$3,'student',$4,$5) ON CONFLICT(customer_id,xero_connection_id,xero_contact_id) DO UPDATE SET classification='student',student_user_id=excluded.student_user_id,college_id=NULL,supplier_id=NULL,reviewed_by=excluded.reviewed_by,reviewed_at=now(),revision=student_college_xero_contact_links.revision+1 RETURNING *`,[tenant,connection,contact,keepUser,actor]);
 await q('INSERT INTO sophia_runtime.student_college_xero_mapping_events(customer_id,xero_connection_id,xero_contact_id,actor_identity,previous_value,confirmed_value) VALUES($1,$2,$3,$4,$5,$6)',[tenant,connection,contact,actor,previous?JSON.stringify(previous):null,JSON.stringify(mapping)]);
 }
 await one("UPDATE sophia_runtime.student_operations_cases SET archive_previous_workflow=jsonb_build_object('stage',current_stage,'status',lifecycle_status,'closedOn',closed_on),current_stage='terminated',lifecycle_status='closed',closed_on=(now() AT TIME ZONE 'Australia/Brisbane')::date,archived_at=now(),record_version=record_version+1,updated_at=now() WHERE customer_id=$1 AND case_id=$2 RETURNING case_id",[tenant,oldCase]);
 const archived=await one("UPDATE sophia_runtime.student_operations_students SET status='archived',record_version=record_version+1,updated_at=now() WHERE customer_id=$1 AND student_id=$2 RETURNING record_version",[tenant,old]);
 await q("INSERT INTO sophia_runtime.student_operations_student_audit_events(customer_id,student_id,actor_identity_user_id,event_type,record_version,changed_fields,correlation_id) VALUES($1,$2,$3,'student.updated',$4,ARRAY['status'],$3)",[tenant,old,actor,archived.record_version]);
 const detail={sourceStudent:'STD-921',destinationStudent:'STD-565',invoiceId:invoice,invoiceNumber:'INV-3449',sourceCase:'CASE-983',destinationCase:'CASE-587',reason:'User-confirmed duplicate student merge; original account and case retained for tracking'};
 for(const c of [oldCase,keepCase])await q("INSERT INTO sophia_runtime.student_operations_case_activity(customer_id,case_id,actor_identity_user_id,event_type,summary,detail) VALUES($1,$2,$3,'student.merged','STD-921 merged into STD-565; INV-3449 moved to CASE-587; duplicate student and CASE-983 archived',$4)",[tenant,c,actor,JSON.stringify(detail)]);
 await q('RESET ROLE');await one("UPDATE public.users SET status='archived',updatedat=now() WHERE id=$1 AND status='active' RETURNING id",[oldUser]);
 for(const table of ['bm_xero_student_contact_links','bm_xero_student_sync_candidates'])check(!(await q(`SELECT 1 FROM public.${table} WHERE customer_id=$1 AND student_id='STD-921'`,[tenant])).rowCount,'Old sync association remains');
 await q('SET LOCAL ROLE sophia_runtime_app');
 for(const table of ['student_operations_case_invoice_links','student_operations_student_contact_links'])check(!(await q(`SELECT 1 FROM sophia_runtime.${table} WHERE customer_id=$1 AND student_id=$2`,[tenant,old])).rowCount,'Old Runtime association remains');
 const totals=(await q("SELECT student_id,count(*)::int AS invoices FROM sophia_runtime.student_operations_xero_invoices WHERE customer_id=$1 AND student_id IN ('STD-565','STD-921') GROUP BY student_id",[tenant])).rows;
 check(totals.length===1&&totals[0].student_id==='STD-565'&&totals[0].invoices===9,'Invoice verification failed');
 await q(apply?'COMMIT':'ROLLBACK');console.log(JSON.stringify({result:apply?'committed':'rehearsal_rolled_back',...detail,totals}));
}catch(e){await q('ROLLBACK');console.error(e.message);process.exitCode=1;}finally{db.release();await pool.end();}
