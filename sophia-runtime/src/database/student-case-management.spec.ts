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
import {StudentInvoiceProjectionRecovery} from '../business-packs/student-operations/student-invoice-projection-recovery.js';
import { publishXeroContact } from '../business-packs/student-operations/student-xero-contact-projection.js';
import { ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { XeroAttachment } from '../connectors/xero/xero.client.js';
import { enqueueDocumentAnalysis, StudentDocumentAnalysisQueue } from '../business-packs/student-operations/student-document-analysis.queue.js';
import { StudentDocumentAnalysisService } from '../business-packs/student-operations/student-document-analysis.service.js';
import { StudentDocumentAnalysisWorker } from '../business-packs/student-operations/student-document-analysis.worker.js';
import { reconcileDocumentChecklist,StudentDocumentChecklistReconciler } from '../business-packs/student-operations/student-document-checklist.js';
import type { DocumentExtraction } from '../business-packs/student-operations/student-document-analysis.contracts.js';
import { StudentCaseInvoiceDraftsService } from '../business-packs/student-operations/student-case-invoice-drafts.js';
import {invoiceDraftXeroValue} from '../business-packs/student-operations/student-case-invoice-matching.js';
import { StudentXeroSalesCatalogueSync } from '../business-packs/student-operations/student-xero-sales-catalogue.js';
import { StudentOperationsXeroSyncService } from '../business-packs/student-operations/student-operations-xero-sync.service.js';

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
      CREATE UNIQUE INDEX users_company_student_identity ON public.users(company_id,student_id);
      CREATE TABLE public.bm_xero_student_identities(customer_id uuid REFERENCES sophia_runtime.customers(customer_id),company_id uuid,student_id text,
        PRIMARY KEY(customer_id,student_id),FOREIGN KEY(company_id,student_id) REFERENCES public.users(company_id,student_id));
      CREATE TABLE public.bm_colleges(college_id uuid PRIMARY KEY,company_id uuid,college_name text,status text);
      CREATE TABLE public.bm_xero_student_contact_links(customer_id uuid,connection_id uuid,contact_id uuid,student_id text);
      CREATE TABLE sophia_runtime.business_pack_entitlements(customer_id uuid,identity_user_id text,pack_id text,status text,role_key text);
      CREATE TABLE sophia_runtime.student_operations_students(student_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),customer_id uuid,student_reference text,legal_name text,email text,updated_at timestamptz DEFAULT now(),UNIQUE(student_id,customer_id),UNIQUE(customer_id,student_reference));
      CREATE TABLE sophia_runtime.xero_connections(xero_connection_id uuid PRIMARY KEY,customer_id uuid,status text DEFAULT 'active',UNIQUE(xero_connection_id,customer_id));
      CREATE TABLE sophia_runtime.student_operations_xero_sync_configurations(customer_id uuid,xero_connection_id uuid,organisation_role text);
      CREATE TABLE sophia_runtime.student_operations_xero_contacts(customer_id uuid,xero_connection_id uuid,xero_contact_id uuid,contact_status text,legal_name text,contact_number text,provider_updated_at timestamptz,
        email text,account_number text,last_seen_sync_run_id uuid NOT NULL,PRIMARY KEY(customer_id,xero_connection_id,xero_contact_id));
      GRANT SELECT ON sophia_runtime.xero_connections,sophia_runtime.student_operations_xero_sync_configurations,sophia_runtime.student_operations_xero_contacts TO sophia_runtime_app;
      CREATE TABLE sophia_runtime.student_operations_xero_invoices(customer_id uuid,xero_connection_id uuid,xero_invoice_id uuid,xero_contact_id uuid,student_id text,invoice_number text,invoice_type text,invoice_status text,invoice_date date,due_date date,advisor_name text,invoice_reference text,college_name text,payment_track text,total numeric,amount_paid numeric,amount_due numeric,currency_code text,
        sent_to_contact boolean NOT NULL DEFAULT false,line_items jsonb NOT NULL DEFAULT '[]',concept text,provider_updated_at timestamptz,last_seen_sync_run_id uuid,updated_at timestamptz DEFAULT now(),PRIMARY KEY(customer_id,xero_connection_id,xero_invoice_id),
        FOREIGN KEY(customer_id,student_id) REFERENCES public.bm_xero_student_identities(customer_id,student_id));
      GRANT SELECT, INSERT, UPDATE ON sophia_runtime.student_operations_xero_invoices TO sophia_runtime_app;
      CREATE TABLE sophia_runtime.student_operations_xero_sync_runs(customer_id uuid,sync_run_id uuid,lease_owner uuid,lease_expires_at timestamptz,status text,invoice_count int);
      GRANT SELECT, UPDATE ON sophia_runtime.student_operations_xero_sync_runs TO sophia_runtime_app;
    `);
    for(const name of ['064_student_operations_student_writes.sql','065_student_operations_write_least_privilege.sql','069_student_case_foundation.sql','070_student_register_advisor_projection.sql','071_student_case_management.sql','072_student_case_contact_projection.sql','073_student_case_workflow.sql','074_student_case_profile_edit.sql','075_student_advisor_directory.sql','087_student_account_case_creation.sql']) {
      await pool.query((await readFile(new URL(`./migrations/${name}`,import.meta.url),'utf8')).replaceAll('__SOPHIA_RUNTIME_SCHEMA__','sophia_runtime'));
    }
    await pool.query((await readFile(new URL('./migrations/103_xero_immediate_contact_projection.sql',import.meta.url),'utf8')).replaceAll('__SOPHIA_RUNTIME_SCHEMA__','sophia_runtime'));
    await pool.query(`INSERT INTO sophia_runtime.customers VALUES($1,$2,'active')`,[tenant,company]);
    await pool.query(`INSERT INTO public.bm_company VALUES($1,'student_operations')`,[company]);
    await pool.query(`INSERT INTO public.users(id,company_id,student_id,name,email,cel,tel,type,status) VALUES($1,$2,'STD-1','Example Student','student@example.test','0412 345 678','07 3333 4444','student','active'),($3,$2,NULL,'Advisor One','advisor@example.test',NULL,NULL,'advisor','active')`,[user,company,advisor]);
    await pool.query(`INSERT INTO public.bm_xero_student_identities VALUES($1,$2,'STD-1')`,[tenant,company]);
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
    await pool.query('ALTER TABLE public.bm_colleges ADD COLUMN abn text');
    await pool.query((await readFile(new URL('./migrations/096_student_offer_review.sql',import.meta.url),'utf8')).replaceAll('__SOPHIA_RUNTIME_SCHEMA__','sophia_runtime'));
    await pool.query((await readFile(new URL('./migrations/097_student_document_checklist.sql',import.meta.url),'utf8')).replaceAll('__SOPHIA_RUNTIME_SCHEMA__','sophia_runtime'));
    await pool.query((await readFile(new URL('./migrations/098_student_verified_document_workflow.sql',import.meta.url),'utf8')).replaceAll('__SOPHIA_RUNTIME_SCHEMA__','sophia_runtime'));
    await pool.query((await readFile(new URL('./migrations/099_student_xero_sales_catalogue.sql',import.meta.url),'utf8')).replaceAll('__SOPHIA_RUNTIME_SCHEMA__','sophia_runtime'));
    await pool.query((await readFile(new URL('./migrations/100_student_xero_invoice_exports.sql',import.meta.url),'utf8')).replaceAll('__SOPHIA_RUNTIME_SCHEMA__','sophia_runtime'));
    await pool.query((await readFile(new URL('./migrations/101_student_editable_invoice_drafts.sql',import.meta.url),'utf8')).replaceAll('__SOPHIA_RUNTIME_SCHEMA__','sophia_runtime'));
    await pool.query((await readFile(new URL('./migrations/102_xero_immediate_invoice_projection.sql',import.meta.url),'utf8')).replaceAll('__SOPHIA_RUNTIME_SCHEMA__','sophia_runtime'));
    await pool.query('GRANT INSERT, UPDATE ON sophia_runtime.student_operations_xero_contacts TO sophia_runtime_app');
    for(const name of ['104_student_invoice_projection_identity.sql','105_event_driven_invoice_checklist.sql','106_payment_monitoring_case_statuses.sql'])await pool.query((await readFile(new URL(`./migrations/${name}`,import.meta.url),'utf8')).replaceAll('__SOPHIA_RUNTIME_SCHEMA__','sophia_runtime'));
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
    const offerId=String((await transaction(tenant,db=>db.query(`SELECT offer_id FROM sophia_runtime.student_case_offers
      WHERE customer_id=$1 AND result_id=$2`,[tenant,offerResult]))).rows[0].offer_id);
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
    await service.update(p,id,{recordVersion:1,status:'payment_received',currentStage:'payment_monitoring'},'checklist-leave-presale');
    expect(await service.get(p,id)).toMatchObject({status:'payment_received',currentStage:'payment_monitoring'});
    await service.update(p,id,{recordVersion:(await service.get(p,id)).recordVersion,status:'awaiting_payment',currentStage:'payment_monitoring'},'checklist-monitor-awaiting');
    expect(await service.get(p,id)).toMatchObject({status:'awaiting_payment',currentStage:'payment_monitoring'});
    await expect(transaction(tenant,db=>db.query(`UPDATE sophia_runtime.student_operations_cases SET lifecycle_status='open',current_stage='payment_received' WHERE customer_id=$1 AND case_id=$2`,[tenant,id]))).rejects.toThrow('check constraint');
    await expect(transaction(tenant,db=>db.query(`UPDATE sophia_runtime.student_operations_cases SET lifecycle_status='open',current_stage='invoices_created' WHERE customer_id=$1 AND case_id=$2`,[tenant,id]))).rejects.toThrow('check constraint');
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
    expect(await service.invoiceDetail(p,detail.caseId,connection,invoice)).toMatchObject({invoiceNumber:'INV-1',status:'PAID',lineItems:[]});
    expect(await service.invoiceDetail(p,detail.caseId,null,invoice)).toMatchObject({invoiceNumber:'INV-1',status:'PAID',lineItems:[]});
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
    await transaction(tenant,db=>db.query('SELECT sophia_runtime.ensure_case_xero_student_identity($1)',[detail.caseId]));
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
      const xero={documentContactAttachments:jest.fn(async()=>[]),ensureStudentContact:jest.fn(async()=>({contactId:contact,status:'ACTIVE',legalName:'No Invoices',email:'no-invoices@example.test',contactNumber:`sophia:${detail.studentId}`,accountNumber:null,updatedAt:null})),uploadAttachment:jest.fn(async()=>({attachmentId:college}))};
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
      expect((await transaction(tenant,db=>db.query('SELECT contact_status,last_seen_sync_run_id FROM sophia_runtime.student_operations_xero_contacts WHERE xero_contact_id=$1',[contact]))).rows).toEqual([{contact_status:'ACTIVE',last_seen_sync_run_id:null}]);
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
  test('interactive contact publication cannot reactivate a contact archived by sync',async()=>{
    const contactId=randomUUID();
    await pool.query(`INSERT INTO sophia_runtime.student_operations_xero_contacts VALUES($1,$2,$3,'ARCHIVED','Provider-newer Name',NULL,now())`,[tenant,connection,contactId]);
    await transaction(tenant,db=>publishXeroContact(db,tenant,connection,{contactId,status:'ACTIVE',legalName:'Earlier response',email:null,contactNumber:null,accountNumber:null,updatedAt:null}));
    expect((await pool.query('SELECT contact_status,legal_name FROM sophia_runtime.student_operations_xero_contacts WHERE xero_contact_id=$1',[contactId])).rows).toEqual([{contact_status:'ARCHIVED',legal_name:'Provider-newer Name'}]);
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
      return {contactId:references.get(v.contactNumber)!,status:'ACTIVE',legalName:v.name,email:v.email,contactNumber:v.contactNumber,accountNumber:null,updatedAt:null};
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
    await transaction(tenant,db=>db.query('SELECT sophia_runtime.ensure_case_xero_student_identity($1)',[student.caseId]));
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
  test('document checklist uses latest accepted evidence, audits transitions, reopens on expiry/replacement and stays tenant scoped',async()=>{
    const keys=['STUDENT_DOCUMENT_CHECKLIST_ENABLED','STUDENT_DOCUMENT_ANALYSIS_ENABLED','STUDENT_OFFER_ANALYSIS_ENABLED'],previous=keys.map(k=>process.env[k]);
    keys.forEach(k=>process.env[k]='true');
    const passportType=(await transaction(tenant,db=>db.query(`UPDATE sophia_runtime.student_operations_document_types SET status='active' WHERE customer_id=$1 AND name='Passport' RETURNING document_type_id`,[tenant]))).rows[0].document_type_id;
    try{
      const id=String((await service.createStudent(p,{studentName:'Automation Student',studentEmail:'automation@example.test'},'automation-student')).caseId);
      const database={tenantTransaction:transaction,tenantReadTransaction:transaction} as DatabaseService,queue=new StudentDocumentAnalysisQueue(database),analysis=new StudentDocumentAnalysisService(database,service);
      const requirements=(await types.requirements(p,{status:'pre_sale'})).requirements;
      const add=async(kind:DocumentExtraction['kind'])=>transaction(tenant,async db=>{
        await service.authorizedCase(db,p,id,true);
        const type=requirements.find(r=>r.requirementKey===kind)!.documentTypeId;
        const document=(await db.query(`INSERT INTO sophia_runtime.student_operations_case_documents(customer_id,case_id,xero_connection_id,source_kind,source_id,attachment_id,file_name,mime_type,size_bytes,document_type_id)
          VALUES($1,$2,$3,'Contacts',$4,$5,'fixture.pdf','application/pdf',100,$6) RETURNING document_id`,[tenant,id,connection,randomUUID(),randomUUID(),type])).rows[0].document_id;
        const job=await enqueueDocumentAnalysis(db,tenant,{caseId:id,documentId:document,kind,contentSha256:'d'.repeat(64),schemaVersion:kind==='letter_of_offer'?'3':'1'});
        const lease=randomUUID();await db.query(`UPDATE sophia_runtime.student_document_analysis_jobs SET status='processing',attempts=1,lease_token=$2,lease_expires_at=now()+interval '3 minutes' WHERE job_id=$1`,[job,lease]);
        await reconcileDocumentChecklist(db,tenant,id);
        return {document,job,lease};
      });
      const finish=async(file:Awaited<ReturnType<typeof add>>,extraction:DocumentExtraction)=>queue.complete(tenant,file.job,file.lease,{extraction,provider:'fixture',model:'fixture',inputTokens:1,outputTokens:1});
      const identity={studentName:'Automation Student',evidence:[{page:1,quote:'Synthetic evidence'}],issues:[]};
      const engagement:DocumentExtraction={...identity,kind:'engagement_letter',status:'signed',signerName:'Automation Student',signedAt:'2026-01-01T01:00:00Z',completed:true,documentIdMatches:true};
      const passport:DocumentExtraction={...identity,kind:'passport',expiresOn:'2030-01-01',mrzExpiryMatches:true};
      const offer:DocumentExtraction={...identity,kind:'letter_of_offer',collegeName:'York Business',abn:null,cricosProviderCode:null,currency:'AUD',statedTotalMinor:904000,
        courses:[{name:'English',code:null,startsOn:null,endsOn:null,duration:'60 weeks'}],fees:[{label:'Total',amountMinor:904000,conditional:false,condition:null}],
        instalments:[{sequence:1,dueTerm:'Immediately',dueOn:null,totalMinor:906500,includedConditionalFeeMinor:2500,components:[]}]};
      const first=await add('engagement_letter');await finish(first,engagement);
      let state=await service.checklist(p,id);expect(state.items[0]).toMatchObject({completed:true,automatic:true,updatedBy:'SophiaAi',validationState:'passed'});expect(state.items[1]).toMatchObject({completed:false,validationState:'missing'});
      await expect(service.updateChecklist(p,id,{itemKey:'document_completeness',completed:true,recordVersion:0},'automation-spoof-complete')).rejects.toThrow('document checks');
      const pass=await add('passport');await finish(pass,passport);
      const loo=await add('letter_of_offer');await finish(loo,offer);
      expect((await service.checklist(p,id)).items[1]).toMatchObject({completed:false,validationState:'needs_review'}); // Presence/proposal is not approval.
      const checked=await analysis.get(p,id,loo.document);
      await analysis.review(p,id,loo.document,{resultId:checked.resultId,expectedReviewVersion:0,expectedCaseVersion:checked.offer!.caseRecordVersion,decision:'confirmed',reason:'All synthetic tables reviewed',corrections:null,collegeId:college},'automation-confirm-offer');
      state=await service.checklist(p,id);expect(state.items[1]).toMatchObject({completed:true,automatic:true,validationState:'passed'});
      for(const key of ['invoice_loo_consistency','pending_track_status']){
        const item=state.items.find(i=>i.key===key)!;state=await service.updateChecklist(p,id,{itemKey:key,completed:true,recordVersion:item.recordVersion},`automation-manual-${key}`);
      }
      const reconcile=async(today?:string)=>transaction(tenant,async db=>{await service.authorizedCase(db,p,id,true);await reconcileDocumentChecklist(db,tenant,id,today);});
      await Promise.all([reconcile(),reconcile()]);
      expect((await service.activities(p,id,{})).activity.filter(a=>a.eventType==='case.checklist_completed')).toHaveLength(1);
      await reconcile('2030-01-01');expect((await service.checklist(p,id)).items[1].completed).toBe(true);
      await reconcile('2030-01-02');state=await service.checklist(p,id);expect(state.items[1]).toMatchObject({completed:false,updatedBy:'SophiaAi'});
      expect(state.items.find(i=>i.key==='pending_track_status')!.completed).toBe(true);
      await reconcile(); // Restore current-date validity without another provider call.
      const replacement=await add('engagement_letter');expect((await service.checklist(p,id)).items[0]).toMatchObject({completed:false,validationState:'checking'});
      await finish(replacement,{...engagement,status:'viewed',completed:false});
      expect((await service.checklist(p,id)).items[0]).toMatchObject({completed:false,validationState:'needs_review'});
      await expect(analysis.review(p,id,first.document,{resultId:(await analysis.get(p,id,first.document)).resultId,expectedReviewVersion:0,decision:'confirmed',reason:'Old evidence',corrections:null},'automation-old-confirm')).rejects.toThrow('newer document');
      const pending=await add('engagement_letter'),newest=await add('engagement_letter');
      await finish(pending,engagement);expect((await service.checklist(p,id)).items[0].completed).toBe(false); // Late old result.
      await finish(newest,engagement);expect((await service.checklist(p,id)).items[0].completed).toBe(true);
      const replacedOffer=await add('letter_of_offer');
      state=await service.checklist(p,id);expect(state.items.find(i=>i.key==='invoice_loo_consistency')!.completed).toBe(false);
      expect((await transaction(tenant,db=>db.query(`SELECT offer_id FROM sophia_runtime.student_case_offers WHERE case_id=$1 AND is_current`,[id]))).rowCount).toBe(0);
      await finish(replacedOffer,offer);expect((await service.checklist(p,id)).items[1].completed).toBe(false);
      const activities=await service.activities(p,id,{limit:100});
      expect(activities.activity.some(a=>a.eventType==='case.checklist_reopened'&&a.actorName==='SophiaAi')).toBe(true);
      expect((await service.get(p,id)).status).toBe('pre_sale');expect((await service.get(p,id)).currentStage).toBe('documents_requested');
      const other='88888888-8888-4888-8888-888888888888';
      expect((await transaction(other,db=>db.query('SELECT * FROM sophia_runtime.student_document_checklist_evaluations'))).rowCount).toBe(0);
      await expect(transaction(tenant,db=>db.query('DELETE FROM sophia_runtime.student_document_checklist_evaluations'))).rejects.toThrow('permission denied');
      const batch=new StudentDocumentChecklistReconciler(database);await batch.processBatch(tenant);
      expect((await transaction(tenant,db=>db.query(`SELECT evidence FROM sophia_runtime.student_document_checklist_evaluations WHERE case_id=$1`,[id]))).rows[0].evidence).not.toEqual([]);
      // Actual upload finalization invokes the same invalidation atomically.
      const restoreUpload=enableCreation();try{
        const mock=provider(),type=requirements.find(r=>r.requirementKey==='engagement_letter')!.documentTypeId;
        const uploaded=await mock.docs.upload(p,id,{documentTypeId:type},pdf,'automation-real-replacement');
        expect((await service.checklist(p,id)).items[0].completed).toBe(false);
        const file=await transaction(tenant,async db=>{
          const lease=randomUUID();return (await db.query(`UPDATE sophia_runtime.student_document_analysis_jobs SET status='processing',attempts=1,lease_token=$2,lease_expires_at=now()+interval '3 minutes'
            WHERE document_id=$1 RETURNING document_id AS document,job_id AS job,lease_token AS lease`,[uploaded.documentId,lease])).rows[0];
        });
        await finish(file,engagement);expect((await service.checklist(p,id)).items[0].completed).toBe(true);
      }finally{restoreUpload();}
      await transaction(tenant,db=>db.query(`UPDATE sophia_runtime.student_operations_document_types SET status='archived' WHERE document_type_id=$1`,[requirements.find(r=>r.requirementKey==='engagement_letter')!.documentTypeId]));
      expect((await service.checklist(p,id)).items[0].completed).toBe(false); // Read guard before worker catches up.
      await reconcile();
      await transaction(tenant,db=>db.query(`UPDATE sophia_runtime.student_operations_document_types SET status='active' WHERE document_type_id=$1`,[requirements.find(r=>r.requirementKey==='engagement_letter')!.documentTypeId]));
      await reconcile();
      process.env.STUDENT_DOCUMENT_CHECKLIST_ENABLED='false';expect(await batch.processBatch(tenant)).toBe(false);
    }finally{
      keys.forEach((k,i)=>{if(previous[i]===undefined)delete process.env[k];else process.env[k]=previous[i];});
      await transaction(tenant,db=>db.query(`UPDATE sophia_runtime.student_operations_document_types SET status='archived' WHERE document_type_id=$1`,[passportType]));
    }
  });
  test('analysis queue deduplicates, fences expired leases, retries and retains immutable scoped evidence',analysisQueueTest);
  test('manual review controls document holds and prepares eight immutable tenant-scoped Sophia drafts without Xero writes',async()=>{
    const keys=['STUDENT_DOCUMENT_WORKFLOW_ENABLED','STUDENT_DOCUMENT_CHECKLIST_ENABLED','STUDENT_DOCUMENT_ANALYSIS_ENABLED','STUDENT_OFFER_ANALYSIS_ENABLED'],previous=keys.map(k=>process.env[k]);keys.forEach(k=>process.env[k]='true');
    try{
      await transaction(tenant,db=>db.query(`UPDATE sophia_runtime.student_operations_document_types SET status='active' WHERE customer_id=$1 AND name IN ('Passport','Engagement letter')`,[tenant]));
      const id=String((await service.createStudent(p,{studentName:'Workflow Fixture',studentEmail:'workflow-fixture@example.test'},'workflow-fixture-create')).caseId);
      const database={tenantTransaction:transaction,tenantReadTransaction:transaction} as DatabaseService,analysis=new StudentDocumentAnalysisService(database,service),createInvoice=jest.fn(async()=>({invoiceId:randomUUID(),invoiceNumber:`XERO-${createInvoice.mock.calls.length}`,status:'DRAFT',total:100})),
        invoiceCreationSession=async()=>({createInvoice,invoiceById:async()=>{throw new Error('Synthetic minimal provider response');}}),
        contactById=jest.fn(async(_tenant:string,_connection:string,contactId:string)=>({contactId,status:'ACTIVE',legalName:'Workflow Fixture',email:null,contactNumber:null,accountNumber:null,updatedAt:null})),
        drafts=new StudentCaseInvoiceDraftsService(database,service,{invoiceCreationSession,contactById} as unknown as XeroConnectorService),queue=new StudentDocumentAnalysisQueue(database);
      const requirements=(await types.requirements(p,{status:'pre_sale'})).requirements;
      const identity={studentName:'Workflow Fixture',evidence:[{page:1,quote:'Synthetic workflow evidence'}],issues:[]};
      const engagement:DocumentExtraction={...identity,kind:'engagement_letter',status:'signed',completed:true,signerName:'Workflow Fixture',signedAt:'2026-01-01T01:00:00Z',documentIdMatches:true};
      const add=async(extraction:DocumentExtraction)=>{
        const value=await transaction(tenant,async db=>{
          await service.authorizedCase(db,p,id,true);
          const type=requirements.find(r=>r.requirementKey===extraction.kind)!.documentTypeId;
          const document=(await db.query(`INSERT INTO sophia_runtime.student_operations_case_documents(customer_id,case_id,xero_connection_id,source_kind,source_id,attachment_id,file_name,mime_type,size_bytes,document_type_id)
            VALUES($1,$2,$3,'Contacts',$4,$5,'workflow-fixture.pdf','application/pdf',10,$6) RETURNING document_id`,[tenant,id,connection,randomUUID(),randomUUID(),type])).rows[0].document_id;
          const job=await enqueueDocumentAnalysis(db,tenant,{caseId:id,documentId:document,kind:extraction.kind,contentSha256:'e'.repeat(64),schemaVersion:extraction.kind==='letter_of_offer'?'3':'1'}),lease=randomUUID();
          await db.query(`UPDATE sophia_runtime.student_document_analysis_jobs SET status='processing',attempts=1,lease_token=$2,lease_expires_at=now()+interval '3 minutes' WHERE job_id=$1`,[job,lease]);
          await reconcileDocumentChecklist(db,tenant,id);return {document,job,lease};
        });
        await queue.complete(tenant,value.job,value.lease,{extraction,provider:'fixture',model:'fixture',inputTokens:1,outputTokens:1});return value.document;
      };
      const review=async(document:string,decision:'confirmed'|'rejected')=>{
        const state=await analysis.get(p,id,document);
        return analysis.review(p,id,document,{resultId:state.resultId,expectedReviewVersion:state.reviewVersion,decision,reason:'Synthetic manual review',corrections:null,...(state.offer?{collegeId:college,expectedCaseVersion:state.offer.caseRecordVersion}:{})},randomUUID());
      };
      const first=await add(engagement);expect((await analysis.get(p,id,first)).status).toBe('needs_review');
      await review(first,'rejected');expect(await service.get(p,id)).toMatchObject({status:'on_hold',currentStage:'documents_requested'});
      expect((await types.requirements(p,{status:'on_hold'})).requirements.map(r=>r.requirementKey)).toEqual(expect.arrayContaining(['engagement_letter','passport','letter_of_offer']));
      const docs=new StudentOperationsCaseDocumentsService(database,service,{} as XeroConnectorService);
      expect((await docs.list(p,id,{})).documents.find(d=>d.documentId===first)?.canReplace).toBe(true);
      const replacement=await add(engagement);expect((await service.get(p,id)).status).toBe('on_hold');
      await review(replacement,'confirmed');expect(await service.get(p,id)).toMatchObject({status:'pre_sale',currentStage:'documents_requested'});
      const passport=await add({...identity,kind:'passport',expiresOn:'2035-01-01',mrzExpiryMatches:true});await review(passport,'confirmed');
      const offer=await add({...identity,kind:'letter_of_offer',collegeName:'York Business',abn:null,cricosProviderCode:null,currency:'AUD',statedTotalMinor:80000,
        courses:[{name:'English',code:null,startsOn:null,endsOn:null,duration:'8 weeks'}],fees:[{label:'Tuition',amountMinor:80000,conditional:false,condition:null}],
        instalments:Array.from({length:8},(_,i)=>({sequence:i+1,dueOn:null,dueTerm:'Immediately',totalMinor:i===0?12500:10000,includedConditionalFeeMinor:i===0?2500:0,components:[{label:'Tuition',amountMinor:10000}]}))});
      await review(offer,'confirmed');expect(await service.get(p,id)).toMatchObject({status:'pre_sale',currentStage:'checklist_complete'});
      const itemId=randomUUID(),catalogue={items:[{itemId,code:'ELICOS ON-SHORE',name:'English',description:'Synthetic course',unitPrice:'100.0000',accountCode:'812',taxType:'BASEXCLUDED'}],accounts:[{code:'812',name:'Tuition fee',taxType:'BASEXCLUDED'}],taxRates:[{taxType:'BASEXCLUDED',name:'BAS Excluded',rate:'0'}]};
      let imports=0;const catalogueSync=new StudentXeroSalesCatalogueSync(database,{salesCatalogue:async()=>{imports++;return catalogue;}} as unknown as XeroConnectorService);
      const results=await Promise.all([catalogueSync.processOne(tenant),catalogueSync.processOne(tenant)]);expect(results.filter(Boolean)).toHaveLength(1);expect(imports).toBe(1);
      const preparation=(await drafts.list(p,id)).preparation!;expect(preparation.source.instalments).toHaveLength(8);expect(preparation.catalogue?.items[0].code).toBe('ELICOS ON-SHORE');
      const advisorId=(await pool.query(`INSERT INTO sophia_runtime.student_operations_advisor_directory(customer_id,code,name,xero_label) VALUES($1,'FIX15','Fixture Advisor','FIX15 Fixture Advisor') RETURNING advisor_id`,[tenant])).rows[0].advisor_id;
      const payload={offerId:preparation.offerId,offerVersion:preparation.offerVersion,caseVersion:preparation.caseVersion,advisorId,catalogueConnectionId:connection,catalogueRevision:preparation.catalogue!.revision,reviewNote:'',invoices:preparation.source.instalments.map(i=>({sequence:i.sequence,issueDate:'2026-10-26',dueDate:'2026-10-26',conditionalFeeApplies:false,conditionalFeeMinor:0,lines:[{kind:'tuition',description:'English tuition',itemId,itemCode:'ELICOS ON-SHORE',quantity:'1',unitPrice:'100.0000',amountMinor:10000,accountCode:'812',taxType:'BASEXCLUDED'}]}))};
      await expect(drafts.prepare(p,id,{...payload,catalogueRevision:999},randomUUID())).rejects.toThrow('catalogue changed');
      await expect(drafts.prepare(p,id,{...payload,invoices:payload.invoices.map(i=>({...i,lines:i.lines.map(l=>({...l,itemId:randomUUID()}))}))},randomUUID())).rejects.toThrow('available Xero item');
      const key=randomUUID(),[saved,replayed]=await Promise.all([drafts.prepare(p,id,payload,key),drafts.prepare(p,id,payload,key)]);expect(saved.count).toBe(8);
      // Idempotency stores the HTTP representation, which serializes pg dates.
      const wire=(value:unknown)=>JSON.parse(JSON.stringify(value));expect(wire(replayed)).toEqual(wire(saved));expect(wire(await drafts.prepare(p,id,payload,key))).toEqual(wire(saved));
      const revised={...payload,draftBatchId:saved.batchId,draftRevision:saved.revision,reviewNote:'Saved review note'},revisedResult=await drafts.prepare(p,id,revised,randomUUID());expect(revisedResult).toMatchObject({batchId:saved.batchId,count:8,updated:true,revision:2});
      const listedAfterSave=await drafts.list(p,id);expect(listedAfterSave.preparation?.savedBatch).toMatchObject({batchId:saved.batchId,advisorId});
      const batch=listedAfterSave.batches[0];expect(batch.snapshot.invoices).toHaveLength(8);expect(batch.snapshot.invoices.every((i:any)=>i.status==='DRAFT'&&i.paymentTrack==='PENDING'&&i.totalMinor===10000)).toBe(true);
      expect(batch.snapshot.invoices[0]).toMatchObject({invoiceNumber:'INV-1',sourceTotalMinor:12500,sourceIncludedConditionalFeeMinor:2500});
      const oldCreate=process.env.XERO_INVOICE_CREATION_ENABLED;process.env.XERO_INVOICE_CREATION_ENABLED='true';
      try{
        const target=randomUUID(),student=(await transaction(tenant,db=>db.query(`SELECT c.student_id,l.student_reference FROM sophia_runtime.student_operations_cases c
          JOIN sophia_runtime.student_operations_student_user_links l USING(customer_id,student_id) WHERE c.case_id=$1`,[id]))).rows[0];
        await transaction(tenant,db=>db.query(`INSERT INTO sophia_runtime.student_operations_primary_xero_contacts(customer_id,student_id,xero_connection_id,xero_contact_id,contact_number,contact_name,selection_method,linked_at) VALUES($1,$2,$3,$4,$5,'Workflow Fixture','external_reference',now())`,[tenant,student.student_id,connection,target,`sophia:${student.student_id}`]));
        // Exact production failure: a fresh student has no legacy sync identity.
        expect((await pool.query('SELECT 1 FROM public.bm_xero_student_identities WHERE customer_id=$1 AND student_id=$2',[tenant,student.student_reference])).rowCount).toBe(0);
        await expect(pool.query(`INSERT INTO sophia_runtime.student_operations_xero_invoices(customer_id,xero_connection_id,xero_invoice_id,xero_contact_id,student_id,invoice_type,invoice_status)
          VALUES($1,$2,$3,$4,$5,'ACCREC','DRAFT')`,[tenant,connection,randomUUID(),target,student.student_reference])).rejects.toMatchObject({code:'23503'});
        contactById.mockImplementationOnce(async()=>({contactId:target,status:'ARCHIVED',legalName:'Workflow Fixture',email:null,contactNumber:null,accountNumber:null,updatedAt:null}));
        await expect(drafts.createXero(p,id,batch.batchId,{sequences:[1],confirmed:true})).rejects.toThrow('not active');
        expect(createInvoice).not.toHaveBeenCalled();
        expect((await pool.query('SELECT 1 FROM sophia_runtime.student_case_xero_invoice_exports WHERE case_id=$1',[id])).rowCount).toBe(0);
        const firstCreated=await drafts.createXero(p,id,batch.batchId,{sequences:[1],confirmed:true});
        expect(contactById).toHaveBeenLastCalledWith(tenant,connection,target);
        expect((await pool.query('SELECT contact_status,last_seen_sync_run_id FROM sophia_runtime.student_operations_xero_contacts WHERE xero_contact_id=$1',[target])).rows).toEqual([{contact_status:'ACTIVE',last_seen_sync_run_id:null}]);
        expect(firstCreated).toMatchObject({created:1,skipped:0});expect(firstCreated.results[0].message).toBeUndefined();expect(createInvoice).toHaveBeenCalledTimes(1);
        expect((await pool.query('SELECT 1 FROM public.bm_xero_student_identities WHERE customer_id=$1 AND student_id=$2',[tenant,student.student_reference])).rowCount).toBe(1);
        await expect(transaction(tenant,db=>db.query('SELECT * FROM public.bm_xero_student_identities'))).rejects.toThrow('permission denied');
        await expect(transaction(randomUUID(),db=>db.query('SELECT sophia_runtime.ensure_case_xero_student_identity($1)',[id]))).rejects.toThrow('unavailable');
        const linked=await service.invoices(p,id,{});expect(linked.total).toBe(1);expect(linked.invoices.some(i=>i.invoiceNumber==='XERO-1')).toBe(true);
        const current={...revised,draftRevision:revisedResult.revision};
        const changedCreated={...current,invoices:current.invoices.map(invoice=>invoice.sequence===1?{...invoice,lines:invoice.lines.map(line=>({...line,description:'Changed after creation'}))}:invoice)};
        await expect(drafts.prepare(p,id,changedCreated,randomUUID())).rejects.toThrow('read-only');
        const changedUncreated={...current,invoices:current.invoices.map(invoice=>invoice.sequence===2?{...invoice,lines:invoice.lines.map(line=>({...line,description:'Editable before creation'}))}:invoice)};
        await expect(drafts.prepare(p,id,changedUncreated,randomUUID())).resolves.toMatchObject({batchId:batch.batchId,updated:true});
        expect(await drafts.createXero(p,id,batch.batchId,{sequences:[1,2,3,4,5,6,7,8],confirmed:true})).toMatchObject({created:7,skipped:1});expect(createInvoice).toHaveBeenCalledTimes(8);
        await drafts.createXero(p,id,batch.batchId,{sequences:[1],confirmed:true});expect(createInvoice).toHaveBeenCalledTimes(8);
        expect(contactById).toHaveBeenCalledTimes(2); // no provider contact reads after publication
        const refreshed=(await drafts.list(p,id)).batches[0];expect(refreshed.exports['1']).toMatchObject({status:'created'});
        // Receipts and indexed links represent the same eight invoices.
        const allCreated=await service.invoices(p,id,{});expect(allCreated.total).toBe(8);expect(allCreated.invoices).toHaveLength(8);
        expect(new Set(allCreated.invoices.map(i=>i.invoiceId)).size).toBe(8);
        // Recover already-created invoices with missing projections, without
        // ever re-sending them or waiting for a full nightly provider import.
        await pool.query('DELETE FROM sophia_runtime.student_operations_case_invoice_links WHERE customer_id=$1 AND case_id=$2',[tenant,id]);
        await pool.query('DELETE FROM sophia_runtime.student_operations_xero_invoices WHERE customer_id=$1 AND student_id=$2',[tenant,student.student_reference]);
        const invoiceById=jest.fn(async(_tenant:string,_connection:string,invoiceId:string)=>{
          const sequence=Number(Object.entries(refreshed.exports).find(([,value])=>value.invoiceId===invoiceId)![0]);
          const source=refreshed.snapshot.invoices.find(i=>i.sequence===sequence)!,value=invoiceDraftXeroValue(refreshed.snapshot,source,target);
          return {invoiceId,contactId:target,invoiceNumber:`XERO-${sequence}`,type:'ACCREC',status:'DRAFT',invoiceDate:value.date,dueDate:value.dueDate,
            currencyCode:'AUD',invoiceReference:value.reference,collegeName:value.reference,concept:null,advisorName:refreshed.snapshot.advisorLabel,
            total:100,amountPaid:0,amountDue:100,paymentTrack:sequence===1?null:'PENDING',sentToContact:false,updatedAt:null,
            lineItems:value.lines.map(line=>({...line,quantity:Number(line.quantity),unitAmount:Number(line.unitAmount),lineAmount:100,taxAmount:0}))};
        });
        const recovery=new StudentInvoiceProjectionRecovery(database,{invoiceById} as unknown as XeroConnectorService);
        await recovery.processBatch(tenant);await recovery.processBatch(tenant);await recovery.processBatch(tenant);
        expect(invoiceById).toHaveBeenCalledTimes(8);expect(createInvoice).toHaveBeenCalledTimes(8);
        expect(await recovery.processBatch(tenant)).toBe(false);expect(invoiceById).toHaveBeenCalledTimes(8);
        expect((await service.invoices(p,id,{})).total).toBe(8);
        // A durable verified receipt repairs a later local write failure without
        // another provider call. Fenced recovery cannot create a second invoice.
        await pool.query('DELETE FROM sophia_runtime.student_operations_case_invoice_links WHERE customer_id=$1 AND case_id=$2 AND xero_invoice_id=$3',[tenant,id,refreshed.exports['1'].invoiceId]);
        await pool.query('DELETE FROM sophia_runtime.student_operations_xero_invoices WHERE customer_id=$1 AND xero_invoice_id=$2',[tenant,refreshed.exports['1'].invoiceId]);
        await pool.query(`UPDATE sophia_runtime.student_case_xero_invoice_exports SET projection_next_attempt_at=now(),projection_attempts=0 WHERE customer_id=$1 AND batch_id=$2 AND sequence=1`,[tenant,batch.batchId]);
        expect(await recovery.processBatch(tenant)).toBe(true);expect(invoiceById).toHaveBeenCalledTimes(8);expect((await service.invoices(p,id,{})).total).toBe(8);
        // Minimal create receipts alone must not advance the case or fabricate
        // tracking confirmation. Simulate hydration into the shared read model.
        expect(await service.get(p,id)).toMatchObject({status:'pre_sale',currentStage:'checklist_complete'});
        const reconcileInvoices=()=>transaction(tenant,async db=>{await service.authorizedCase(db,p,id,true);await reconcileDocumentChecklist(db,tenant,id);});
        const evaluatedAt=async()=>(await pool.query('SELECT invoice_checked_at FROM sophia_runtime.student_document_checklist_evaluations WHERE customer_id=$1 AND case_id=$2',[tenant,id])).rows[0].invoice_checked_at.toISOString();
        const unchanged=await evaluatedAt();await service.checklist(p,id);await reconcileInvoices();await reconcileInvoices();expect(await evaluatedAt()).toBe(unchanged);
        await pool.query('UPDATE sophia_runtime.student_operations_xero_invoices SET updated_at=now() WHERE customer_id=$1 AND xero_invoice_id=$2',[tenant,refreshed.exports['1'].invoiceId]);
        await reconcileInvoices();expect(await evaluatedAt()).toBe(unchanged); // unchanged sync data does not invalidate
        for(const invoice of refreshed.snapshot.invoices){
          const value=invoiceDraftXeroValue(refreshed.snapshot,invoice,target);
          const lines=value.lines.map(line=>({description:line.description,itemCode:line.itemCode,quantity:Number(line.quantity),unitAmount:Number(line.unitAmount),accountCode:line.accountCode,taxType:line.taxType,taxAmount:0,lineAmount:100,tracking:line.tracking}));
          await transaction(tenant,db=>db.query(`UPDATE sophia_runtime.student_operations_xero_invoices SET line_items=$3,payment_track=$4 WHERE customer_id=$1 AND xero_invoice_id=$2`,
            [tenant,refreshed.exports[String(invoice.sequence)].invoiceId,JSON.stringify(lines),invoice.sequence===1?null:'PENDING']));
        }
        await reconcileInvoices();expect(await service.get(p,id)).toMatchObject({status:'pre_sale',currentStage:'checklist_complete'});
        let checklist=await service.checklist(p,id);
        expect(checklist.items.find(i=>i.key==='invoice_loo_consistency')).toMatchObject({completed:true,automatic:true});
        expect(checklist.items.find(i=>i.key==='pending_track_status')).toMatchObject({completed:false,automatic:true});
        await expect(service.updateChecklist(p,id,{itemKey:'pending_track_status',completed:true,recordVersion:0},randomUUID())).rejects.toThrow('confirmed Xero invoices');
        await transaction(tenant,db=>db.query(`UPDATE sophia_runtime.student_operations_xero_invoices SET payment_track='PENDING' WHERE customer_id=$1 AND xero_invoice_id=$2`,[tenant,refreshed.exports['1'].invoiceId]));
        // The normal create/reconcile completion hook uses the same case lock
        // and evaluator as the background checklist worker.
        await drafts.createXero(p,id,batch.batchId,{sequences:[1],confirmed:true});
        expect(await service.get(p,id)).toMatchObject({status:'pre_sale',currentStage:'awaiting_payment'});
        checklist=await service.checklist(p,id);expect(checklist.items.every(i=>i.completed)).toBe(true);
        const stageEvents=() => service.activities(p,id,{}).then(data=>data.activity.filter(a=>a.summary.startsWith('Awaiting Payment')));
        expect(await stageEvents()).toHaveLength(1);
        await Promise.all([reconcileInvoices(),reconcileInvoices()]);expect(await stageEvents()).toHaveLength(1);
        await pool.query(`UPDATE sophia_runtime.student_operations_cases SET lifecycle_status='on_hold',current_stage='documents_requested' WHERE customer_id=$1 AND case_id=$2`,[tenant,id]);
        await reconcileInvoices();expect(await service.get(p,id)).toMatchObject({status:'on_hold',currentStage:'documents_requested'});
        await pool.query(`UPDATE sophia_runtime.student_operations_cases SET lifecycle_status='payment_received',current_stage='payment_monitoring' WHERE customer_id=$1 AND case_id=$2`,[tenant,id]);
        await reconcileInvoices();expect((await service.get(p,id)).currentStage).toBe('payment_monitoring');
        // Restore only this disposable fixture's stage for the independent
        // nightly-sync and replacement-document scenarios below.
        await pool.query(`UPDATE sophia_runtime.student_operations_cases SET lifecycle_status='pre_sale',current_stage='checklist_complete' WHERE customer_id=$1 AND case_id=$2`,[tenant,id]);
        // The real nightly persistence stage updates a newly created invoice
        // in place; both list and detail immediately read that same cached row.
        const updated=allCreated.invoices[1],runId=randomUUID(),owner=randomUUID();
        await pool.query("INSERT INTO sophia_runtime.student_operations_xero_sync_runs VALUES($1,$2,$3,now()+interval '10 minutes','processing',0)",[tenant,runId,owner]);
        const sync=new StudentOperationsXeroSyncService(database,{} as never);
        await (sync as any).persistInvoices(tenant,{sync_run_id:runId,xero_connection_id:connection},owner,[{
          invoiceId:updated.invoiceId,contactId:target,invoiceNumber:updated.invoiceNumber,type:'ACCREC',status:'PAID',invoiceDate:'2026-10-26',dueDate:'2026-10-26',
          invoiceReference:'Updated college',concept:'Updated by nightly sync',advisorName:'New advisor',collegeName:'Updated college',paymentTrack:'Paid out',sentToContact:true,
          currencyCode:'AUD',total:100,amountPaid:100,amountDue:0,updatedAt:'2026-10-28T02:00:00.000Z',lineItems:[{lineItemId:randomUUID(),description:'Updated by nightly sync',quantity:1,unitAmount:100,accountCode:'812',taxType:'BASEXCLUDED',taxAmount:0,lineAmount:100,tracking:[]}],
        }],1);
        const latest=await service.invoiceDetail(p,id,connection,updated.invoiceId);
        expect(await service.invoiceDetail(p,id,null,updated.invoiceId)).toEqual(latest);
        expect(latest).toMatchObject({status:'PAID',paymentTrack:'Paid out',reference:'Updated college',lineItems:[{description:'Updated by nightly sync'}]});
        expect(Number(latest.amountPaid)).toBe(100);expect(Number(latest.amountDue)).toBe(0);
        expect((await service.invoices(p,id,{})).invoices.find(i=>i.invoiceId===updated.invoiceId)?.status).toBe('PAID');
        await (drafts as any).confirmCreated(p,id,batch.batchId,connection,target,refreshed.snapshot,refreshed.snapshot.invoices.find((i:any)=>i.sequence===updated.draftSequence),
          {invoiceId:updated.invoiceId,invoiceNumber:updated.invoiceNumber,status:'DRAFT',total:100});
        expect((await service.invoiceDetail(p,id,connection,updated.invoiceId)).status).toBe('PAID'); // Late confirmation cannot undo a newer sync.
        expect((await pool.query('SELECT student_id FROM sophia_runtime.student_operations_xero_invoices WHERE xero_invoice_id=$1',[updated.invoiceId])).rows[0].student_id).toBe(student.student_reference);
        await expect(service.invoiceDetail({...p,role:'advisor'},id,connection,updated.invoiceId)).rejects.toThrow('financial access');
        await expect(service.invoiceDetail(p,id,connection,randomUUID())).rejects.toThrow('Case invoice not found');
        // Reproduce older confirmed invoices whose local projection failed.
        const unindexed=allCreated.invoices[0];
        await pool.query('DELETE FROM sophia_runtime.student_operations_case_invoice_links WHERE customer_id=$1 AND case_id=$2 AND xero_invoice_id=$3',[tenant,id,unindexed.invoiceId]);
        await pool.query('DELETE FROM sophia_runtime.student_operations_xero_invoices WHERE customer_id=$1 AND xero_invoice_id=$2',[tenant,unindexed.invoiceId]);
        const fallback=await service.invoices(p,id,{});expect(fallback.total).toBe(8);expect(fallback.invoices).toHaveLength(8);
        const recovered=fallback.invoices.find(i=>i.invoiceId===unindexed.invoiceId)!;
        expect((await service.invoiceDetail(p,id,connection,unindexed.invoiceId)).lineItems.length).toBeGreaterThan(0);
        expect(recovered).toMatchObject({invoiceNumber:unindexed.invoiceNumber,draftBatchId:batch.batchId,status:'DRAFT',currency:'AUD'});expect(Number(recovered.amountDue)).toBe(100);
        const pages=await Promise.all([1,2,3].map(page=>service.invoices(p,id,{page,limit:3})));
        expect(pages.every(page=>page.total===8)).toBe(true);expect(new Set(pages.flatMap(page=>page.invoices.map(i=>i.invoiceId))).size).toBe(8);
        await expect(service.invoices({...p,tenantId:randomUUID()},id,{})).rejects.toThrow('Case not found');
        expect((await transaction(randomUUID(),db=>db.query('SELECT * FROM sophia_runtime.student_case_xero_invoice_exports'))).rowCount).toBe(0);
        await expect(transaction(tenant,db=>db.query('DELETE FROM sophia_runtime.student_case_xero_invoice_exports'))).rejects.toThrow('permission denied');
      }finally{if(oldCreate===undefined)delete process.env.XERO_INVOICE_CREATION_ENABLED;else process.env.XERO_INVOICE_CREATION_ENABLED=oldCreate;}
      await expect(drafts.list({...p,role:'advisor'},id)).rejects.toThrow('financial access');
      const other=randomUUID();expect((await transaction(other,db=>db.query('SELECT * FROM sophia_runtime.student_case_invoice_draft_batches'))).rowCount).toBe(0);
      await expect(transaction(tenant,db=>db.query('DELETE FROM sophia_runtime.student_case_invoice_draft_batches'))).rejects.toThrow('permission denied');
      await expect(transaction(tenant,db=>db.query("UPDATE sophia_runtime.student_case_invoice_draft_batches SET created_at=now()"))).rejects.toThrow('permission denied');
      expect((await transaction(other,db=>db.query('SELECT * FROM sophia_runtime.student_xero_sales_catalogues'))).rowCount).toBe(0);
      await expect(transaction(tenant,db=>db.query('DELETE FROM sophia_runtime.student_xero_sales_catalogues'))).rejects.toThrow('permission denied');
      await transaction(tenant,db=>db.query(`UPDATE sophia_runtime.student_xero_sales_catalogues SET next_attempt_at=now() WHERE customer_id=$1`,[tenant]));
      const failedSync=new StudentXeroSalesCatalogueSync(database,{salesCatalogue:async()=>{throw new Error('Synthetic upstream failure');}} as unknown as XeroConnectorService);
      await failedSync.processOne(tenant);const preserved=await transaction(tenant,db=>db.query(`SELECT snapshot,revision,error_code,next_attempt_at>now() AS delayed FROM sophia_runtime.student_xero_sales_catalogues WHERE customer_id=$1`,[tenant]));
      expect(preserved.rows[0]).toMatchObject({snapshot:catalogue,revision:1,error_code:'provider_unavailable',delayed:true});
      // Replacement reopens verification immediately; stale proposals remain audit-only.
      const next=await add(engagement);expect((await service.get(p,id)).currentStage).toBe('documents_requested');
      await expect(drafts.prepare(p,id,{...payload,caseVersion:(await service.get(p,id)).recordVersion},randomUUID())).rejects.toThrow('not verified');
      await service.update(p,id,{recordVersion:(await service.get(p,id)).recordVersion,status:'on_hold'},randomUUID());
      await review(next,'confirmed');expect((await service.get(p,id)).status).toBe('on_hold'); // Manual holds are not released.
    }finally{keys.forEach((k,i)=>{if(previous[i]===undefined)delete process.env[k];else process.env[k]=previous[i];});}
  });
  test('administrator cleanup previews safely, refuses unsafe targets and removes only the synthetic student',async()=>{
    // Reuse this suite's synthetic eight-invoice case, never a live database.
    await pool.query(`CREATE TABLE IF NOT EXISTS sophia_runtime.student_operations_document_sources(customer_id uuid,xero_connection_id uuid,source_id uuid);
      CREATE TABLE sophia_runtime.student_operations_xero_candidate_reviews(customer_id uuid,student_id uuid,FOREIGN KEY(student_id,customer_id) REFERENCES sophia_runtime.student_operations_students(student_id,customer_id));
      CREATE TABLE public.bm_xero_student_sync_candidates(customer_id uuid,connection_id uuid,student_id text,contact_ids uuid[]);
      ALTER TABLE sophia_runtime.student_operations_xero_sync_runs ADD COLUMN xero_connection_id uuid;`);
    const root=(await pool.query(`SELECT c.case_id,c.case_reference,s.student_id,s.legal_name,s.email,l.user_id,l.student_reference,l.company_id,
      e.xero_contact_id,e.xero_connection_id FROM sophia_runtime.student_operations_cases c
      JOIN sophia_runtime.student_operations_students s USING(customer_id,student_id)
      JOIN sophia_runtime.student_operations_student_user_links l USING(customer_id,student_id)
      JOIN sophia_runtime.student_case_xero_invoice_exports e USING(customer_id,case_id)
      WHERE c.customer_id=$1 AND s.legal_name='Workflow Fixture' LIMIT 1`,[tenant])).rows[0];
    expect(root).toBeTruthy();
    await pool.query(`INSERT INTO public.bm_xero_student_identities VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[tenant,root.company_id,root.student_reference]);
    await pool.query(`INSERT INTO public.bm_xero_student_sync_candidates VALUES($1,$2,$3,ARRAY[$4::uuid])`,[tenant,connection,root.student_reference,root.xero_contact_id]);
    await pool.query(`UPDATE sophia_runtime.student_case_xero_invoice_exports SET xero_invoice_number='INV-'||(10586+sequence)::text WHERE customer_id=$1 AND case_id=$2`,[tenant,root.case_id]);
    await pool.query(`INSERT INTO sophia_runtime.student_operations_xero_invoices(customer_id,xero_connection_id,xero_invoice_id,xero_contact_id,student_id,invoice_number,invoice_type,invoice_status,total,amount_paid,amount_due)
      SELECT customer_id,xero_connection_id,xero_invoice_id,xero_contact_id,$3,xero_invoice_number,'ACCREC','DELETED',100,0,0 FROM sophia_runtime.student_case_xero_invoice_exports WHERE customer_id=$1 AND case_id=$2
      ON CONFLICT(customer_id,xero_connection_id,xero_invoice_id) DO UPDATE SET invoice_status='DELETED',amount_paid=0,invoice_number=excluded.invoice_number`,[tenant,root.case_id,root.student_reference]);
    await pool.query(`UPDATE sophia_runtime.student_operations_xero_contacts SET contact_status='ARCHIVED' WHERE customer_id=$1 AND xero_contact_id=$2`,[tenant,root.xero_contact_id]);
    const counters=(await pool.query('SELECT * FROM public.bm_student_id_counter')).rows;
    const auditBefore=Number((await pool.query(`SELECT count(*) n FROM sophia_runtime.student_operations_case_activity WHERE customer_id=$1 AND case_id=$2`,[tenant,root.case_id])).rows[0].n);
    let script=await readFile(new URL('../../../scripts/sql/cleanup_test_student_std_1071.sql',import.meta.url),'utf8');
    expect(script).toContain('false AS apply_cleanup');
    expect(script.trimEnd()).toMatch(/ROLLBACK;$/);
    expect(script).toContain('10586+sequence');
    expect(script).not.toMatch(/STD-1070|CASE-1069|test@gmail\.com/);
    for(const [from,to] of Object.entries({'33ed40a6-7f2b-407c-aab2-de76b1cb45a8':tenant,'80d5e42f-2de1-4792-86b5-54c7cdeb2660':root.company_id,
      '7af793a7-87e9-4241-b0c1-d0bd0bee6687':root.student_id,'cb56429a-f3cd-4242-bb27-825efbabd043':root.user_id,'971f2c76-1d45-4abc-bfff-52bb371f6ba4':root.case_id,
      'a10fef7f-8451-42aa-94b9-6238d1929470':root.xero_connection_id,'10e416b4-f822-451f-9255-9be7ac9810a8':root.xero_contact_id,
      'STD-1071':root.student_reference,'CASE-1070':root.case_reference,'TEST2 - Student':root.legal_name,'test2@student.com':root.email}))script=script.replaceAll(from,to);
    const execute=async(sql:string)=>{const client=await pool.connect();try{return await client.query(sql);}finally{await client.query('ROLLBACK');client.release();}};
    await execute(script);expect((await pool.query('SELECT id FROM public.users WHERE id=$1',[root.user_id])).rowCount).toBe(1);
    const apply=script.replace('false AS apply_cleanup','true AS apply_cleanup');
    await execute(apply); // Even apply=true cannot persist with the final ROLLBACK.
    expect(Number((await pool.query(`SELECT count(*) n FROM sophia_runtime.student_operations_case_activity WHERE customer_id=$1 AND case_id=$2`,[tenant,root.case_id])).rows[0].n)).toBe(auditBefore);
    await expect(execute(script.replace(`${root.user_id}'::uuid AS user_id`,`${randomUUID()}'::uuid AS user_id`))).rejects.toThrow('Target identity/case changed');
    await pool.query(`UPDATE sophia_runtime.student_case_xero_invoice_exports SET xero_invoice_number='INV-OTHER' WHERE customer_id=$1 AND case_id=$2 AND sequence=1`,[tenant,root.case_id]);
    await expect(execute(apply)).rejects.toThrow('Expected exactly INV-10587 through INV-10594');
    await pool.query(`UPDATE sophia_runtime.student_case_xero_invoice_exports SET xero_invoice_number='INV-10587' WHERE customer_id=$1 AND case_id=$2 AND sequence=1`,[tenant,root.case_id]);
    await pool.query(`UPDATE sophia_runtime.student_operations_xero_invoices SET amount_paid=1 WHERE customer_id=$1 AND student_id=$2`,[tenant,root.student_reference]);
    await expect(execute(apply)).rejects.toThrow('Sync must first confirm');
    await pool.query(`UPDATE sophia_runtime.student_operations_xero_invoices SET amount_paid=0 WHERE customer_id=$1 AND student_id=$2`,[tenant,root.student_reference]);
    await pool.query(`UPDATE sophia_runtime.student_operations_xero_contacts SET contact_status='ACTIVE' WHERE customer_id=$1 AND xero_contact_id=$2`,[tenant,root.xero_contact_id]);
    await expect(execute(apply)).rejects.toThrow('Sync must first confirm');
    await pool.query(`UPDATE sophia_runtime.student_operations_xero_contacts SET contact_status='ARCHIVED' WHERE customer_id=$1 AND xero_contact_id=$2`,[tenant,root.xero_contact_id]);
    await pool.query('CREATE TABLE public.cleanup_script_extra_ref(user_id uuid REFERENCES public.users(id) ON DELETE CASCADE)');
    await pool.query('INSERT INTO public.cleanup_script_extra_ref VALUES($1)',[root.user_id]);
    await expect(execute(apply)).rejects.toThrow('Unplanned referencing row');
    await pool.query('DROP TABLE public.cleanup_script_extra_ref');
    await execute(apply.replace(/ROLLBACK;\s*$/,'COMMIT;'));
    expect((await pool.query('SELECT id FROM public.users WHERE id=$1',[root.user_id])).rowCount).toBe(0);
    expect((await pool.query('SELECT case_id FROM sophia_runtime.student_operations_cases WHERE case_id=$1',[root.case_id])).rowCount).toBe(0);
    expect((await pool.query('SELECT student_id FROM sophia_runtime.student_operations_students WHERE student_id=$1',[root.student_id])).rowCount).toBe(0);
    expect((await pool.query('SELECT id FROM public.users WHERE id=$1',[user])).rowCount).toBe(1);
    expect((await pool.query('SELECT * FROM public.bm_student_id_counter')).rows).toEqual(counters);
    expect((await pool.query(`SELECT count(*)::int n FROM sophia_runtime.student_operations_xero_invoices WHERE customer_id=$1 AND xero_contact_id=$2 AND student_id IS NULL`,[tenant,root.xero_contact_id])).rows[0].n).toBe(8);
    expect((await pool.query(`SELECT tgenabled FROM pg_trigger WHERE tgname IN ('student_operations_case_activity_append_only','protect_student_operations_student_audit_event')`)).rows.every(r=>r.tgenabled==='O')).toBe(true);
    const restore=enableCreation();try{expect(await service.createStudent(p,{studentName:'Fresh Test',studentEmail:root.email},randomUUID())).toHaveProperty('caseId');}finally{restore();}
  });

  test('offer extraction saves proposals, matches the college and confirms immutable financial revisions',async()=>{
    const restore=enableCreation(),old=process.env.STUDENT_DOCUMENT_ANALYSIS_ENABLED,oldOffer=process.env.STUDENT_OFFER_ANALYSIS_ENABLED;
    process.env.STUDENT_DOCUMENT_ANALYSIS_ENABLED=process.env.STUDENT_OFFER_ANALYSIS_ENABLED='true';
    try{
      const collegeId=randomUUID();await pool.query(`INSERT INTO public.bm_colleges(college_id,company_id,college_name,status,abn) VALUES($1,$2,'East Coast College','active','11627536823')`,[collegeId,company]);
      const student=await overflowStudent('Offer Workflow'),mock=provider(),db={tenantTransaction:transaction,tenantReadTransaction:transaction} as DatabaseService;
      const analysis=new StudentDocumentAnalysisService(db,service),type=(await types.requirements(p,{status:'pre_sale'})).requirements.find(r=>r.requirementKey==='letter_of_offer')!;
      process.env.STUDENT_OFFER_ANALYSIS_ENABLED='false';
      const uploaded=await mock.docs.upload(p,student.caseId,{documentTypeId:type.documentTypeId},pdf,'offer-upload-trigger'),documentId=String(uploaded.documentId);
      process.env.STUDENT_OFFER_ANALYSIS_ENABLED='true';
      expect((await analysis.get(p,student.caseId,documentId)).canStart).toBe(true);
      expect((await mock.docs.list(p,student.caseId,{})).documents[0].analysisStatus).toBe('not_checked');
      expect(await analysis.start(p,student.caseId,documentId,{},'offer-start-saved')).toEqual({queued:true});
      expect(await analysis.start(p,student.caseId,documentId,{},'offer-start-saved')).toEqual({queued:true});
      expect(mock.xero.uploadAttachment).toHaveBeenCalledTimes(1);
      const extraction={kind:'letter_of_offer' as const,studentName:'Offer Workflow',collegeName:'East Coast College',abn:'11627536823',cricosProviderCode:'03829G',currency:'AUD',statedTotalMinor:904000,evidence:[{page:2,quote:'Grand total AUD 9040.00'}],issues:[],
        courses:[{name:'General English',code:'116682E',startsOn:'2027-01-25',endsOn:'2028-03-19',duration:'60 weeks'}],
        fees:[{label:'Tuition and material',amountMinor:904000,conditional:false,condition:null},{label:'International transfer',amountMinor:2500,conditional:true,condition:'International payments only'}],
        instalments:[{sequence:1,dueTerm:'Immediately',dueOn:null,totalMinor:99500,includedConditionalFeeMinor:2500,components:[{label:'Material',amountMinor:5000},{label:'Tuition',amountMinor:72000}]},{sequence:2,dueTerm:null,dueOn:'2028-01-31',totalMinor:807000,includedConditionalFeeMinor:0,components:[]}]};
      const worker=new StudentDocumentAnalysisWorker(db,{attachmentContent:async()=>pdf.buffer} as unknown as XeroConnectorService,{extract:async()=>({extraction,provider:'fixture',model:'fixture',inputTokens:100,outputTokens:200})});
      await worker.processOne(tenant);
      const initial=await analysis.get(p,student.caseId,documentId);
      expect(initial.status).toBe('needs_review');expect(initial.offer).toMatchObject({resolution:'exact',currentCollegeId:collegeId,selectedCollegeId:collegeId,totals:{statedTotalMinor:904000,instalmentTotalMinor:906500,includedConditionalFeesMinor:2500,unexplainedDifference:false}});
      expect((await service.get(p,student.caseId)).colleges.some(c=>c.collegeId===collegeId&&c.isPrimary)).toBe(true);
      const payload={resultId:initial.resultId,expectedReviewVersion:0,expectedCaseVersion:initial.offer!.caseRecordVersion,decision:'confirmed',reason:'Checked all source tables',corrections:extraction,collegeId,replaceCollege:false,acknowledgeTotals:false};
      await expect(analysis.review(p,student.caseId,documentId,{...payload,collegeId:randomUUID()},'offer-foreign-college')).rejects.toThrow('active college');
      await expect(analysis.review(p,student.caseId,documentId,{...payload,corrections:{...extraction,statedTotalMinor:910000}},'offer-unexplained')).rejects.toThrow('acknowledge');
      expect(await analysis.review(p,student.caseId,documentId,payload,'offer-confirm')).toEqual({saved:true});
      expect(await analysis.review(p,student.caseId,documentId,payload,'offer-confirm')).toEqual({saved:true});
      const header=await transaction(tenant,db=>db.query(`SELECT offer_id,status,review_version,is_current FROM sophia_runtime.student_case_offers WHERE customer_id=$1 AND case_id=$2 ORDER BY review_version`,[tenant,student.caseId]));
      expect(header.rows.map(r=>[r.review_version,r.is_current])).toEqual([[0,false],[1,true]]);
      expect((await analysis.get(p,student.caseId,documentId)).status).toBe('passed');
      expect((await service.get(p,student.caseId)).courseName).toBe('General English');
      const payments=await transaction(tenant,db=>db.query(`SELECT total_minor::int,included_conditional_fee_minor::int,due_on,due_term FROM sophia_runtime.student_case_offer_instalments WHERE offer_id=$1 ORDER BY sequence`,[header.rows[1].offer_id]));
      expect(payments.rows[0]).toEqual({total_minor:99500,included_conditional_fee_minor:2500,due_on:null,due_term:'Immediately'});
      expect((await transaction(tenant,db=>db.query(`SELECT components FROM sophia_runtime.student_case_offer_instalments WHERE offer_id=$1 AND sequence=1`,[header.rows[1].offer_id]))).rows[0].components).toEqual(extraction.instalments[0].components);
      expect((await pool.query('SELECT extraction FROM sophia_runtime.student_document_analysis_results WHERE result_id=$1',[initial.resultId])).rows[0].extraction).toEqual(extraction);
      await expect(analysis.review(p,student.caseId,documentId,payload,'offer-stale-confirm')).rejects.toThrow('changed');
      const revised=await analysis.get(p,student.caseId,documentId);
      await analysis.review(p,student.caseId,documentId,{...payload,expectedReviewVersion:1,expectedCaseVersion:revised.offer!.caseRecordVersion,corrections:{...extraction,courses:[{...extraction.courses[0],name:'Reviewed English course'}]}},'offer-revise');
      expect((await transaction(tenant,db=>db.query(`SELECT count(*)::int n FROM sophia_runtime.student_case_offers WHERE case_id=$1 AND is_current`,[student.caseId]))).rows[0].n).toBe(1);
      expect((await pool.query('SELECT status FROM sophia_runtime.student_case_offers WHERE offer_id=$1',[header.rows[1].offer_id])).rows[0].status).toBe('superseded');
      const other='88888888-8888-4888-8888-888888888888';expect((await transaction(other,db=>db.query('SELECT * FROM sophia_runtime.student_operations_offer_college_directory'))).rowCount).toBe(0);
      expect((await service.activities(p,student.caseId,{})).activity.find(a=>a.eventType==='case.college_matched')?.actorName).toBe('SophiaAi');
      const secondCase=String((await service.create(p,{userId:student.userId,collegeId:college},'offer-existing-college-case')).caseId);
      const secondFile=String((await mock.docs.upload(p,secondCase,{documentTypeId:type.documentTypeId},pdf,'offer-second-upload')).documentId);
      await worker.processOne(tenant);const existing=await analysis.get(p,secondCase,secondFile);
      expect(existing.offer?.currentCollegeId).toBe(college); // Existing assignment was preserved.
      const nextPayload={...payload,resultId:existing.resultId,expectedCaseVersion:existing.offer!.caseRecordVersion};
      await service.update(p,secondCase,{recordVersion:existing.offer!.caseRecordVersion,title:'Changed in another editor'},'offer-concurrent-case-edit');
      await expect(analysis.review(p,secondCase,secondFile,nextPayload,'offer-stale-case')).rejects.toThrow('Case changed');
      const refreshed=await analysis.get(p,secondCase,secondFile),freshPayload={...nextPayload,expectedCaseVersion:refreshed.offer!.caseRecordVersion};
      await expect(analysis.review(p,secondCase,secondFile,freshPayload,'offer-replace-denied')).rejects.toThrow('replacing');
      await analysis.review(p,secondCase,secondFile,{...freshPayload,replaceCollege:true},'offer-replace-confirmed');
      expect((await service.get(p,secondCase)).colleges.find(c=>c.isPrimary)?.collegeId).toBe(collegeId);
    }finally{restore();if(old===undefined)delete process.env.STUDENT_DOCUMENT_ANALYSIS_ENABLED;else process.env.STUDENT_DOCUMENT_ANALYSIS_ENABLED=old;if(oldOffer===undefined)delete process.env.STUDENT_OFFER_ANALYSIS_ENABLED;else process.env.STUDENT_OFFER_ANALYSIS_ENABLED=oldOffer;}
  });
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
