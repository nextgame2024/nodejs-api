import {afterAll,beforeAll,beforeEach,describe,expect,it,jest} from '@jest/globals';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {BadGatewayException,ConflictException,ForbiddenException} from '@nestjs/common';
import {StudentXeroSalesCatalogueSync,readPtySaleOptions} from './student-xero-sales-catalogue.js';
import {StudentCollegeMatchingService} from './student-college-matching.service.js';
import {StudentCommissionInvoicesService} from './student-commission-invoices.service.js';
import {StudentOperationsXeroSyncService} from './student-operations-xero-sync.service.js';
import {autoMatchCollegeContacts} from './student-college-auto-matching.js';
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
 async function trustReceipts(count=1,first=1){for(let sequence=first;sequence<first+count;sequence++)await pool.query(`INSERT INTO ${schema}.student_case_xero_invoice_exports(customer_id,case_id,batch_id,sequence,xero_connection_id,xero_contact_id,provider_key,status,xero_invoice_id,completed_at,requested_by_identity_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,'created',$8,now(),'actor')`,[tenant,caseId,batchId,sequence,trustId,contactId,String(sequence).padStart(64,'0'),randomUUID()]);}
 beforeAll(async()=>{
  const parsed=new URL(url!);if(!['127.0.0.1','localhost'].includes(parsed.hostname)||parsed.pathname!=='/sophia_pty_validation')throw new Error('Use only the disposable local sophia_pty_validation database.');
  pool=new pg.Pool({connectionString:url,max:6});process.env.SOPHIA_RUNTIME_SCHEMA=schema;process.env.XERO_INVOICE_CREATION_ENABLED='true';
  await pool.query(`CREATE SCHEMA ${schema}; DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='sophia_runtime_app') THEN CREATE ROLE sophia_runtime_app NOLOGIN NOBYPASSRLS; END IF; END $$;
    GRANT USAGE ON SCHEMA ${schema} TO sophia_runtime_app;
    CREATE TABLE ${schema}.customers(customer_id uuid PRIMARY KEY,external_company_id text,status text);
    CREATE TABLE ${schema}.xero_connections(customer_id uuid,xero_connection_id uuid,status text,PRIMARY KEY(xero_connection_id,customer_id));
    CREATE TABLE ${schema}.student_operations_xero_sync_configurations(customer_id uuid,xero_connection_id uuid,organisation_role text,enabled boolean,next_sync_at timestamptz,PRIMARY KEY(customer_id,xero_connection_id));
    CREATE TABLE ${schema}.student_case_deletions(customer_id uuid,case_id uuid,completed_at timestamptz,targets jsonb);
    CREATE TABLE ${schema}.student_operations_xero_contacts(customer_id uuid,xero_connection_id uuid,xero_contact_id uuid,contact_status text,legal_name text,email text,PRIMARY KEY(customer_id,xero_connection_id,xero_contact_id));
    CREATE TABLE ${schema}.student_operations_college_directory(customer_id uuid,college_id uuid,college_name text,PRIMARY KEY(customer_id,college_id));
    CREATE TABLE ${schema}.student_case_invoice_draft_batches(customer_id uuid,case_id uuid,batch_id uuid,offer_id uuid,revision integer,snapshot jsonb,PRIMARY KEY(customer_id,batch_id));
    CREATE TABLE ${schema}.student_case_offers(customer_id uuid,offer_id uuid,is_current boolean);
    CREATE TABLE ${schema}.student_xero_sales_catalogues(customer_id uuid,xero_connection_id uuid,snapshot jsonb,revision integer,last_synced_at timestamptz,error_code text,next_attempt_at timestamptz DEFAULT now(),attempts integer DEFAULT 0,lease_token uuid,lease_expires_at timestamptz,PRIMARY KEY(customer_id,xero_connection_id));
    CREATE TABLE ${schema}.student_operations_xero_invoices(customer_id uuid,xero_connection_id uuid,xero_invoice_id uuid,invoice_status text,invoice_date date,due_date date,total numeric,amount_paid numeric,amount_due numeric);
    ALTER TABLE ${schema}.student_operations_xero_invoices ADD PRIMARY KEY(customer_id,xero_connection_id,xero_invoice_id),ADD xero_contact_id uuid,ADD invoice_number text,ADD invoice_type text,ADD invoice_reference text,ADD concept text,ADD advisor_name text,ADD college_name text,ADD payment_track text,ADD sent_to_contact boolean,ADD line_items jsonb,ADD currency_code text,ADD provider_updated_at timestamptz,ADD last_seen_sync_run_id uuid,ADD updated_at timestamptz DEFAULT now();
    CREATE TABLE ${schema}.student_operations_xero_sync_runs(customer_id uuid,sync_run_id uuid,status text,lease_owner text,lease_expires_at timestamptz,invoice_count integer,xero_connection_id uuid,created_at timestamptz DEFAULT now(),mode text);
    CREATE TABLE IF NOT EXISTS public.bm_colleges(college_id uuid PRIMARY KEY,company_id uuid,college_name text,trading_name text,acronym text,status text DEFAULT 'active');
    CREATE TABLE IF NOT EXISTS public.bm_college_commission_rules(rule_id uuid PRIMARY KEY,company_id uuid,college_id uuid,classification text,location text,program text,commission_basis_points integer,calculation_method text,rounding_decimal_places integer,cashback_status text,bonus_status text,application_conditions text,active boolean,createdat timestamptz DEFAULT now(),updatedat timestamptz DEFAULT now());
    GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA ${schema} TO sophia_runtime_app;`);
  // The actual worker function body is used, preserving its lease/window SQL.
  const worker=sql('080_student_sync_worker_pipeline.sql');await pool.query(worker.slice(worker.indexOf('CREATE FUNCTION '+schema+'.student_operations_automatic_window')));
  await pool.query(sql('100_student_xero_invoice_exports.sql'));await pool.query(sql('127_student_pty_foundation.sql'));await pool.query(sql('128_student_commission_invoices.sql'));await pool.query(sql('129_student_college_matching_aliases.sql'));
  for(const table of ['customers','xero_connections','student_operations_xero_sync_configurations','student_operations_xero_contacts','student_operations_college_directory','student_case_invoice_draft_batches','student_case_offers','student_xero_sales_catalogues','student_operations_xero_invoices','student_operations_xero_sync_runs'])await pool.query(`ALTER TABLE ${schema}.${table} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${schema}.${table} FORCE ROW LEVEL SECURITY; CREATE POLICY tenant_scope ON ${schema}.${table} USING(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid) WITH CHECK(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid);`);
  const cases={authorizedCase:async(db:pg.PoolClient,principal:{tenantId:string},id:string)=>{const found=await db.query(`SELECT 1 FROM ${schema}.student_case_invoice_draft_batches WHERE customer_id=$1 AND case_id=$2`,[principal.tenantId,id]);if(!found.rowCount)throw new ForbiddenException();return {lifecycle_status:'pre_sale'};},activity:async()=>{}};
  service=new StudentCommissionInvoicesService({tenantTransaction:tx,tenantReadTransaction:tx} as never,cases as never,{invoiceCreationSession:session} as never);
 },20000);
 beforeEach(async()=>{
  await pool.query(`TRUNCATE ${schema}.student_commission_exports,${schema}.student_commission_drafts,${schema}.student_case_xero_invoice_exports,${schema}.student_case_invoice_draft_batches CASCADE;
    DELETE FROM ${schema}.student_college_xero_mapping_events;DELETE FROM ${schema}.student_college_xero_contact_links;DELETE FROM ${schema}.student_operations_xero_contacts;DELETE FROM ${schema}.student_operations_college_directory;DELETE FROM ${schema}.student_operations_xero_sync_configurations;DELETE FROM ${schema}.xero_connections;DELETE FROM ${schema}.customers;DELETE FROM ${schema}.student_xero_sales_catalogues;DELETE FROM ${schema}.student_operations_xero_invoices;DELETE FROM ${schema}.student_operations_xero_sync_runs;`);
  await pool.query('DELETE FROM public.bm_colleges WHERE company_id IN ($1,$2)',[tenant,other]);
  await pool.query(`INSERT INTO public.bm_colleges(college_id,company_id,college_name,status) VALUES($1,$2,$3,'active')`,[collegeId,tenant,'Fixture College']);
  await pool.query('DELETE FROM public.bm_college_commission_rules WHERE company_id=$1',[tenant]);
    await pool.query(`INSERT INTO ${schema}.customers VALUES($1::uuid,$1::text,'active'),($2::uuid,$2::text,'active')`,[tenant,other]);
    await pool.query(`INSERT INTO ${schema}.xero_connections VALUES($1,$2,'active'),($1,$3,'active')`,[tenant,trustId,ptyId]);
    await pool.query(`INSERT INTO ${schema}.student_operations_xero_sync_configurations VALUES($1,$2,'trust',true,now()),($1,$3,'operating',true,now())`,[tenant,trustId,ptyId]);
    await pool.query(`INSERT INTO ${schema}.student_operations_xero_contacts VALUES($1,$2,$3,'ACTIVE','Fixture College',NULL)`,[tenant,ptyId,contactId]);
    await pool.query(`INSERT INTO ${schema}.student_operations_college_directory VALUES($1,$2,'Fixture College')`,[tenant,collegeId]);
  await pool.query(`INSERT INTO public.bm_college_commission_rules(rule_id,company_id,college_id,commission_basis_points,calculation_method,rounding_decimal_places,cashback_status,bonus_status,active) VALUES($1,$2,$3,3000,'tuition_fee_percentage',2,'not_recorded','not_applicable',true)`,[itemId,tenant,collegeId]);
  await pool.query(`INSERT INTO ${schema}.student_college_xero_contact_links(customer_id,xero_connection_id,xero_contact_id,college_id,classification,reviewed_by) VALUES($1,$2,$3,$4,'college','actor')`,[tenant,ptyId,contactId,collegeId]);
  await pool.query(`INSERT INTO ${schema}.student_case_invoice_draft_batches VALUES($1,$2,$3,NULL,1,$4)`,[tenant,caseId,batchId,JSON.stringify(snapshot)]);
  const catalogue={trackingCategories:[{trackingCategoryId:trustId,name:'Type of Sale',options:[{trackingOptionId:itemId,name:'Instalment'},{trackingOptionId:batchId,name:'Marketing'}]}],items:[{itemId,code:'TUITION',name:'Commission',accountCode:'200',taxType:'OUTPUT'}],accounts:[{code:'200',name:'Sales Commissions',taxType:'OUTPUT'}],taxRates:[{name:'GST on Income',taxType:'OUTPUT',rate:'10'}],brandingThemes:[{brandingThemeId:itemId,name:'PTY Open for Australia Account'}]};
  await pool.query(`INSERT INTO ${schema}.student_xero_sales_catalogues(customer_id,xero_connection_id,snapshot,revision,last_synced_at,error_code,next_attempt_at) VALUES($1,$2,$3,1,now(),NULL,now()+interval '1 day')`,[tenant,ptyId,JSON.stringify(catalogue)]);
  changedTrust=providerFailure=false;live=maxLive=0;createInvoice.mockClear();session.mockClear();
 });
 afterAll(async()=>{if(pool){await pool.query(`DROP SCHEMA ${schema} CASCADE`);await pool.query('DELETE FROM public.bm_college_commission_rules WHERE company_id=$1',[tenant]);await pool.query('DELETE FROM public.bm_colleges WHERE company_id IN ($1,$2)',[tenant,other]);await pool.end();}if(oldSchema===undefined)delete process.env.SOPHIA_RUNTIME_SCHEMA;else process.env.SOPHIA_RUNTIME_SCHEMA=oldSchema;if(oldFlag===undefined)delete process.env.XERO_INVOICE_CREATION_ENABLED;else process.env.XERO_INVOICE_CREATION_ENABLED=oldFlag;});
 it('separates archived/imported contacts from pending active sales and keeps empty-page totals',async()=>{
  const run=randomUUID(),oldRun=randomUUID(),pending=randomUUID(),archived=randomUUID(),supplier=randomUUID(),deletedOnly=randomUUID(),otherCustomer=randomUUID();
  await pool.query(`INSERT INTO ${schema}.student_operations_xero_sync_runs(customer_id,sync_run_id,xero_connection_id,status,mode,created_at)
    VALUES($1,$2,$3,'succeeded','reconciliation',now()),($1,$4,$3,'succeeded','initial',now()-interval '1 day')`,[tenant,run,ptyId,oldRun]);
  for(const [id,status] of [[pending,'ACTIVE'],[archived,'ARCHIVED'],[supplier,'ACTIVE'],[deletedOnly,'ACTIVE'],[otherCustomer,'ACTIVE']])
    await pool.query(`INSERT INTO ${schema}.student_operations_xero_contacts VALUES($1,$2,$3,$4,$5,NULL)`,[tenant,ptyId,id,status,id]);
  for(const [id,status,seen,type] of [[contactId,'DRAFT',run,'ACCREC'],[pending,'PAID',run,'ACCREC'],[pending,'AUTHORISED',run,'ACCRECCREDIT'],[archived,'PAID',run,'ACCREC'],[deletedOnly,'DELETED',run,'ACCREC'],[supplier,'PAID',oldRun,'ACCREC'],[otherCustomer,'DRAFT',run,'ACCREC']])
    await pool.query(`INSERT INTO ${schema}.student_operations_xero_invoices(customer_id,xero_connection_id,xero_invoice_id,xero_contact_id,invoice_status,last_seen_sync_run_id,invoice_type) VALUES($1,$2,$3,$4,$5,$6,$7)`,[tenant,ptyId,randomUUID(),id,status,seen,type]);
  await pool.query(`INSERT INTO ${schema}.student_college_xero_contact_links(customer_id,xero_connection_id,xero_contact_id,classification,reviewed_by) VALUES($1,$2,$3,'other','actor')`,[tenant,ptyId,otherCustomer]);
  const matching=new StudentCollegeMatchingService({tenantTransaction:tx,tenantReadTransaction:tx} as never);
  const result=await matching.list(p,ptyId,{});
  expect(result.total).toBe(1);expect(result.items).toEqual([expect.objectContaining({contactId:pending,invoiceCount:2})]);
  expect(result.summary).toEqual({importedContacts:6,activeContacts:5,archivedContacts:1,salesContacts:4,pendingSalesContacts:1,salesTransactions:5,linkedTransactions:1});
  const all=await matching.list(p,ptyId,{scope:'all',status:'all',includeColleges:'false',page:3,limit:25});
  expect(all.total).toBe(6);expect(all.items).toEqual([]);expect(all).not.toHaveProperty('colleges');
  expect((await matching.list(p,ptyId,{scope:'active',status:'all'})).total).toBe(5);
  await expect(matching.list({tenantId:tenant,identityUserId:'advisor',role:'advisor'} as never,ptyId,{})).rejects.toThrow(ForbiddenException);
  await expect(matching.list({tenantId:other,identityUserId:'other',role:'chief_executive'} as never,ptyId,{})).rejects.toThrow('PTY organisation not found');
 });
 it('applies real migrations with forced RLS and no unrestricted Business Manager grant',async()=>{
  const role=await pool.query("SELECT rolbypassrls FROM pg_roles WHERE rolname='sophia_runtime_app'");expect(role.rows[0].rolbypassrls).toBe(false);
  const rules=await tx(tenant,db=>db.query(`SELECT * FROM ${schema}.student_college_commission_rules`));expect(rules.rowCount).toBe(1);
  expect((await tx(other,db=>db.query(`SELECT * FROM ${schema}.student_college_commission_rules`))).rowCount).toBe(0);
  await expect(tx(tenant,db=>db.query('SELECT * FROM public.bm_college_commission_rules'))).rejects.toThrow('permission denied');
 });
 it('returns the local Type of Sale list, defaults to Instalment and saves per-invoice choices',async()=>{
  expect((await tx(tenant,db=>readPtySaleOptions(db,tenant))).map(o=>o.name)).toEqual(['Instalment','Marketing']);
  expect(await tx(other,db=>readPtySaleOptions(db,other))).toEqual([]);
  const options=await service.options(p,caseId,collegeId);
  expect(options).toMatchObject({defaultTypeOfSaleOptionId:itemId,typeOfSaleOptions:[{value:itemId,label:'Instalment'},{value:batchId,label:'Marketing'}]});
  await service.prepare(p,caseId,batchId,{batchRevision:1,selections:[{sequence:1},{sequence:2,typeOfSaleOptionId:batchId}]});
  expect((await service.list(p,caseId,batchId)).items.map(row=>row.snapshot.value.lines[0].tracking[0].option)).toEqual(['Instalment','Marketing']);
  await trustReceipts(2);await service.create(p,caseId,batchId,{sequences:[2],confirmed:true});
  expect(createInvoice.mock.calls[0][0].lines[0].tracking).toEqual([{name:'Type of Sale',option:'Marketing',trackingCategoryId:trustId,trackingOptionId:batchId}]);
 });
 it('uses the offer Type of Sale snapshot unless explicitly overridden for PTY',async()=>{
  const reviewed=structuredClone(snapshot);reviewed.invoices[0].typeOfSaleOptionId=batchId;reviewed.invoices[1].typeOfSaleOptionId=batchId;
  await pool.query(`UPDATE ${schema}.student_case_invoice_draft_batches SET snapshot=$3 WHERE customer_id=$1 AND batch_id=$2`,[tenant,batchId,JSON.stringify(reviewed)]);
  await service.prepare(p,caseId,batchId,{batchRevision:1,selections:[{sequence:1},{sequence:2,typeOfSaleOptionId:itemId}]});
  expect((await service.list(p,caseId,batchId)).items.map(row=>row.snapshot.value.lines[0].tracking[0].option)).toEqual(['Marketing','Instalment']);
 });
 it('blocks a new commission while its college contact is reserved for case deletion',async()=>{
  await prepareAll();await trustReceipts();
  await pool.query(`INSERT INTO ${schema}.student_case_deletions(customer_id,case_id,targets) VALUES($1,$2,$3)`,[tenant,randomUUID(),JSON.stringify({contacts:[{connectionId:ptyId,contactId,college:true}]})]);
  try{const result=await service.create(p,caseId,batchId,{sequences:[1],confirmed:true});expect(result.results[0]).toMatchObject({status:'not_attempted',message:expect.stringContaining('Finish the case deletion')});expect(createInvoice).not.toHaveBeenCalled();}
  finally{await pool.query(`DELETE FROM ${schema}.student_case_deletions WHERE customer_id=$1`,[tenant]);}
 });
 it('keeps omitted legacy selections on Instalment while metadata is waiting for import',async()=>{
  await pool.query(`UPDATE ${schema}.student_xero_sales_catalogues SET snapshot=snapshot-'trackingCategories'`);
  await prepareAll();expect((await service.list(p,caseId,batchId)).items[0].snapshot.value.lines[0].tracking).toEqual([{name:'Type of Sale',option:'Instalment'}]);
 });
 it('rejects unknown choices and a selection archived since its draft was prepared',async()=>{
  await expect(service.prepare(p,caseId,batchId,{batchRevision:1,selections:[{sequence:1,typeOfSaleOptionId:randomUUID()}]})).rejects.toThrow('active Type of Sale');
  await service.prepare(p,caseId,batchId,{batchRevision:1,selections:[{sequence:1,typeOfSaleOptionId:batchId}]});await trustReceipts();
  await pool.query(`UPDATE ${schema}.student_xero_sales_catalogues SET snapshot=jsonb_set(snapshot,'{trackingCategories,0,options}',(snapshot->'trackingCategories'->0->'options')-1)`);
  const result=await service.create(p,caseId,batchId,{sequences:[1],confirmed:true});expect(result.results[0]).toMatchObject({status:'not_attempted',message:expect.stringContaining('Type of Sale changed')});expect(createInvoice).not.toHaveBeenCalled();
 });
 it('backfills missing tracking through one background catalogue import without bypassing retry backoff',async()=>{
  const previous=process.env.STUDENT_DOCUMENT_WORKFLOW_ENABLED;process.env.STUDENT_DOCUMENT_WORKFLOW_ENABLED='true';
  try{
    await pool.query(`DELETE FROM ${schema}.student_operations_xero_sync_configurations WHERE organisation_role='trust'`);
    const original=(await pool.query(`SELECT snapshot FROM ${schema}.student_xero_sales_catalogues`)).rows[0].snapshot;
    await pool.query(`UPDATE ${schema}.student_xero_sales_catalogues SET snapshot=snapshot-'trackingCategories'`);
    const xero={salesCatalogue:jest.fn(async()=>original)},worker=new StudentXeroSalesCatalogueSync({tenantTransaction:tx,tenantReadTransaction:tx} as never,xero as never);
    expect(await worker.processOne(tenant)).toBe(true);expect(xero.salesCatalogue).toHaveBeenCalledTimes(1);const refreshed=(await pool.query(`SELECT snapshot,error_code,attempts FROM ${schema}.student_xero_sales_catalogues`)).rows[0];expect(refreshed.error_code).toBeNull();expect(refreshed.snapshot.trackingCategories).toBeDefined();expect(await worker.processOne(tenant)).toBe(false);
    await pool.query(`UPDATE ${schema}.student_xero_sales_catalogues SET snapshot=snapshot-'trackingCategories'`);xero.salesCatalogue.mockRejectedValueOnce(new Error('Provider unavailable'));
    expect(await worker.processOne(tenant)).toBe(true);expect(await worker.processOne(tenant)).toBe(false);expect(xero.salesCatalogue).toHaveBeenCalledTimes(2);
  }finally{if(previous===undefined)delete process.env.STUDENT_DOCUMENT_WORKFLOW_ENABLED;else process.env.STUDENT_DOCUMENT_WORKFLOW_ENABLED=previous;}
 });
 it('saves the server calculation and correct PTY recipient/reference, tax and dates',async()=>{
  await prepareAll();const rows=await service.list(p,caseId,batchId),s=rows.items[0].snapshot as any;
  expect(s.calculation).toMatchObject({tuitionMinor:10000,commissionMinor:3000});expect(s.taxMinor).toBe(300);expect(s.value).toMatchObject({contactId,date:'2026-11-11',reference:'Fixture Student',lines:[expect.objectContaining({itemCode:'TUITION',unitAmount:'30.00',accountCode:'200',taxType:'OUTPUT',tracking:[{name:'Type of Sale',option:'Instalment',trackingCategoryId:trustId,trackingOptionId:itemId}]})]});
 });
 it('saves 12 units at 80 dollars for 960 dollars commission and 96 dollars GST',async()=>{
  const changed=structuredClone(snapshot),tuition=changed.invoices[0].lines[0];
  tuition.quantity='12';tuition.unitPrice='320.00';tuition.unitAmountMinor=32000;tuition.amountMinor=384000;changed.invoices[0].totalMinor=386500;
  await pool.query(`UPDATE ${schema}.student_case_invoice_draft_batches SET snapshot=$1`,[JSON.stringify(changed)]);
  await pool.query('UPDATE public.bm_college_commission_rules SET commission_basis_points=2500 WHERE company_id=$1',[tenant]);
  await service.prepare(p,caseId,batchId,{batchRevision:1,selections:[{sequence:1}]});
  const row=(await service.list(p,caseId,batchId)).items[0].snapshot;
  expect(row.value.lines[0]).toMatchObject({quantity:'12',unitAmount:'80.00',itemCode:'TUITION',accountCode:'200'});
  expect(row.calculation.commissionMinor).toBe(96000);expect(row.taxMinor).toBe(9600);expect(row.totalMinor).toBe(105600);
 });
 it('refuses a legacy pending one-unit commission until its TRUST quantity is prepared again',async()=>{
  const changed=structuredClone(snapshot);changed.invoices[0].lines[0].quantity='12';
  await pool.query(`UPDATE ${schema}.student_case_invoice_draft_batches SET snapshot=$1`,[JSON.stringify(changed)]);
  await prepareAll();await trustReceipts();
  await pool.query(`UPDATE ${schema}.student_commission_drafts SET snapshot=jsonb_set(jsonb_set(snapshot,'{value,lines,0,quantity}','"1"'::jsonb),'{value,lines,0,unitAmount}','"30.00"'::jsonb)`);
  const result=await service.create(p,caseId,batchId,{sequences:[1],confirmed:true});
  expect(result.results[0]).toMatchObject({status:'not_attempted',message:expect.stringContaining('quantity or price')});expect(createInvoice).not.toHaveBeenCalled();
 });
 it('derives the PTY item from saved TRUST tuition using organisation-local IDs',async()=>{
  await service.prepare(p,caseId,batchId,{batchRevision:1,selections:[{sequence:1}]});
  expect((await service.list(p,caseId,batchId)).items[0].snapshot.value.lines[0]).toMatchObject({itemCode:'TUITION',accountCode:'200',taxType:'OUTPUT'});
 });
 it('rejects an unrelated client-selected PTY item without saving drafts',async()=>{
  await expect(service.prepare(p,caseId,batchId,{batchRevision:1,selections:[{sequence:1,itemId:randomUUID()}]})).rejects.toThrow('must match');
  expect((await service.list(p,caseId,batchId)).items).toEqual([]);
 });
 it('keeps PTY pending when its catalogue has no corresponding tuition item',async()=>{
  await pool.query(`UPDATE ${schema}.student_xero_sales_catalogues SET snapshot=jsonb_set(snapshot,'{items,0,code}','"DIFFERENT"'::jsonb)`);
  await expect(prepareAll()).rejects.toThrow('one matching item');expect((await service.list(p,caseId,batchId)).items).toEqual([]);
 });
 it('uses each instalment tuition code rather than one global PTY selection',async()=>{
  const otherItem=randomUUID(),changed=structuredClone(snapshot);changed.invoices[1].lines[0].itemCode='VET';
  await pool.query(`UPDATE ${schema}.student_case_invoice_draft_batches SET snapshot=$1`,[JSON.stringify(changed)]);
  await pool.query(`UPDATE ${schema}.student_xero_sales_catalogues SET snapshot=jsonb_set(snapshot,'{items}',(snapshot->'items')||$1::jsonb)`,[JSON.stringify([{itemId:otherItem,code:'VET',name:'VET commission',accountCode:'200',taxType:'OUTPUT'}])]);
  await service.prepare(p,caseId,batchId,{batchRevision:1,selections:[{sequence:1},{sequence:2}]});
  const rows=(await service.list(p,caseId,batchId)).items;expect(rows.map(row=>row.snapshot.value.lines[0].itemCode)).toEqual(['TUITION','VET']);
 });
 it('refuses direct PTY creation until its TRUST receipt exists',async()=>{
  await prepareAll();const r=await service.create(p,caseId,batchId,{sequences:[1],confirmed:true});expect(r.results[0]).toMatchObject({status:'not_attempted',message:expect.stringContaining('TRUST invoice first')});expect(createInvoice).not.toHaveBeenCalled();
 });
 it('allows only the PTY instalment whose corresponding TRUST receipt exists',async()=>{
  await prepareAll(2);await trustReceipts(1,2);
  const result=await service.create(p,caseId,batchId,{sequences:[1,2],confirmed:true});
  expect(result.results).toEqual([expect.objectContaining({sequence:1,status:'not_attempted',message:expect.stringContaining('TRUST invoice first')}),expect.objectContaining({sequence:2,status:'created'})]);
  expect(createInvoice).toHaveBeenCalledTimes(1);
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
 it('auto-matches a numbered college name with one immutable audit event and no repeated writes',async()=>{
  await pool.query(`DELETE FROM ${schema}.student_college_xero_contact_links`);
  await pool.query(`UPDATE ${schema}.student_operations_xero_contacts SET legal_name='Fixture College Pty. Ltd. - 2'`);
  expect((await tx(tenant,db=>autoMatchCollegeContacts(db,tenant,ptyId))).matched).toBe(1);
  expect((await tx(tenant,db=>autoMatchCollegeContacts(db,tenant,ptyId))).matched).toBe(0);
  const audit=await tx(tenant,db=>db.query(`SELECT actor_identity,confirmed_value FROM ${schema}.student_college_xero_mapping_events`));
  expect(audit.rowCount).toBe(1);expect(audit.rows[0].confirmed_value).toMatchObject({college_id:collegeId,method:'normalised_name',confidence:1,algorithm:'college-name-v1'});
 });
 it('matches trading names through the narrow alias view without granting BM table access',async()=>{
  await pool.query(`DELETE FROM ${schema}.student_college_xero_contact_links`);
  await pool.query(`UPDATE public.bm_colleges SET trading_name='English Unlimited; Example Learning, Example Training' WHERE company_id=$1`,[tenant]);
  await pool.query(`UPDATE ${schema}.student_operations_xero_contacts SET legal_name='English Unlimited - 2'`);
  expect((await tx(tenant,db=>autoMatchCollegeContacts(db,tenant,ptyId))).matched).toBe(1);
  expect((await tx(other,db=>db.query(`SELECT * FROM ${schema}.student_college_matching_directory`))).rowCount).toBe(0);
  await expect(tx(tenant,db=>db.query('SELECT * FROM public.bm_colleges'))).rejects.toThrow('permission denied');
 });
 it('maps multiple historical contacts while retaining the explicitly confirmed new-invoice recipient',async()=>{
  const additional=randomUUID();
  await pool.query(`INSERT INTO ${schema}.student_operations_xero_contacts VALUES($1,$2,$3,'ACTIVE','Fixture College - 2',NULL)`,[tenant,ptyId,additional]);
  expect((await tx(tenant,db=>autoMatchCollegeContacts(db,tenant,ptyId))).matched).toBe(1);
  expect((await service.options(p,caseId,collegeId)).issue).toBeNull();await prepareAll();
  expect((await service.list(p,caseId,batchId)).items[0].snapshot.value.contactId).toBe(contactId);
 });
 it('requires human recipient confirmation when several numbered contacts were matched automatically',async()=>{
  await pool.query(`UPDATE ${schema}.student_college_xero_contact_links SET reviewed_by='system:college-name-match:v1'`);
  await pool.query(`INSERT INTO ${schema}.student_operations_xero_contacts VALUES($1,$2,$3,'ACTIVE','Fixture College - 2',NULL)`,[tenant,ptyId,randomUUID()]);
  await tx(tenant,db=>autoMatchCollegeContacts(db,tenant,ptyId));
  expect((await service.options(p,caseId,collegeId)).issue).toContain('invoice recipient');
  await pool.query(`UPDATE ${schema}.student_college_xero_contact_links SET reviewed_by='chief' WHERE xero_contact_id=$1`,[contactId]);
  expect((await service.options(p,caseId,collegeId)).issue).toBeNull();
 });
 it('never overrides human other/unresolved decisions and never matches TRUST contacts',async()=>{
  await pool.query(`UPDATE ${schema}.student_college_xero_contact_links SET classification='other',college_id=NULL`);
  expect((await tx(tenant,db=>autoMatchCollegeContacts(db,tenant,ptyId))).matched).toBe(0);
  expect((await tx(tenant,db=>autoMatchCollegeContacts(db,tenant,trustId))).matched).toBe(0);
  expect((await pool.query(`SELECT classification FROM ${schema}.student_college_xero_contact_links`)).rows[0].classification).toBe('other');
 });
 it('keeps ambiguous directory names pending and scopes candidates to the tenant',async()=>{
  await pool.query(`DELETE FROM ${schema}.student_college_xero_contact_links`);
  await pool.query(`INSERT INTO public.bm_colleges(college_id,company_id,college_name,status) VALUES($1,$2,'Fixture College Ltd','active')`,[randomUUID(),tenant]);
  expect((await tx(tenant,db=>autoMatchCollegeContacts(db,tenant,ptyId))).matched).toBe(0);
  expect((await tx(other,db=>autoMatchCollegeContacts(db,other,ptyId))).matched).toBe(0);
 });
 it('rolls back automatic mappings when the audit cannot be committed',async()=>{
  await pool.query(`DELETE FROM ${schema}.student_college_xero_contact_links`);
  await pool.query(`REVOKE INSERT ON ${schema}.student_college_xero_mapping_events FROM sophia_runtime_app`);
  try{await expect(tx(tenant,db=>autoMatchCollegeContacts(db,tenant,ptyId))).rejects.toThrow('permission denied');}
  finally{await pool.query(`GRANT INSERT ON ${schema}.student_college_xero_mapping_events TO sophia_runtime_app`);}
  expect((await pool.query(`SELECT * FROM ${schema}.student_college_xero_contact_links`)).rowCount).toBe(0);
 });
 it('imports PTY dates, payments and credits idempotently through the actual sync upsert',async()=>{
  const runId=randomUUID(),invoiceId=randomUUID();
  await pool.query(`INSERT INTO ${schema}.student_operations_xero_sync_runs(customer_id,sync_run_id,status,lease_owner,lease_expires_at,invoice_count) VALUES($1,$2,'processing','worker',now()+interval '10 minutes',0)`,[tenant,runId]);
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
