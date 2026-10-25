import { readFile } from 'node:fs/promises';
import { jest } from '@jest/globals';
import { StudentDocumentTypesService } from '../business-packs/student-operations/student-document-types.service.js';
import { Pool } from 'pg';
import { DatabaseService } from './database.service.js';
import { StudentOperationsCasesService } from '../business-packs/student-operations/student-operations-cases.service.js';
import type { StudentOperationsWorkspacePrincipal } from '../business-packs/student-operations/student-operations-workspace.service.js';
import { runCaseMigration } from '../../scripts/migrate-student-cases.js';
import { StudentOperationsCaseDocumentsService } from '../business-packs/student-operations/student-operations-case-documents.service.js';
import { XeroConnectorService } from '../connectors/xero/xero-connector.service.js';
import { StudentPrimaryXeroContact } from '../business-packs/student-operations/student-primary-xero-contact.js';
import { ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { XeroAttachment } from '../connectors/xero/xero.client.js';
import { enqueueDocumentAnalysis, StudentDocumentAnalysisQueue } from '../business-packs/student-operations/student-document-analysis.queue.js';
import { StudentDocumentAnalysisService } from '../business-packs/student-operations/student-document-analysis.service.js';
import { StudentDocumentAnalysisWorker } from '../business-packs/student-operations/student-document-analysis.worker.js';

const url=process.env.LOCAL_CASE_MANAGEMENT_TEST_DATABASE_URL;
if(url && !['localhost','127.0.0.1'].includes(new URL(url).hostname)) throw new Error('A disposable local database is required');
const suite=url?describe:describe.skip;
const tenant='11111111-1111-4111-8111-111111111111',company='22222222-2222-4222-8222-222222222222',user='33333333-3333-4333-8333-333333333333',advisor='44444444-4444-4444-8444-444444444444',connection='55555555-5555-4555-8555-555555555555',invoice='66666666-6666-4666-8666-666666666666',college='77777777-7777-4777-8777-777777777777';
suite('Case management against disposable PostgreSQL',()=>{
  const pool=new Pool({connectionString:url,max:2});
  const p:StudentOperationsWorkspacePrincipal={tenantId:tenant,externalCompanyId:company,identityUserId:advisor,entitlementId:advisor,role:'chief_executive',authorizationRevision:1};
  const transaction=async <T>(id:string,work:(db:import('pg').PoolClient)=>Promise<T>)=>{
    const db=await pool.connect();
    try{await db.query('BEGIN');await db.query('SET LOCAL ROLE sophia_runtime_app');await db.query("SELECT set_config('sophia.tenant_id',$1,true)",[id]);const result=await work(db);await db.query('COMMIT');return result;}
    catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  };
  const service=new StudentOperationsCasesService({tenantTransaction:transaction,tenantReadTransaction:transaction} as DatabaseService);
  beforeAll(async()=>{
    await pool.query(`
      DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='sophia_runtime_app') THEN CREATE ROLE sophia_runtime_app NOLOGIN; END IF; END $$;
      CREATE SCHEMA sophia_runtime; GRANT USAGE ON SCHEMA sophia_runtime TO sophia_runtime_app;
      CREATE TABLE sophia_runtime.customers(customer_id uuid PRIMARY KEY,external_company_id text,status text);
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE TABLE public.bm_company(company_id uuid PRIMARY KEY,workspace_profile text);
      CREATE TABLE public.bm_student_id_counter(id boolean PRIMARY KEY,last_value bigint NOT NULL);
      INSERT INTO public.bm_student_id_counter VALUES(true,1);
      CREATE TABLE public.users(id uuid PRIMARY KEY,company_id uuid,student_id text UNIQUE,name text,email text,cel text,tel text,type text,status text,username text UNIQUE,password text,image text,bio text,createdat timestamptz DEFAULT now(),updatedat timestamptz DEFAULT now());
      CREATE TABLE public.bm_colleges(college_id uuid PRIMARY KEY,company_id uuid,college_name text,status text);
      CREATE TABLE public.bm_xero_student_contact_links(customer_id uuid,connection_id uuid,contact_id uuid,student_id text);
      CREATE TABLE sophia_runtime.business_pack_entitlements(customer_id uuid,identity_user_id text,pack_id text,status text,role_key text);
      CREATE TABLE sophia_runtime.student_operations_students(student_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),customer_id uuid,student_reference text,legal_name text,email text,updated_at timestamptz DEFAULT now(),UNIQUE(student_id,customer_id),UNIQUE(customer_id,student_reference));
      CREATE TABLE sophia_runtime.xero_connections(xero_connection_id uuid PRIMARY KEY,customer_id uuid,status text DEFAULT 'active',UNIQUE(xero_connection_id,customer_id));
      CREATE TABLE sophia_runtime.student_operations_xero_sync_configurations(customer_id uuid,xero_connection_id uuid,organisation_role text);
      CREATE TABLE sophia_runtime.student_operations_xero_contacts(customer_id uuid,xero_connection_id uuid,xero_contact_id uuid,contact_status text,legal_name text,contact_number text,provider_updated_at timestamptz);
      GRANT SELECT ON sophia_runtime.xero_connections,sophia_runtime.student_operations_xero_sync_configurations,sophia_runtime.student_operations_xero_contacts TO sophia_runtime_app;
      CREATE TABLE sophia_runtime.student_operations_xero_invoices(customer_id uuid,xero_connection_id uuid,xero_invoice_id uuid,xero_contact_id uuid,student_id text,invoice_number text,invoice_type text,invoice_status text,invoice_date date,due_date date,advisor_name text,invoice_reference text,college_name text,payment_track text,total numeric,amount_paid numeric,amount_due numeric,currency_code text,PRIMARY KEY(customer_id,xero_connection_id,xero_invoice_id));
      GRANT SELECT ON sophia_runtime.student_operations_xero_invoices TO sophia_runtime_app;
    `);
    for(const name of ['064_student_operations_student_writes.sql','065_student_operations_write_least_privilege.sql','069_student_case_foundation.sql','070_student_register_advisor_projection.sql','071_student_case_management.sql','072_student_case_contact_projection.sql','073_student_case_workflow.sql','074_student_case_profile_edit.sql','075_student_advisor_directory.sql','087_student_account_case_creation.sql']) {
      await pool.query((await readFile(new URL(`./migrations/${name}`,import.meta.url),'utf8')).replaceAll('__SOPHIA_RUNTIME_SCHEMA__','sophia_runtime'));
    }
    await pool.query(`INSERT INTO sophia_runtime.customers VALUES($1,$2,'active')`,[tenant,company]);
    await pool.query(`INSERT INTO public.bm_company VALUES($1,'student_operations')`,[company]);
    await pool.query(`INSERT INTO public.users(id,company_id,student_id,name,email,cel,tel,type,status) VALUES($1,$2,'STD-1','Example Student','student@example.test','0412 345 678','07 3333 4444','student','active'),($3,$2,NULL,'Advisor One','advisor@example.test',NULL,NULL,'advisor','active')`,[user,company,advisor]);
    await pool.query(`INSERT INTO sophia_runtime.business_pack_entitlements VALUES($1,$2,'student-operations','active','advisor')`,[tenant,advisor]);
    await pool.query(`INSERT INTO public.bm_colleges VALUES($1,$2,'York Business','active')`,[college,company]);
    await pool.query(`INSERT INTO sophia_runtime.xero_connections(xero_connection_id,customer_id) VALUES($1,$2)`,[connection,tenant]);
    await pool.query(`INSERT INTO sophia_runtime.student_operations_xero_sync_configurations VALUES($1,$2,'trust')`,[tenant,connection]);
    await pool.query(`INSERT INTO sophia_runtime.student_operations_xero_contacts VALUES($1,$2,$3,'ACTIVE','Example Student',NULL,now())`,[tenant,connection,invoice]);
    await pool.query(`INSERT INTO sophia_runtime.student_operations_xero_invoices(customer_id,xero_connection_id,xero_invoice_id,xero_contact_id,student_id,invoice_number,invoice_type,invoice_status,invoice_date,advisor_name,invoice_reference) VALUES($1,$2,$3,$3,'STD-1','INV-1','ACCREC','PAID','2025-01-01','Advisor One','YORK BUSINESS')`,[tenant,connection,invoice]);
    await pool.query(`UPDATE public.users SET password='unchanged-legacy-hash' WHERE id=$1`,[user]);
    await pool.query(await readFile(new URL('./migrations/088_user_password_setup_state.sql',import.meta.url),'utf8'));
    await pool.query((await readFile(new URL('./migrations/089_student_document_types_uploads.sql',import.meta.url),'utf8')).replaceAll('__SOPHIA_RUNTIME_SCHEMA__','sophia_runtime'));
    await pool.query((await readFile(new URL('./migrations/090_student_primary_xero_contacts.sql',import.meta.url),'utf8')).replaceAll('__SOPHIA_RUNTIME_SCHEMA__','sophia_runtime'));
    // New durable stores must deny deletion even under inherited owner defaults.
    await pool.query('ALTER DEFAULT PRIVILEGES IN SCHEMA sophia_runtime GRANT DELETE ON TABLES TO sophia_runtime_app');
    await pool.query((await readFile(new URL('./migrations/091_student_document_contact_overflow.sql',import.meta.url),'utf8')).replaceAll('__SOPHIA_RUNTIME_SCHEMA__','sophia_runtime'));
    await pool.query('ALTER DEFAULT PRIVILEGES IN SCHEMA sophia_runtime REVOKE DELETE ON TABLES FROM sophia_runtime_app');
    await pool.query((await readFile(new URL('./migrations/092_student_case_checklists.sql',import.meta.url),'utf8')).replaceAll('__SOPHIA_RUNTIME_SCHEMA__','sophia_runtime'));
    await pool.query(`INSERT INTO sophia_runtime.student_operations_document_types(customer_id,company_id,name,required) VALUES($1,$2,'letter of offer',false)`,[tenant,company]);
    await pool.query((await readFile(new URL('./migrations/093_student_status_document_requirements.sql',import.meta.url),'utf8')).replaceAll('__SOPHIA_RUNTIME_SCHEMA__','sophia_runtime'));
    await pool.query('ALTER DEFAULT PRIVILEGES IN SCHEMA sophia_runtime GRANT DELETE,UPDATE ON TABLES TO sophia_runtime_app');
    await pool.query((await readFile(new URL('./migrations/094_student_document_analysis.sql',import.meta.url),'utf8')).replaceAll('__SOPHIA_RUNTIME_SCHEMA__','sophia_runtime'));
    await pool.query('ALTER DEFAULT PRIVILEGES IN SCHEMA sophia_runtime REVOKE DELETE,UPDATE ON TABLES FROM sophia_runtime_app');
    await pool.query((await readFile(new URL('./migrations/095_student_document_analysis_review.sql',import.meta.url),'utf8')).replaceAll('__SOPHIA_RUNTIME_SCHEMA__','sophia_runtime'));
  });
  afterAll(async()=>{await pool.end();});
  const analysisQueueTest=async()=>{
    const id=String((await service.createStudent(p,{studentName:'Analysis Student',studentEmail:'analysis@example.test'},'analysis-create-student')).caseId);
    const documentId=String((await transaction(tenant,db=>db.query(`INSERT INTO sophia_runtime.student_operations_case_documents
      (customer_id,case_id,xero_connection_id,source_kind,source_id,attachment_id,file_name,mime_type,size_bytes)
      VALUES($1,$2,$3,'Contacts',$4,$5,'passport.pdf','application/pdf',100) RETURNING document_id`,[tenant,id,connection,invoice,randomUUID()]))).rows[0].document_id);
    const queue=new StudentDocumentAnalysisQueue({tenantTransaction:transaction} as DatabaseService);
    const input={caseId:id,documentId,contentSha256:'a'.repeat(64),kind:'passport'};
    const [first,second]=await Promise.all([transaction(tenant,db=>enqueueDocumentAnalysis(db,tenant,input)),transaction(tenant,db=>enqueueDocumentAnalysis(db,tenant,input))]);
    expect(second).toBe(first);
    const [a,b]=await Promise.all([queue.claim(tenant),queue.claim(tenant)]);
    expect([a,b].filter(Boolean)).toHaveLength(1);
    const original=(a??b)!;
    expect(original.jobId).toBe(first);
    const payload={extraction:{kind:'passport',studentName:'Analysis Student',evidence:[{page:1,quote:'Expiry 2035-08-06'}],issues:[],expiresOn:'2035-08-06',mrzExpiryMatches:true},provider:'fixture',model:'fixture-v1',inputTokens:100,outputTokens:20};
    await transaction(tenant,db=>db.query(`UPDATE sophia_runtime.student_document_analysis_jobs SET lease_expires_at=now()-interval '1 second' WHERE job_id=$1`,[first]));
    expect(await queue.complete(tenant,first,original.leaseToken,payload)).toBeNull();
    const reclaimed=(await queue.claim(tenant))!;
    expect(reclaimed.attempts).toBe(2);
    expect(await queue.fail(tenant,first,original.leaseToken,'provider_unavailable',true)).toBe(false);
    expect(await queue.fail(tenant,first,reclaimed.leaseToken,'rate_limited',true)).toBe(true);
    expect(await queue.claim(tenant)).toBeNull();
    await transaction(tenant,db=>db.query(`UPDATE sophia_runtime.student_document_analysis_jobs SET next_attempt_at=now() WHERE job_id=$1`,[first]));
    const retry=(await queue.claim(tenant))!;
    await expect(queue.complete(tenant,first,retry.leaseToken,{...payload,extraction:{...payload.extraction,passportNumber:'must-not-persist'}})).rejects.toThrow();
    const resultId=await queue.complete(tenant,first,retry.leaseToken,payload);
    expect(resultId).toBeTruthy();
    expect(await queue.complete(tenant,first,retry.leaseToken,payload)).toBeNull();
    const other='88888888-8888-4888-8888-888888888888';
    expect(await queue.claim(other)).toBeNull();
    expect((await transaction(other,db=>db.query('SELECT * FROM sophia_runtime.student_document_analysis_results'))).rowCount).toBe(0);
    await expect(transaction(other,db=>enqueueDocumentAnalysis(db,other,input))).rejects.toThrow();
    await expect(transaction(tenant,db=>db.query('UPDATE sophia_runtime.student_document_analysis_results SET extraction=$1',[{}]))).rejects.toThrow('permission denied');
    for(const tab of ['student_document_analysis_jobs','student_document_analysis_results','student_document_reviews','student_case_offers','student_case_offer_courses','student_case_offer_fees','student_case_offer_instalments']) {
      await expect(transaction(tenant,db=>db.query(`DELETE FROM sophia_runtime.${tab}`))).rejects.toThrow('permission denied');
    }
    const reviewArgs=[tenant,id,documentId,resultId];
    await transaction(tenant,db=>db.query(`INSERT INTO sophia_runtime.student_document_reviews(customer_id,case_id,document_id,result_id,review_version,decision,reason,actor_identity_user_id)
      VALUES($1,$2,$3,$4,1,'confirmed','Checked expiry',$5)`,[...reviewArgs,advisor]));
    await expect(transaction(tenant,db=>db.query(`INSERT INTO sophia_runtime.student_document_reviews(customer_id,case_id,document_id,result_id,review_version,decision,reason,actor_identity_user_id)
      VALUES($1,$2,$3,$4,1,'rejected','Stale update',$5)`,[...reviewArgs,advisor]))).rejects.toThrow('duplicate key');
    await expect(transaction(tenant,db=>db.query(`UPDATE sophia_runtime.student_document_reviews SET decision='rejected'`))).rejects.toThrow('permission denied');
    // Final-attempt crash becomes terminal instead of staying processing forever.
    const finalJob=await transaction(tenant,db=>enqueueDocumentAnalysis(db,tenant,{...input,schemaVersion:'2'}));
    await queue.claim(tenant);
    await transaction(tenant,db=>db.query(`UPDATE sophia_runtime.student_document_analysis_jobs SET attempts=5,lease_expires_at=now()-interval '1 second' WHERE job_id=$1`,[finalJob]));
    expect(await queue.claim(tenant)).toBeNull();
    expect((await transaction(tenant,db=>db.query('SELECT status FROM sophia_runtime.student_document_analysis_jobs WHERE job_id=$1',[finalJob]))).rows[0].status).toBe('failed');
    // Persist source financial values independently; no invoice applicability decision exists here.
    const offerJob=await transaction(tenant,db=>enqueueDocumentAnalysis(db,tenant,{...input,kind:'letter_of_offer'}));
    const offerLease=(await queue.claim(tenant))!;
    const offerResult=await queue.complete(tenant,offerJob,offerLease.leaseToken,{...payload,extraction:{
      kind:'letter_of_offer',studentName:'Analysis Student',evidence:[{page:1,quote:'Total AUD 9040'}],issues:[],
      collegeName:'Example College',abn:null,cricosProviderCode:null,currency:'AUD',statedTotalMinor:904000,
      courses:[],fees:[],instalments:[],
    }});
    const offerId=String((await transaction(tenant,db=>db.query(`INSERT INTO sophia_runtime.student_case_offers
      (customer_id,case_id,document_id,result_id,currency,stated_total_minor)
      VALUES($1,$2,$3,$4,'AUD',904000) RETURNING offer_id`,[tenant,id,documentId,offerResult]))).rows[0].offer_id);
    await transaction(tenant,db=>db.query(`INSERT INTO sophia_runtime.student_case_offer_fees
      (customer_id,offer_id,label,amount_minor,conditional,condition) VALUES($1,$2,'International transfer',2500,true,'International payments')`,[tenant,offerId]));
    await transaction(tenant,db=>db.query(`INSERT INTO sophia_runtime.student_case_offer_instalments
      (customer_id,offer_id,sequence,due_term,total_minor,included_conditional_fee_minor)
      VALUES($1,$2,1,'Immediately',99500,2500)`,[tenant,offerId]));
    expect((await transaction(tenant,db=>db.query('SELECT total_minor::int,due_on,included_conditional_fee_minor::int FROM sophia_runtime.student_case_offer_instalments WHERE offer_id=$1',[offerId]))).rows[0])
      .toEqual({total_minor:99500,due_on:null,included_conditional_fee_minor:2500});
    expect((await transaction(other,db=>db.query('SELECT * FROM sophia_runtime.student_case_offers'))).rowCount).toBe(0);
    await expect(transaction(tenant,db=>db.query('UPDATE sophia_runtime.student_case_offers SET is_current=true WHERE offer_id=$1',[offerId]))).rejects.toThrow('check constraint');
  };
  const checklists=async()=>{
    const created=await service.createStudent(p,{studentName:'Checklist Student',studentEmail:'checklist@example.test'},'checklist-create-student');
    const id=String(created.caseId),initial=await service.checklist(p,id);
    expect(initial.items).toHaveLength(4);expect(initial.items.every(i=>!i.completed&&i.recordVersion===0)).toBe(true);
    for(const item of initial.items){
      const payload={itemKey:item.key,completed:true,recordVersion:0},key=`checklist-${item.key}`;
      const saved=await service.updateChecklist(p,id,payload,key);
      expect(await service.updateChecklist(p,id,payload,key)).toEqual(JSON.parse(JSON.stringify(saved)));
    }
    const activity=await service.activities(p,id,{});
    expect(activity.activity.filter(i=>i.eventType==='case.checklist_completed')).toHaveLength(1);
    expect(activity.activity.find(i=>i.eventType==='student.created')).toMatchObject({summary:'User created',actorName:'Advisor One'});
    expect(activity.activity.find(i=>i.eventType==='case.checklist_completed')).toMatchObject({summary:'Checklist complete',actorName:'Advisor One'});
    await expect(service.updateChecklist(p,id,{itemKey:initial.items[0].key,completed:false,recordVersion:0},'checklist-stale')).rejects.toThrow('Checklist changed');
    await service.updateChecklist(p,id,{itemKey:initial.items[0].key,completed:false,recordVersion:1},'checklist-reopen');
    expect((await service.activities(p,id,{})).activity.filter(i=>i.eventType==='case.checklist_reopened')).toHaveLength(1);
    const other=String((await service.create(p,{userId:(await service.get(p,id)).userId},'checklist-other-case')).caseId);
    expect((await service.checklist(p,other)).items.every(i=>!i.completed)).toBe(true);
    await Promise.all(initial.items.map(item=>service.updateChecklist(p,other,{itemKey:item.key,completed:true,recordVersion:0},`concurrent-checklist-${item.key}`)));
    expect((await service.activities(p,other,{})).activity.filter(i=>i.eventType==='case.checklist_completed')).toHaveLength(1);
    await transaction(tenant,db=>db.query(`INSERT INTO sophia_runtime.student_operations_case_activity(customer_id,case_id,actor_identity_user_id,event_type,summary) VALUES($1,$2,'system:test','case.checklist_verified','Automatic verification')`,[tenant,id]));
    expect((await service.activities(p,id,{})).activity.find(i=>i.summary==='Automatic verification')?.actorName).toBe('SophiaAi');
    await expect(service.updateChecklist(p,id,{itemKey:initial.items[0].key,completed:true,recordVersion:2,actorName:'SophiaAi'},'checklist-spoof-actor')).rejects.toThrow('Invalid case request');
    await expect(service.updateChecklist({...p,role:'advisor'},id,{itemKey:initial.items[0].key,completed:true,recordVersion:2},'checklist-advisor')).rejects.toThrow('permission');
    await expect(service.checklist({...p,tenantId:'88888888-8888-4888-8888-888888888888'},id)).rejects.toThrow('not found');
    expect((await transaction('88888888-8888-4888-8888-888888888888',db=>db.query('SELECT * FROM sophia_runtime.student_operations_case_checklist'))).rowCount).toBe(0);
    await expect(transaction(tenant,db=>db.query('DELETE FROM sophia_runtime.student_operations_case_checklist'))).rejects.toThrow('permission denied');
    await service.update(p,id,{recordVersion:1,status:'in_progress',currentStage:'payment_received'},'checklist-leave-presale');
    await expect(service.updateChecklist(p,id,{itemKey:initial.items[0].key,completed:true,recordVersion:2},'checklist-wrong-status')).rejects.toThrow('Pre-sale');
  };
  test('password setup migration preserves legacy access and marks all future account inserts',async()=>{
    expect((await pool.query('SELECT must_change_password,password FROM public.users WHERE id=$1',[user])).rows[0])
      .toEqual({must_change_password:false,password:'unchanged-legacy-hash'});
    expect((await pool.query('SELECT must_change_password FROM public.users WHERE id=$1',[advisor])).rows[0].must_change_password).toBe(false);
    const result=await pool.query(`INSERT INTO public.users(id,company_id,name,email,type,must_change_password)
      VALUES(gen_random_uuid(),$1,'New employee','new-employee@example.test','employee',false)
      RETURNING must_change_password`,[company]);
    expect(result.rows[0].must_change_password).toBe(true);
    const column=await pool.query(`SELECT is_nullable,column_default FROM information_schema.columns
      WHERE table_schema='public' AND table_name='users' AND column_name='must_change_password'`);
    expect(column.rows[0]).toEqual({is_nullable:'NO',column_default:'false'});
  });
  test('preview is read-only; migration creates one case and reruns without duplication',async()=>{
    const preview=await runCaseMigration(pool,tenant,false);
    expect(preview.counts.planned).toBe(1);
    expect((await pool.query('SELECT count(*)::int n FROM sophia_runtime.student_operations_cases')).rows[0].n).toBe(0);
    const applied=await runCaseMigration(pool,tenant,true);
    expect(applied.counts.created).toBe(1);
    expect(applied.documentJobsQueued).toBe(2);
    expect((await runCaseMigration(pool,tenant,true)).counts.already_has_case).toBe(1);
    const list=await service.list(p,{});
    expect(list.total).toBe(1);
    const detail=await service.get(p,list.cases[0].caseId);
    expect(detail.status).toBe('in_progress');
    expect(detail.studentName).toBe('Example Student');
    expect(detail.studentEmail).toBe('student@example.test');
    expect(detail.studentPhone).toBe('07 3333 4444');
    expect(detail.studentMobile).toBe('0412 345 678');
    expect(detail.openedOn).toBeTruthy();
    expect(detail.currentStage).toBe('imported_pending_review');
    expect(detail.courseName).toBeNull();
    expect(detail.colleges[0].collegeId).toBe(college);
    expect((await service.invoices(p,detail.caseId,{})).total).toBe(1);
  });
  test('supports multiple cases, idempotency, optimistic concurrency and advisor access',async()=>{
    const first=await service.create(p,{userId:user,advisorUserId:advisor,collegeId:college,courseName:'English'},'create-case-2');
    const replay=await service.create(p,{userId:user,advisorUserId:advisor,collegeId:college,courseName:'English'},'create-case-2');
    expect(replay).toEqual(first);
    const id=String(first.caseId);
    expect((await service.list(p,{})).total).toBe(2);
    await expect(service.create(p,{userId:user,title:'Different'},'create-case-2')).rejects.toThrow('Idempotency');
    await expect(service.update(p,id,{recordVersion:4,title:'Conflict'},'update-case-2')).rejects.toThrow('Case changed');
    await service.update(p,id,{recordVersion:1,currentStage:'payments_complete',status:'closed'},'complete-case-2');
    expect((await service.get(p,id)).status).toBe('closed');
    expect((await service.get({...p,role:'advisor'},id)).caseId).toBe(id);
    await expect(service.get({...p,role:'advisor',identityUserId:user},id)).rejects.toThrow('Case not found');
    await expect(service.get({...p,tenantId:'88888888-8888-4888-8888-888888888888'},id)).rejects.toThrow('Case not found');
    await expect(service.linkInvoice(p,id,{connectionId:connection,invoiceId:invoice},'link-case-2')).rejects.toThrow('another case');
    await expect(service.create({...p,role:'advisor'},{userId:user},'create-case-3')).rejects.toThrow('permission');
  });
  test('discovers attachments from verified invoice/contact sources and authorizes content',async()=>{
    const list=await service.list(p,{});
    const id=list.cases.find(c=>c.currentStage==='imported_pending_review')!.caseId;
    const connector={attachments:async()=>[{attachmentId:invoice,fileName:'offer.pdf',mimeType:'application/pdf',sizeBytes:4}],attachmentContent:async()=>Buffer.from('test')};
    const documents=new StudentOperationsCaseDocumentsService({tenantTransaction:transaction,tenantReadTransaction:transaction} as DatabaseService,service,connector as unknown as XeroConnectorService);
    expect((await documents.enqueue(p,id)).queued).toBe(0);
    expect((await documents.enqueue(p,id)).queued).toBe(0);
    expect(await documents.processOne(tenant)).toBe(true);
    expect(await documents.processOne(tenant)).toBe(true);
    expect(await documents.processOne(tenant)).toBe(false);
    const files=await documents.list(p,id);
    expect(files.documents).toHaveLength(2);
    const paged=await documents.list(p,id,{page:2,limit:1});
    expect(paged.total).toBe(2);
    expect(paged.documents).toHaveLength(1);
    await expect(documents.list(p,id,{limit:1001})).rejects.toThrow('Invalid document pagination');
    expect(files.discovery).toEqual([{status:'succeeded',errorCode:null,count:2}]);
    expect((await documents.content(p,id,files.documents[0].documentId)).buffer.toString()).toBe('test');
    await expect(documents.content({...p,role:'advisor',identityUserId:user},id,files.documents[0].documentId)).rejects.toThrow('Case not found');
    expect(files.documents[0]).not.toHaveProperty('xero_connection_id');
  });
  test('saves case and linked login identity atomically and rejects duplicate email',async()=>{
    const id=(await service.list(p,{})).cases.find(c=>c.currentStage==='imported_pending_review')!.caseId;
    const before=await service.get(p,id);
    const saved=await service.update(p,id,{recordVersion:before.recordVersion,studentName:'Updated Student',studentEmail:'updated@example.test',mobile:'0400 111 222',phone:'07 1111 2222',collegeId:college,advisorUserId:advisor},'update-case-profile');
    const detail=await service.get(p,id);
    expect(detail).toMatchObject({studentName:'Updated Student',studentEmail:'updated@example.test',studentMobile:'0400 111 222',studentPhone:'07 1111 2222',recordVersion:saved.recordVersion});
    const account=(await pool.query('SELECT name,email,cel,tel FROM public.users WHERE id=$1',[user])).rows[0];
    expect(account).toMatchObject({name:'Updated Student',email:'updated@example.test',cel:'0400 111 222',tel:'07 1111 2222'});
    await expect(service.update(p,id,{recordVersion:saved.recordVersion,title:'Must roll back',studentEmail:'advisor@example.test'},'duplicate-case-email')).rejects.toThrow('already in use');
    expect((await service.get(p,id)).title).not.toBe('Must roll back');
  });
  test('creates a student account, profile, link and numbered first case only on one idempotent save',async()=>{
    const value={studentName:'New Student',studentEmail:'NEW@example.test',mobile:'0400 222 333',courseName:'English'};
    const before=(await pool.query('SELECT count(*)::int n FROM public.users')).rows[0].n;
    await service.editOptions(p);service.options();
    expect((await pool.query('SELECT count(*)::int n FROM public.users')).rows[0].n).toBe(before);
    const [created,replayed]=await Promise.all([service.createStudent(p,value,'new-student-save'),service.createStudent(p,value,'new-student-save')]);
    expect(replayed).toEqual(created);
    const detail=await service.get(p,String(created.caseId));
    expect(detail).toMatchObject({studentName:'New Student',studentEmail:'new@example.test',studentMobile:'0400 222 333',courseName:'English',currentStage:'documents_requested',status:'pre_sale'});
    expect(detail.caseNumber).toMatch(/^CASE-\d+$/);expect(detail.studentReference).toBe('STD-2');
    expect((await pool.query('SELECT count(*)::int n FROM public.users')).rows[0].n).toBe(before+1);
    const account=(await pool.query('SELECT type,status,password,must_change_password FROM public.users WHERE id=$1',[detail.userId])).rows[0];
    expect(account.must_change_password).toBe(true);
    expect(account).toMatchObject({type:'student',status:'active'});
    expect(account.password).toMatch(/^\$2[aby]\$10\$/);
    expect(created).not.toHaveProperty('password');expect(detail).not.toHaveProperty('password');
    expect((await service.activities(p,detail.caseId,{})).activity).toHaveLength(2);
    expect((await pool.query("SELECT event_type,actor_identity_user_id FROM sophia_runtime.student_operations_student_audit_events WHERE student_id=$1",[detail.studentId])).rows).toEqual([{event_type:'student.created',actor_identity_user_id:advisor}]);
    await expect(service.createStudent(p,{...value,courseName:'Changed'},'new-student-save')).rejects.toThrow('Idempotency');
  });
  test('rejects duplicates/foreign choices and rolls back account, profile and number counter on failure',async()=>{
    const before=(await pool.query('SELECT last_value FROM public.bm_student_id_counter')).rows[0].last_value;
    const accounts=(await pool.query('SELECT count(*)::int n FROM public.users')).rows[0].n;
    await expect(service.createStudent(p,{studentName:'Other',studentEmail:'NEW@example.test'},'duplicate-new-student')).rejects.toThrow('already in use');
    await expect(service.createStudent(p,{studentName:'Wrong Choice',studentEmail:'rollback@example.test',collegeId:user},'rollback-new-student')).rejects.toThrow('College');
    expect((await pool.query('SELECT last_value FROM public.bm_student_id_counter')).rows[0].last_value).toBe(before);
    expect((await pool.query('SELECT count(*)::int n FROM public.users')).rows[0].n).toBe(accounts);
    expect((await pool.query("SELECT count(*)::int n FROM sophia_runtime.student_operations_students WHERE email='rollback@example.test'")).rows[0].n).toBe(0);
    await expect(service.createStudent(p,{studentName:'Staff',studentEmail:'advisor@example.test'},'staff-email-student')).rejects.toThrow('already in use');
  });
  test('enforces manager scope, strict inputs, migration-only stage rejection and narrow identity privileges',async()=>{
    const value={studentName:'Not Created',studentEmail:'not-created@example.test'};
    await expect(service.createStudent({...p,role:'advisor'},value,'forbidden-student')).rejects.toThrow('permission');
    await expect(service.createStudent(p,{...value,userId:user},'injected-user-student')).rejects.toThrow('Invalid case');
    await expect(service.createStudent(p,{...value,customerId:tenant},'injected-tenant-student')).rejects.toThrow('Invalid case');
    await expect(service.createStudent(p,{...value,currentStage:'imported_pending_review'},'import-stage-student')).rejects.toThrow('only for migrated');
    await expect(service.createStudent({...p,tenantId:'88888888-8888-4888-8888-888888888888'},value,'foreign-student')).rejects.toThrow();
    await expect(transaction(tenant,db=>db.query("INSERT INTO public.users(id) VALUES(gen_random_uuid())"))).rejects.toThrow('permission denied');
    await expect(transaction(tenant,db=>db.query('UPDATE public.bm_student_id_counter SET last_value=0'))).rejects.toThrow('permission denied');
  });
  const types=new StudentDocumentTypesService({tenantTransaction:transaction,tenantReadTransaction:transaction} as DatabaseService,service);
  test('document types are company-scoped, active-unique, editable and archived without deletion',async()=>{
    const first=await types.create(p,{name:'  Passport   copy ',required:true},'type-passport');
    expect(first).toMatchObject({name:'Passport copy',required:true,status:'active',recordVersion:1});
    expect(await types.create(p,{name:'Passport copy',required:true},'type-passport')).toEqual(first);
    await expect(types.create(p,{name:'passport copy',required:false},'type-duplicate')).rejects.toThrow('already exists');
    await expect(types.create(p,{name:'Injected',required:false,companyId:company},'type-injected')).rejects.toThrow('Enter a document');
    await expect(types.create({...p,role:'advisor'},{name:'Denied',required:false},'type-forbidden')).rejects.toThrow();
    expect((await types.list({...p,tenantId:'88888888-8888-4888-8888-888888888888'})).types).toHaveLength(0);
    const changed=await types.update(p,String(first.documentTypeId),{name:'Travel document',required:false,recordVersion:1},'type-edit');
    expect(changed).toMatchObject({name:'Travel document',required:false,recordVersion:2});
    await expect(types.update(p,String(first.documentTypeId),{required:true,recordVersion:1},'type-stale')).rejects.toThrow('changed');
    await types.update(p,String(first.documentTypeId),{status:'archived',recordVersion:2},'type-archive');
    expect((await types.list(p)).types).toHaveLength(3);
    await types.create(p,{name:'TRAVEL DOCUMENT',required:true},'type-new-after-archive');
    expect((await pool.query('SELECT status FROM sophia_runtime.student_operations_document_types WHERE document_type_id=$1',[first.documentTypeId])).rows[0].status).toBe('archived');
    expect((await pool.query('SELECT count(*)::int n FROM sophia_runtime.student_operations_document_type_events WHERE document_type_id=$1',[first.documentTypeId])).rows[0].n).toBe(3);
    await expect(transaction(tenant,db=>db.query('DELETE FROM sophia_runtime.student_operations_document_types'))).rejects.toThrow('permission denied');
  });
  test('Contact-only Xero upload is idempotent, typed and auditable; archived labels and content remain readable',async()=>{
    const file={buffer:Buffer.from('%PDF-1.7\nExample\n%%EOF'),originalname:'passport.pdf',mimetype:'application/pdf'};
    const xero={documentContactAttachments:jest.fn(async()=>[]),uploadAttachment:jest.fn(async()=>({attachmentId:college})),attachmentContent:jest.fn(async()=>file.buffer)};
    const docs=new StudentOperationsCaseDocumentsService({tenantTransaction:transaction,tenantReadTransaction:transaction} as DatabaseService,service,xero as unknown as XeroConnectorService);
    const created=await service.create(p,{userId:user},'uploaded-document-case');
    const id=String(created.caseId),type=(await types.list(p)).types.find(t=>t.name==='TRAVEL DOCUMENT')!;
    const input={documentTypeId:type.documentTypeId};
    expect(await docs.uploadOptions(p,id)).toMatchObject({available:true});
    const result=await docs.upload(p,id,input,file,'upload-example');
    expect(await docs.upload(p,id,input,file,'upload-example')).toEqual(result);
    expect(xero.uploadAttachment).toHaveBeenCalledTimes(1);
    expect(xero.uploadAttachment.mock.calls[0]).toEqual([tenant,connection,'Contacts',invoice,expect.stringMatching(/^[a-f0-9-]+-passport\.pdf$/),'application/pdf',file.buffer,expect.stringMatching(/^[a-f0-9]{64}$/),expect.any(Function)]);
    const listed=await docs.list(p,id,{});
    expect(listed.documents).toHaveLength(1);
    expect(listed.documents[0]).toMatchObject({documentId:result.documentId,documentTypeName:'TRAVEL DOCUMENT',documentTypeRequired:true,sourceKind:'Contacts'});
    expect(listed.documents[0]).not.toHaveProperty('private_object_key');
    await types.update(p,type.documentTypeId,{status:'archived',recordVersion:type.recordVersion},'archive-upload-type');
    expect((await docs.list(p,id,{})).documents[0].documentTypeName).toBe('TRAVEL DOCUMENT');
    expect((await docs.content(p,id,String(result.documentId))).buffer.equals(file.buffer)).toBe(true);
    expect(xero.attachmentContent).toHaveBeenCalledWith(tenant,connection,'Contacts',invoice,college);
    await expect(docs.upload(p,id,input,file,'upload-archived')).rejects.toThrow('active');
    const activities=await service.activities(p,id,{});
    expect(activities.activity.filter(a=>a.eventType==='case.document_uploaded')).toHaveLength(1);
  });
  test('upload validates permissions, tenant, file bytes, type and Contact identity before any provider request',async()=>{
    const xero={uploadAttachment:jest.fn()};
    const docs=new StudentOperationsCaseDocumentsService({tenantTransaction:transaction,tenantReadTransaction:transaction} as DatabaseService,service,xero as unknown as XeroConnectorService);
    const id=String((await service.create(p,{userId:user},'invalid-upload-case')).caseId);
    const type=await types.create(p,{name:'Offer',required:false},'offer-upload-type');
    const input={documentTypeId:type.documentTypeId};
    const file={buffer:Buffer.from('%PDF-1.7\nExample\n%%EOF'),originalname:'offer.pdf',mimetype:'application/pdf'};
    await expect(docs.upload({...p,role:'advisor'},id,input,file,'upload-denied')).rejects.toThrow();
    await expect(docs.upload({...p,tenantId:'88888888-8888-4888-8888-888888888888'},id,input,file,'upload-other-tenant')).rejects.toThrow('Case not found');
    await expect(docs.upload(p,id,input,{...file,buffer:Buffer.from('<html>unsafe</html>')},'upload-fake')).rejects.toThrow('content');
    await expect(docs.upload(p,id,input,{...file,originalname:'offer.svg'},'upload-extension')).rejects.toThrow('format');
    await expect(docs.upload(p,id,input,{...file,buffer:Buffer.alloc(10*1024*1024+1)},'upload-size')).rejects.toThrow('10 MB');
    await expect(docs.upload(p,id,{...input,documentTypeId:user},file,'upload-missing-type')).rejects.toThrow();
    await expect(docs.upload(p,id,{...input,connectionId:connection,contactId:user},file,'upload-foreign-contact')).rejects.toThrow('Reload');
    await expect(docs.upload(p,id,{...input,sourceKind:'Invoices'},file,'upload-wrong-source')).rejects.toThrow('Choose a document');
    expect(xero.uploadAttachment).not.toHaveBeenCalled();
  });
  test('ambiguous provider failures retain a stable upload identity and lease instead of duplicating files',async()=>{
    const xero={documentContactAttachments:jest.fn(async()=>[]),uploadAttachment:jest.fn(async()=>{throw new Error('Provider timeout');})};
    const docs=new StudentOperationsCaseDocumentsService({tenantTransaction:transaction,tenantReadTransaction:transaction} as DatabaseService,service,xero as unknown as XeroConnectorService);
    const id=String((await service.create(p,{userId:user},'timeout-upload-case')).caseId);
    const type=(await types.list(p)).types[0];
    const input={documentTypeId:type.documentTypeId};
    const file={buffer:Buffer.from('%PDF-1.7\nExample\n%%EOF'),originalname:'offer.pdf',mimetype:'application/pdf'};
    await expect(docs.upload(p,id,input,file,'timeout-upload')).rejects.toThrow('timeout');
    await expect(docs.upload(p,id,input,file,'timeout-upload')).rejects.toThrow('still processing');
    expect(xero.uploadAttachment).toHaveBeenCalledTimes(1);
    const firstCall=xero.uploadAttachment.mock.calls[0];
    await pool.query(`UPDATE sophia_runtime.student_operations_document_uploads SET lease_expires_at=now()-interval '1 second' WHERE idempotency_key='timeout-upload'`);
    await expect(docs.upload(p,id,input,file,'timeout-upload')).rejects.toThrow('timeout');
    expect(xero.uploadAttachment.mock.calls[1].slice(0,8)).toEqual(firstCall.slice(0,8));
    expect((await docs.list(p,id,{})).documents).toHaveLength(0);
  });
  test('a persisted provider receipt recovers local finalization without sending the file twice',async()=>{
    const xero={documentContactAttachments:jest.fn(async()=>[]),uploadAttachment:jest.fn(async()=>({attachmentId:user}))};
    const docs=new StudentOperationsCaseDocumentsService({tenantTransaction:transaction,tenantReadTransaction:transaction} as DatabaseService,service,xero as unknown as XeroConnectorService);
    const id=String((await service.create(p,{userId:user},'receipt-recovery-case')).caseId);
    const type=(await types.list(p)).types[0];
    const input={documentTypeId:type.documentTypeId};
    const file={buffer:Buffer.from('%PDF-1.7\nExample\n%%EOF'),originalname:'receipt.pdf',mimetype:'application/pdf'};
    const audit=jest.spyOn(service,'activity').mockRejectedValueOnce(new Error('Local audit interruption'));
    try {await expect(docs.upload(p,id,input,file,'receipt-recovery')).rejects.toThrow('Local audit');}
    finally {audit.mockRestore();}
    expect((await docs.list(p,id,{})).documents).toHaveLength(0);
    expect((await pool.query("SELECT status FROM sophia_runtime.student_operations_document_uploads WHERE idempotency_key='receipt-recovery'")).rows[0].status).toBe('uploaded');
    const result=await docs.upload(p,id,input,file,'receipt-recovery');
    expect(xero.uploadAttachment).toHaveBeenCalledTimes(1);
    expect((await docs.list(p,id,{})).documents[0].documentId).toBe(result.documentId);
  });
  test('pins the latest invoice Contact once and shares it across all student cases',async()=>{
    const created=await service.createStudent(p,{studentName:'Historical Student',studentEmail:'history@example.test'},'primary-history-student');
    const id=String(created.caseId),detail=await service.get(p,id);
    const older='a1111111-1111-4111-8111-111111111111',newer='a2222222-2222-4222-8222-222222222222';
    for(const [contact,date] of [[older,'2020-01-01'],[newer,'2026-10-20']]) {
      await pool.query(`INSERT INTO sophia_runtime.student_operations_xero_contacts VALUES($1,$2,$3,'ACTIVE','Historical Student',NULL,now())`,[tenant,connection,contact]);
      await pool.query(`INSERT INTO sophia_runtime.student_operations_xero_invoices(customer_id,xero_connection_id,xero_invoice_id,xero_contact_id,student_id,invoice_type,invoice_status,invoice_date) VALUES($1,$2,$3,$3,$4,'ACCREC','PAID',$5)`,[tenant,connection,contact,detail.studentReference,date]);
    }
    // An unrelated legacy number must not outrank the newest invoice's NULL number.
    await pool.query(`UPDATE sophia_runtime.student_operations_xero_contacts SET contact_number='old-external-code' WHERE xero_contact_id=$1`,[older]);
    const xero={ensureStudentContact:jest.fn()},resolver=new StudentPrimaryXeroContact({tenantTransaction:transaction,tenantReadTransaction:transaction} as DatabaseService,service,xero as unknown as XeroConnectorService);
    expect(await resolver.ensure(p,id)).toEqual({xero_connection_id:connection,source_id:newer});
    // New invoice activity must not move files/repin the primary identity later.
    await pool.query(`UPDATE sophia_runtime.student_operations_xero_invoices SET invoice_date='2027-01-01' WHERE xero_contact_id=$1`,[older]);
    const second=await service.create(p,{userId:detail.userId},'primary-history-second');
    expect(await resolver.ensure(p,String(second.caseId))).toEqual({xero_connection_id:connection,source_id:newer});
    expect(xero.ensureStudentContact).not.toHaveBeenCalled();
    expect((await pool.query(`SELECT count(*)::int n FROM sophia_runtime.student_operations_primary_xero_contacts WHERE student_id=$1`,[detail.studentId])).rows[0].n).toBe(1);
  });
  test('students with no invoices can upload, provision once, and reuse storage for a second case',async()=>{
    const old=process.env.XERO_CONTACT_CREATION_ENABLED;process.env.XERO_CONTACT_CREATION_ENABLED='true';
    try {
      const created=await service.createStudent(p,{studentName:'No Invoices',studentEmail:'no-invoices@example.test'},'primary-no-invoices');
      const id=String(created.caseId),detail=await service.get(p,id);
      const contact='a3333333-3333-4333-8333-333333333333';
      const xero={documentContactAttachments:jest.fn(async()=>[]),ensureStudentContact:jest.fn(async()=>({contactId:contact})),uploadAttachment:jest.fn(async()=>({attachmentId:college}))};
      const docs=new StudentOperationsCaseDocumentsService({tenantTransaction:transaction,tenantReadTransaction:transaction} as DatabaseService,service,xero as unknown as XeroConnectorService);
      const type=(await types.list(p)).types[0],file={buffer:Buffer.from('%PDF-1.7\nExample\n%%EOF'),originalname:'new-student.pdf',mimetype:'application/pdf'};
      // Options are read-only and do not create provider Contacts.
      expect((await docs.uploadOptions(p,id)).available).toBe(true);expect(xero.ensureStudentContact).not.toHaveBeenCalled();
      await expect(docs.upload(p,id,{documentTypeId:user},file,'primary-invalid-type')).rejects.toThrow('active');
      expect(xero.ensureStudentContact).not.toHaveBeenCalled();
      await docs.upload(p,id,{documentTypeId:type.documentTypeId},file,'primary-first-upload');
      const second=await service.create(p,{userId:detail.userId},'primary-no-invoices-case2');
      await docs.upload(p,String(second.caseId),{documentTypeId:type.documentTypeId},file,'primary-second-upload');
      expect(xero.ensureStudentContact).toHaveBeenCalledTimes(1);
      expect(xero.ensureStudentContact).toHaveBeenCalledWith(tenant,connection,{contactNumber:`sophia:${detail.studentId}`,name:`No Invoices (${detail.studentReference})`,email:'no-invoices@example.test'},expect.stringMatching(/^[a-f0-9]{64}$/));
      expect(xero.uploadAttachment.mock.calls.every(call=>call[3]===contact)).toBe(true);
      expect((await service.invoices(p,id,{})).total).toBe(0);
      expect((await docs.list(p,id,{})).documents).toHaveLength(1);
      expect((await docs.list(p,String(second.caseId),{})).documents).toHaveLength(1);
      const foreign=await transaction('88888888-8888-4888-8888-888888888888',db=>db.query('SELECT * FROM sophia_runtime.student_operations_primary_xero_contacts'));
      expect(foreign.rowCount).toBe(0);
      await expect(transaction(tenant,db=>db.query('DELETE FROM sophia_runtime.student_operations_primary_xero_contacts'))).rejects.toThrow('permission denied');
    } finally {if(old===undefined)delete process.env.XERO_CONTACT_CREATION_ENABLED;else process.env.XERO_CONTACT_CREATION_ENABLED=old;}
  });
  test('reuses an explicitly linked Contact even without invoices and hides other tenant links',async()=>{
    const created=await service.createStudent(p,{studentName:'Linked Without Invoices',studentEmail:'linked-no-invoices@example.test'},'primary-linked-no-invoice');
    const id=String(created.caseId),detail=await service.get(p,id),contact='a4444444-4444-4444-8444-444444444444';
    await pool.query(`INSERT INTO sophia_runtime.student_operations_xero_contacts VALUES($1,$2,$3,'ACTIVE','Linked Without Invoices',NULL,now())`,[tenant,connection,contact]);
    await pool.query(`INSERT INTO public.bm_xero_student_contact_links VALUES($1,$2,$3,$4)`,[tenant,connection,contact,detail.studentReference]);
    const xero={ensureStudentContact:jest.fn()},resolver=new StudentPrimaryXeroContact({tenantTransaction:transaction,tenantReadTransaction:transaction} as DatabaseService,service,xero as unknown as XeroConnectorService);
    expect(await resolver.ensure(p,id)).toEqual({xero_connection_id:connection,source_id:contact});
    expect(xero.ensureStudentContact).not.toHaveBeenCalled();
    expect((await transaction('88888888-8888-4888-8888-888888888888',db=>db.query('SELECT * FROM sophia_runtime.student_operations_student_contact_links'))).rowCount).toBe(0);
    await expect(transaction(tenant,db=>db.query('SELECT * FROM public.bm_xero_student_contact_links'))).rejects.toThrow('permission denied');
  });
  test('concurrent cases share one provisioning lease and uncertain creation retains the snapshot',async()=>{
    const old=process.env.XERO_CONTACT_CREATION_ENABLED;process.env.XERO_CONTACT_CREATION_ENABLED='true';
    try {
      const created=await service.createStudent(p,{studentName:'Pending Storage',studentEmail:'pending-storage@example.test'},'primary-pending');
      const id=String(created.caseId),detail=await service.get(p,id);
      const xero={ensureStudentContact:jest.fn(async()=>{throw new Error('Provider timeout');})};
      const resolver=new StudentPrimaryXeroContact({tenantTransaction:transaction,tenantReadTransaction:transaction} as DatabaseService,service,xero as unknown as XeroConnectorService);
      const second=await service.create(p,{userId:detail.userId},'primary-pending-second');
      const outcomes=await Promise.allSettled([resolver.ensure(p,id),resolver.ensure(p,String(second.caseId))]);
      const failures=outcomes.map(result=>result.status==='rejected'?String(result.reason):'unexpected success');
      expect(failures.some(message=>message.includes('timeout'))).toBe(true);
      expect(failures.some(message=>message.includes('being prepared'))).toBe(true);
      expect(xero.ensureStudentContact).toHaveBeenCalledTimes(1);
      const firstCall=xero.ensureStudentContact.mock.calls[0];
      await pool.query(`UPDATE sophia_runtime.student_operations_primary_xero_contacts SET lease_expires_at=now()-interval '1 second' WHERE student_id=$1`,[detail.studentId]);
      await pool.query(`UPDATE sophia_runtime.student_operations_students SET legal_name='Changed Profile' WHERE student_id=$1`,[detail.studentId]);
      await expect(resolver.ensure(p,id)).rejects.toThrow('timeout');
      expect(xero.ensureStudentContact.mock.calls[1]).toEqual(firstCall);
    } finally {if(old===undefined)delete process.env.XERO_CONTACT_CREATION_ENABLED;else process.env.XERO_CONTACT_CREATION_ENABLED=old;}
  });
  test('does not silently reroute an archived primary or pick an ambiguous organisation',async()=>{
    const id=(await service.list(p,{})).cases.find(c=>c.studentReference==='STD-1')!.caseId;
    const resolver=new StudentPrimaryXeroContact({tenantTransaction:transaction,tenantReadTransaction:transaction} as DatabaseService,service,{} as XeroConnectorService);
    await pool.query(`UPDATE sophia_runtime.student_operations_xero_contacts SET contact_status='ARCHIVED' WHERE xero_contact_id=$1`,[invoice]);
    try {await expect(resolver.ensure(p,id)).rejects.toThrow('administrator attention');}
    finally {await pool.query(`UPDATE sophia_runtime.student_operations_xero_contacts SET contact_status='ACTIVE' WHERE xero_contact_id=$1`,[invoice]);}
    const another='a5555555-5555-4555-8555-555555555555';
    await pool.query(`INSERT INTO sophia_runtime.xero_connections(xero_connection_id,customer_id) VALUES($1,$2)`,[another,tenant]);
    await pool.query(`INSERT INTO sophia_runtime.student_operations_xero_sync_configurations VALUES($1,$2,'trust')`,[tenant,another]);
    try {await expect(resolver.ensure(p,id)).rejects.toThrow('administrator attention');}
    finally {await pool.query(`UPDATE sophia_runtime.xero_connections SET status='revoked' WHERE xero_connection_id=$1`,[another]);}
  });
  function provider() {
    const references=new Map<string,string>(),files=new Map<string,XeroAttachment[]>();
    const ensureStudentContact=jest.fn(async(_t:string,_c:string,v:{contactNumber:string;name:string;email:string|null},_key:string)=>{
      if(!references.has(v.contactNumber)){const contact=randomUUID();references.set(v.contactNumber,contact);files.set(contact,[]);}
      return {contactId:references.get(v.contactNumber)!};
    });
    const documentContactAttachments=jest.fn(async(_t:string,_c:string,id:string)=>[...(files.get(id)??[])]);
    const uploadAttachment=jest.fn(async(...args:unknown[])=>{
      const contact=String(args[3]),name=String(args[4]),list=files.get(contact)??[];
      const existing=list.find(f=>f.fileName===name);if(existing)return existing;
      if(list.length>=10)throw new ConflictException({errorCode:'student_document_storage_full'});
      await (args[8] as ()=>Promise<void>)();
      const result={attachmentId:randomUUID(),fileName:name,mimeType:String(args[5]),sizeBytes:(args[6] as Buffer).length};
      files.set(contact,[...list,result]);return result;
    });
    const xero={ensureStudentContact,documentContactAttachments,uploadAttachment};
    const docs=new StudentOperationsCaseDocumentsService({tenantTransaction:transaction,tenantReadTransaction:transaction} as DatabaseService,service,xero as unknown as XeroConnectorService);
    return {xero,files,references,docs};
  }
  const pdf={buffer:Buffer.from('%PDF-1.7\nExample\n%%EOF'),originalname:'case.pdf',mimetype:'application/pdf'};
  async function overflowStudent(name:string) {
    const value=await service.createStudent(p,{studentName:name,studentEmail:`${name.toLowerCase().replaceAll(' ','-')}@example.test`},`overflow-${name.replaceAll(' ','-')}`);
    return service.get(p,String(value.caseId));
  }
  const enableCreation=()=>{const old=process.env.XERO_CONTACT_CREATION_ENABLED;process.env.XERO_CONTACT_CREATION_ENABLED='true';return ()=>{if(old===undefined)delete process.env.XERO_CONTACT_CREATION_ENABLED;else process.env.XERO_CONTACT_CREATION_ENABLED=old;};};
  test('25 files across three cases automatically use three Contacts without changing billing identity',async()=>{
    const restore=enableCreation();try {
      const student=await overflowStudent('Many Documents'),mock=provider(),type=(await types.list(p)).types[0];
      const two=await service.create(p,{userId:student.userId},'overflow-many-case2'),three=await service.create(p,{userId:student.userId},'overflow-many-case3');
      const cases=[student.caseId,String(two.caseId),String(three.caseId)];
      for(let n=0;n<25;n++)await mock.docs.upload(p,cases[n%3],{documentTypeId:type.documentTypeId},pdf,`overflow-many-file-${n}`);
      expect([...mock.files.values()].map(f=>f.length).sort((a,b)=>b-a)).toEqual([10,10,5]);
      expect(mock.references.size).toBe(3);
      const primary=(await pool.query('SELECT xero_contact_id FROM sophia_runtime.student_operations_primary_xero_contacts WHERE student_id=$1',[student.studentId])).rows[0].xero_contact_id;
      expect(primary).toBe(mock.references.get(`sophia:${student.studentId}`));
      expect((await mock.docs.list(p,cases[0],{})).total).toBe(9);expect((await mock.docs.list(p,cases[1],{})).total).toBe(8);expect((await mock.docs.list(p,cases[2],{})).total).toBe(8);
      expect((await service.invoices(p,student.caseId,{})).total).toBe(0);
      const foreign=await transaction('88888888-8888-4888-8888-888888888888',db=>db.query('SELECT * FROM sophia_runtime.student_operations_document_contacts'));
      expect(foreign.rowCount).toBe(0);
      await expect(transaction(tenant,db=>db.query('DELETE FROM sophia_runtime.student_operations_document_contacts'))).rejects.toThrow('permission denied');
    } finally {restore();}
  });
  test('reuses free space on historical linked Contacts before creating overflow',async()=>{
    const student=await overflowStudent('Legacy Capacity'),mock=provider(),type=(await types.list(p)).types[0],primary=randomUUID(),legacy=randomUUID();
    for(const [id,date]of [[primary,'2026-10-24'],[legacy,'2020-01-01']]) {
      await pool.query(`INSERT INTO sophia_runtime.student_operations_xero_contacts VALUES($1,$2,$3,'ACTIVE','Legacy Capacity',NULL,now())`,[tenant,connection,id]);
      await pool.query(`INSERT INTO sophia_runtime.student_operations_xero_invoices(customer_id,xero_connection_id,xero_invoice_id,xero_contact_id,student_id,invoice_type,invoice_status,invoice_date) VALUES($1,$2,$3,$3,$4,'ACCREC','PAID',$5)`,[tenant,connection,id,student.studentReference,date]);
    }
    mock.files.set(primary,Array.from({length:10},(_,n)=>({attachmentId:randomUUID(),fileName:`old-${n}.pdf`,mimeType:'application/pdf',sizeBytes:1})));
    await mock.docs.upload(p,student.caseId,{documentTypeId:type.documentTypeId},pdf,'overflow-legacy-upload');
    expect(mock.xero.uploadAttachment.mock.calls[0][3]).toBe(legacy);expect(mock.xero.ensureStudentContact).not.toHaveBeenCalled();
    expect((await pool.query('SELECT xero_contact_id FROM sophia_runtime.student_operations_primary_xero_contacts WHERE student_id=$1',[student.studentId])).rows[0].xero_contact_id).toBe(primary);
  });
  test('concurrent cases reserve the last slot once and route the other upload to one overflow Contact',async()=>{
    const restore=enableCreation();try {
      const student=await overflowStudent('Concurrent Capacity'),mock=provider(),type=(await types.list(p)).types[0];
      await mock.docs.upload(p,student.caseId,{documentTypeId:type.documentTypeId},pdf,'overflow-concurrent-initial');
      const primary=mock.references.get(`sophia:${student.studentId}`)!;
      mock.files.set(primary,[...mock.files.get(primary)!,...Array.from({length:8},(_,n)=>({attachmentId:randomUUID(),fileName:`old-${n}.pdf`,mimeType:'application/pdf',sizeBytes:1}))]);
      const second=String((await service.create(p,{userId:student.userId},'overflow-concurrent-case2')).caseId);
      await Promise.all([mock.docs.upload(p,student.caseId,{documentTypeId:type.documentTypeId},pdf,'overflow-concurrent-a'),mock.docs.upload(p,second,{documentTypeId:type.documentTypeId},pdf,'overflow-concurrent-b')]);
      expect([...mock.files.values()].map(f=>f.length).sort((a,b)=>b-a)).toEqual([10,1]);expect(mock.references.size).toBe(2);
    } finally {restore();}
  });
  test('a capacity race before PUT reroutes safely; a timeout after PUT stays pinned and recovers',async()=>{
    const restore=enableCreation();try {
      const student=await overflowStudent('Capacity Recovery'),mock=provider(),type=(await types.list(p)).types[0];
      const normal=mock.xero.uploadAttachment.getMockImplementation()!;
      mock.xero.uploadAttachment.mockImplementationOnce(async()=>{throw new ConflictException({errorCode:'student_document_storage_full'});});
      await mock.docs.upload(p,student.caseId,{documentTypeId:type.documentTypeId},pdf,'overflow-race-file');
      expect(mock.references.size).toBe(2);expect([...mock.files.values()].flat()).toHaveLength(1);
      mock.xero.uploadAttachment.mockImplementationOnce(async(...args:unknown[])=>{await normal(...args);throw new Error('Unknown provider result');});
      await expect(mock.docs.upload(p,student.caseId,{documentTypeId:type.documentTypeId},pdf,'overflow-unknown-file')).rejects.toThrow('Unknown provider');
      const before=(await pool.query("SELECT source_id,destination_state FROM sophia_runtime.student_operations_document_uploads WHERE idempotency_key='overflow-unknown-file'")).rows[0];
      expect(before.destination_state).toBe('attempted');
      await pool.query("UPDATE sophia_runtime.student_operations_document_uploads SET lease_expires_at=now()-interval '1 second' WHERE idempotency_key='overflow-unknown-file'");
      await mock.docs.upload(p,student.caseId,{documentTypeId:type.documentTypeId},pdf,'overflow-unknown-file');
      expect((await pool.query("SELECT source_id FROM sophia_runtime.student_operations_document_uploads WHERE idempotency_key='overflow-unknown-file'")).rows[0].source_id).toBe(before.source_id);
      expect([...mock.files.values()].flat()).toHaveLength(2);expect(mock.references.size).toBe(2);
    } finally {restore();}
  });
  test('an uncertain overflow creation reuses the same durable intent and external reference',async()=>{
    const restore=enableCreation();try {
      const student=await overflowStudent('Overflow Provision Recovery'),mock=provider(),type=(await types.list(p)).types[0];
      const resolver=new StudentPrimaryXeroContact({tenantTransaction:transaction,tenantReadTransaction:transaction} as DatabaseService,service,mock.xero as unknown as XeroConnectorService);
      const primary=await resolver.ensure(p,student.caseId);
      mock.files.set(primary.source_id,Array.from({length:10},(_,n)=>({attachmentId:randomUUID(),fileName:`existing-${n}.pdf`,mimeType:'application/pdf',sizeBytes:1})));
      const create=mock.xero.ensureStudentContact.getMockImplementation()!;
      mock.xero.ensureStudentContact.mockImplementationOnce(async(...args)=>{await create(...args);throw new Error('Contact creation timeout');});
      await expect(mock.docs.upload(p,student.caseId,{documentTypeId:type.documentTypeId},pdf,'overflow-create-timeout')).rejects.toThrow('Contact creation timeout');
      const first=mock.xero.ensureStudentContact.mock.calls.at(-1)!;
      await pool.query(`UPDATE sophia_runtime.student_operations_document_contacts SET lease_expires_at=now()-interval '1 second' WHERE student_id=$1 AND kind='overflow'`,[student.studentId]);
      await pool.query("UPDATE sophia_runtime.student_operations_document_uploads SET lease_expires_at=now()-interval '1 second' WHERE idempotency_key='overflow-create-timeout'");
      await mock.docs.upload(p,student.caseId,{documentTypeId:type.documentTypeId},pdf,'overflow-create-timeout');
      expect(mock.xero.ensureStudentContact.mock.calls.at(-1)).toEqual(first);expect(mock.references.size).toBe(2);
      expect((await pool.query("SELECT sequence_number FROM sophia_runtime.student_operations_document_contacts WHERE student_id=$1 AND kind='overflow'",[student.studentId])).rows).toEqual([{sequence_number:2}]);
    } finally {restore();}
  });
  test('checklist is case-scoped, versioned, idempotent and logs completion once with the actor',checklists);
  test('status document requirements reuse existing types, are extensible and track whole-case typed uploads',async()=>{
    const restore=enableCreation();try {
    const requirements=(await types.requirements(p,{status:'pre_sale'})).requirements;
    expect(requirements.map(r=>r.name)).toEqual(['Engagement letter','letter of offer','Passport']);
    expect(requirements.every(r=>r.required&&r.available&&!r.uploaded)).toBe(true);
    expect((await types.list(p)).types.filter(t=>t.name.toLowerCase()==='letter of offer')).toHaveLength(1);
    expect((await types.list(p)).types.find(t=>t.name==='letter of offer')!.required).toBe(false);
    const created=await service.createStudent(p,{studentName:'Requirements Student',studentEmail:'requirements@example.test'},'requirements-student');
    const id=String(created.caseId),mock=provider(),passport=requirements.find(r=>r.requirementKey==='passport')!;
    let state=await mock.docs.list(p,id,{});expect(state.documents).toHaveLength(0);expect(state.requirements).toHaveLength(3);
    await mock.docs.upload(p,id,{documentTypeId:passport.documentTypeId},pdf,'requirements-passport');
    state=await mock.docs.list(p,id,{page:2,limit:1});
    expect(state.documents).toHaveLength(0);expect(state.requirements.find(r=>r.requirementKey==='passport')!.uploaded).toBe(true);
    const other=String((await service.create(p,{userId:(await service.get(p,id)).userId},'requirements-other-case')).caseId);
    expect((await mock.docs.list(p,other,{})).requirements.every(r=>!r.uploaded)).toBe(true);
    const extra=await types.create(p,{name:'Bank statement',required:false},'requirements-extra-type');
    await transaction(tenant,db=>db.query(`INSERT INTO sophia_runtime.student_operations_status_document_requirements(customer_id,case_status,requirement_key,document_type_id,sort_order) VALUES($1,'on_hold','bank_statement',$2,1)`,[tenant,extra.documentTypeId]));
    expect((await types.requirements(p,{status:'on_hold'})).requirements.map(r=>r.name)).toEqual(['Bank statement']);
    expect((await types.requirements({...p,tenantId:'88888888-8888-4888-8888-888888888888'},{status:'on_hold'})).requirements).toHaveLength(0);
    expect((await types.requirements({...p,tenantId:'88888888-8888-4888-8888-888888888888'},{status:'pre_sale'})).requirements.every(r=>r.documentTypeId===null)).toBe(true);
    await expect(types.requirements(p,{status:'pre_sale',companyId:company})).rejects.toThrow('valid case status');
    await expect(transaction(tenant,db=>db.query('DELETE FROM sophia_runtime.student_operations_status_document_requirements'))).rejects.toThrow('permission denied');
    const passportType=(await types.list(p)).types.find(t=>t.documentTypeId===passport.documentTypeId)!;
    await types.update(p,passport.documentTypeId,{status:'archived',recordVersion:passportType.recordVersion},'requirements-archive-type');
    expect((await types.requirements(p,{status:'pre_sale'})).requirements.find(r=>r.requirementKey==='passport')!.available).toBe(false);
    await transaction(tenant,db=>db.query('SELECT sophia_runtime.initialize_student_document_requirements($1)',[company]));
    expect((await types.list(p)).types.some(t=>t.name==='Passport')).toBe(false);
    expect((await mock.docs.list(p,id,{})).requirements.find(r=>r.requirementKey==='passport')!.uploaded).toBe(true);
    }finally{restore();}
  });
  test('new companies preview read-only defaults and initialize their own types without elevated grants',async()=>{
    const otherTenant=randomUUID(),otherCompany=randomUUID(),principal={...p,tenantId:otherTenant,externalCompanyId:otherCompany};
    await pool.query(`INSERT INTO sophia_runtime.customers VALUES($1,$2,'active')`,[otherTenant,otherCompany]);
    await pool.query(`INSERT INTO public.bm_company VALUES($1,'student_operations')`,[otherCompany]);
    const preview=(await types.requirements(principal,{status:'pre_sale'})).requirements;
    expect(preview).toHaveLength(3);expect(preview.every(r=>r.documentTypeId===null&&!r.available)).toBe(true);
    expect((await types.list(principal)).types).toHaveLength(0);
    await expect(transaction(otherTenant,db=>db.query('SELECT sophia_runtime.initialize_student_document_requirements($1)',[company]))).rejects.toThrow(/scope mismatch|foreign key/);
    await transaction(otherTenant,db=>db.query('SELECT sophia_runtime.initialize_student_document_requirements($1)',[otherCompany]));
    await transaction(otherTenant,db=>db.query('SELECT sophia_runtime.initialize_student_document_requirements($1)',[otherCompany]));
    expect((await types.list(principal)).types).toHaveLength(3);
    expect((await types.requirements(principal,{status:'pre_sale'})).requirements.every(r=>r.available&&r.documentTypeId)).toBe(true);
    await transaction(otherTenant,db=>db.query(`UPDATE sophia_runtime.student_operations_status_document_requirements SET status='archived' WHERE requirement_key='passport'`));
    await transaction(otherTenant,db=>db.query('SELECT sophia_runtime.initialize_student_document_requirements($1)',[otherCompany]));
    expect((await types.requirements(principal,{status:'pre_sale'})).requirements).toHaveLength(2);
    await expect(transaction(otherTenant,db=>db.query('SELECT * FROM sophia_runtime.customers'))).rejects.toThrow('permission denied');
    await expect(transaction(otherTenant,db=>db.query('DELETE FROM sophia_runtime.student_operations_document_requirement_defaults'))).rejects.toThrow('permission denied');
  });
  test('analysis queue deduplicates, fences expired leases, retries and retains immutable scoped evidence',analysisQueueTest);
  test('upload through analysis and audited review/retry respects permissions and optimistic versions',async()=>{
    const restore=enableCreation(),old=process.env.STUDENT_DOCUMENT_ANALYSIS_ENABLED;
    process.env.STUDENT_DOCUMENT_ANALYSIS_ENABLED='true';
    try{
      const student=await overflowStudent('Workflow Analysis'),mock=provider();
      const db={tenantTransaction:transaction,tenantReadTransaction:transaction} as DatabaseService;
      const analysis=new StudentDocumentAnalysisService(db,service);
      const type=(await types.requirements(p,{status:'pre_sale'})).requirements.find(r=>r.requirementKey==='engagement_letter')!;
      const uploaded=await mock.docs.upload(p,student.caseId,{documentTypeId:type.documentTypeId},pdf,'analysis-upload-trigger');
      expect(await mock.docs.upload(p,student.caseId,{documentTypeId:type.documentTypeId},pdf,'analysis-upload-trigger')).toEqual(uploaded);
      const documentId=String(uploaded.documentId);
      expect((await mock.docs.list(p,student.caseId,{})).documents[0].analysisStatus).toBe('checking');
      expect((await analysis.get(p,student.caseId,documentId)).status).toBe('checking');
      const extraction={kind:'engagement_letter' as const,studentName:'Workflow Analysis',evidence:[{page:4,quote:'Signed and completed'}],issues:[],status:'signed',signerName:'Workflow Analysis',signedAt:'2026-09-15T02:59:31Z',completed:true,documentIdMatches:true};
      const worker=new StudentDocumentAnalysisWorker(db,{attachmentContent:async()=>pdf.buffer} as unknown as XeroConnectorService,{extract:async()=>({extraction,provider:'fixture',model:'fixture',inputTokens:10,outputTokens:20})});
      expect(await worker.processOne(tenant)).toBe(true);
      const checked=await analysis.get(p,student.caseId,documentId);
      expect(checked.status).toBe('passed');expect(checked.resultId).toBeTruthy();
      const listed=await mock.docs.list(p,student.caseId,{});
      expect(listed.documents[0].analysisStatus).toBe('passed');expect(JSON.stringify(listed)).not.toContain('Signed and completed');
      const payload={resultId:checked.resultId,expectedReviewVersion:0,decision:'rejected',reason:'Please replace the file',corrections:null};
      await expect(analysis.review({...p,role:'advisor'},student.caseId,documentId,payload,'analysis-advisor-denied')).rejects.toThrow();
      await expect(analysis.get({...p,tenantId:'88888888-8888-4888-8888-888888888888'},student.caseId,documentId)).rejects.toThrow('not found');
      expect(await analysis.review(p,student.caseId,documentId,payload,'analysis-review-reject')).toEqual({saved:true});
      expect(await analysis.review(p,student.caseId,documentId,payload,'analysis-review-reject')).toEqual({saved:true});
      expect((await analysis.get(p,student.caseId,documentId)).status).toBe('invalid');
      await expect(analysis.review(p,student.caseId,documentId,payload,'analysis-review-stale')).rejects.toThrow('changed');
      await analysis.review(p,student.caseId,documentId,{...payload,expectedReviewVersion:1,decision:'confirmed',reason:'Original checked'},'analysis-review-confirm');
      expect((await analysis.get(p,student.caseId,documentId)).status).toBe('passed');
      const activity=await service.activities(p,student.caseId,{});
      expect(activity.activity.filter(a=>a.eventType==='case.document_reviewed')).toHaveLength(2);
      expect(activity.activity.find(a=>a.eventType==='case.document_checked')?.actorName).toBe('SophiaAi');
      // A failed check retries the same saved document, without an additional Xero upload.
      const second=await mock.docs.upload(p,student.caseId,{documentTypeId:type.documentTypeId},pdf,'analysis-upload-failure');
      const queue=new StudentDocumentAnalysisQueue(db),lease=(await queue.claim(tenant))!;
      await queue.fail(tenant,lease.jobId,lease.leaseToken,'provider_unavailable',false);
      expect((await analysis.get(p,student.caseId,String(second.documentId))).status).toBe('check_failed');
      const calls=mock.xero.uploadAttachment.mock.calls.length;
      await analysis.retry(p,student.caseId,String(second.documentId),{jobId:lease.jobId},'analysis-retry-same-file');
      expect(mock.xero.uploadAttachment).toHaveBeenCalledTimes(calls);
      expect((await analysis.get(p,student.caseId,String(second.documentId))).status).toBe('checking');
    }finally{restore();if(old===undefined)delete process.env.STUDENT_DOCUMENT_ANALYSIS_ENABLED;else process.env.STUDENT_DOCUMENT_ANALYSIS_ENABLED=old;}
  });
});
