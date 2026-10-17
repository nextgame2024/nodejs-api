import { readFile } from 'node:fs/promises';
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
      CREATE TABLE public.users(id uuid PRIMARY KEY,company_id uuid,student_id text,name text,email text,cel text,tel text,type text,status text,createdat timestamptz DEFAULT now(),updatedat timestamptz DEFAULT now());
      CREATE TABLE public.bm_colleges(college_id uuid PRIMARY KEY,company_id uuid,college_name text,status text);
      CREATE TABLE sophia_runtime.business_pack_entitlements(customer_id uuid,identity_user_id text,pack_id text,status text,role_key text);
      CREATE TABLE sophia_runtime.student_operations_students(student_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),customer_id uuid,student_reference text,legal_name text,email text,UNIQUE(student_id,customer_id),UNIQUE(customer_id,student_reference));
      CREATE TABLE sophia_runtime.xero_connections(xero_connection_id uuid PRIMARY KEY,customer_id uuid,UNIQUE(xero_connection_id,customer_id));
      CREATE TABLE sophia_runtime.student_operations_xero_invoices(customer_id uuid,xero_connection_id uuid,xero_invoice_id uuid,xero_contact_id uuid,student_id text,invoice_number text,invoice_type text,invoice_status text,invoice_date date,due_date date,advisor_name text,invoice_reference text,college_name text,total numeric,amount_paid numeric,amount_due numeric,currency_code text,PRIMARY KEY(customer_id,xero_connection_id,xero_invoice_id));
      GRANT SELECT ON sophia_runtime.student_operations_xero_invoices TO sophia_runtime_app;
    `);
    for(const name of ['064_student_operations_student_writes.sql','065_student_operations_write_least_privilege.sql','069_student_case_foundation.sql','070_student_register_advisor_projection.sql','071_student_case_management.sql','072_student_case_contact_projection.sql','073_student_case_workflow.sql']) {
      await pool.query((await readFile(new URL(`./migrations/${name}`,import.meta.url),'utf8')).replaceAll('__SOPHIA_RUNTIME_SCHEMA__','sophia_runtime'));
    }
    await pool.query(`INSERT INTO sophia_runtime.customers VALUES($1,$2,'active')`,[tenant,company]);
    await pool.query(`INSERT INTO public.users(id,company_id,student_id,name,email,cel,tel,type,status) VALUES($1,$2,'STD-1','Example Student','student@example.test','0412 345 678','07 3333 4444','student','active'),($3,$2,NULL,'Advisor One','advisor@example.test',NULL,NULL,'advisor','active')`,[user,company,advisor]);
    await pool.query(`INSERT INTO sophia_runtime.business_pack_entitlements VALUES($1,$2,'student-operations','active','advisor')`,[tenant,advisor]);
    await pool.query(`INSERT INTO public.bm_colleges VALUES($1,$2,'York Business','active')`,[college,company]);
    await pool.query(`INSERT INTO sophia_runtime.xero_connections VALUES($1,$2)`,[connection,tenant]);
    await pool.query(`INSERT INTO sophia_runtime.student_operations_xero_invoices(customer_id,xero_connection_id,xero_invoice_id,xero_contact_id,student_id,invoice_number,invoice_type,invoice_status,invoice_date,advisor_name,invoice_reference) VALUES($1,$2,$3,$3,'STD-1','INV-1','ACCREC','PAID','2025-01-01','Advisor One','YORK BUSINESS')`,[tenant,connection,invoice]);
  });
  afterAll(async()=>{await pool.end();});
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
    expect(detail.studentPhone).toBe('0412 345 678');
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
});
