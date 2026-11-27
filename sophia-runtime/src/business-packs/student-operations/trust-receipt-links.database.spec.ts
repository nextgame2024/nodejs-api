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
    for (const file of ['143_trust_receipt_verifications','144_trust_receipt_payment_links','145_trust_receipt_overpayment_links','146_trust_payment_reconciliation_checks','147_trust_reconciliation_check_privileges','148_trust_receipt_payment_purpose','149_trust_reconciliation_claims','150_trust_reconciliation_claim_history','151_trust_receipt_payment_link_note','152_trust_receipt_overpayment_link_note','153_trust_reported_reconciliation_date']) {
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
    const date='2020-01-02', receipt=randomUUID(), second=randomUUID(), run=randomUUID();
    await admin.query(`INSERT INTO ${schema}.student_operations_xero_sync_configurations VALUES($1,$2,true,'trust')`,[tenant,connection]);
    await admin.query(`INSERT INTO ${schema}.student_operations_xero_invoices VALUES($1,$2,$3,2741.80,'AUD','ACCREC','AUTHORISED',NULL)`,[tenant,connection,invoice]);
    await admin.query(`INSERT INTO ${schema}.student_operations_xero_sync_runs VALUES($1,$2,$3,now(),'succeeded','initial')`,[tenant,connection,run]);
    await admin.query(`UPDATE ${schema}.student_operations_xero_invoices SET last_seen_sync_run_id=$1 WHERE xero_invoice_id=$2`,[run,invoice]);
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
    const unlinked = randomUUID();
    await service.verify(principal,connection,invoice,unlinked,{...input,reference:'awaiting link'});
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
    for (const flag of [undefined, true, false]) {
      const settlement = {entries:[{kind:'payment',id:payment,date,amount:2741.80,isReconciled:flag === true ? false : undefined},
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
    const checkedUnknown = {queue:'reconciliation_review', reconciliationStatus:'checked_unknown'};
    expect((await register.invoices(tenant,connection,checkedUnknown)).invoices).toEqual([]);
    const mixedEntries = [{kind:'payment',id:payment,date,amount:2741.80},
      {kind:'payment',id:anotherPayment,date,amount:2740,isReconciled:true}];
    await admin.query(`UPDATE ${schema}.student_operations_xero_invoices SET settlement=$1 WHERE xero_invoice_id=$2`,[JSON.stringify({entries:mixedEntries}),invoice]);
    expect(await pending()).toMatchObject([{reconciliation:{amount:5483.60,payments:2,unassigned:1,managerChecks:1,xeroPending:0,statusUnknown:1,linkMismatch:1}}]);
    expect((await register.invoices(tenant,connection,checkedPending)).invoices).toEqual([]);
    expect(await register.invoices(tenant,connection,checkedUnknown)).toMatchObject({
      total:1,invoices:[{reconciliation:{amount:2741.80,payments:1,managerChecks:1,statusUnknown:1,linkMismatch:0}}]
    });
    expect((await register.invoices(tenant,connection,{...checkedUnknown,followUpOwner:'unassigned'})).invoices).toEqual([]);
    const mismatches = {queue:'reconciliation_review', reconciliationStatus:'link_mismatch'};
    expect((await register.invoices(tenant,connection,mismatches)).invoices)
      .toMatchObject([{reconciliation:{amount:2741.80,payments:1,managerChecks:0,statusUnknown:0,linkMismatch:1}}]);
    expect((await register.invoices(tenant,connection,{...mismatches,followUpOwner:'mine'},undefined,currentOwner)).invoices).toEqual([]);
    pendingEntries[0].isReconciled=true;
    await writeEntries();
    expect(await pending()).toMatchObject([{reconciliation:{amount:2741.80,payments:1,managerChecks:0}}]);
    expect((await register.invoices(tenant,connection,checkedPending)).invoices).toEqual([]);
    pendingEntries[1].isReconciled=true;
    await writeEntries();
    expect(await pending()).toEqual([]);
    await admin.query(`UPDATE ${schema}.student_operations_xero_invoices SET settlement=NULL`);
    await admin.query(`INSERT INTO ${schema}.student_operations_xero_sync_runs VALUES($1,$2,$3,now(),'succeeded','reconciliation')`,[tenant,connection,randomUUID()]);
    expect((await service.list(principal,connection,invoice)).find(r=>r.id===excessOwner)).toMatchObject({linkedOverpaymentId:credit,possibleOverpaymentIds:[]});
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
