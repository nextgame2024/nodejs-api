import {Module} from '@nestjs/common';
import {NestFactory} from '@nestjs/core';
import {BusinessManagerIdentityBridge} from '../../admin/identity/business-manager-identity.bridge.js';
import {TrustBankCheckWorker} from './trust-bank-check-worker.js';
import {TrustPaymentSubmission} from './trust-payment-submission.js';
import {TrustDispatchWorker} from './trust-dispatch-worker.js';
import {beforeAll,afterAll,describe,it,expect} from '@jest/globals';
import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {DatabaseService} from '../../database/database.service.js';
import {StudentOperationsXeroSyncService} from './student-operations-xero-sync.service.js';
import {TrustStagedDepositsController} from './trust-staged-deposits.controller.js';
import {TrustReceiptsController} from './trust-receipts.controller.js';

import {StudentOperationsWorkspaceService} from './student-operations-workspace.service.js';

const socket = process.env.STUDENT_RECEIPT_TEST_SOCKET;
(socket ? describe : describe.skip)('TRUST receipt links with PostgreSQL', () => {
  const schema = 'receipt_test_' + randomUUID().replaceAll('-','');
  const tenant=randomUUID(), connection=randomUUID(), invoice=randomUUID(), payment=randomUUID();
  const principal = {studentOperationsPrincipal:{tenantId:tenant,identityUserId:'fixture',role:'chief_executive'}} as never;
  const env = {...process.env};
  let admin:pg.Client, db:DatabaseService, service:TrustReceiptsController;
  beforeAll(async () => {
    if (!socket?.startsWith('/private/tmp/sophia-trust-check.')) throw Error('Use a disposable test socket.');
    const url='postgresql://postgres@localhost/postgres?host='+encodeURIComponent(socket)+'&port=54389';
    Object.assign(process.env,{SOPHIA_RUNTIME_DATABASE_URL:url,SOPHIA_RUNTIME_DB_SSL:'false',SOPHIA_RUNTIME_SCHEMA:schema});
    admin = new pg.Client({connectionString:url});
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema};
      GRANT USAGE ON SCHEMA ${schema} TO sophia_runtime_app;
      CREATE TABLE ${schema}.student_operations_xero_invoices(customer_id uuid,xero_connection_id uuid,xero_invoice_id uuid,amount_due numeric,currency_code text,invoice_type text,invoice_status text,settlement jsonb,xero_contact_id uuid,invoice_date date,total numeric,last_seen_sync_run_id uuid,PRIMARY KEY(customer_id,xero_connection_id,xero_invoice_id));
      CREATE TABLE ${schema}.student_operations_xero_sync_configurations(customer_id uuid,xero_connection_id uuid,enabled boolean,organisation_role text,PRIMARY KEY(customer_id,xero_connection_id));
      CREATE TABLE ${schema}.student_xero_sales_catalogues(customer_id uuid,xero_connection_id uuid,snapshot jsonb,revision integer,last_synced_at timestamptz,error_code text,PRIMARY KEY(customer_id,xero_connection_id));
      CREATE TABLE ${schema}.student_operations_xero_sync_runs(customer_id uuid,xero_connection_id uuid,sync_run_id uuid,created_at timestamptz,status text,mode text);
      CREATE TABLE ${schema}.customers(customer_id uuid PRIMARY KEY,status text);
      CREATE TABLE ${schema}.business_pack_entitlements(customer_id uuid,identity_user_id text,role_key text,pack_id text,status text);
      CREATE TABLE ${schema}.student_operations_advisor_roster(customer_id uuid,user_id text,display_name text);
      CREATE TABLE ${schema}.business_pack_access_audit_events(customer_id uuid,identity_user_id text,pack_id text,event_type text,outcome text,correlation_id text,metadata jsonb);
      GRANT INSERT ON ${schema}.business_pack_access_audit_events TO sophia_runtime_app;
      CREATE TABLE ${schema}.xero_connections(customer_id uuid,xero_connection_id uuid,status text,xero_tenant_id text DEFAULT 'fixture',tenant_name text DEFAULT 'Test TRUST');
      CREATE TABLE ${schema}.student_operations_xero_contacts(customer_id uuid,xero_connection_id uuid,xero_contact_id uuid,legal_name text,email text,contact_number text,account_number text,PRIMARY KEY(customer_id,xero_connection_id,xero_contact_id));
      CREATE TABLE ${schema}.student_operations_xero_candidate_reviews(customer_id uuid,xero_connection_id uuid,xero_contact_id uuid,review_status text,student_id uuid);
      CREATE TABLE ${schema}.student_operations_students(customer_id uuid,student_id uuid,legal_name text,student_reference text,PRIMARY KEY(student_id,customer_id));
      ALTER TABLE ${schema}.student_operations_xero_invoices ADD invoice_number text, ADD invoice_reference text, ADD due_date date, ADD amount_paid numeric,
        ADD provider_updated_at timestamptz, ADD line_items jsonb, ADD sent_to_contact boolean, ADD concept text, ADD advisor_name text, ADD college_name text, ADD payment_track text;
      GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO sophia_runtime_app;`);
    await admin.query(`GRANT UPDATE ON ${schema}.student_xero_sales_catalogues TO sophia_runtime_app`);
    for (const file of ['143_trust_receipt_verifications','144_trust_receipt_payment_links','145_trust_receipt_overpayment_links','146_trust_payment_reconciliation_checks','147_trust_reconciliation_check_privileges','148_trust_receipt_payment_purpose','149_trust_reconciliation_claims','150_trust_reconciliation_claim_history','151_trust_receipt_payment_link_note','152_trust_receipt_overpayment_link_note','153_trust_reported_reconciliation_date','154_trust_receipt_bank_transaction_id','155_xero_payment_observations','156_xero_payment_observation_history_index','157_trust_imported_payment_verification','158_trust_statement_record_lineage','159_trust_staged_deposits','160_trust_staged_deposit_privileges','161_trust_invoice_match_decisions','162_trust_split_reservations','163_trust_split_line_allocations','164_trust_residual_reviews','165_trust_receipt_proposals','166_trust_receipt_account_mappings','167_trust_payment_dispatch_queue','168_trust_dispatch_worker_checks','169_trust_payment_submissions','170_trust_payment_bank_checks','171_trust_staged_screenshots','172_trust_payer_relationships']) {
      if (file.startsWith('160_')) await admin.query(`GRANT UPDATE,DELETE,TRUNCATE ON ${schema}.student_trust_staged_deposits TO sophia_runtime_app`);
      if (file.startsWith('147_')) await admin.query(`GRANT UPDATE,DELETE ON ${schema}.student_trust_payment_reconciliation_checks TO sophia_runtime_app`);
      const sql=await readFile(new URL('../../database/migrations/'+file+'.sql',import.meta.url),'utf8');
      await admin.query(sql.replaceAll('__SOPHIA_RUNTIME_SCHEMA__',schema));
    }
    const privileges = await admin.query(`SELECT has_table_privilege('sophia_runtime_app',$1,'UPDATE,DELETE,TRUNCATE') AS mutable`,[schema+'.student_trust_payment_reconciliation_checks']);
    expect(privileges.rows[0].mutable).toBe(false);
    const stagePrivileges=await admin.query(`SELECT has_table_privilege('sophia_runtime_app',$1,'UPDATE,DELETE,TRUNCATE') AS mutable`,
      [schema+'.student_trust_staged_deposits']);
    expect(stagePrivileges.rows[0].mutable).toBe(false);
    db = new DatabaseService();
    service = new TrustReceiptsController(db,new StudentOperationsWorkspaceService(db),{} as never);
  });
  afterAll(async () => {
    if(db) await db.onModuleDestroy();
    if(admin) { await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE'); await admin.end(); }
    for (const name of ['SOPHIA_RUNTIME_SCHEMA','SOPHIA_RUNTIME_DB_SSL','SOPHIA_RUNTIME_DATABASE_URL']) {
      if(env[name]===undefined) delete process.env[name]; else process.env[name]=env[name];
    }
  });
  it('stages an unmatched TRUST deposit once, scopes access, and removes it from the queue after verification',async()=>{
    const staging=new TrustStagedDepositsController(db);
    const conn=randomUUID(), inv=randomUUID(), run=randomUUID();
    const source={account:'Test TRUST',bankTransactionId:'STAGED-1',receivedOn:'2020-01-02',amount:'2742.00',reference:'College fee',
      statementFileName:'deposit.csv',statementFileSha256:'2'.repeat(64),statementRecord:'2'};
    await admin.query(`INSERT INTO ${schema}.xero_connections VALUES($1,$2,'active')`,[tenant,conn]);
    await admin.query(`INSERT INTO ${schema}.student_operations_xero_sync_configurations VALUES($1,$2,true,'operating')`,[tenant,conn]);
    await expect(staging.stage(principal,conn,source)).rejects.toThrow();
    await admin.query(`UPDATE ${schema}.student_operations_xero_sync_configurations SET organisation_role='trust' WHERE xero_connection_id=$1`,[conn]);
    const attempts=await Promise.all([staging.stage(principal,conn,source),staging.stage(principal,conn,source)]);
    expect(attempts.map(r=>r.created).sort()).toEqual([false,true]);
    expect(attempts[0].id).toBe(attempts[1].id);
    expect(await staging.stage(principal,conn,{...source,statementFileSha256:'3'.repeat(64)})).toMatchObject({created:false});
    for (const changes of [{amount:'2743'},{bankTransactionId:'OTHER'},{statementRecord:'1'},{statementFileName:undefined},{receivedOn:'2999-01-01'}]) {
      await expect(staging.stage(principal,conn,{...source,...changes})).rejects.toThrow();
    }
    await expect(staging.list({studentOperationsPrincipal:{tenantId:randomUUID(),role:'chief_executive'}} as never,conn,{})).rejects.toThrow();
    await expect(staging.list({studentOperationsPrincipal:{tenantId:tenant,role:'advisor'}} as never,conn,{})).rejects.toThrow();
    const other={...source,bankTransactionId:'STAGED-2',statementRecord:'3'};
    await staging.stage(principal,conn,other);
    expect(await staging.list(principal,conn,{q:'fee'})).toMatchObject({page:1,hasMore:false,deposits:[{},{}]});
    expect(await staging.list(principal,conn,{q:'STAGED-1'})).toMatchObject({deposits:[{id:attempts[0].id,source:{record:2}}]});
    await admin.query(`INSERT INTO ${schema}.student_operations_xero_invoices VALUES($1,$2,$3,2741.80,'AUD','ACCREC','AUTHORISED',NULL)`,[tenant,conn,inv]);
    await admin.query(`INSERT INTO ${schema}.student_operations_xero_sync_runs VALUES($1,$2,$3,now(),'succeeded','initial')`,[tenant,conn,run]);
    await admin.query(`UPDATE ${schema}.student_operations_xero_invoices SET last_seen_sync_run_id=$1 WHERE xero_invoice_id=$2`,[run,inv]);
    await service.verify(principal,conn,inv,randomUUID(),source);
    expect(await staging.list(principal,conn,{})).toMatchObject({deposits:[{transactionId:'STAGED-2'}]});
    await expect(staging.stage(principal,conn,source)).rejects.toThrow();
    for (let i=0;i<25;i++) await staging.stage(principal,conn,{...other,bankTransactionId:'PAGE-'+i,statementRecord:String(4+i)});
    const firstPage=await staging.list(principal,conn,{page:'1'});
    const secondPage=await staging.list(principal,conn,{page:'2'});
    expect(firstPage.hasMore).toBe(true);
    expect(secondPage.hasMore).toBe(false);
    expect(new Set([...firstPage.deposits,...secondPage.deposits].map(d=>d.id)).size).toBe(26);
    expect((await service.list(principal,conn,inv))[0].statementSource).toMatchObject({record:2,sha256:source.statementFileSha256});
  });

  it('accepts authenticated multipart intake over HTTP and returns private evidence bytes',async()=>{
    const conn=randomUUID(),scope=new StudentOperationsWorkspaceService(db);
    await admin.query(`INSERT INTO ${schema}.xero_connections VALUES($1,$2,'active')`,[tenant,conn]);
    await admin.query(`INSERT INTO ${schema}.student_operations_xero_sync_configurations VALUES($1,$2,true,'trust')`,[tenant,conn]);
    @Module({controllers:[TrustStagedDepositsController],providers:[
      {provide:BusinessManagerIdentityBridge,useValue:{authenticate:async(token:string)=>({userId:token})}},
      {provide:StudentOperationsWorkspaceService,useValue:{recordAccess:scope.recordAccess.bind(scope),
        resolvePrincipal:async({userId}:{userId:string})=>({tenantId:tenant,identityUserId:'http-fixture',role:userId==='Bearer manager'?'chief_executive':'advisor'})}},
      {provide:DatabaseService,useValue:{tenantTransaction:db.tenantTransaction.bind(db),tenantReadTransaction:db.tenantReadTransaction.bind(db)}},
    ]}) class IntakeFixture {}
    const app=await NestFactory.create(IntakeFixture,{logger:false,abortOnError:false});
    try {
      await app.listen(0,'127.0.0.1');
      const base=(await app.getUrl())+'/business-packs/student-operations/v1/workspace/trust-staged-deposits/'+conn;
      const contact=randomUUID();
      await admin.query(`INSERT INTO ${schema}.student_operations_xero_contacts(customer_id,xero_connection_id,xero_contact_id,legal_name)
        VALUES($1,$2,$3,'Test contact')`,[tenant,conn,contact]);
      const payerUrl=base+'/contacts/'+contact+'/payers';
      const review=(role:string)=>fetch(payerUrl,{method:'POST',headers:{Authorization:'Bearer '+role,'Content-Type':'application/json'},
        body:JSON.stringify({name:'Test Parent',relationship:'sponsor',reason:'Bank evidence',active:true,revision:0})});
      expect((await review('advisor')).status).toBe(403);
      expect((await review('manager')).status).toBe(201);
      const payers=await fetch(payerUrl,{headers:{Authorization:'Bearer manager'}});
      expect(payers.headers.get('cache-control')).toContain('no-store');
      expect(await payers.json()).toMatchObject({relationships:[{name:'Test Parent',revision:1}]});
      const upload=(token:string,size=8)=>{
        const data=new FormData(),bytes=new Uint8Array(size);bytes.set([137,80,78,71,13,10,26,10]);
        Object.entries({account:'Test TRUST',receivedOn:'2020-01-02',amount:'55',reference:'fixture',bankTransactionId:'HTTP-1'})
          .forEach(([k,v])=>data.append(k,v));
        data.append('file',new Blob([bytes],{type:'image/png'}),'bank.png');
        return fetch(base+'/screenshot',{method:'POST',headers:token?{Authorization:'Bearer '+token}:{},body:data});
      };
      expect((await upload('')).status).toBe(401);expect((await upload('advisor')).status).toBe(403);
      expect((await upload('manager',5242881)).status).toBe(413);
      const saved=await upload('manager');expect(saved.status).toBe(201);
      const {id}=await saved.json() as {id:string};
      const url=base+'/'+id+'/screenshot';
      expect((await fetch(url,{headers:{Authorization:'Bearer advisor'}})).status).toBe(403);
      const download=await fetch(url,{headers:{Authorization:'Bearer manager'}});
      expect(download.status).toBe(200);expect(download.headers.get('cache-control')).toContain('no-store');
      expect(download.headers.get('content-type')).toContain('image/png');expect(download.headers.get('x-content-type-options')).toBe('nosniff');
      expect(Buffer.from(await download.arrayBuffer()).toString('hex')).toBe('89504e470d0a1a0a');
    } finally {await app.close();}
  });
  it.each(['screenshot only','CSV first','screenshot first'])('carries private evidence through verification (%s)',async mode=>{
    const stage=new TrustStagedDepositsController(db),conn=randomUUID(),inv=randomUUID(),run=randomUUID(),key=randomUUID();
    const bank={account:'Fixture TRUST',reference:'Test reference',amount:'50.00',bankTransactionId:'BANK-ID',receivedOn:'2020-01-02'};
    const csv={statementFileName:'bank.csv',statementFileSha256:'a'.repeat(64),statementRecord:'2'};
    const image={mimetype:'image/png',buffer:Buffer.from('89504e470d0a1a0a','hex')};
    const denied={studentOperationsPrincipal:{tenantId:tenant,identityUserId:'advisor',role:'advisor'}} as never;
    await admin.query(`INSERT INTO ${schema}.xero_connections VALUES($1,$2,'active')`,[tenant,conn]);
    await admin.query(`INSERT INTO ${schema}.student_operations_xero_sync_configurations VALUES($1,$2,true,'operating')`,[tenant,conn]);
    const save=()=>stage.stageScreenshot(principal,conn,bank,image);
    await expect(save()).rejects.toThrow();
    await admin.query(`UPDATE ${schema}.student_operations_xero_sync_configurations SET organisation_role='trust' WHERE xero_connection_id=$1`,[conn]);
    await expect(stage.stageScreenshot(denied,conn,bank,image)).rejects.toThrow();
    await expect(stage.stageScreenshot(principal,conn,bank,{...image,mimetype:'image/jpeg'})).rejects.toThrow();
    await expect(stage.stageScreenshot(principal,conn,bank,{...image,buffer:Buffer.alloc(5242881)})).rejects.toThrow();
    await expect(stage.stageScreenshot(principal,conn,bank)).rejects.toThrow();
    if (mode==='CSV first') await stage.stage(principal,conn,{...bank,...csv});
    const [a,b]=await Promise.all([save(),save()]);
    expect(a.id).toBe(b.id);expect([a.created,b.created].sort()).toEqual([false,true]);
    await expect(stage.stageScreenshot(principal,conn,bank,{...image,buffer:Buffer.concat([image.buffer,Buffer.from('different')])})).rejects.toThrow();
    if (mode==='screenshot first') {
      expect(await stage.stage(principal,conn,{...bank,...csv})).toEqual({id:a.id,created:true});
      expect(await stage.stage(principal,conn,{...bank,...csv})).toEqual({id:a.id,created:false});
      await expect(stage.stage(principal,conn,{...bank,...csv,bankTransactionId:'OTHER'})).rejects.toThrow();
    }
    const listed=(await stage.list(principal,conn,{})).deposits;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({screenshotSha256:createHash('sha256').update(image.buffer).digest('hex'),source:mode==='screenshot only'?null:{record:2}});
    expect(listed[0]).not.toHaveProperty('evidence');
    expect((await stage.screenshot(principal,conn,a.id)).getHeaders().type).toBe('image/png');
    await expect(stage.screenshot(denied,conn,a.id)).rejects.toThrow();
    await expect(stage.screenshot(principal,randomUUID(),a.id)).rejects.toThrow();
    await admin.query(`INSERT INTO ${schema}.student_operations_xero_sync_runs VALUES($1,$2,$3,now(),'succeeded','initial')`,[tenant,conn,run]);
    await admin.query(`INSERT INTO ${schema}.student_operations_xero_invoices(customer_id,xero_connection_id,xero_invoice_id,
      amount_due,currency_code,invoice_type,invoice_status,last_seen_sync_run_id) VALUES($1,$2,$3,50,'AUD','ACCREC','AUTHORISED',$4)`,[tenant,conn,inv,run]);
    const payload={...bank,...(mode==='screenshot only'?{}:csv),stagedScreenshotId:a.id};
    for (const changed of [{stagedScreenshotId:randomUUID()},{amount:'49'},{reference:'Edited'},{bankTransactionId:'OTHER'}])
      await expect(service.verify(principal,conn,inv,key,{...payload,...changed})).rejects.toThrow();
    await expect(service.verify(principal,conn,inv,key,bank)).rejects.toThrow('Choose the saved deposit');
    await expect(service.verify(principal,conn,inv,key,payload,image)).rejects.toThrow();
    expect(await service.verify(principal,conn,inv,key,payload)).toEqual({id:key});
    expect(await service.verify(principal,conn,inv,key,payload)).toEqual({id:key});
    expect((await service.list(principal,conn,inv))[0]).toMatchObject({hasEvidence:true,stagedScreenshotId:a.id});
    const file=await service.evidence(principal,conn,inv,key),chunks:Buffer[]=[];
    for await(const part of file.getStream()) chunks.push(Buffer.from(part));
    expect(Buffer.concat(chunks)).toEqual(image.buffer);
    expect(await stage.list(principal,conn,{})).toMatchObject({deposits:[]});
    await expect(save()).rejects.toThrow();
  });
  it.each(['verification','submission','acknowledged'])('binds an approval to a verified movement during %s',async(mode)=>{
    const conn=randomUUID(),run=randomUUID(),inv=randomUUID(),receipt=randomUUID(),contact=randomUUID();
    await admin.query(`INSERT INTO ${schema}.xero_connections VALUES($1,$2,'active')`,[tenant,conn]);
    await admin.query(`INSERT INTO ${schema}.student_operations_xero_sync_configurations VALUES($1,$2,true,'trust')`,[tenant,conn]);
    await admin.query(`INSERT INTO ${schema}.student_operations_xero_sync_runs VALUES($1,$2,$3,now(),'succeeded','initial')`,[tenant,conn,run]);
    await admin.query(`INSERT INTO ${schema}.student_operations_xero_invoices
      (customer_id,xero_connection_id,xero_invoice_id,currency_code,invoice_type,invoice_status,xero_contact_id,
       amount_due,total,last_seen_sync_run_id,invoice_number,settlement)
      VALUES($1,$2,$3,'AUD','ACCREC','AUTHORISED',$4,3500,3500,$5,'INV-TEST','{"entries":[]}')`,[tenant,conn,inv,contact,run]);
    const updated='2026-11-01T01:00:00Z';
    await admin.query(`UPDATE ${schema}.student_operations_xero_invoices SET provider_updated_at=$2 WHERE xero_invoice_id=$1`,[inv,updated]);
    await service.verify(principal,conn,inv,receipt,{account:'Test TRUST',receivedOn:'2020-01-02',amount:'3000',reference:'Tuition',bankTransactionId:'TEST-01'});
    const read=()=>service.proposal(principal,conn,inv,receipt);
    const save=(body:unknown)=>service.changeProposal(principal,conn,inv,receipt,body);
    const staging=new TrustStagedDepositsController(db),bank=randomUUID();
    const map=(input:unknown)=>staging.changeAccountMapping(principal,conn,input);
    const command={revision:0,catalogueRevision:1,accountId:bank,receiptLabel:'Test TRUST',reason:'Compared bank evidence',requestId:randomUUID()};
    expect((await read()).accountIssue).toContain('current bank account import');
    await expect(map(command)).rejects.toThrow();
    await admin.query(`INSERT INTO ${schema}.student_xero_sales_catalogues VALUES($1,$2,$3,1,now(),NULL)`,[tenant,conn,
      JSON.stringify({receiptBankAccounts:[{id:bank,name:'Bank TRUST'}]})]);
    await expect(map({...command,accountId:randomUUID()})).rejects.toThrow();
    await expect(map({...command,catalogueRevision:0})).rejects.toThrow();
    await expect(staging.accountMapping({studentOperationsPrincipal:{tenantId:randomUUID(),role:'chief_executive'}} as never,conn)).rejects.toThrow();
    expect(await Promise.all([map(command),map(command)])).toEqual([{revision:1},{revision:1}]);
    await expect(map({...command,reason:'Another reason'})).rejects.toThrow();
    expect((await read()).snapshot.mappedAccount).toEqual({id:bank,name:'Bank TRUST',revision:1});
    const initial=await read();
    expect(initial).toMatchObject({state:'new',blocked:null,revision:0,snapshot:{bankId:'TEST-01',amount:'3000.00',due:'3500.00',contactId:contact}});
    const prepare={action:'prepare',reason:'Checked remittance',token:initial.token,revision:0,requestId:randomUUID()};
    await expect(save({...prepare,action:'approve'})).rejects.toThrow();
    await expect(service.proposal({studentOperationsPrincipal:{role:'chief_executive',tenantId:randomUUID()}} as never,conn,inv,receipt)).rejects.toThrow();
    expect(()=>service.changeProposal({studentOperationsPrincipal:{role:'advisor',tenantId:tenant}} as never,conn,inv,receipt,prepare)).toThrow();
    expect(await Promise.all([save(prepare),save(prepare)])).toEqual([{revision:1},{revision:1}]);
    await expect(save({...prepare,reason:'Different evidence'})).rejects.toThrow();
    const approve={...prepare,action:'approve',revision:1,requestId:randomUUID()};
    const results=await Promise.allSettled([save(approve),save({...approve,requestId:randomUUID()})]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect(await read()).toMatchObject({state:'approved',history:[{actor:'fixture',action:'approve'},{action:'prepare'}]});
    const independent={studentOperationsPrincipal:{role:'chief_executive',tenantId:tenant,identityUserId:'reviewer'}} as never;
    expect((await read()).releaseCheck).toContain('independent');
    expect((await service.proposal(independent,conn,inv,receipt)).releaseCheck).toBeNull();
    const enqueue={revision:2,token:initial.token,requestId:randomUUID(),reason:'Checked release'};
    const release=(body:unknown)=>service.enqueue(independent,conn,inv,receipt,body);
    await expect(service.enqueue(principal,conn,inv,receipt,enqueue)).rejects.toThrow();
    await expect(release({...enqueue,token:'0'.repeat(64)})).rejects.toThrow();
    const queued=await Promise.all([release(enqueue),release(enqueue)]);
    expect(queued[0]).toEqual(queued[1]);
    await expect(release({...enqueue,reason:'Other evidence'})).rejects.toThrow();
    await expect(release({...enqueue,requestId:randomUUID()})).rejects.toThrow();
    expect((await read()).dispatch).toMatchObject({id:queued[0].id,actor:'reviewer',cancelledAt:null});
    const live={invoiceId:inv,invoiceNumber:'INV-TEST',contactId:contact,type:'ACCREC',status:'AUTHORISED',currencyCode:'AUD',
      amountDue:3500,updatedAt:updated,settlement:{entries:[]}};
    if (mode!=='verification') {
      const paymentId=randomUUID(),dispatch=queued[0].id;
      let writes=0,visible=false,bankReads=0;
      let bankOutcome:'pending'|'reconciled'|'deleted'='pending';
      const connector={invoiceById:async()=>live as never,trustPaymentSession:async()=>({
        bankStatus:async()=>{bankReads++;return bankOutcome;},bank:async()=>true,submit:async()=>{writes++;if (mode==='acknowledged') return paymentId;throw new Error('lost response');},
        verify:async(_payment:unknown,id?:string)=>{if (visible && mode==='acknowledged') expect(id).toBe(paymentId);return visible?paymentId:null;},
      })};
      const posting=new TrustPaymentSubmission(db,connector);
      const submit=()=>posting.run(tenant,conn,dispatch,'submit');
      expect(await posting.run(tenant,conn,dispatch,'recover')).toEqual({status:'unsubmitted'});
      const keys=['XERO_TRUST_PAYMENT_SUBMISSION_ENABLED','XERO_TRUST_PAYMENT_PILOT_SCOPE','XERO_TRUST_PREFEED_ENABLED','XERO_TRUST_PAYMENT_MAX_AUD'];
      const previous=keys.map(k=>process.env[k]);
      try {
        delete process.env.XERO_TRUST_PAYMENT_SUBMISSION_ENABLED;
        await expect(submit()).rejects.toThrow('disabled');
        process.env.XERO_TRUST_PAYMENT_SUBMISSION_ENABLED='true';process.env.XERO_TRUST_PAYMENT_PILOT_SCOPE=tenant+'/'+randomUUID();
        await expect(submit()).rejects.toThrow('disabled');
        process.env.XERO_TRUST_PAYMENT_PILOT_SCOPE=tenant+'/'+conn;delete process.env.XERO_TRUST_PREFEED_ENABLED;
        process.env.XERO_TRUST_PAYMENT_MAX_AUD='2999.99';
        await expect(submit()).rejects.toThrow('pilot limit');process.env.XERO_TRUST_PAYMENT_MAX_AUD='3000';
        await admin.query(`INSERT INTO ${schema}.customers VALUES($1,'active')`,[tenant]);
        await admin.query(`INSERT INTO ${schema}.business_pack_entitlements VALUES($1,'fixture','chief_executive','student-operations','active')`,[tenant]);
        expect(await new TrustDispatchWorker(db,connector).processOne(tenant,conn)).toMatchObject({status:'matched'});
        process.env.XERO_TRUST_PREFEED_ENABLED='true';
        await expect(submit()).rejects.toThrow('manager permissions');
        await admin.query(`INSERT INTO ${schema}.business_pack_entitlements VALUES($1,'reviewer','chief_executive','student-operations','active')`,[tenant]);
        delete process.env.XERO_TRUST_PREFEED_ENABLED;await expect(submit()).rejects.toThrow('receipt source');
        process.env.XERO_TRUST_PREFEED_ENABLED='true';
        const results=await Promise.all([submit(),submit()]);
        expect(results.map(r=>r.status)).toEqual(['awaiting_verification','awaiting_verification']);
        expect(writes).toBe(1);
        await expect(service.cancelDispatch(principal,conn,inv,receipt,{dispatchId:dispatch,reason:'Late cancellation'})).rejects.toThrow();
        await expect(save({...prepare,action:'withdraw',revision:2,requestId:randomUUID()})).rejects.toThrow();
        expect(await staging.dispatches(principal,conn,{status:'submitted'})).toMatchObject({count:1});
        delete process.env.XERO_TRUST_PAYMENT_SUBMISSION_ENABLED;visible=true;
        expect(await Promise.all([posting.run(tenant,conn,dispatch,'recover'),submit()])).toEqual([
          {status:'confirmed',paymentId},{status:'confirmed',paymentId}]);
        expect(await submit()).toEqual({status:'confirmed',paymentId});expect(writes).toBe(1);
        expect(await staging.dispatches(principal,conn,{status:'confirmed'})).toMatchObject({rows:[{paymentId}]});
        const poller=new TrustBankCheckWorker(db,connector);
        expect(await poller.processOne(randomUUID(),conn)).toBe(false);
        expect(await poller.processOne(tenant,randomUUID())).toBe(false);
        const poll=()=>poller.processOne(tenant,conn);
        expect(await staging.dispatches(principal,conn,{status:'bank_unchecked'})).toMatchObject({count:1});
        expect((await Promise.all([poll(),poll()])).sort()).toEqual([false,true]);
        expect(bankReads).toBe(1);
        expect(await staging.dispatches(principal,conn,{q:paymentId,status:'bank_pending'})).toMatchObject({rows:[{bankOutcome:'pending'}]});
        const advance=()=>admin.query(`UPDATE ${schema}.student_trust_bank_check_results SET checked_at=checked_at-interval '2 days' WHERE dispatch_id=$1`,[dispatch]);
        await advance();bankOutcome='reconciled';expect(await poll()).toBe(true);
        expect(await staging.dispatches(principal,conn,{status:'bank_reconciled'})).toMatchObject({rows:[{bankOutcome:'reconciled'}]});
        await advance();
        expect(await staging.dispatches(principal,conn,{status:'bank_stale'})).toMatchObject({rows:[{bankStale:true,daysSinceConfirmation:0}]});
        expect(await staging.dispatches(principal,conn,{status:'bank_reconciled'})).toMatchObject({count:0});
        bankOutcome='deleted';expect(await poll()).toBe(true);
        expect(await staging.dispatches(principal,conn,{status:'bank_review'})).toMatchObject({rows:[{status:'confirmed',
          bankHistory:[{outcome:'deleted'},{outcome:'reconciled'},{outcome:'pending'}]}]});
        expect(await staging.dispatches(principal,conn,{status:'bank_reconciled'})).toMatchObject({count:0});
        await advance();
        const slow=new TrustBankCheckWorker(db,{trustPaymentSession:async()=>({
          ...await connector.trustPaymentSession(),bankStatus:async()=>{
            await admin.query(`UPDATE ${schema}.student_trust_bank_check_claims SET started_at=now()-interval '3 minutes' WHERE dispatch_id=$1 AND attempt=4`,[dispatch]);
            return 'pending';
          },
        })});
        expect(await slow.processOne(tenant,conn)).toBe(true);
        expect(await staging.dispatches(principal,conn,{})).toMatchObject({rows:[{bankOutcome:'deleted'}]});
        const outage=new TrustBankCheckWorker(db,{trustPaymentSession:async()=>{throw new Error('provider failure');}});
        expect(await outage.processOne(tenant,conn)).toBe(true);
        expect(await staging.dispatches(principal,conn,{status:'bank_review'})).toMatchObject({rows:[{bankOutcome:'unavailable'}]});
        expect(writes).toBe(1);
        expect(await read()).toMatchObject({dispatch:{submitted:true,paymentId}});
        expect((await service.list(principal,conn,inv))[0]).toMatchObject({linkedPaymentId:paymentId,linkedAmount:'3000.00'});
      } finally {
        await admin.query(`DELETE FROM ${schema}.business_pack_entitlements WHERE customer_id=$1`,[tenant]);
        await admin.query(`DELETE FROM ${schema}.customers WHERE customer_id=$1`,[tenant]);
        keys.forEach((key,index)=>{if(previous[index]===undefined)delete process.env[key];else process.env[key]=previous[index];});
      }
      return;
    }
    let response:unknown=live;
    let duringRead:(()=>Promise<unknown>)|undefined;
    const calls:string[][]=[];
    const checks=new TrustReceiptsController(db,new StudentOperationsWorkspaceService(db),{invoiceById:async(...args:string[])=>{
      calls.push(args);await duringRead?.();return response;
    }} as never);
    let workerCalls=0;
    const worker=new TrustDispatchWorker(db,{invoiceById:async()=>{
      workerCalls++;
      if (workerCalls===1) throw new Error('private provider data');
      return live as never;
    }});
    expect(await worker.processOne(randomUUID(),conn)).toEqual({status:'idle'});
    expect(await worker.processOne(tenant,randomUUID())).toEqual({status:'idle'});
    const runWorker=()=>worker.processOne(tenant,conn);
    expect((await Promise.all([runWorker(),runWorker()])).map(r=>r.status).sort()).toEqual(['idle','unavailable']);
    expect(workerCalls).toBe(1);
    expect(await staging.dispatches(principal,conn,{})).toMatchObject({rows:[{workerCheck:{attempt:1,status:'retry',detail:'Invoice verification was unavailable.'}}]});
    await admin.query(`UPDATE ${schema}.student_trust_dispatch_results SET checked_at=now()-interval '3 min' WHERE dispatch_id=$1`,[queued[0].id]);
    // An interrupted second run used its entire lease without producing a result.
    await admin.query(`INSERT INTO ${schema}.student_trust_dispatch_attempts(customer_id,connection_id,dispatch_id,attempt,lease_until)
      VALUES($1,$2,$3,2,now()-interval '1 second')`,[tenant,conn,queued[0].id]);
    expect(await runWorker()).toMatchObject({status:'matched',attempt:3});
    expect(await runWorker()).toEqual({status:'idle'});
    expect(await staging.dispatches(principal,conn,{})).toMatchObject({rows:[{workerCheck:{attempt:3,status:'matched'}}]});
    const check=()=>checks.checkInvoice(principal,conn,inv,receipt,queued[0].id);
    await expect(checks.checkInvoice(principal,conn,inv,receipt,randomUUID())).rejects.toThrow();
    expect(calls).toHaveLength(0);
    expect(await check()).toMatchObject({issue:null});
    expect(calls[0]).toEqual([tenant,conn,inv,'fixture']);
    for (const difference of [{invoiceId:randomUUID()},{contactId:randomUUID()},{status:'PAID'},{type:'ACCPAY'},{currencyCode:'USD'},
      {amountDue:3499},{settlement:undefined},{settlement:{entries:[],omittedKinds:['payment']}},
      {settlement:{entries:[{kind:'payment',id:randomUUID(),amount:50}]}},{updatedAt:null}]) {
      response={...live,...difference};
      expect((await check()).issue).toBeTruthy();
    }
    expect(await staging.dispatches(principal,conn,{q:'TEST-01'})).toMatchObject({count:1,rows:[{status:'recorded',amount:'3000.00',invoice:inv}]});
    await expect(staging.dispatches({studentOperationsPrincipal:{role:'chief_executive',tenantId:randomUUID()}} as never,conn,{})).rejects.toThrow();
    duringRead=()=>admin.query(`UPDATE ${schema}.student_xero_sales_catalogues SET last_synced_at=now()-interval '25 hours' WHERE xero_connection_id=$1`,[conn]);
    response=live;await expect(check()).rejects.toThrow('current dispatch');
    expect(await read()).toMatchObject({state:'stale'});
    await admin.query(`UPDATE ${schema}.student_xero_sales_catalogues SET last_synced_at=now(),snapshot=jsonb_set(snapshot,'{receiptBankAccounts,0,name}','"Renamed TRUST"') WHERE xero_connection_id=$1`,[conn]);
    expect((await read()).accountIssue).toContain('changed');
    const remove={...command,revision:1,requestId:randomUUID(),accountId:null,receiptLabel:null};
    await map(remove);
    expect((await read()).state).toBe('stale');
    await map({...command,revision:2,requestId:randomUUID(),receiptLabel:'Another label'});
    expect((await read()).accountIssue).toContain('label differs');
    await map({...command,revision:3,requestId:randomUUID()});
    expect((await read()).snapshot.mappedAccount?.revision).toBe(4);
    await admin.query(`UPDATE ${schema}.student_operations_xero_invoices SET xero_contact_id=$2 WHERE xero_invoice_id=$1`,[inv,randomUUID()]);
    const changed=await read();
    expect(changed.state).toBe('stale');
    await expect(save({...prepare,revision:2,requestId:randomUUID()})).rejects.toThrow();
    await save({...prepare,revision:2,requestId:randomUUID(),token:changed.token});
    expect((await read()).dispatch?.cancelReason).toContain('revision 3');
    expect(await staging.dispatches(principal,conn,{status:'cancelled'})).toMatchObject({count:1});
    await admin.query(`UPDATE ${schema}.student_trust_receipt_proposals SET expires_at=now()-interval '1 minute'
      WHERE verification_id=$1 AND revision=3`,[receipt]);
    expect((await read()).state).toBe('expired');
    await expect(save({...approve,revision:3,token:changed.token,requestId:randomUUID()})).rejects.toThrow();
    await save({...prepare,action:'withdraw',revision:3,token:changed.token,requestId:randomUUID()});
    expect((await read()).state).toBe('withdrawn');
    await save({...prepare,revision:4,token:changed.token,requestId:randomUUID()});
    await save({...approve,revision:5,token:changed.token,requestId:randomUUID()});
    const second=await release({...enqueue,revision:6,token:changed.token,requestId:randomUUID()});
    expect(second.id).not.toBe(queued[0].id);
    const cancel={dispatchId:second.id,reason:'Incorrect release'};
    const lateWorker=new TrustDispatchWorker(db,{invoiceById:async()=>{
      await admin.query(`UPDATE ${schema}.student_trust_dispatch_attempts SET lease_until=now()-interval '1 second' WHERE dispatch_id=$1`,[second.id]);
      return live as never;
    }});
    expect(await lateWorker.processOne(tenant,conn)).toMatchObject({status:'lease_expired',attempt:1});
    const cancelledWorker=new TrustDispatchWorker(db,{invoiceById:async()=>{
      await service.cancelDispatch(principal,conn,inv,receipt,cancel);
      return live as never;
    }});
    expect(await cancelledWorker.processOne(tenant,conn)).toMatchObject({status:'review',attempt:2});
    expect(await runWorker()).toEqual({status:'idle'});
    expect(await service.cancelDispatch(principal,conn,inv,receipt,cancel)).toEqual(second);
    expect(await service.cancelDispatch(principal,conn,inv,receipt,cancel)).toEqual(second);
    await expect(service.cancelDispatch(principal,conn,inv,receipt,{...cancel,reason:'Different reason'})).rejects.toThrow();
    await expect(release({...enqueue,revision:6,token:changed.token,requestId:randomUUID()})).rejects.toThrow();
    expect(await staging.dispatches(principal,conn,{status:'recorded'})).toMatchObject({count:0});

    await admin.query(`UPDATE ${schema}.student_operations_xero_invoices SET settlement=$2 WHERE xero_invoice_id=$1`,[inv,
      JSON.stringify({entries:[{id:randomUUID(),kind:'payment',amount:3000}]})]);
    expect((await read()).blocked).toContain('imported invoice payment');
    await admin.query(`UPDATE ${schema}.student_operations_xero_invoices SET settlement=NULL WHERE xero_invoice_id=$1`,[inv]);
    expect((await read()).blocked).toContain('complete payment details');
    await admin.query(`UPDATE ${schema}.student_operations_xero_invoices SET amount_due=500 WHERE xero_invoice_id=$1`,[inv]);
    expect((await read()).blocked).toContain('balance');
    await admin.query(`UPDATE ${schema}.student_operations_xero_sync_configurations SET enabled=false WHERE xero_connection_id=$1`,[conn]);
    await expect(save(prepare)).rejects.toThrow();
  });

  it('reserves line purposes under invoice locks and restores capacity on release',async()=>{
    const staging=new TrustStagedDepositsController(db);
    const conn=randomUUID(),run=randomUUID(),inv=randomUUID();
    await admin.query(`INSERT INTO ${schema}.xero_connections VALUES($1,$2,'active')`,[tenant,conn]);
    await admin.query(`INSERT INTO ${schema}.student_operations_xero_sync_configurations VALUES($1,$2,true,'trust')`,[tenant,conn]);
    await admin.query(`INSERT INTO ${schema}.student_operations_xero_sync_runs VALUES($1,$2,$3,now(),'succeeded','initial')`,[tenant,conn,run]);
    const items=[{lineItemId:randomUUID(),description:'Tuition',lineAmount:100,taxAmount:0},
      {lineItemId:randomUUID(),description:'Materials',lineAmount:20,taxAmount:5}];
    await admin.query(`INSERT INTO ${schema}.student_operations_xero_invoices
      (customer_id,xero_connection_id,xero_invoice_id,currency_code,invoice_type,invoice_status,
       amount_due,total,last_seen_sync_run_id,line_items) VALUES($1,$2,$3,'AUD','ACCREC','AUTHORISED',125,125,$4,$5)`,
      [tenant,conn,inv,run,JSON.stringify(items)]);
    const stage=(n:number)=>staging.stage(principal,conn,{account:'Trust',receivedOn:'2020-01-02',amount:'40',reference:'test',
      bankTransactionId:'LINE-'+n,statementFileName:'bank.csv',statementFileSha256:'6'.repeat(64),statementRecord:String(n)});
    const deposits=await Promise.all([stage(2),stage(3)]);
    const lookup=()=>staging.invoiceLines(principal,conn,deposits[0].id,inv);
    const options=(await lookup()).lines;
    expect(options.map(row=>row.available)).toEqual(['100.00','25.00']);
    await expect(staging.invoiceLines({studentOperationsPrincipal:{tenantId:randomUUID(),role:'chief_executive'}} as never,
      conn,deposits[0].id,inv)).rejects.toThrow();
    const line={lineId:options[1].lineId,token:options[1].token,amount:'20'};
    const input={invoiceId:inv,expectedBalance:'125',amount:'30',lines:[line]};
    const preview=(row:unknown)=>staging.previewSplit(principal,conn,deposits[0].id,{allocations:[row]});
    expect(await preview(input)).toMatchObject({unassigned:'10.00',allocations:[{purposeUnassigned:'10.00',lines:[
      {lineId:line.lineId,gross:'25.00',amount:'20.00'}]}]});
    for (const invalid of [{...input,amount:'19'},{...input,lines:[line,line]},
      {...input,lines:[{...line,amount:'26'}]},{...input,lines:[{...line,token:'0'.repeat(64)}]}]) {
      await expect(preview(invalid)).rejects.toThrow();
    }
    const results=await Promise.allSettled(deposits.map(d=>staging.changeReservation(principal,conn,d.id,{
      action:'reserve',allocations:[input],reason:'Remittance',revision:0,requestId:randomUUID()})));
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    const winner=deposits[results.findIndex(r=>r.status==='fulfilled')];
    expect((await lookup()).lines[1].available).toBe('5.00');
    expect((await staging.candidates(principal,conn,winner.id,{})).reservation.plan.allocations[0].lines[0].label).toBe('Materials');
    const student=randomUUID(),contact=randomUUID();
    await admin.query(`INSERT INTO ${schema}.student_operations_students VALUES($1,$2,'Student Example','S-42')`,[tenant,student]);
    await admin.query(`UPDATE ${schema}.student_operations_xero_invoices SET xero_contact_id=$2 WHERE xero_invoice_id=$1`,[inv,contact]);
    await admin.query(`INSERT INTO ${schema}.student_operations_xero_candidate_reviews VALUES($1,$2,$3,'accepted',$4)`,[tenant,conn,contact,student]);
    const list=(query={})=>staging.residuals(principal,conn,query);
    expect(await list()).toMatchObject({count:1,total:'10.00',rows:[{student:null,revision:0}]});
    const pending=await staging.residual(principal,conn,winner.id);
    expect(pending.choices).toMatchObject([{id:student,reference:'S-42'}]);
    const assign={studentId:student,requestId:randomUUID(),revision:0,reservation:1,reason:'Reviewed remittance'};
    const save=(body:unknown)=>staging.reviewResidual(principal,conn,winner.id,body);
    await expect(save({...assign,studentId:randomUUID()})).rejects.toThrow();
    await expect(staging.reviewResidual({studentOperationsPrincipal:{tenantId:randomUUID(),role:'chief_executive'}} as never,
      conn,winner.id,assign)).rejects.toThrow();
    expect(await Promise.all([save(assign),save(assign)])).toEqual([{revision:1},{revision:1}]);
    await expect(save({...assign,reason:'Different'})).rejects.toThrow();
    expect(await list({status:'assigned',q:'s-42'})).toMatchObject({count:1,total:'10.00',rows:[{student:'Student Example'}]});
    expect(await list({studentId:student})).toMatchObject({count:1,total:'10.00'});
    expect(await list({studentId:randomUUID()})).toMatchObject({count:0,total:'0.00'});
    expect(await list({status:'unassigned'})).toMatchObject({count:0,total:'0.00'});
    await expect(save({...assign,studentId:null,requestId:randomUUID()})).rejects.toThrow();
    await save({...assign,studentId:null,revision:1,requestId:randomUUID(),reason:'Corrected payer evidence'});
    expect((await staging.residual(principal,conn,winner.id)).history.map(r=>r.studentId)).toEqual([null,student]);
    await staging.changeReservation(principal,conn,winner.id,{action:'release',revision:1,reason:'Correction',requestId:randomUUID()});
    expect(await list()).toMatchObject({count:0,total:'0.00'});
    await expect(save({...assign,revision:2,requestId:randomUUID()})).rejects.toThrow();
    expect((await lookup()).lines[1].available).toBe('25.00');
    items[1].description='Revised supplies';
    await admin.query(`UPDATE ${schema}.student_operations_xero_invoices SET line_items=$2 WHERE xero_invoice_id=$1`,[inv,JSON.stringify(items)]);
    await expect(preview(input)).rejects.toThrow('Refresh the invoice lines');
    await admin.query(`UPDATE ${schema}.student_operations_xero_invoices SET amount_due=100 WHERE xero_invoice_id=$1`,[inv]);
    expect((await lookup()).lines).toEqual([]);
  });

  it('ranks reviewed payers across contacts, records conflicts and invalidates withdrawn evidence',async()=>{
    const staging=new TrustStagedDepositsController(db),conn=randomUUID(),run=randomUUID();
    const family=randomUUID(),other=randomUUID();
    await admin.query(`INSERT INTO ${schema}.xero_connections VALUES($1,$2,'active')`,[tenant,conn]);
    await admin.query(`INSERT INTO ${schema}.student_operations_xero_sync_configurations VALUES($1,$2,true,'trust')`,[tenant,conn]);
    await admin.query(`INSERT INTO ${schema}.student_operations_xero_sync_runs VALUES($1,$2,$3,now(),'succeeded','initial')`,[tenant,conn,run]);
    for (const [id,name,number] of [[family,'Aria Green','INV-10'],[other,'Robin Fox','INV-20']]) {
      await admin.query(`INSERT INTO ${schema}.student_operations_xero_contacts(customer_id,xero_connection_id,xero_contact_id,legal_name)
        VALUES($1,$2,$3,$4)`,[tenant,conn,id,name]);
      await admin.query(`INSERT INTO ${schema}.student_operations_xero_invoices(customer_id,xero_connection_id,xero_invoice_id,xero_contact_id,
        invoice_status,currency_code,invoice_type,amount_due,last_seen_sync_run_id,invoice_number)
        VALUES($1,$2,$3,$4,'AUTHORISED','AUD','ACCREC',100,$5,$6)`,[tenant,conn,randomUUID(),id,run,number]);
    }
    const sponsor={name:'Lee-West',relationship:'sponsor',reason:'Reviewed signed remittance',active:true,revision:0};
    const confirm=()=>staging.reviewPayer(principal,conn,family,sponsor);
    await expect(staging.reviewPayer(principal,conn,randomUUID(),sponsor)).rejects.toThrow();
    await expect(staging.reviewPayer(principal,conn,family,{...sponsor,name:'1234'})).rejects.toThrow();
    const outsider={studentOperationsPrincipal:{tenantId:randomUUID(),identityUserId:'other',role:'chief_executive'}} as never;
    await expect(staging.reviewPayer(outsider,conn,family,sponsor)).rejects.toThrow();
    await expect(staging.payers(outsider,conn,family)).rejects.toThrow();
    expect(await Promise.all([confirm(),confirm()])).toEqual([{revision:1},{revision:1}]);
    expect(await staging.payers(principal,conn,family)).toMatchObject({relationships:[{name:'Lee-West',active:true,revision:1,actor:'fixture'}]});
    let record=1;
    const stage=async(reference:string)=>{
      record++;
      return (await staging.stage(principal,conn,{account:'Family',bankTransactionId:'REF-'+record,receivedOn:'2020-02-01',amount:'95',
        reference,statementFileName:'test.csv',statementFileSha256:'5'.repeat(64),statementRecord:String(record)})).id;
    };
    const get=(id:string,q='')=>staging.candidates(principal,conn,id,{q});
    const sponsorOnly=await stage('Transfer LEE / west');
    const chosen=(await get(sponsorOnly)).invoices[0];
    expect(chosen).toMatchObject({contactId:family,contactConflict:false,payerMatches:[{relationship:'sponsor',name:'Lee-West',revision:1}],score:4});
    const unknown=await stage('Lee Western');
    expect((await get(unknown)).invoices).toEqual([]);
    expect((await get(unknown,'lee-west')).invoices).toMatchObject([{contactId:family,score:0,payerMatches:[]}]);
    expect((await get(await stage('Aria Green payment'))).invoices).toMatchObject([{contactId:family,contactMatch:true}]);
    const competing=await stage('INV-20 Lee West');
    expect((await get(competing)).invoices).toMatchObject([{contactId:other,contactConflict:true},{contactId:family,contactConflict:true}]);
    expect((await get(competing,'INV-20')).invoices).toMatchObject([{contactConflict:true}]);
    const decision={invoiceId:chosen.id,q:'',page:1,revision:0,evidenceToken:chosen.evidenceToken,decision:'accepted',reason:'Checked remittance',requestId:randomUUID()};
    await staging.decide(principal,conn,sponsorOnly,decision);
    const revoke={...sponsor,active:false,reason:'Mandate ended',revision:1};
    await staging.reviewPayer(principal,conn,family,revoke);
    await expect(confirm()).rejects.toThrow('Reload');
    expect((await get(sponsorOnly)).invoices).toEqual([]);
    expect((await get(sponsorOnly,'INV-10')).invoices).toMatchObject([{evidenceChanged:true}]);
    await expect(staging.decide(principal,conn,sponsorOnly,{...decision,requestId:randomUUID(),revision:1})).rejects.toThrow('changed');
    expect((await staging.payers(principal,conn,family)).relationships[0]).toMatchObject({active:false,revision:2});
  });

  it('ranks scoped current AUD invoice suggestions, preserves ties and abstains without evidence',async()=>{
    const staging=new TrustStagedDepositsController(db);
    const conn=randomUUID(),run=randomUUID(),oldRun=randomUUID(),contact=randomUUID();
    await admin.query(`INSERT INTO ${schema}.xero_connections VALUES($1,$2,'active')`,[tenant,conn]);
    await admin.query(`INSERT INTO ${schema}.student_operations_xero_sync_configurations VALUES($1,$2,true,'trust')`,[tenant,conn]);
    await admin.query(`INSERT INTO ${schema}.student_operations_xero_sync_runs VALUES
      ($1,$2,$3,now()-interval '1 day','succeeded','initial'),($1,$2,$4,now(),'succeeded','reconciliation')`,[tenant,conn,oldRun,run]);
    await admin.query(`INSERT INTO ${schema}.student_operations_xero_contacts(customer_id,xero_connection_id,xero_contact_id,legal_name)
      VALUES($1,$2,$3,'Sponsor % Test')`,[tenant,conn,contact]);
    const insert=(number:string,ref:string,amount:string,currency='AUD',status='AUTHORISED',seen=run)=>
      admin.query(`INSERT INTO ${schema}.student_operations_xero_invoices
        (customer_id,xero_connection_id,xero_invoice_id,xero_contact_id,currency_code,invoice_type,invoice_status,
         amount_due,last_seen_sync_run_id,invoice_number,invoice_reference)
        VALUES($1,$2,$3,$4,$5,'ACCREC',$6,$7,$8,$9,$10)`,[tenant,conn,randomUUID(),contact,currency,status,amount,seen,number,ref]);
    await insert('INV-7','School','125');
    await insert('INV-8','inv-7','99.8');
    for (let i=0;i<12;i++) await insert('EQUAL-'+i,'Different','100');
    await insert('OTHER','No match','800');
    await insert('USD','INV-7','100','USD');
    await insert('VOID','INV-7','100','AUD','VOIDED');
    await insert('OLD','INV-7','100','AUD','AUTHORISED',oldRun);
    const body={account:'Test',bankTransactionId:'MATCH-1',receivedOn:'2020-01-02',amount:'100',reference:'Inv-7',
      statementFileName:'bank.csv',statementFileSha256:'4'.repeat(64),statementRecord:'2'};
    const {id}=await staging.stage(principal,conn,body);
    const get=(query:Record<string,string>={})=>staging.candidates(principal,conn,id,query);
    const first=await get();
    expect(first.ruleVersion).toBe(2);
    expect(first.invoices.slice(0,2)).toMatchObject([
      {invoiceNumber:'INV-7',numberMatch:true,difference:'-25.00'},
      {invoiceNumber:'INV-8',referenceMatch:true,difference:'0.20'}]);
    expect(first.invoices[2]).toMatchObject({amountMatch:true,peers:12,score:1});
    const next=await get({page:'2'});
    expect(next.hasMore).toBe(false);
    expect(new Set([...first.invoices,...next.invoices].map(row=>row.id)).size).toBe(14);
    expect((await get({q:'OTHER'})).invoices).toMatchObject([{invoiceNumber:'OTHER',score:0}]);
    expect((await get({q:'sponsor %'})).invoices).toHaveLength(10);
    const noEvidence=await staging.stage(principal,conn,{...body,reference:'',amount:'89',bankTransactionId:'MATCH-2',statementRecord:'3'});
    expect((await staging.candidates(principal,conn,noEvidence.id,{})).invoices).toEqual([]);
    await expect(staging.candidates(principal,conn,randomUUID(),{})).rejects.toThrow();
    await expect(staging.candidates({studentOperationsPrincipal:{tenantId:randomUUID(),role:'chief_executive'}} as never,conn,id,{})).rejects.toThrow();
    const embedded=await staging.stage(principal,conn,{...body,reference:'Transfer for INV-7, thank you',amount:'89',bankTransactionId:'MATCH-3',statementRecord:'4'});
    expect((await staging.candidates(principal,conn,embedded.id,{})).invoices).toMatchObject([{invoiceNumber:'INV-7',numberInReference:true}]);
    const longer=await staging.stage(principal,conn,{...body,reference:'Transfer INV-70',amount:'89',bankTransactionId:'MATCH-4',statementRecord:'5'});
    expect((await staging.candidates(principal,conn,longer.id,{})).invoices).toEqual([]);
    const report=(extra:Record<string,unknown>={})=>staging.outcomes(principal,conn,{from:'2020-01-02',to:'2020-01-02',...extra});
    expect(await report()).toMatchObject({total:4,reviewed:0,medianReviewMinutes:null,counts:{unreviewed:4},bands:[]});
    await expect(report({from:'2018-01-01'})).rejects.toThrow();
    await expect(report({to:'2020-01-01'})).rejects.toThrow();
    await expect(staging.outcomes({studentOperationsPrincipal:{tenantId:randomUUID(),role:'chief_executive'}} as never,conn,
      {from:'2020-01-02',to:'2020-01-02'})).rejects.toThrow();
    const a=first.invoices[0], b=first.invoices[1];
    const left={invoiceId:a.id,expectedBalance:a.balance,amount:'70.13'};
    const right={invoiceId:b.id,expectedBalance:b.balance,amount:'29.67'};
    const split=(allocations:unknown[])=>staging.previewSplit(principal,conn,id,{allocations});
    expect(await split([left,right])).toEqual({allocated:'99.80',unassigned:'0.20',allocations:[
      {invoiceId:a.id,invoiceNumber:'INV-7',amount:'70.13',remainingDue:'54.87'},
      {invoiceId:b.id,invoiceNumber:'INV-8',amount:'29.67',remainingDue:'70.13'}]});
    expect(await split([{...left,amount:'100'}])).toMatchObject({allocated:'100.00',unassigned:'0.00'});
    for (const invalid of [[],Array(21).fill(left),[left,{...left,invoiceId:a.id.toUpperCase()}],
      [left,{...right,amount:'30'}],[{...right,amount:'100'}],[{...left,amount:'0'}],
      [{...left,amount:'0.001'}],[{...left,expectedBalance:'100'}],[{...left,invoiceId:randomUUID()}]]) {
      await expect(split(invalid)).rejects.toThrow();
    }
    await expect(staging.previewSplit({studentOperationsPrincipal:{tenantId:randomUUID(),role:'chief_executive'}} as never,
      conn,id,{allocations:[left]})).rejects.toThrow();
    const reservation={action:'reserve',revision:0,requestId:randomUUID(),reason:'Reviewed payer remittance',allocations:[left,right]};
    const change=(deposit:string,input:unknown)=>staging.changeReservation(principal,conn,deposit,input);
    const second={...reservation,requestId:randomUUID(),allocations:[{...left,amount:'60.00'}]};
    const competing=await Promise.allSettled([change(id,reservation),change(embedded.id,second)]);
    expect(competing.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    const firstWon=competing[0].status==='fulfilled';
    const winner=firstWon?id:embedded.id, loser=firstWon?embedded.id:id;
    const accepted=firstWon?reservation:second, rejected=firstWon?second:reservation;
    expect(await change(winner,accepted)).toEqual({revision:1});
    await expect(change(winner,{...accepted,reason:'Changed request'})).rejects.toThrow('request changed');
    const snapshot=(await staging.candidates(principal,conn,winner,{})).reservation;
    expect(snapshot).toMatchObject({revision:1,action:'reserve',reason:accepted.reason,actor:'fixture'});
    expect(snapshot.plan.allocated).toBe(firstWon?'99.80':'60.00');
    // Verify a different movement on the reserved invoice, then the reserved movement on another invoice.
    await expect(service.verify(principal,conn,a.id,randomUUID(),{...body,bankTransactionId:'MANUAL',
      statementFileName:undefined,statementFileSha256:undefined,statementRecord:undefined})).rejects.toThrow('active split');
    const source=firstWon?body:{...body,bankTransactionId:'MATCH-3',statementRecord:'4',amount:'89'};
    await expect(service.verify(principal,conn,first.invoices[2].id,randomUUID(),source)).rejects.toThrow('active split');
    const release={action:'release',revision:1,requestId:randomUUID(),reason:'Corrected remittance'};
    await expect(change(winner,{...release,revision:0})).rejects.toThrow('current reservation');
    await expect(staging.changeReservation({studentOperationsPrincipal:{tenantId:randomUUID(),role:'chief_executive'}} as never,
      conn,winner,release)).rejects.toThrow();
    expect(await Promise.all([change(winner,release),change(winner,release)])).toEqual([{revision:2},{revision:2}]);
    expect((await staging.candidates(principal,conn,winner,{})).reservation).toMatchObject({revision:2,action:'release',plan:null});
    await change(loser,rejected);
    // Different deposits can reserve disjoint portions of one invoice.
    const small={...reservation,revision:2,requestId:randomUUID(),allocations:[{...left,amount:'1.00'}]};
    await change(winner,small);
    await change(winner,{...release,revision:3,requestId:randomUUID()});
    await change(loser,{...release,requestId:randomUUID()});
    const command={invoiceId:a.id,requestId:randomUUID(),decision:'accepted',reason:'Compared the remittance',
      revision:0,evidenceToken:a.evidenceToken,q:'',page:1};
    await expect(staging.decide(principal,conn,id,{...command,reason:' '})).rejects.toThrow();
    await expect(staging.decide(principal,conn,id,{...command,evidenceToken:'0'.repeat(64)})).rejects.toThrow();
    const writes=await Promise.all([staging.decide(principal,conn,id,command),staging.decide(principal,conn,id,command)]);
    expect(writes).toEqual([{revision:1},{revision:1}]);
    await expect(staging.decide(principal,conn,id,{...command,reason:'other'})).rejects.toThrow();
    await expect(staging.decide(principal,conn,id,{...command,requestId:randomUUID()})).rejects.toThrow();
    expect(await report({outcome:'awaiting_receipt'})).toMatchObject({total:4,reviewed:1,filteredTotal:1,
      deposits:[{id,acceptedId:a.id,verifiedId:null,outcome:'awaiting_receipt'}]});
    const alternate={...command,invoiceId:b.id,evidenceToken:b.evidenceToken,revision:1,requestId:randomUUID()};
    const changes=await Promise.allSettled([staging.decide(principal,conn,id,alternate),
      staging.decide(principal,conn,id,{...alternate,requestId:randomUUID()})]);
    expect(changes.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect((await get()).invoices.slice(0,2)).toMatchObject([{decision:'superseded'},{decision:'accepted'}]);
    await staging.decide(principal,conn,id,{...alternate,decision:'dismissed',reason:'Payer supplied a correction',
      revision:2,requestId:randomUUID()});
    expect(await report({outcome:'dismissed'})).toMatchObject({deposits:[{id,acceptedId:null}],reviewed:1});
    const history=await staging.decisions(principal,conn,id,{});
    expect(history.entries).toMatchObject([{revision:3,decision:'dismissed',ruleVersion:2,reviewer:'fixture',
      evidence:{id:b.id,balance:'99.80',lookup:'suggested'}},{revision:2,decision:'accepted'},{revision:1,reason:command.reason}]);
    expect((await staging.decisions(principal,conn,id,{before:2})).entries).toHaveLength(1);
    await admin.query(`UPDATE ${schema}.student_operations_xero_invoices SET amount_due=132 WHERE xero_invoice_id=$1`,[a.id]);
    await expect(split([left,right])).rejects.toThrow('balance changed');
    expect((await get()).invoices[0]).toMatchObject({evidenceChanged:true});
    await expect(staging.decide(principal,conn,id,{...command,revision:3,requestId:randomUUID()})).rejects.toThrow();
    const invoice=a.id;
    await service.verify(principal,conn,invoice,randomUUID(),body);
    await expect(split([right])).rejects.toThrow('verified receipt');
    await expect(change(noEvidence.id,{...reservation,requestId:randomUUID(),allocations:[
      {...left,amount:'1',expectedBalance:'132'}]})).rejects.toThrow('unlinked receipts');
    expect((await service.list(principal,conn,invoice))[0].reviewedDepositId).toBe(id);
    expect((await staging.decisions(principal,conn,id,{})).entries).toHaveLength(3);
    expect(await staging.decide(principal,conn,id,command)).toEqual({revision:1});
    await expect(staging.decide(principal,conn,id,{...command,revision:3,requestId:randomUUID()})).rejects.toThrow();
    await expect(get()).rejects.toThrow();
    expect(await report({outcome:'no_acceptance'})).toMatchObject({deposits:[{id,acceptedId:null,verifiedId:a.id}],bands:[]});
    for (const [idx,target] of [a.id,b.id].entries()) {
      const deposit={...body,bankTransactionId:'COMPARE-'+idx,statementRecord:String(10+idx)};
      const staged=await staging.stage(principal,conn,deposit);
      const q=idx===0?'':'INV-7';
      const lookup=await staging.candidates(principal,conn,staged.id,{q});
      const chosen=lookup.invoices.find(row=>row.id===a.id)!;
      await staging.decide(principal,conn,staged.id,{...command,q,invoiceId:a.id,evidenceToken:chosen.evidenceToken,requestId:randomUUID()});
      await service.verify(principal,conn,target,randomUUID(),deposit);
    }
    const changed={...body,bankTransactionId:'CONFLICT',statementRecord:'12'};
    await staging.stage(principal,conn,changed);
    await service.verify(principal,conn,a.id,randomUUID(),{...changed,amount:'99'});
    await admin.query(`UPDATE ${schema}.student_trust_staged_deposits d SET staged_at=m.first_review-interval '20 minutes'
      FROM (SELECT deposit_id,min(reviewed_at) AS first_review FROM ${schema}.student_trust_invoice_match_decisions
        WHERE customer_id=$1 AND connection_id=$2 GROUP BY deposit_id) m
      WHERE d.customer_id=$1 AND d.connection_id=$2 AND d.deposit_id=m.deposit_id`,[tenant,conn]);
    const metrics=await report({outcome:'different_invoice'});
    expect(metrics).toMatchObject({total:7,reviewed:3,filteredTotal:1,
      counts:{unreviewed:3,no_acceptance:1,same_invoice:1,different_invoice:1,conflict:1},
      deposits:[{acceptedId:a.id,verifiedId:b.id,outcome:'different_invoice'}],
      bands:[{lookup:'manual',agreed:0,verified:1,version:2},{lookup:'suggested',agreed:1,verified:1,version:2}]});
    expect(metrics.medianReviewMinutes).toBe(20);
    expect((await report({sort:'amount',direction:'asc'})).deposits[0].amount).toBe('89.00');
    expect((await report({sort:'amount',direction:'desc'})).deposits[0].amount).toBe('100.00');
    expect(await report({from:'2020-01-03',to:'2020-01-03'})).toMatchObject({total:0,counts:{},bands:[],deposits:[]});
    for(let n=0;n<5;n++) await staging.stage(principal,conn,{...body,statementRecord:String(20+n),bankTransactionId:'PAGE-OUTCOME-'+n});
    const pages=await Promise.all([1,2].map(page=>report({page,limit:'10'})));
    expect(pages.map(data=>data.deposits.length)).toEqual([10,2]);
    expect(new Set(pages.flatMap(data=>data.deposits.map((row:{id:string})=>row.id))).size).toBe(12);
  });

  it('links only the invoice portion once and flags a later missing payment',async () => {
    const reviewer = {studentOperationsPrincipal:{tenantId:tenant,identityUserId:'reviewer',role:'chief_executive'}} as never;
    await admin.query(`INSERT INTO ${schema}.student_operations_advisor_roster VALUES
      ($1,'reviewer','Fixture Reviewer'),($2,'fixture','Other Tenant Manager')`,[tenant,randomUUID()]);
    const date='2020-01-02', receipt=randomUUID(), second=randomUUID(), run=randomUUID();
    await admin.query(`INSERT INTO ${schema}.student_operations_xero_sync_configurations VALUES($1,$2,true,'trust')`,[tenant,connection]);
    await admin.query(`INSERT INTO ${schema}.student_operations_xero_invoices VALUES($1,$2,$3,2741.80,'AUD','ACCREC','AUTHORISED',NULL)`,[tenant,connection,invoice]);
    await admin.query(`INSERT INTO ${schema}.student_operations_xero_sync_runs VALUES($1,$2,$3,now(),'succeeded','initial')`,[tenant,connection,run]);
    await admin.query(`UPDATE ${schema}.student_operations_xero_invoices SET last_seen_sync_run_id=$1 WHERE xero_invoice_id=$2`,[run,invoice]);
    const input={receivedOn:date,account:'Fixture TRUST',amount:'2742.00',reference:'first'};
    const identical = {...input,reference:'same reference'};
    await admin.query(`UPDATE ${schema}.student_operations_xero_invoices SET invoice_number='TEST-42' WHERE xero_invoice_id=$1`,[invoice]);
    const csvKey=randomUUID();
    const csvInput={...input,bankTransactionId:'CSV-test',statementFileName:'statement.csv',
      statementRecord:'2',statementFileSha256:'f'.repeat(64)};
    for(const changes of [{statementRecord:'1'},{statementRecord:'1002'},{statementRecord:undefined},
      {statementFileSha256:'invalid'},{statementFileName:'../bank.csv'},{bankTransactionId:''}]) {
      await expect(service.verify(principal,connection,invoice,csvKey,{...csvInput,...changes})).rejects.toThrow();
    }
    await service.verify(principal,connection,invoice,csvKey,csvInput);
    await expect(service.verify(principal,connection,invoice,csvKey,{...csvInput,amount:'2742'})).resolves.toEqual({id:csvKey});
    expect(await service.list(principal,connection,invoice)).toMatchObject([{statementSource:{
      name:'statement.csv',sha256:csvInput.statementFileSha256,record:2}}]);
    await expect(service.verify(principal,connection,invoice,csvKey,{...csvInput,statementRecord:'3'})).rejects.toThrow();
    await expect(service.verify(principal,connection,invoice,randomUUID(),{...csvInput,bankTransactionId:'another',account:'alias'})).rejects.toThrow();
    await admin.query(`DELETE FROM ${schema}.student_trust_receipt_verifications WHERE verification_id=$1`,[csvKey]);
    const bankIds = ['BANK-1','BANK-2'];
    const keys = bankIds.map(() => randomUUID());
    await Promise.all(bankIds.map((bankTransactionId,i) =>
      service.verify(principal,connection,invoice,keys[i],{...identical,bankTransactionId})));
    await expect(service.verify(principal,connection,invoice,keys[0],{...identical,bankTransactionId:'BANK-1'})).resolves.toEqual({id:keys[0]});
    await expect(service.verify(principal,connection,invoice,randomUUID(),{...identical,reference:'changed',amount:'3000.00',bankTransactionId:'BANK-1'})).rejects.toMatchObject({response:{errorCode:'trust_bank_transaction_already_verified',invoiceNumber:'TEST-42',invoiceId:invoice,receivedOn:date,amount:'2742.00'}});
    await expect(service.verify(principal,connection,invoice,randomUUID(),identical)).rejects.toThrow();
    expect((await service.list(principal,connection,invoice)).map(r=>r.bankTransactionId).sort()).toEqual(bankIds);
    await admin.query(`DELETE FROM ${schema}.student_trust_receipt_verifications WHERE verification_id=ANY($1::uuid[])`,[keys]);
    const retries = ['2742','2742.0','2742.00'].map(amount =>
      service.verify(principal,connection,invoice,receipt,{...input,amount}));
    expect(await Promise.all(retries)).toEqual(Array(3).fill({id:receipt}));
    const oldHash = createHash('sha256').update(JSON.stringify([
      connection,invoice,date,'2742.0',input.account,input.reference,null
    ])).digest('hex');
    await admin.query(`UPDATE ${schema}.student_trust_receipt_verifications SET payload_hash=$2 WHERE verification_id=$1`,[receipt,oldHash]);
    await expect(service.verify(principal,connection,invoice,receipt,input)).resolves.toEqual({id:receipt});
    await expect(service.verify(principal,connection,invoice,receipt,{...input,amount:'2742.01'})).rejects.toThrow();
    await expect(service.verify(reviewer,connection,invoice,receipt,input)).rejects.toThrow();
    await expect(service.verify(principal,connection,invoice,randomUUID(),{...input,bankTransactionId:'BANK-3'})).rejects.toThrow();
    const tuition = {...input,reference:'second',paymentPurpose:'Tuition instalment'};
    await service.verify(principal,connection,invoice,second,tuition);
    await service.verify(principal,connection,invoice,second,tuition);
    await expect(service.verify(principal,connection,invoice,second,{...tuition,paymentPurpose:'Materials'})).rejects.toThrow();
    await expect(service.verify(principal,connection,invoice,randomUUID(),{...tuition,paymentPurpose:'Materials'})).rejects.toThrow();
    const purposes=await service.list(principal,connection,invoice);
    expect(purposes.find(r=>r.id===receipt)).toMatchObject({paymentPurpose:null,verifiedByName:null});
    await admin.query(`INSERT INTO ${schema}.student_operations_advisor_roster VALUES ($1,'fixture','Fixture Verifier')`,[tenant]);
    expect(purposes.find(r=>r.id===second).paymentPurpose).toBe('Tuition instalment');
    const unlinked = randomUUID();
    const bankId = 'BANK-' + 'X'.repeat(145);
    await service.verify(principal,connection,invoice,unlinked,{...input,reference:'awaiting link',bankTransactionId:bankId});
    const screenshot = Buffer.from('89504e470d0a1a0a','hex');
    await admin.query(`UPDATE ${schema}.student_trust_receipt_verifications SET evidence=$1,evidence_type='image/png' WHERE verification_id=$2`,[screenshot,unlinked]);
    const download = (role:string, targetConnection:string) => service.evidence({
      studentOperationsPrincipal:{tenantId:tenant,identityUserId:'download-fixture',role},
      studentOperationsCorrelationId:'fixture-download'
    } as never,targetConnection,invoice,unlinked);
    expect((await download('chief_executive',connection)).getHeaders().type).toBe('image/png');
    const wrongConnection = randomUUID();
    await expect(download('chief_executive',wrongConnection)).rejects.toMatchObject({status:404});
    await expect(download('advisor',connection)).rejects.toMatchObject({status:403});
    const audit = await admin.query(`SELECT outcome,metadata FROM ${schema}.business_pack_access_audit_events
      WHERE customer_id=$1 AND identity_user_id='download-fixture' AND correlation_id='fixture-download'`,[tenant]);
    expect(audit.rows).toHaveLength(3);
    const target = {action:'trust_receipt.evidence_download',invoiceId:invoice,receiptId:unlinked,connectionId:connection};
    expect(audit.rows).toEqual(expect.arrayContaining([
      {outcome:'allowed',metadata:target}, {outcome:'denied',metadata:target},
      {outcome:'denied',metadata:{...target,connectionId:wrongConnection}}
    ]));
    const credit=randomUUID();
    const entries=[{kind:'payment',id:payment,date,amount:2741.80},{kind:'overpayment',id:credit,date,amount:0.20}];
    await admin.query(`UPDATE ${schema}.student_operations_xero_invoices SET settlement=$1,invoice_status='PAID',amount_due=0`,[JSON.stringify({entries})]);
    const contact=randomUUID();
    await admin.query(`UPDATE ${schema}.student_operations_xero_invoices SET xero_contact_id=$1`,[contact]);
    await admin.query(`INSERT INTO ${schema}.student_operations_xero_invoices
      (customer_id,xero_connection_id,xero_invoice_id,currency_code,invoice_type,invoice_status,xero_contact_id,invoice_date,total,last_seen_sync_run_id)
      VALUES($1,$2,$3,'AUD','RECEIVE-OVERPAYMENT','AUTHORISED',$4,$5,0.20,$6)`,[tenant,connection,credit,contact,date,run]);
    expect((await service.list(principal,connection,invoice))[0]).toMatchObject({candidateIds:[payment],possibleOverpaymentIds:[credit]});
    await expect(service.link(principal,connection,invoice,receipt,credit)).rejects.toThrow();
    const links=await Promise.allSettled([receipt,second].map(id=>service.link(reviewer,connection,invoice,id,payment,{decisionNote:'  Compared bank evidence  '})));
    expect(links.filter(x=>x.status==='fulfilled')).toHaveLength(1);
    const owner=links[0].status==='fulfilled'?receipt:second;
    await admin.query(`INSERT INTO ${schema}.student_xero_payment_observations
      (customer_id,xero_connection_id,xero_invoice_id,payment_id,amount,currency_code,first_seen_run_id,first_seen_at)
      SELECT $1,$2,$3,$4,n,'AUD',$5,timestamptz '2020-01-01' + n * interval '1 day' FROM generate_series(1,6) n`,
      [tenant,connection,invoice,payment,run]);
    const receiptHistory = (await service.list(principal,connection,invoice));
    expect(receiptHistory.find(r=>r.id===owner).paymentObservations.map((o:{amount:string})=>o.amount)).toEqual(['6','5','4','3','2']);
    expect(receiptHistory.find(r=>r.id===unlinked).paymentObservations).toEqual([]);
    const cursor = receiptHistory.find(r=>r.id===owner).observationCursor;
    expect(await service.olderObservations(principal,connection,invoice,owner,payment,cursor))
      .toMatchObject({entries:[{amount:'1'}],nextCursor:null});
    expect(await service.olderObservations(principal,connection,invoice,unlinked,payment,cursor))
      .toEqual({entries:[],nextCursor:null});
    await expect(service.linkOverpayment(principal,connection,invoice,owner,payment)).rejects.toThrow();
    const excessLinks=await Promise.allSettled([receipt,second].map(id=>service.linkOverpayment(principal,connection,invoice,id,credit,{decisionNote:'  Checked credit against deposit  '})));
    expect(excessLinks.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    const excessOwner=excessLinks[0].status==='fulfilled'?receipt:second;
    await service.linkOverpayment(principal,connection,invoice,excessOwner,credit);
    await service.linkOverpayment(principal,connection,invoice,excessOwner,credit,{decisionNote:'Checked credit against deposit'});
    await expect(service.linkOverpayment(principal,connection,invoice,excessOwner,credit,{decisionNote:'Different credit'})).rejects.toThrow();
    const reviews = await service.list(principal,connection,invoice);
    expect(reviews.find(r=>r.id===excessOwner)).toMatchObject({linkedOverpaymentId:credit,overpaymentLinkNote:'Checked credit against deposit',overpaymentLinkedByName:'Fixture Verifier',possibleOverpaymentIds:[credit]});
    expect(reviews.find(r=>r.id!==excessOwner).possibleOverpaymentIds).toEqual([]);
    expect(reviews.find(r=>r.id===owner).paymentLinkNote).toBe('Compared bank evidence');
    await service.link(reviewer,connection,invoice,owner,payment,{decisionNote:'Compared bank evidence'});
    await expect(service.link(reviewer,connection,invoice,owner,payment,{decisionNote:'Changed note'})).rejects.toThrow();
    await service.link(principal,connection,invoice,owner,payment);
    await expect(service.link(principal,connection,randomUUID(),owner,payment)).rejects.toThrow();
    await expect(service.attestReconciliation(principal,connection,randomUUID(),owner,payment)).rejects.toThrow();
    await expect(service.attestReconciliation(principal,connection,invoice,owner,credit)).rejects.toThrow();
    const claims = await Promise.allSettled([principal,reviewer].map(actor=>service.claimReview(actor,connection,invoice,owner,payment)));
    expect(claims.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    const [winner,other]=claims[0].status==='fulfilled'?[principal,reviewer]:[reviewer,principal];
    const first=await service.claimReview(winner,connection,invoice,owner,payment);
    expect((await service.list(winner,connection,invoice)).find(r=>r.id===owner)).toMatchObject({reviewClaimId:first.claimId,reviewOwnedByMe:true});
    await expect(service.releaseReview(other,connection,invoice,owner,payment,first.claimId)).rejects.toThrow();
    await service.releaseReview(winner,connection,invoice,owner,payment,first.claimId);
    const next=await service.claimReview(other,connection,invoice,owner,payment);
    await service.releaseReview(winner,connection,invoice,owner,payment,first.claimId);
    expect((await service.list(winner,connection,invoice)).find(r=>r.id===owner)).toMatchObject({reviewClaimId:next.claimId,reviewOwnedByMe:false});
    const history=await service.claimHistory(winner,connection,invoice,owner,payment);
    expect(history.entries.map(c=>c.id)).toEqual([next.claimId,first.claimId]);
    expect(history.entries[0].releasedAt).toBeNull();
    expect(history.entries[1].releasedAt).toBeInstanceOf(Date);
    expect(history.entries[0].ownerName).toBe(other===principal?'Fixture Verifier':'Fixture Reviewer');
    expect((await service.claimHistory(winner,connection,randomUUID(),owner,payment)).entries).toEqual([]);
    await admin.query(`INSERT INTO ${schema}.student_trust_reconciliation_claims
      (customer_id,connection_id,payment_id,claimed_by,claimed_at,released_at)
      SELECT $1,$2,$3,'former-manager','2020-01-01','2020-01-02' FROM generate_series(1,10)`,[tenant,connection,payment]);
    const newest=await service.claimHistory(winner,connection,invoice,owner,payment);
    const older=await service.claimHistory(winner,connection,invoice,owner,payment,newest.nextCursor);
    expect(newest.entries).toHaveLength(10);
    expect(older.entries).toHaveLength(2);
    expect(new Set([...newest.entries,...older.entries].map(c=>c.id)).size).toBe(12);
    expect(older.entries[0].ownerName).toBeNull();
    expect(older.nextCursor).toBeNull();
    const availablePayment = randomUUID();
    for (const contradiction of [{amount:2741.81}, {date:'2020-01-03'}, {date:null}]) {
      const entries = [payment,availablePayment].flatMap(id => {
        const original = {kind:'payment',id,date,amount:2741.80,isReconciled:false};
        return [original,{...original,...contradiction}];
      });
      await admin.query(`UPDATE ${schema}.student_operations_xero_invoices SET settlement=$1 WHERE xero_invoice_id=$2`,
        [JSON.stringify({entries}),invoice]);
      const receipts = await service.list(principal,connection,invoice);
      expect(receipts.find(r=>r.id===owner)).toMatchObject({linkedPaymentId:payment,linkedPaymentReconciled:null,candidateIds:[]});
      await expect(service.link(principal,connection,invoice,unlinked,availablePayment)).rejects.toThrow();
      await expect(service.attestReconciliation(principal,connection,invoice,owner,payment)).rejects.toThrow();
    }
    for (const flag of [undefined, true, false]) {
      const settlement = {entries:[{kind:'payment',id:payment,date,amount:2741.80,isReconciled:undefined},
        {kind:'payment',id:payment,date,amount:2741.80,isReconciled:flag},
        {kind:'payment',id:randomUUID(),date,amount:2741.80,isReconciled:true}]};
      await admin.query(`UPDATE ${schema}.student_operations_xero_invoices SET settlement=$1 WHERE xero_invoice_id=$2`,[JSON.stringify(settlement),invoice]);
      const linked=(await service.list(principal,connection,invoice)).find(r=>r.id===owner);
      expect(linked.linkedPaymentReconciled).toBe(flag ?? null);
      if (flag === true) await expect(service.attestReconciliation(principal,connection,invoice,owner,payment)).rejects.toThrow();
      if (flag === false) {
        await expect(service.attestReconciliation(reviewer,connection,invoice,owner,payment,{reportedReconciledOn:'2099-01-01'})).rejects.toThrow();
        const checks=await Promise.all([1,2].map(()=>service.attestReconciliation(reviewer,connection,invoice,owner,payment,{reportedReconciledOn:date})));
        await expect(service.attestReconciliation(reviewer,connection,invoice,owner,payment,{reportedReconciledOn:'2020-01-03'})).rejects.toThrow();
        expect(checks[0].checkedAt).toEqual(checks[1].checkedAt);
        const checked=(await service.list(principal,connection,invoice)).find(r=>r.id===owner);
        expect(checked).toMatchObject({verifiedByName:'Fixture Verifier',paymentLinkedByName:'Fixture Reviewer',paymentLinkedAt:expect.any(Date),reconciliationCheckedByName:'Fixture Reviewer',reportedReconciledOn:date,linkedPaymentReconciled:false,reconciliationCheckedAt:checks[0].checkedAt});
      }
    }
    await admin.query(`INSERT INTO ${schema}.xero_connections VALUES($1,$2,'active')`,[tenant,connection]);
    await admin.query(`INSERT INTO ${schema}.student_operations_xero_contacts VALUES($1,$2,$3,'Fixture')`,[tenant,connection,contact]);
    await admin.query(`UPDATE ${schema}.student_operations_xero_invoices SET last_seen_sync_run_id=$1 WHERE xero_invoice_id=$2`,[run,invoice]);
    const anotherPayment = randomUUID();
    const pendingEntries = [payment,anotherPayment].map(id=>({kind:'payment',id,date,amount:2741.80,isReconciled:false}));
    const writeEntries = () => admin.query(`UPDATE ${schema}.student_operations_xero_invoices SET settlement=$1 WHERE xero_invoice_id=$2`,[JSON.stringify({entries:pendingEntries}),invoice]);
    await writeEntries();
    const register = new StudentOperationsXeroSyncService(db,{} as never);
    const searchBankId = (queue:string, q:string) => register.invoices(tenant,connection,{queue,q});
    expect(await searchBankId('receipts_awaiting_link',bankId)).toMatchObject({total:1});
    expect(await searchBankId('receipts_awaiting_link',bankId.slice(0,-1))).toMatchObject({total:0});
    expect(await searchBankId('excess_receipts',bankId)).toMatchObject({total:1});
    expect(await searchBankId('reconciliation_review',bankId)).toMatchObject({total:0});
    expect(await searchBankId('receipts_awaiting_link','WAITING LINK')).toMatchObject({total:1});
    expect(await searchBankId('excess_receipts','WAITING LINK')).toMatchObject({total:1});
    expect(await searchBankId('excess_receipts',credit.toUpperCase())).toMatchObject({total:1});
    expect(await searchBankId('receipts_awaiting_link',credit)).toMatchObject({total:0});
    expect(await searchBankId('excess_receipts','%')).toMatchObject({total:0});
    const awaitingLink = (paymentCandidateStatus?: 'available' | 'multiple' | 'partial' | 'none') => register.invoices(tenant,connection,{queue:'receipts_awaiting_link',paymentCandidateStatus});
    expect(await awaitingLink()).toMatchObject({total:1,invoices:[{amountDue:0,unlinkedReceipts:{count:2,amount:5484,withCandidates:2}}]});
    expect((await awaitingLink('available')).total).toBe(1);
    expect((await awaitingLink('none')).total).toBe(0);
    expect((await awaitingLink('partial')).total).toBe(0);
    await admin.query(`UPDATE ${schema}.student_trust_receipt_verifications SET received_on=$2::date - 1 WHERE verification_id=$1`,[unlinked,date]);
    expect(await awaitingLink('partial')).toMatchObject({total:1,invoices:[{unlinkedReceipts:{count:2,amount:5484,withCandidates:1}}]});
    expect((await awaitingLink('none')).total).toBe(0);
    await admin.query(`UPDATE ${schema}.student_trust_receipt_verifications SET received_on=$2 WHERE verification_id=$1`,[unlinked,date]);
    // Two receipts share one eligible ID, even if the import repeats that ID.
    pendingEntries.push({...pendingEntries[1]});
    await writeEntries();
    expect((await awaitingLink('multiple')).total).toBe(0);
    pendingEntries.push({...pendingEntries[1],id:randomUUID()});
    await writeEntries();
    expect(await awaitingLink('multiple')).toMatchObject({total:1,invoices:[{unlinkedReceipts:{
      count:2, amount:5484, withCandidates:2, withMultipleCandidates:2
    }}]});
    for (const marker of [{allocationListsOmitted:true},{omittedKinds:['payment']}]) {
      await admin.query(`UPDATE ${schema}.student_operations_xero_invoices SET settlement=$1 WHERE xero_invoice_id=$2`,
        [JSON.stringify({...marker,entries:pendingEntries}),invoice]);
      expect((await awaitingLink('available')).total).toBe(0);
      const receipts = await service.list(principal,connection,invoice);
      expect(receipts.find(r=>r.id===unlinked).candidateIds).toEqual([]);
      expect(receipts.find(r=>r.id===owner).candidateIds).toEqual([payment]);
      await expect(service.link(principal,connection,invoice,unlinked,anotherPayment)).rejects.toThrow('Review the latest imported payments');
      await expect(service.link(principal,connection,invoice,owner,payment)).resolves.toEqual({paymentId:payment});
    }
    pendingEntries.splice(2);
    await writeEntries();
    await service.link(principal,connection,invoice,owner===receipt?second:receipt,anotherPayment);
    expect((await awaitingLink('available')).total).toBe(0);
    expect((await awaitingLink('none')).total).toBe(1);
    expect((await awaitingLink('partial')).total).toBe(0);
    expect(await awaitingLink()).toMatchObject({total:1,invoices:[{unlinkedReceipts:{count:1,amount:2742,withCandidates:0}}]});
    await admin.query(`UPDATE ${schema}.student_trust_receipt_payment_links SET linked_at='2020-01-02T01:00:00Z' WHERE payment_id=$1`,[payment]);
    await admin.query(`UPDATE ${schema}.student_trust_receipt_payment_links
      SET linked_at=(((now() AT TIME ZONE 'Australia/Brisbane')::date - 2) + time '23:59') AT TIME ZONE 'Australia/Brisbane'
      WHERE payment_id=$1`,[anotherPayment]);
    // Keep the older linked receipt on its original date. Only the unlinked receipts determine age.
    await admin.query(`UPDATE ${schema}.student_trust_receipt_verifications
      SET received_on=(now() AT TIME ZONE 'Australia/Brisbane')::date - 3
      WHERE invoice_id=$1 AND verification_id<>$2`,[invoice,excessOwner]);
    const excess = await register.invoices(tenant,connection,{queue:'excess_receipts'});
    expect(excess.invoices).toMatchObject([{receiptExcess:0.60,unlinkedExcess:0.40,unlinkedExcessDays:3}]);
    await admin.query(`UPDATE ${schema}.student_trust_receipt_verifications SET received_on=$2 WHERE invoice_id=$1`,[invoice,date]);
    await admin.query(`UPDATE ${schema}.student_operations_xero_invoices SET currency_code='USD' WHERE xero_invoice_id=$1`,[invoice]);
    expect((await service.list(principal,connection,invoice)).find(r=>r.id===excessOwner))
      .toMatchObject({linkedOverpaymentId:credit,possibleOverpaymentIds:[]});
    await admin.query(`UPDATE ${schema}.student_operations_xero_invoices SET currency_code='AUD' WHERE xero_invoice_id=$1`,[invoice]);
    const excessByStatus = (excessLinkStatus: string) => register.invoices(tenant,connection,{queue:'excess_receipts',excessLinkStatus});
    expect(await excessByStatus('link_mismatch')).toMatchObject({total:0,invoices:[]});
    await admin.query(`UPDATE ${schema}.student_operations_xero_invoices SET total=0.21 WHERE xero_invoice_id=$1`,[credit]);
    expect(await excessByStatus('link_mismatch')).toMatchObject({total:1,invoices:[{receiptExcess:0.60,unlinkedExcess:0.40}]});
    await admin.query(`UPDATE ${schema}.student_operations_xero_invoices SET total=0.20 WHERE xero_invoice_id=$1`,[credit]);
    expect(await excessByStatus('link_mismatch')).toMatchObject({total:0,invoices:[]});
    expect(await excessByStatus('needs_link')).toMatchObject({total:1,invoices:[{receiptExcess:0.60,unlinkedExcess:0.40}]});
    expect(await excessByStatus('fully_linked')).toMatchObject({total:0,invoices:[]});
    await admin.query(`INSERT INTO ${schema}.student_trust_receipt_overpayment_links
      (customer_id,connection_id,verification_id,overpayment_id,excess_amount,linked_by)
      SELECT customer_id,connection_id,verification_id,gen_random_uuid(),0.20,'fixture'
      FROM ${schema}.student_trust_receipt_verifications WHERE invoice_id=$1 AND verification_id<>$2`,[invoice,excessOwner]);
    expect(await excessByStatus('needs_link')).toMatchObject({total:0,invoices:[]});
    expect(await excessByStatus('fully_linked')).toMatchObject({total:1,invoices:[{receiptExcess:0.60,unlinkedExcess:0,unlinkedExcessDays:null}]});
    expect(await excessByStatus('link_mismatch')).toMatchObject({total:1,invoices:[{unlinkedExcess:0}]});
    const pending = async () => (await register.invoices(tenant,connection,{queue:'reconciliation_review'})).invoices;
    expect(await pending()).toMatchObject([{reconciliation:{oldestLinkedAt:'2020-01-02T01:00:00.000Z',amount:5483.60,payments:2,unassigned:1,managerChecks:1,xeroPending:2,statusUnknown:0,linkMismatch:0}}]);
    const review = (options:Record<string,unknown>) => register.invoices(tenant,connection,{queue:'reconciliation_review',...options});
    expect(await review({minFollowUpDays:2})).toMatchObject({invoices:[{reconciliation:{payments:2}}]});
    expect(await review({minFollowUpDays:3})).toMatchObject({invoices:[{reconciliation:{payments:1,amount:2741.80}}]});
    expect(await review({q:anotherPayment.toUpperCase()})).toMatchObject({total:1});
    expect(await review({q:anotherPayment,minFollowUpDays:3})).toMatchObject({total:0});
    expect(await review({q:'ECOND'})).toMatchObject({total:1});
    expect(await review({q:'awaiting link'})).toMatchObject({total:0});
    await expect(register.invoices(tenant,connection,{queue:'excess_receipts',minFollowUpDays:7})).rejects.toThrow();
    const filtered = async (followUpOwner:'mine'|'unassigned', actor:string) =>
      (await register.invoices(tenant,connection,{queue:'reconciliation_review',followUpOwner},undefined,actor)).invoices;
    const currentOwner = other===principal?'fixture':'reviewer';
    expect(await filtered('mine',currentOwner)).toMatchObject([{reconciliation:{payments:1,amount:2741.80,unassigned:0,managerChecks:1,latestReportedReconciledOn:date}}]);
    expect(await filtered('mine',currentOwner==='fixture'?'reviewer':'fixture')).toEqual([]);
    expect(await filtered('unassigned',currentOwner)).toMatchObject([{reconciliation:{payments:1,pendingDays:2,amount:2741.80,unassigned:1,managerChecks:0,latestReportedReconciledOn:null}}]);
    const checkedPending = {queue:'reconciliation_review', reconciliationStatus:'checked_pending'};
    expect((await register.invoices(tenant,connection,checkedPending)).invoices)
      .toMatchObject([{reconciliation:{amount:2741.80,payments:1,managerChecks:1,xeroPending:1}}]);
    expect((await register.invoices(tenant,connection,{...checkedPending,followUpOwner:'unassigned'})).invoices).toEqual([]);
    const uncheckedPending = {queue:'reconciliation_review', reconciliationStatus:'unchecked_pending'};
    const uncheckedUnknown = {queue:'reconciliation_review', reconciliationStatus:'unchecked_unknown'};
    expect((await register.invoices(tenant,connection,uncheckedPending)).invoices)
      .toMatchObject([{reconciliation:{amount:2741.80,payments:1,managerChecks:0,unassigned:1}}]);
    expect((await register.invoices(tenant,connection,uncheckedUnknown)).total).toBe(0);
    {
      const entries = [...pendingEntries,{...pendingEntries[1],isReconciled:true}];
      await admin.query(`UPDATE ${schema}.student_operations_xero_invoices SET settlement=$1 WHERE xero_invoice_id=$2`,[JSON.stringify({entries}),invoice]);
      expect((await register.invoices(tenant,connection,uncheckedUnknown)).invoices)
        .toMatchObject([{reconciliation:{payments:1,statusUnknown:1,linkMismatch:0,managerChecks:0}}]);
      expect((await register.invoices(tenant,connection,uncheckedPending)).total).toBe(0);
      expect((await service.list(principal,connection,invoice)).find(r=>r.linkedPaymentId===anotherPayment).linkedPaymentReconciled).toBeNull();
    }
    await writeEntries();
    const checkedUnknown = {queue:'reconciliation_review', reconciliationStatus:'checked_unknown'};
    expect((await register.invoices(tenant,connection,checkedUnknown)).invoices).toEqual([]);
    await admin.query(`UPDATE ${schema}.student_operations_xero_invoices SET settlement=$1 WHERE xero_invoice_id=$2`,
      [JSON.stringify({allocationListsOmitted:true,entries:pendingEntries.map(entry=>({...entry,isReconciled:true}))}),invoice]);
    expect(await pending()).toMatchObject([{reconciliation:{payments:2,statusUnknown:2,linkMismatch:0}}]);
    expect((await service.list(principal,connection,invoice)).find(r=>r.id===owner).linkedPaymentReconciled).toBeNull();
    await admin.query(`UPDATE ${schema}.student_operations_xero_invoices SET settlement=$1 WHERE xero_invoice_id=$2`,
      [JSON.stringify({omittedKinds:['payment'],entries:pendingEntries.map(entry=>({...entry,isReconciled:true}))}),invoice]);
    expect(await pending()).toMatchObject([{reconciliation:{payments:2,statusUnknown:2,linkMismatch:0}}]);
    const mixedEntries = [{kind:'payment',id:payment,date,amount:2741.80},
      {kind:'payment',id:anotherPayment,date,amount:2740,isReconciled:true}];
    await admin.query(`UPDATE ${schema}.student_operations_xero_invoices SET settlement=$1 WHERE xero_invoice_id=$2`,[JSON.stringify({entries:mixedEntries}),invoice]);
    expect(await pending()).toMatchObject([{reconciliation:{amount:5483.60,payments:2,unassigned:1,managerChecks:1,xeroPending:0,statusUnknown:1,linkMismatch:1}}]);
    expect((await register.invoices(tenant,connection,checkedPending)).invoices).toEqual([]);
    expect(await register.invoices(tenant,connection,checkedUnknown)).toMatchObject({
      total:1,invoices:[{reconciliation:{amount:2741.80,payments:1,managerChecks:1,statusUnknown:1,linkMismatch:0}}]
    });
    expect((await register.invoices(tenant,connection,{...checkedUnknown,followUpOwner:'unassigned'})).invoices).toEqual([]);
    expect((await register.invoices(tenant,connection,uncheckedUnknown)).total).toBe(0);
    const mismatches = {queue:'reconciliation_review', reconciliationStatus:'link_mismatch'};
    expect((await register.invoices(tenant,connection,mismatches)).invoices)
      .toMatchObject([{reconciliation:{amount:2741.80,payments:1,managerChecks:0,statusUnknown:0,linkMismatch:1}}]);
    expect((await register.invoices(tenant,connection,{...mismatches,followUpOwner:'mine'},undefined,currentOwner)).invoices).toEqual([]);
    const confirmed = (q?:string) => register.invoices(tenant,connection,{queue:'reconciled_payments',q});
    expect((await confirmed()).total).toBe(0);
    pendingEntries[0].isReconciled=true;
    await writeEntries();
    expect(await pending()).toMatchObject([{reconciliation:{amount:2741.80,payments:1,managerChecks:0}}]);
    expect((await register.invoices(tenant,connection,checkedPending)).invoices).toEqual([]);
    expect(await confirmed(payment)).toMatchObject({total:1,invoices:[{confirmedPayments:{count:1,amount:2741.8}}]});
    expect((await confirmed(anotherPayment)).total).toBe(0);
    pendingEntries[1].isReconciled=true;
    await writeEntries();
    expect(await pending()).toEqual([]);
    expect(await confirmed()).toMatchObject({total:1,invoices:[{confirmedPayments:{count:2,amount:5483.6}}]});
    pendingEntries[0].isReconciled=false;
    await writeEntries();
    expect((await confirmed(payment)).total).toBe(0);
    expect(await pending()).toMatchObject([{reconciliation:{payments:1,managerChecks:1,xeroPending:1}}]);
    await admin.query(`UPDATE ${schema}.student_operations_xero_invoices SET settlement=$1 WHERE xero_invoice_id=$2`,
      [JSON.stringify({entries:pendingEntries,omittedKinds:['payment']}),invoice]);
    expect((await confirmed()).total).toBe(0);
    await admin.query(`UPDATE ${schema}.student_operations_xero_invoices SET settlement=NULL`);
    await admin.query(`INSERT INTO ${schema}.student_operations_xero_sync_runs VALUES($1,$2,$3,now(),'succeeded','reconciliation')`,[tenant,connection,randomUUID()]);
    expect((await service.list(principal,connection,invoice)).find(r=>r.id===excessOwner)).toMatchObject({linkedOverpaymentId:credit,possibleOverpaymentIds:[]});
    await admin.query(`DELETE FROM ${schema}.student_operations_xero_contacts WHERE customer_id=$1 AND xero_connection_id=$2 AND xero_contact_id=$3`,[tenant,connection,contact]);
    const exceptions = (q?:string) => register.invoices(tenant,connection,{queue:'receipt_exceptions',q});
    for (const q of [undefined,'WAITING LINK',bankId,payment.toUpperCase(),credit]) {
      expect(await exceptions(q)).toMatchObject({total:1,invoices:[{xeroInvoiceId:invoice,
        receiptException:{reason:'not_current',count:3,amount:8226,latestReceiptOn:date}}]});
    }
    expect((await exceptions(randomUUID())).total).toBe(0);
    await expect(register.invoice(tenant,connection,invoice)).rejects.toThrow('Xero invoice not found');
    expect(await register.invoice(tenant,connection,invoice,true)).toMatchObject({receiptException:{reason:'not_current'},settlement:null,lineItems:[]});
    await admin.query(`INSERT INTO ${schema}.student_operations_xero_contacts VALUES($1,$2,$3,'Fixture')`,[tenant,connection,contact]);
    const latestRun=(await admin.query(`SELECT sync_run_id FROM ${schema}.student_operations_xero_sync_runs WHERE customer_id=$1 AND xero_connection_id=$2 ORDER BY created_at DESC LIMIT 1`,[tenant,connection])).rows[0].sync_run_id;
    for (const status of ['VOIDED','DELETED']) {
      await admin.query(`UPDATE ${schema}.student_operations_xero_invoices SET invoice_status=$2,last_seen_sync_run_id=$3 WHERE xero_invoice_id=$1`,[invoice,status,latestRun]);
      expect(await exceptions()).toMatchObject({total:1,invoices:[{receiptException:{reason:status.toLowerCase()}}]});
      expect((await confirmed()).total).toBe(0);
    }
    await admin.query(`UPDATE ${schema}.student_operations_xero_invoices SET invoice_status='AUTHORISED' WHERE xero_invoice_id=$1`,[invoice]);
    expect((await exceptions()).total).toBe(0);
    expect(await register.invoice(tenant,connection,invoice,true)).toMatchObject({status:'authorised',xeroInvoiceId:invoice});
    await admin.query(`UPDATE ${schema}.student_operations_xero_invoices SET last_seen_sync_run_id=$2 WHERE xero_invoice_id=$1`,[invoice,run]);
    await admin.query(`UPDATE ${schema}.student_operations_xero_sync_configurations SET enabled=false WHERE xero_connection_id=$1`,[connection]);
    expect((await exceptions()).total).toBe(0);
    await expect(register.invoice(tenant,connection,invoice,true)).rejects.toThrow('Xero invoice not found');
    await admin.query(`UPDATE ${schema}.student_operations_xero_sync_configurations SET enabled=true WHERE xero_connection_id=$1`,[connection]);
    // The invoice still looks payable locally even though the newer full import omitted it.
    const stalePayment = randomUUID();
    const staleEntries = [{kind:'payment',id:stalePayment,date,amount:2741.80}];
    await admin.query(`UPDATE ${schema}.student_operations_xero_invoices
      SET settlement=$1,invoice_status='AUTHORISED',amount_due=2741.80 WHERE xero_invoice_id=$2`,[JSON.stringify({entries:staleEntries}),invoice]);
    await expect(service.verify(principal,connection,invoice,randomUUID(),{...input,reference:'new'})).rejects.toThrow();
    await expect(service.link(principal,connection,invoice,unlinked,stalePayment)).rejects.toThrow();
    await expect(service.verify(principal,connection,invoice,receipt,input)).resolves.toEqual({id:receipt});
    const row=(await service.list(principal,connection,invoice)).find(r=>r.id===owner);
    expect(row).toMatchObject({amount:'2742.00',linkedAmount:'2741.80',linkedPaymentReconciled:null,possibleOverpaymentIds:[],candidateIds:[],linkedPaymentId:payment});
  });
  it('verifies a bank receipt after Xero records payment, atomically and with the original allocation',async()=>{
    const conn=randomUUID(), inv=randomUUID(), pay=randomUUID(), run=randomUUID(), contact=randomUUID(), credit=randomUUID();
    const date='2020-01-02';
    const entry={id:pay,kind:'payment',amount:2741.8,date,isReconciled:true,reference:'Tuesday school transfer'};
    const input={receivedOn:date,amount:'2742.00',account:'TRUST fixture',reference:'test deposit',
      importedPaymentId:pay,importedPaymentAmount:'2741.80'};
    await admin.query(`INSERT INTO ${schema}.student_operations_xero_sync_configurations VALUES($1,$2,true,'trust')`,[tenant,conn]);
    await admin.query(`INSERT INTO ${schema}.student_operations_xero_sync_runs VALUES($1,$2,$3,now(),'succeeded','initial')`,[tenant,conn,run]);
    await admin.query(`INSERT INTO ${schema}.student_operations_xero_invoices
      (customer_id,xero_connection_id,xero_invoice_id,xero_contact_id,last_seen_sync_run_id,currency_code,invoice_type,invoice_status,amount_due,total,invoice_date,settlement)
      VALUES ($1,$2,$3,$4,$5,'AUD','ACCREC','PAID',0,2741.80,$6,$7),($1,$2,$8,$4,$5,'AUD','RECEIVE-OVERPAYMENT','AUTHORISED',0,0.20,$6,NULL)`,
      [tenant,conn,inv,contact,run,date,JSON.stringify({entries:[entry]}),credit]);
    const snapshot=(value:unknown)=>admin.query(`UPDATE ${schema}.student_operations_xero_invoices SET settlement=$1 WHERE xero_invoice_id=$2`,[JSON.stringify(value),inv]);
    const verify=(id:string,changes:Record<string,unknown>={})=>service.verify(principal,conn,inv,id,{...input,...changes});
    await admin.query(`INSERT INTO ${schema}.xero_connections VALUES($1,$2,'active')`,[tenant,conn]);
    await admin.query(`INSERT INTO ${schema}.student_operations_xero_contacts VALUES($1,$2,$3,'Fixture')`,[tenant,conn,contact]);
    const register=new StudentOperationsXeroSyncService(db,{} as never);
    const available=(filters:Record<string,string>={})=>register.invoices(tenant,conn,{queue:'payments_without_receipts',...filters});
    for(const changes of [{receivedOn:'2020-01-03'},{importedPaymentAmount:'2741.70'},{amount:'2000'},{importedPaymentId:randomUUID()}]) {
      await expect(verify(randomUUID(),changes)).rejects.toThrow();
    }
    for (const value of [{entries:[entry],omittedKinds:['payment']},{entries:[entry,{...entry,amount:2750}]}]) {
      await snapshot(value);
      expect((await available()).total).toBe(0);
      await expect(verify(randomUUID())).rejects.toThrow();
    }
    const second={...entry,id:randomUUID(),date:'2020-01-03',amount:25,reference:'Other deposit'};
    await snapshot({entries:[entry,entry,second]});
    expect(await available()).toMatchObject({total:1,invoices:[{availablePayments:{count:2,amount:2766.8,latestDate:second.date}}]});
    for (const q of [pay.toUpperCase(),'SCHOOL']) {
      expect((await available({q})).total).toBe(1);
    }
    expect(await available({importedPaymentDate:date,importedPaymentAmount:'2741.80'}))
      .toMatchObject({invoices:[{availablePayments:{count:1,amount:2741.8,latestDate:date}}]});
    expect((await available({importedPaymentDate:date,importedPaymentAmount:'25'})).total).toBe(0);
    await expect(register.invoices(tenant,conn,{queue:'outstanding_invoices',importedPaymentAmount:'25'})).rejects.toThrow();

    const otherInvoice=randomUUID();
    await admin.query(`INSERT INTO ${schema}.student_operations_xero_invoices
      (customer_id,xero_connection_id,xero_invoice_id,xero_contact_id,last_seen_sync_run_id,currency_code,invoice_type,invoice_status,amount_due,total,invoice_date,settlement)
      VALUES ($1,$2,$3,$4,$5,'AUD','ACCREC','AUTHORISED',50,75,$6,$7)`,
      [tenant,conn,otherInvoice,contact,run,date,JSON.stringify({entries:[{...second,id:randomUUID(),date:'2020-01-04'}]})]);
    expect((await available()).invoices.map(row=>row.xeroInvoiceId)).toEqual([otherInvoice,inv]);
    await admin.query(`UPDATE ${schema}.student_operations_xero_sync_configurations SET enabled=false WHERE xero_connection_id=$1`,[conn]);
    expect((await available()).total).toBe(0);
    await admin.query(`UPDATE ${schema}.student_operations_xero_sync_configurations SET enabled=true WHERE xero_connection_id=$1`,[conn]);
    const latestRun=randomUUID();
    await admin.query(`INSERT INTO ${schema}.student_operations_xero_sync_runs VALUES($1,$2,$3,now()+interval '1 minute','succeeded','reconciliation')`,[tenant,conn,latestRun]);
    expect((await available()).total).toBe(0);
    await admin.query(`UPDATE ${schema}.student_operations_xero_invoices SET last_seen_sync_run_id=$1 WHERE xero_invoice_id IN ($2,$3)`,[latestRun,inv,credit]);
    expect((await available()).invoices.map(row=>row.xeroInvoiceId)).toEqual([inv]);
    const ids=[randomUUID(),randomUUID()];
    const attempts=await Promise.allSettled(ids.map((id,i)=>verify(id,{reference:'test '+i,bankTransactionId:'test-'+i})));
    expect(attempts.filter(a=>a.status==='fulfilled')).toHaveLength(1);
    const winner=attempts.findIndex(a=>a.status==='fulfilled');
    const key=ids[winner],details={reference:'test '+winner,bankTransactionId:'test-'+winner};
    expect(await service.list(principal,conn,inv)).toMatchObject([{id:key,invoiceDue:'0.0000',amount:'2742.00',
      importedPaymentAmount:'2741.80',linkedPaymentId:pay,linkedAmount:'2741.80',linkedPaymentReconciled:true,possibleOverpaymentIds:[credit]}]);
    expect((await available({q:pay})).total).toBe(0);
    expect((await available({q:second.id})).total).toBe(1);
    expect(await register.invoices(tenant,conn,{queue:'excess_receipts'})).toMatchObject({invoices:[{receiptExcess:0.2,unlinkedExcess:0.2}]});
    expect(await register.invoices(tenant,conn,{queue:'reconciled_payments'})).toMatchObject({invoices:[{confirmedPayments:{count:1,amount:2741.8}}]});
    await service.linkOverpayment(principal,conn,inv,key,credit);
    expect(await register.invoices(tenant,conn,{queue:'excess_receipts'})).toMatchObject({invoices:[{receiptExcess:0.2,unlinkedExcess:0}]});
    await snapshot({entries:[]});
    await expect(verify(key,details)).resolves.toEqual({id:key});
    await expect(verify(key,{...details,importedPaymentId:randomUUID()})).rejects.toThrow();
    const partial=randomUUID();
    await admin.query(`UPDATE ${schema}.student_operations_xero_invoices SET invoice_status='AUTHORISED',amount_due=50 WHERE xero_invoice_id=$1`,[inv]);
    await snapshot({entries:[{...entry,id:partial,amount:25}]});
    const partialInput={importedPaymentId:partial,importedPaymentAmount:'25.00',amount:'25.00',bankTransactionId:'PT-25'};
    await expect(verify(randomUUID(),{...partialInput,amount:'26.00'})).rejects.toThrow();
    await service.verify(principal,conn,inv,randomUUID(),{receivedOn:date,account:input.account,amount:'25.00',reference:'Monday receipt'});
    await expect(verify(randomUUID(),partialInput)).rejects.toThrow();
    const monday=(await service.list(principal,conn,inv)).find(r=>r.reference==='Monday receipt');
    expect(monday.candidateIds).toContain(partial);
    await service.link(principal,conn,inv,monday.id,partial);
    const secondPartial=randomUUID();
    await snapshot({entries:[{...entry,id:secondPartial,amount:25}]});
    await verify(randomUUID(),{...partialInput,importedPaymentId:secondPartial});
    expect((await service.list(principal,conn,inv)).find(r=>r.linkedPaymentId===secondPartial))
      .toMatchObject({invoiceDue:'50.0000',importedPaymentAmount:'25.00',linkedAmount:'25.00'});
  });

  it.each([
    {due:'100.0050', received:'101.00', expected:100.01, other:100.00},
    {due:'100.0049', received:'101.00', expected:100.00, other:100.01},
    {due:'100.0050', received:'50.01', expected:50.01, other:50.02},
    {due:'0.0049', received:'0.01', expected:0, other:0.01},
  ])('matches AUD cents for a $received receipt against a $due invoice', async ({due,received,expected,other}) => {
    const conn = randomUUID(), inv = randomUUID(), receipt = randomUUID();
    const date = '2020-01-02';
    const entries = [expected,other].map(amount => ({kind:'payment',id:randomUUID(),date,amount}));
    await admin.query(`INSERT INTO ${schema}.student_operations_xero_sync_configurations VALUES($1,$2,true,'trust')`,[tenant,conn]);
    await admin.query(`INSERT INTO ${schema}.student_operations_xero_invoices
      (customer_id,xero_connection_id,xero_invoice_id,amount_due,currency_code,invoice_type,invoice_status,settlement)
      VALUES($1,$2,$3,$4,'AUD','ACCREC','AUTHORISED',$5)`,[tenant,conn,inv,due,JSON.stringify({entries})]);
    const run = randomUUID();
    await admin.query(`INSERT INTO ${schema}.student_operations_xero_sync_runs VALUES($1,$2,$3,now(),'succeeded','initial')`,[tenant,conn,run]);
    await admin.query(`UPDATE ${schema}.student_operations_xero_invoices SET last_seen_sync_run_id=$1 WHERE xero_invoice_id=$2`,[run,inv]);
    await service.verify(principal,conn,inv,receipt,{receivedOn:date,account:'Fixture TRUST',amount:received});
    const [row] = await service.list(principal,conn,inv);
    expect(row.candidateIds).toEqual(expected > 0 ? [entries[0].id] : []);
    await expect(service.link(principal,conn,inv,receipt,entries[1].id)).rejects.toThrow();
    if (expected > 0) {
      await service.link(principal,conn,inv,receipt,entries[0].id);
      expect((await service.list(principal,conn,inv))[0].linkedAmount).toBe(expected.toFixed(2));
    }
  });

});
