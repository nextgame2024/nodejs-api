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
      CREATE TABLE sophia_runtime.business_pack_entitlements(customer_id uuid,identity_user_id text,pack_id text,status text,role_key text);
      CREATE TABLE sophia_runtime.student_operations_students(student_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),customer_id uuid,student_reference text,legal_name text,email text,updated_at timestamptz DEFAULT now(),UNIQUE(student_id,customer_id),UNIQUE(customer_id,student_reference));
      CREATE TABLE sophia_runtime.xero_connections(xero_connection_id uuid PRIMARY KEY,customer_id uuid,UNIQUE(xero_connection_id,customer_id));
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
    await pool.query(`INSERT INTO sophia_runtime.xero_connections VALUES($1,$2)`,[connection,tenant]);
    await pool.query(`INSERT INTO sophia_runtime.student_operations_xero_invoices(customer_id,xero_connection_id,xero_invoice_id,xero_contact_id,student_id,invoice_number,invoice_type,invoice_status,invoice_date,advisor_name,invoice_reference) VALUES($1,$2,$3,$3,'STD-1','INV-1','ACCREC','PAID','2025-01-01','Advisor One','YORK BUSINESS')`,[tenant,connection,invoice]);
    await pool.query(`UPDATE public.users SET password='unchanged-legacy-hash' WHERE id=$1`,[user]);
    await pool.query(await readFile(new URL('./migrations/088_user_password_setup_state.sql',import.meta.url),'utf8'));
    await pool.query((await readFile(new URL('./migrations/089_student_document_types_uploads.sql',import.meta.url),'utf8')).replaceAll('__SOPHIA_RUNTIME_SCHEMA__','sophia_runtime'));
  });
  afterAll(async()=>{await pool.end();});
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
    expect((await service.activities(p,detail.caseId,{})).activity).toHaveLength(1);
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
    const changed=await types.update(p,String(first.documentTypeId),{name:'Passport',required:false,recordVersion:1},'type-edit');
    expect(changed).toMatchObject({name:'Passport',required:false,recordVersion:2});
    await expect(types.update(p,String(first.documentTypeId),{required:true,recordVersion:1},'type-stale')).rejects.toThrow('changed');
    await types.update(p,String(first.documentTypeId),{status:'archived',recordVersion:2},'type-archive');
    expect((await types.list(p)).types).toHaveLength(0);
    await types.create(p,{name:'PASSPORT',required:true},'type-new-after-archive');
    expect((await pool.query('SELECT status FROM sophia_runtime.student_operations_document_types WHERE document_type_id=$1',[first.documentTypeId])).rows[0].status).toBe('archived');
    expect((await pool.query('SELECT count(*)::int n FROM sophia_runtime.student_operations_document_type_events WHERE document_type_id=$1',[first.documentTypeId])).rows[0].n).toBe(3);
    await expect(transaction(tenant,db=>db.query('DELETE FROM sophia_runtime.student_operations_document_types'))).rejects.toThrow('permission denied');
  });
  test('Contact-only Xero upload is idempotent, typed and auditable; archived labels and content remain readable',async()=>{
    const file={buffer:Buffer.from('%PDF-1.7\nExample\n%%EOF'),originalname:'passport.pdf',mimetype:'application/pdf'};
    const xero={uploadAttachment:jest.fn(async()=>({attachmentId:college})),attachmentContent:jest.fn(async()=>file.buffer)};
    const docs=new StudentOperationsCaseDocumentsService({tenantTransaction:transaction,tenantReadTransaction:transaction} as DatabaseService,service,xero as unknown as XeroConnectorService);
    const created=await service.create(p,{userId:user},'uploaded-document-case');
    const id=String(created.caseId),type=(await types.list(p)).types[0];
    const input={documentTypeId:type.documentTypeId,connectionId:connection,contactId:invoice};
    expect((await docs.uploadOptions(p,id)).contacts).toHaveLength(1);
    const result=await docs.upload(p,id,input,file,'upload-example');
    expect(await docs.upload(p,id,input,file,'upload-example')).toEqual(result);
    expect(xero.uploadAttachment).toHaveBeenCalledTimes(1);
    expect(xero.uploadAttachment.mock.calls[0]).toEqual([tenant,connection,'Contacts',invoice,expect.stringMatching(/^[a-f0-9-]+-passport\.pdf$/),'application/pdf',file.buffer,expect.stringMatching(/^[a-f0-9]{64}$/)]);
    const listed=await docs.list(p,id,{});
    expect(listed.documents).toHaveLength(1);
    expect(listed.documents[0]).toMatchObject({documentId:result.documentId,documentTypeName:'PASSPORT',documentTypeRequired:true,sourceKind:'Contacts'});
    expect(listed.documents[0]).not.toHaveProperty('private_object_key');
    await types.update(p,type.documentTypeId,{status:'archived',recordVersion:type.recordVersion},'archive-upload-type');
    expect((await docs.list(p,id,{})).documents[0].documentTypeName).toBe('PASSPORT');
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
    const input={documentTypeId:type.documentTypeId,connectionId:connection,contactId:invoice};
    const file={buffer:Buffer.from('%PDF-1.7\nExample\n%%EOF'),originalname:'offer.pdf',mimetype:'application/pdf'};
    await expect(docs.upload({...p,role:'advisor'},id,input,file,'upload-denied')).rejects.toThrow();
    await expect(docs.upload({...p,tenantId:'88888888-8888-4888-8888-888888888888'},id,input,file,'upload-other-tenant')).rejects.toThrow('Case not found');
    await expect(docs.upload(p,id,input,{...file,buffer:Buffer.from('<html>unsafe</html>')},'upload-fake')).rejects.toThrow('content');
    await expect(docs.upload(p,id,input,{...file,originalname:'offer.svg'},'upload-extension')).rejects.toThrow('format');
    await expect(docs.upload(p,id,input,{...file,buffer:Buffer.alloc(10*1024*1024+1)},'upload-size')).rejects.toThrow('10 MB');
    await expect(docs.upload(p,id,{...input,documentTypeId:user},file,'upload-missing-type')).rejects.toThrow();
    await expect(docs.upload(p,id,{...input,contactId:user},file,'upload-foreign-contact')).rejects.toThrow('Contact linked');
    await expect(docs.upload(p,id,{...input,sourceKind:'Invoices'},file,'upload-wrong-source')).rejects.toThrow('Choose a document');
    expect(xero.uploadAttachment).not.toHaveBeenCalled();
  });
  test('ambiguous provider failures retain a stable upload identity and lease instead of duplicating files',async()=>{
    const xero={uploadAttachment:jest.fn(async()=>{throw new Error('Provider timeout');})};
    const docs=new StudentOperationsCaseDocumentsService({tenantTransaction:transaction,tenantReadTransaction:transaction} as DatabaseService,service,xero as unknown as XeroConnectorService);
    const id=String((await service.create(p,{userId:user},'timeout-upload-case')).caseId);
    const type=(await types.list(p)).types[0];
    const input={documentTypeId:type.documentTypeId,connectionId:connection,contactId:invoice};
    const file={buffer:Buffer.from('%PDF-1.7\nExample\n%%EOF'),originalname:'offer.pdf',mimetype:'application/pdf'};
    await expect(docs.upload(p,id,input,file,'timeout-upload')).rejects.toThrow('timeout');
    await expect(docs.upload(p,id,input,file,'timeout-upload')).rejects.toThrow('still processing');
    expect(xero.uploadAttachment).toHaveBeenCalledTimes(1);
    const firstCall=xero.uploadAttachment.mock.calls[0];
    await pool.query(`UPDATE sophia_runtime.student_operations_document_uploads SET lease_expires_at=now()-interval '1 second' WHERE idempotency_key='timeout-upload'`);
    await expect(docs.upload(p,id,input,file,'timeout-upload')).rejects.toThrow('timeout');
    expect(xero.uploadAttachment.mock.calls[1]).toEqual(firstCall);
    expect((await docs.list(p,id,{})).documents).toHaveLength(0);
  });
  test('a persisted provider receipt recovers local finalization without sending the file twice',async()=>{
    const xero={uploadAttachment:jest.fn(async()=>({attachmentId:user}))};
    const docs=new StudentOperationsCaseDocumentsService({tenantTransaction:transaction,tenantReadTransaction:transaction} as DatabaseService,service,xero as unknown as XeroConnectorService);
    const id=String((await service.create(p,{userId:user},'receipt-recovery-case')).caseId);
    const type=(await types.list(p)).types[0];
    const input={documentTypeId:type.documentTypeId,connectionId:connection,contactId:invoice};
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
});
