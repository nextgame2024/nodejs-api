import {beforeAll,afterAll,describe,it,expect} from '@jest/globals';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {DatabaseService} from '../../database/database.service.js';
import {StudentOperationsXeroSyncService} from './student-operations-xero-sync.service.js';
import {TrustReceiptsController} from './trust-receipts.controller.js';

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
      CREATE TABLE ${schema}.student_operations_xero_sync_configurations(customer_id uuid,xero_connection_id uuid,enabled boolean,organisation_role text);
      CREATE TABLE ${schema}.student_operations_xero_sync_runs(customer_id uuid,xero_connection_id uuid,sync_run_id uuid,created_at timestamptz,status text,mode text);
      CREATE TABLE ${schema}.student_operations_advisor_roster(customer_id uuid,user_id text,display_name text);
      CREATE TABLE ${schema}.xero_connections(customer_id uuid,xero_connection_id uuid,status text);
      CREATE TABLE ${schema}.student_operations_xero_contacts(customer_id uuid,xero_connection_id uuid,xero_contact_id uuid,legal_name text,email text,contact_number text,account_number text);
      CREATE TABLE ${schema}.student_operations_xero_candidate_reviews(customer_id uuid,xero_connection_id uuid,xero_contact_id uuid,review_status text,student_id text);
      ALTER TABLE ${schema}.student_operations_xero_invoices ADD invoice_number text, ADD invoice_reference text, ADD due_date date, ADD amount_paid numeric,
        ADD sent_to_contact boolean, ADD concept text, ADD advisor_name text, ADD college_name text, ADD payment_track text;
      GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO sophia_runtime_app;`);
    for (const file of ['143_trust_receipt_verifications','144_trust_receipt_payment_links','145_trust_receipt_overpayment_links','146_trust_payment_reconciliation_checks','147_trust_reconciliation_check_privileges','148_trust_receipt_payment_purpose','149_trust_reconciliation_claims']) {
      if (file.startsWith('147_')) await admin.query(`GRANT UPDATE,DELETE ON ${schema}.student_trust_payment_reconciliation_checks TO sophia_runtime_app`);
      const sql=await readFile(new URL('../../database/migrations/'+file+'.sql',import.meta.url),'utf8');
      await admin.query(sql.replaceAll('__SOPHIA_RUNTIME_SCHEMA__',schema));
    }
    const privileges = await admin.query(`SELECT has_table_privilege('sophia_runtime_app',$1,'UPDATE,DELETE,TRUNCATE') AS mutable`,[schema+'.student_trust_payment_reconciliation_checks']);
    expect(privileges.rows[0].mutable).toBe(false);
    db = new DatabaseService();
    service = new TrustReceiptsController(db);
  });
  afterAll(async () => {
    if(db) await db.onModuleDestroy();
    if(admin) { await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE'); await admin.end(); }
    for (const name of ['SOPHIA_RUNTIME_SCHEMA','SOPHIA_RUNTIME_DB_SSL','SOPHIA_RUNTIME_DATABASE_URL']) {
      if(env[name]===undefined) delete process.env[name]; else process.env[name]=env[name];
    }
  });
  it('links only the invoice portion once and flags a later missing payment',async () => {
    const reviewer = {studentOperationsPrincipal:{tenantId:tenant,identityUserId:'reviewer',role:'chief_executive'}} as never;
    await admin.query(`INSERT INTO ${schema}.student_operations_advisor_roster VALUES
      ($1,'reviewer','Fixture Reviewer'),($2,'fixture','Other Tenant Manager')`,[tenant,randomUUID()]);
    const date='2020-01-02', receipt=randomUUID(), second=randomUUID();
    await admin.query(`INSERT INTO ${schema}.student_operations_xero_sync_configurations VALUES($1,$2,true,'trust')`,[tenant,connection]);
    await admin.query(`INSERT INTO ${schema}.student_operations_xero_invoices VALUES($1,$2,$3,2741.80,'AUD','ACCREC','AUTHORISED',NULL)`,[tenant,connection,invoice]);
    const input={receivedOn:date,account:'Fixture TRUST',amount:'2742.00',reference:'first'};
    await service.verify(principal,connection,invoice,receipt,input);
    const tuition = {...input,reference:'second',paymentPurpose:'Tuition instalment'};
    await service.verify(principal,connection,invoice,second,tuition);
    await service.verify(principal,connection,invoice,second,tuition);
    await expect(service.verify(principal,connection,invoice,second,{...tuition,paymentPurpose:'Materials'})).rejects.toThrow();
    await expect(service.verify(principal,connection,invoice,randomUUID(),{...tuition,paymentPurpose:'Materials'})).rejects.toThrow();
    const purposes=await service.list(principal,connection,invoice);
    expect(purposes.find(r=>r.id===receipt)).toMatchObject({paymentPurpose:null,verifiedByName:null});
    await admin.query(`INSERT INTO ${schema}.student_operations_advisor_roster VALUES ($1,'fixture','Fixture Verifier')`,[tenant]);
    expect(purposes.find(r=>r.id===second).paymentPurpose).toBe('Tuition instalment');
    const credit=randomUUID();
    const entries=[{kind:'payment',id:payment,date,amount:2741.80},{kind:'overpayment',id:credit,date,amount:0.20}];
    await admin.query(`UPDATE ${schema}.student_operations_xero_invoices SET settlement=$1,invoice_status='PAID',amount_due=0`,[JSON.stringify({entries})]);
    const contact=randomUUID(), run=randomUUID();
    await admin.query(`UPDATE ${schema}.student_operations_xero_invoices SET xero_contact_id=$1`,[contact]);
    await admin.query(`INSERT INTO ${schema}.student_operations_xero_sync_runs VALUES($1,$2,$3,now(),'succeeded','initial')`,[tenant,connection,run]);
    await admin.query(`INSERT INTO ${schema}.student_operations_xero_invoices
      (customer_id,xero_connection_id,xero_invoice_id,currency_code,invoice_type,invoice_status,xero_contact_id,invoice_date,total,last_seen_sync_run_id)
      VALUES($1,$2,$3,'AUD','RECEIVE-OVERPAYMENT','AUTHORISED',$4,$5,0.20,$6)`,[tenant,connection,credit,contact,date,run]);
    expect((await service.list(principal,connection,invoice))[0]).toMatchObject({candidateIds:[payment],possibleOverpaymentIds:[credit]});
    await expect(service.link(principal,connection,invoice,receipt,credit)).rejects.toThrow();
    const links=await Promise.allSettled([receipt,second].map(id=>service.link(reviewer,connection,invoice,id,payment)));
    expect(links.filter(x=>x.status==='fulfilled')).toHaveLength(1);
    const owner=links[0].status==='fulfilled'?receipt:second;
    await expect(service.linkOverpayment(principal,connection,invoice,owner,payment)).rejects.toThrow();
    const excessLinks=await Promise.allSettled([receipt,second].map(id=>service.linkOverpayment(principal,connection,invoice,id,credit)));
    expect(excessLinks.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    const excessOwner=excessLinks[0].status==='fulfilled'?receipt:second;
    await service.linkOverpayment(principal,connection,invoice,excessOwner,credit);
    const reviews = await service.list(principal,connection,invoice);
    expect(reviews.find(r=>r.id===excessOwner)).toMatchObject({linkedOverpaymentId:credit,overpaymentLinkedByName:'Fixture Verifier',possibleOverpaymentIds:[credit]});
    expect(reviews.find(r=>r.id!==excessOwner).possibleOverpaymentIds).toEqual([]);
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
    for (const flag of [undefined, true, false]) {
      const settlement = {entries:[{kind:'payment',id:payment,date,amount:2741.80,isReconciled:flag},
        {kind:'payment',id:randomUUID(),date,amount:2741.80,isReconciled:true}]};
      await admin.query(`UPDATE ${schema}.student_operations_xero_invoices SET settlement=$1 WHERE xero_invoice_id=$2`,[JSON.stringify(settlement),invoice]);
      const linked=(await service.list(principal,connection,invoice)).find(r=>r.id===owner);
      expect(linked.linkedPaymentReconciled).toBe(flag ?? null);
      if (flag === true) await expect(service.attestReconciliation(principal,connection,invoice,owner,payment)).rejects.toThrow();
      if (flag === false) {
        const checks=await Promise.all([1,2].map(()=>service.attestReconciliation(reviewer,connection,invoice,owner,payment)));
        expect(checks[0].checkedAt).toEqual(checks[1].checkedAt);
        const checked=(await service.list(principal,connection,invoice)).find(r=>r.id===owner);
        expect(checked).toMatchObject({verifiedByName:'Fixture Verifier',paymentLinkedByName:'Fixture Reviewer',paymentLinkedAt:expect.any(Date),reconciliationCheckedByName:'Fixture Reviewer',linkedPaymentReconciled:false,reconciliationCheckedAt:checks[0].checkedAt});
      }
    }
    await admin.query(`INSERT INTO ${schema}.xero_connections VALUES($1,$2,'active')`,[tenant,connection]);
    await admin.query(`INSERT INTO ${schema}.student_operations_xero_contacts VALUES($1,$2,$3,'Fixture')`,[tenant,connection,contact]);
    await admin.query(`UPDATE ${schema}.student_operations_xero_invoices SET last_seen_sync_run_id=$1 WHERE xero_invoice_id=$2`,[run,invoice]);
    const anotherPayment = randomUUID();
    const pendingEntries = [payment,anotherPayment].map(id=>({kind:'payment',id,date,amount:2741.80,isReconciled:false}));
    const writeEntries = () => admin.query(`UPDATE ${schema}.student_operations_xero_invoices SET settlement=$1 WHERE xero_invoice_id=$2`,[JSON.stringify({entries:pendingEntries}),invoice]);
    await writeEntries();
    await service.link(principal,connection,invoice,owner===receipt?second:receipt,anotherPayment);
    await admin.query(`UPDATE ${schema}.student_trust_receipt_payment_links SET linked_at='2020-01-02T01:00:00Z' WHERE payment_id=$1`,[payment]);
    const register=new StudentOperationsXeroSyncService(db,{} as never);
    const pending = async () => (await register.invoices(tenant,connection,{queue:'reconciliation_review'})).invoices;
    expect(await pending()).toMatchObject([{reconciliation:{oldestLinkedAt:'2020-01-02T01:00:00.000Z',amount:5483.60,payments:2,unassigned:1,managerChecks:1,xeroPending:2,statusUnknown:0,linkMismatch:0}}]);
    const mixedEntries = [{kind:'payment',id:payment,date,amount:2741.80},
      {kind:'payment',id:anotherPayment,date,amount:2740,isReconciled:true}];
    await admin.query(`UPDATE ${schema}.student_operations_xero_invoices SET settlement=$1 WHERE xero_invoice_id=$2`,[JSON.stringify({entries:mixedEntries}),invoice]);
    expect(await pending()).toMatchObject([{reconciliation:{amount:5483.60,payments:2,unassigned:1,managerChecks:1,xeroPending:0,statusUnknown:1,linkMismatch:1}}]);
    pendingEntries[0].isReconciled=true;
    await writeEntries();
    expect(await pending()).toMatchObject([{reconciliation:{amount:2741.80,payments:1,managerChecks:0}}]);
    pendingEntries[1].isReconciled=true;
    await writeEntries();
    expect(await pending()).toEqual([]);
    await admin.query(`UPDATE ${schema}.student_operations_xero_invoices SET settlement=NULL`);
    await admin.query(`INSERT INTO ${schema}.student_operations_xero_sync_runs VALUES($1,$2,$3,now(),'succeeded','reconciliation')`,[tenant,connection,randomUUID()]);
    expect((await service.list(principal,connection,invoice)).find(r=>r.id===excessOwner)).toMatchObject({linkedOverpaymentId:credit,possibleOverpaymentIds:[]});
    const row=(await service.list(principal,connection,invoice)).find(r=>r.id===owner);
    expect(row).toMatchObject({amount:'2742.00',linkedAmount:'2741.80',linkedPaymentReconciled:null,possibleOverpaymentIds:[],candidateIds:[],linkedPaymentId:payment});
  });
});
