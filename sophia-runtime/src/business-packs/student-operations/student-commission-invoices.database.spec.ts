import {afterAll,beforeAll,beforeEach,describe,expect,it,jest} from '@jest/globals';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {BadGatewayException,ConflictException,ForbiddenException} from '@nestjs/common';
import {StudentCommissionInvoicesService} from './student-commission-invoices.service.js';
import {StudentOperationsXeroSyncService} from './student-operations-xero-sync.service.js';
import type {InvoiceSnapshot} from './student-case-invoice-drafts.js';
import {invoiceDraftXeroValue} from './student-case-invoice-matching.js';
import type {XeroInvoiceCreate,XeroInvoiceRecord} from '../../connectors/xero/xero.client.js';

// Opt-in only; this suite creates fixtures in a dedicated disposable database.
const url=process.env.STUDENT_PTY_TEST_DATABASE_URL;
const suite=url?describe:describe.skip;
const tenant='11111111-1111-4111-8111-111111111111',other='99999999-9999-4999-8999-999999999999',caseId='22222222-2222-4222-8222-222222222222',batchId='33333333-3333-4333-8333-333333333333';
const trustId='44444444-4444-4444-8444-444444444444',ptyId='55555555-5555-4555-8555-555555555555',contactId='66666666-6666-4666-8666-666666666666',collegeId='77777777-7777-4777-8777-777777777777',itemId='88888888-8888-4888-8888-888888888888';
const p={tenantId:tenant,identityUserId:'test-actor',role:'chief_executive'} as never;
const schema=`pty_test_${randomUUID().replaceAll('-','')}`,sql=(name:string)=>readFileSync(new URL(`../../database/migrations/${name}`,import.meta.url),'utf8').replaceAll('__SOPHIA_RUNTIME_SCHEMA__',schema);
const snapshot:InvoiceSnapshot={studentName:'Fixture Student',advisorLabel:'S15 Advisor',currency:'AUD',collegeId,collegeName:'Fixture College',catalogueConnectionId:trustId,
 invoices:Array.from({length:7},(_,i)=>({sequence:i+1,issueDate:'2026-11-11',dueDate:'2026-11-11',conditionalFeeMinor:0,totalMinor:12500,invoiceNumber:`INV-${i+1}`,collegeName:'Fixture College',
 lines:[{kind:'tuition',amountMinor:10000,description:'Tuition',quantity:'1',unitPrice:'100.00',unitAmountMinor:10000,itemCode:'TUITION',accountCode:'812',taxType:'BASEXCLUDED'},
 {kind:'enrolment',amountMinor:2500,description:'Enrolment',quantity:'1',unitPrice:'25.00',unitAmountMinor:2500,itemCode:'ENROL',accountCode:'812',taxType:'BASEXCLUDED'}]}))};
function invoice(value:XeroInvoiceCreate,id:string):XeroInvoiceRecord{return {invoiceId:id,invoiceNumber:'TRUST-1',contactId:value.contactId,invoiceReference:value.reference,concept:null,advisorName:'S15 Advisor',collegeName:'Fixture College',paymentTrack:'Pending',sentToContact:false,
 type:'ACCREC',status:'DRAFT',invoiceDate:value.date,dueDate:value.dueDate,currencyCode:'AUD',total:125,amountPaid:0,amountDue:125,updatedAt:null,
 lineItems:value.lines.map(l=>({lineItemId:null,itemCode:l.itemCode??null,description:l.description,quantity:Number(l.quantity),unitAmount:Number(l.unitAmount),discountRate:null,accountCode:l.accountCode,taxType:l.taxType,taxAmount:0,lineAmount:Number(l.unitAmount),tracking:l.tracking}))};}

