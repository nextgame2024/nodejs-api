import {beforeAll,afterAll,describe,it,expect} from '@jest/globals';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {DatabaseService} from '../../database/database.service.js';
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
      GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO sophia_runtime_app;`);
    for (const file of ['143_trust_receipt_verifications','144_trust_receipt_payment_links','145_trust_receipt_overpayment_links']) {
      const sql=await readFile(new URL('../../database/migrations/'+file+'.sql',import.meta.url),'utf8');
      await admin.query(sql.replaceAll('__SOPHIA_RUNTIME_SCHEMA__',schema));
    }
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
    const date='2020-01-02', receipt=randomUUID(), second=randomUUID();
    await admin.query(`INSERT INTO ${schema}.student_operations_xero_sync_configurations VALUES($1,$2,true,'trust')`,[tenant,connection]);
    await admin.query(`INSERT INTO ${schema}.student_operations_xero_invoices VALUES($1,$2,$3,2741.80,'AUD','ACCREC','AUTHORISED',NULL)`,[tenant,connection,invoice]);
    const input={receivedOn:date,account:'Fixture TRUST',amount:'2742.00',reference:'first'};
    await service.verify(principal,connection,invoice,receipt,input);
    await service.verify(principal,connection,invoice,second,{...input,reference:'second'});
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
    const links=await Promise.allSettled([receipt,second].map(id=>service.link(principal,connection,invoice,id,payment)));
    expect(links.filter(x=>x.status==='fulfilled')).toHaveLength(1);
    const owner=links[0].status==='fulfilled'?receipt:second;
    await expect(service.linkOverpayment(principal,connection,invoice,owner,payment)).rejects.toThrow();
    const excessLinks=await Promise.allSettled([receipt,second].map(id=>service.linkOverpayment(principal,connection,invoice,id,credit)));
    expect(excessLinks.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    const excessOwner=excessLinks[0].status==='fulfilled'?receipt:second;
    await service.linkOverpayment(principal,connection,invoice,excessOwner,credit);
    const reviews = await service.list(principal,connection,invoice);
    expect(reviews.find(r=>r.id===excessOwner)).toMatchObject({linkedOverpaymentId:credit,possibleOverpaymentIds:[credit]});
    expect(reviews.find(r=>r.id!==excessOwner).possibleOverpaymentIds).toEqual([]);
    await service.link(principal,connection,invoice,owner,payment);
    await expect(service.link(principal,connection,randomUUID(),owner,payment)).rejects.toThrow();
    for (const flag of [undefined, true, false]) {
      const settlement = {entries:[{kind:'payment',id:payment,date,amount:2741.80,isReconciled:flag},
        {kind:'payment',id:randomUUID(),date,amount:2741.80,isReconciled:true}]};
      await admin.query(`UPDATE ${schema}.student_operations_xero_invoices SET settlement=$1 WHERE xero_invoice_id=$2`,[JSON.stringify(settlement),invoice]);
      const linked=(await service.list(principal,connection,invoice)).find(r=>r.id===owner);
      expect(linked.linkedPaymentReconciled).toBe(flag ?? null);
    }
    await admin.query(`UPDATE ${schema}.student_operations_xero_invoices SET settlement=NULL`);
    await admin.query(`INSERT INTO ${schema}.student_operations_xero_sync_runs VALUES($1,$2,$3,now(),'succeeded','reconciliation')`,[tenant,connection,randomUUID()]);
    expect((await service.list(principal,connection,invoice)).find(r=>r.id===excessOwner)).toMatchObject({linkedOverpaymentId:credit,possibleOverpaymentIds:[]});
    const row=(await service.list(principal,connection,invoice)).find(r=>r.id===owner);
    expect(row).toMatchObject({amount:'2742.00',linkedAmount:'2741.80',linkedPaymentReconciled:null,possibleOverpaymentIds:[],candidateIds:[],linkedPaymentId:payment});
  });
});