suite('PTY migrations and commission execution with PostgreSQL RLS',()=>{
 let pool:pg.Pool,service:StudentCommissionInvoicesService;
 let changedTrust=false,providerFailure=false,live=0,maxLive=0;
 const createInvoice=jest.fn(async(value:XeroInvoiceCreate,_key:string)=>{
  live++;maxLive=Math.max(maxLive,live);await new Promise(r=>setTimeout(r,10));live--;
  if(providerFailure)throw new BadGatewayException('Provider outcome uncertain');
  return {invoiceId:randomUUID(),invoiceNumber:'PTY-1',status:'DRAFT',total:Number(value.lines[0].unitAmount)*1.1};
 });
 const session=jest.fn(async(_tenant:string,_connection:string,role:string)=>role==='operating'?{createInvoice}:{invoiceById:async(id:string)=>{
  const value=invoiceDraftXeroValue(snapshot,snapshot.invoices[0],contactId),record=invoice(value,id);if(changedTrust)record.total=999;return record;
 }});
 const oldSchema=process.env.SOPHIA_RUNTIME_SCHEMA,oldFlag=process.env.XERO_INVOICE_CREATION_ENABLED;
 async function tx<T>(tenantId:string,work:(db:pg.PoolClient)=>Promise<T>):Promise<T>{
  const db=await pool.connect();try{await db.query('BEGIN');await db.query('SET LOCAL ROLE sophia_runtime_app');await db.query("SELECT set_config('sophia.tenant_id',$1,true)",[tenantId]);const result=await work(db);await db.query('COMMIT');return result;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
 }
 async function prepareAll(count=1){return service.prepare(p,caseId,batchId,{batchRevision:1,selections:Array.from({length:count},(_,i)=>({sequence:i+1,itemId}))});}
 async function trustReceipts(count=1){for(let sequence=1;sequence<=count;sequence++)await pool.query(`INSERT INTO ${schema}.student_case_xero_invoice_exports(customer_id,case_id,batch_id,sequence,xero_connection_id,xero_contact_id,provider_key,status,xero_invoice_id,completed_at,requested_by_identity_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,'created',$8,now(),'actor')`,[tenant,caseId,batchId,sequence,trustId,contactId,String(sequence).padStart(64,'0'),randomUUID()]);}
 beforeAll(async()=>{
  const parsed=new URL(url!);if(!['127.0.0.1','localhost'].includes(parsed.hostname)||parsed.pathname!=='/sophia_pty_validation')throw new Error('Use only the disposable local sophia_pty_validation database.');
  pool=new pg.Pool({connectionString:url,max:6});process.env.SOPHIA_RUNTIME_SCHEMA=schema;process.env.XERO_INVOICE_CREATION_ENABLED='true';
  await pool.query(`CREATE SCHEMA ${schema}; DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='sophia_runtime_app') THEN CREATE ROLE sophia_runtime_app NOLOGIN NOBYPASSRLS; END IF; END $$;
    GRANT USAGE ON SCHEMA ${schema} TO sophia_runtime_app;
    CREATE TABLE ${schema}.customers(customer_id uuid PRIMARY KEY,external_company_id text,status text);
    CREATE TABLE ${schema}.xero_connections(customer_id uuid,xero_connection_id uuid,status text,PRIMARY KEY(xero_connection_id,customer_id));
    CREATE TABLE ${schema}.student_operations_xero_sync_configurations(customer_id uuid,xero_connection_id uuid,organisation_role text,enabled boolean,next_sync_at timestamptz,PRIMARY KEY(customer_id,xero_connection_id));
    CREATE TABLE ${schema}.student_operations_xero_contacts(customer_id uuid,xero_connection_id uuid,xero_contact_id uuid,contact_status text,legal_name text,email text,PRIMARY KEY(customer_id,xero_connection_id,xero_contact_id));
    CREATE TABLE ${schema}.student_operations_college_directory(customer_id uuid,college_id uuid,college_name text,PRIMARY KEY(customer_id,college_id));
    CREATE TABLE ${schema}.student_case_invoice_draft_batches(customer_id uuid,case_id uuid,batch_id uuid,offer_id uuid,revision integer,snapshot jsonb,PRIMARY KEY(customer_id,batch_id));
    CREATE TABLE ${schema}.student_case_offers(customer_id uuid,offer_id uuid,is_current boolean);
    CREATE TABLE ${schema}.student_xero_sales_catalogues(customer_id uuid,xero_connection_id uuid,snapshot jsonb,revision integer,last_synced_at timestamptz,error_code text);
    CREATE TABLE ${schema}.student_operations_xero_invoices(customer_id uuid,xero_connection_id uuid,xero_invoice_id uuid,invoice_status text,invoice_date date,due_date date,total numeric,amount_paid numeric,amount_due numeric);
    ALTER TABLE ${schema}.student_operations_xero_invoices ADD PRIMARY KEY(customer_id,xero_connection_id,xero_invoice_id),ADD xero_contact_id uuid,ADD invoice_number text,ADD invoice_type text,ADD invoice_reference text,ADD concept text,ADD advisor_name text,ADD college_name text,ADD payment_track text,ADD sent_to_contact boolean,ADD line_items jsonb,ADD currency_code text,ADD provider_updated_at timestamptz,ADD last_seen_sync_run_id uuid,ADD updated_at timestamptz DEFAULT now();
    CREATE TABLE ${schema}.student_operations_xero_sync_runs(customer_id uuid,sync_run_id uuid,status text,lease_owner text,lease_expires_at timestamptz,invoice_count integer);
    CREATE TABLE IF NOT EXISTS public.bm_college_commission_rules(rule_id uuid PRIMARY KEY,company_id uuid,college_id uuid,classification text,location text,program text,commission_basis_points integer,calculation_method text,rounding_decimal_places integer,cashback_status text,bonus_status text,application_conditions text,active boolean,createdat timestamptz DEFAULT now(),updatedat timestamptz DEFAULT now());
    GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA ${schema} TO sophia_runtime_app;`);
  // The actual worker function body is used, preserving its lease/window SQL.
  const worker=sql('080_student_sync_worker_pipeline.sql');await pool.query(worker.slice(worker.indexOf('CREATE FUNCTION '+schema+'.student_operations_automatic_window')));
  await pool.query(sql('100_student_xero_invoice_exports.sql'));await pool.query(sql('127_student_pty_foundation.sql'));await pool.query(sql('128_student_commission_invoices.sql'));
  for(const table of ['customers','xero_connections','student_operations_xero_sync_configurations','student_operations_xero_contacts','student_operations_college_directory','student_case_invoice_draft_batches','student_case_offers','student_xero_sales_catalogues','student_operations_xero_invoices','student_operations_xero_sync_runs'])await pool.query(`ALTER TABLE ${schema}.${table} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${schema}.${table} FORCE ROW LEVEL SECURITY; CREATE POLICY tenant_scope ON ${schema}.${table} USING(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid) WITH CHECK(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid);`);
  const cases={authorizedCase:async(db:pg.PoolClient,principal:{tenantId:string},id:string)=>{const found=await db.query(`SELECT 1 FROM ${schema}.student_case_invoice_draft_batches WHERE customer_id=$1 AND case_id=$2`,[principal.tenantId,id]);if(!found.rowCount)throw new ForbiddenException();return {lifecycle_status:'pre_sale'};},activity:async()=>{}};
  service=new StudentCommissionInvoicesService({tenantTransaction:tx,tenantReadTransaction:tx} as never,cases as never,{invoiceCreationSession:session} as never);
 },20000);
 beforeEach(async()=>{
  await pool.query(`TRUNCATE ${schema}.student_commission_exports,${schema}.student_commission_drafts,${schema}.student_case_xero_invoice_exports,${schema}.student_case_invoice_draft_batches CASCADE;
    DELETE FROM ${schema}.student_college_xero_mapping_events;DELETE FROM ${schema}.student_college_xero_contact_links;DELETE FROM ${schema}.student_operations_xero_contacts;DELETE FROM ${schema}.student_operations_college_directory;DELETE FROM ${schema}.student_operations_xero_sync_configurations;DELETE FROM ${schema}.xero_connections;DELETE FROM ${schema}.customers;DELETE FROM ${schema}.student_xero_sales_catalogues;DELETE FROM ${schema}.student_operations_xero_invoices;`);
  await pool.query('DELETE FROM public.bm_college_commission_rules WHERE company_id=$1',[tenant]);
    await pool.query(`INSERT INTO ${schema}.customers VALUES($1::uuid,$1::text,'active'),($2::uuid,$2::text,'active')`,[tenant,other]);
    await pool.query(`INSERT INTO ${schema}.xero_connections VALUES($1,$2,'active'),($1,$3,'active')`,[tenant,trustId,ptyId]);
    await pool.query(`INSERT INTO ${schema}.student_operations_xero_sync_configurations VALUES($1,$2,'trust',true,now()),($1,$3,'operating',true,now())`,[tenant,trustId,ptyId]);
    await pool.query(`INSERT INTO ${schema}.student_operations_xero_contacts VALUES($1,$2,$3,'ACTIVE','Fixture College',NULL)`,[tenant,ptyId,contactId]);
    await pool.query(`INSERT INTO ${schema}.student_operations_college_directory VALUES($1,$2,'Fixture College')`,[tenant,collegeId]);
  await pool.query(`INSERT INTO public.bm_college_commission_rules(rule_id,company_id,college_id,commission_basis_points,calculation_method,rounding_decimal_places,cashback_status,bonus_status,active) VALUES($1,$2,$3,3000,'tuition_fee_percentage',2,'not_recorded','not_applicable',true)`,[itemId,tenant,collegeId]);
  await pool.query(`INSERT INTO ${schema}.student_college_xero_contact_links(customer_id,xero_connection_id,xero_contact_id,college_id,classification,reviewed_by) VALUES($1,$2,$3,$4,'college','actor')`,[tenant,ptyId,contactId,collegeId]);
  await pool.query(`INSERT INTO ${schema}.student_case_invoice_draft_batches VALUES($1,$2,$3,NULL,1,$4)`,[tenant,caseId,batchId,JSON.stringify(snapshot)]);
  const catalogue={items:[{itemId,code:'COMMISSION',name:'Commission',accountCode:'200',taxType:'OUTPUT'}],accounts:[{code:'200',name:'Sales Commissions',taxType:'OUTPUT'}],taxRates:[{name:'GST on Income',taxType:'OUTPUT',rate:'10'}],brandingThemes:[{brandingThemeId:itemId,name:'PTY Open for Australia Account'}]};
  await pool.query(`INSERT INTO ${schema}.student_xero_sales_catalogues VALUES($1,$2,$3,1,now(),NULL)`,[tenant,ptyId,JSON.stringify(catalogue)]);
  changedTrust=providerFailure=false;live=maxLive=0;createInvoice.mockClear();session.mockClear();
 });
 afterAll(async()=>{if(pool){await pool.query(`DROP SCHEMA ${schema} CASCADE`);await pool.query('DELETE FROM public.bm_college_commission_rules WHERE company_id=$1',[tenant]);await pool.end();}if(oldSchema===undefined)delete process.env.SOPHIA_RUNTIME_SCHEMA;else process.env.SOPHIA_RUNTIME_SCHEMA=oldSchema;if(oldFlag===undefined)delete process.env.XERO_INVOICE_CREATION_ENABLED;else process.env.XERO_INVOICE_CREATION_ENABLED=oldFlag;});
 it('applies real migrations with forced RLS and no unrestricted Business Manager grant',async()=>{
  const role=await pool.query("SELECT rolbypassrls FROM pg_roles WHERE rolname='sophia_runtime_app'");expect(role.rows[0].rolbypassrls).toBe(false);
  const rules=await tx(tenant,db=>db.query(`SELECT * FROM ${schema}.student_college_commission_rules`));expect(rules.rowCount).toBe(1);
  expect((await tx(other,db=>db.query(`SELECT * FROM ${schema}.student_college_commission_rules`))).rowCount).toBe(0);
  await expect(tx(tenant,db=>db.query('SELECT * FROM public.bm_college_commission_rules'))).rejects.toThrow('permission denied');
 });
 it('saves the server calculation and correct PTY recipient/reference, tax and dates',async()=>{
  await prepareAll();const rows=await service.list(p,caseId,batchId),s=rows.items[0].snapshot as any;
  expect(s.calculation).toMatchObject({tuitionMinor:10000,commissionMinor:3000});expect(s.taxMinor).toBe(300);expect(s.value).toMatchObject({contactId,date:'2026-11-11',reference:'Fixture Student',lines:[expect.objectContaining({unitAmount:'30.00',accountCode:'200',taxType:'OUTPUT',tracking:[{name:'Type of Sale',option:'Instalment'}]})]});
 });
 it('refuses direct PTY creation until its TRUST receipt exists',async()=>{
  await prepareAll();const r=await service.create(p,caseId,batchId,{sequences:[1],confirmed:true});expect(r.results[0]).toMatchObject({status:'not_attempted',message:expect.stringContaining('TRUST invoice first')});expect(createInvoice).not.toHaveBeenCalled();
 });
 it('creates once and skips duplicate or concurrent calls',async()=>{
  await prepareAll();await trustReceipts();await Promise.all([service.create(p,caseId,batchId,{sequences:[1],confirmed:true}),service.create(p,caseId,batchId,{sequences:[1],confirmed:true})]);expect(createInvoice).toHaveBeenCalledTimes(1);
  const r=await service.create(p,caseId,batchId,{sequences:[1],confirmed:true});expect(r.results[0].status).toBe('already_created');
 });
 it('holds uncertain provider outcomes and never replays them',async()=>{
  await prepareAll();await trustReceipts();providerFailure=true;
  expect((await service.create(p,caseId,batchId,{sequences:[1],confirmed:true})).results[0].status).toBe('review_required');
  await service.create(p,caseId,batchId,{sequences:[1],confirmed:true});expect(createInvoice).toHaveBeenCalledTimes(1);
 });
 it('detects changed source invoices in Xero before sending PTY',async()=>{
  await prepareAll();await trustReceipts();changedTrust=true;const r=await service.create(p,caseId,batchId,{sequences:[1],confirmed:true});expect(r.results[0].message).toContain('TRUST invoice changed');expect(createInvoice).not.toHaveBeenCalled();
 });
 it('protects calculation snapshots and permanent source links after creation',async()=>{
  await prepareAll();await trustReceipts();await service.create(p,caseId,batchId,{sequences:[1],confirmed:true});
  await expect(tx(tenant,db=>db.query(`UPDATE ${schema}.student_commission_drafts SET source_hash=$1`,['a'.repeat(64)]))).rejects.toThrow('immutable');
  await expect(tx(tenant,db=>db.query(`DELETE FROM ${schema}.student_commission_exports`))).rejects.toThrow('permission denied');
  expect((await tx(other,db=>db.query(`SELECT * FROM ${schema}.student_commission_exports`))).rowCount).toBe(0);
 });
 it('uses at most three workers and one session per organisation in a bulk request',async()=>{
  await prepareAll(7);await trustReceipts(7);const r=await service.create(p,caseId,batchId,{sequences:[1,2,3,4,5,6,7],confirmed:true});
  expect(r.created).toBe(7);expect(maxLive).toBeLessThanOrEqual(3);expect(maxLive).toBeGreaterThan(1);expect(session).toHaveBeenCalledTimes(2);expect(r.results.map(i=>i.sequence)).toEqual([1,2,3,4,5,6,7]);
 });
 it('blocks changed catalogue revisions and rules',async()=>{
  await prepareAll();await trustReceipts();await pool.query(`UPDATE ${schema}.student_xero_sales_catalogues SET revision=2`);
  const r=await service.create(p,caseId,batchId,{sequences:[1],confirmed:true});expect(r.results[0].status).toBe('not_attempted');expect(createInvoice).not.toHaveBeenCalled();
 });
 it('denies unauthorized financial access before database work',async()=>{await expect(service.options({...p as object,role:'advisor'} as never,caseId,collegeId)).rejects.toThrow();});
 it('imports PTY dates, payments and credits idempotently through the actual sync upsert',async()=>{
  const runId=randomUUID(),invoiceId=randomUUID();
  await pool.query(`INSERT INTO ${schema}.student_operations_xero_sync_runs VALUES($1,$2,'processing','worker',now()+interval '10 minutes',0)`,[tenant,runId]);
  const sync=new StudentOperationsXeroSyncService({tenantTransaction:tx} as never,{} as never) as any;
  const value=invoice(invoiceDraftXeroValue(snapshot,snapshot.invoices[0],contactId),invoiceId);
  value.invoiceReference='Fixture Student';value.invoiceDate='2026-11-20';value.status='PAID';value.amountPaid=125;value.amountDue=0;
  value.settlement={fullyPaidOnDate:'2026-11-21',entries:[{kind:'payment',id:contactId,date:'2026-11-21',amount:125}]};
  const run={sync_run_id:runId,xero_connection_id:ptyId};
  await sync.persistInvoices(tenant,run,'worker',[value],1);await sync.persistInvoices(tenant,run,'worker',[value],1);
  const result=await tx(tenant,db=>db.query(`SELECT invoice_date::text,college_name,invoice_reference,amount_paid::text,settlement FROM ${schema}.student_operations_xero_invoices WHERE xero_invoice_id=$1`,[invoiceId]));
  expect(result.rowCount).toBe(1);expect(result.rows[0]).toMatchObject({invoice_date:'2026-11-20',college_name:null,invoice_reference:'Fixture Student',amount_paid:'125',settlement:value.settlement});
  delete value.settlement;await sync.persistInvoices(tenant,run,'worker',[value],1);
  expect((await pool.query(`SELECT settlement FROM ${schema}.student_operations_xero_invoices WHERE xero_invoice_id=$1`,[invoiceId])).rows[0].settlement.entries).toHaveLength(1);
 });
});
