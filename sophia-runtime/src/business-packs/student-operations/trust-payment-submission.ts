import { ConflictException,NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { DatabaseService } from '../../database/database.service.js';
import { runtimeConfig } from '../../config/runtime-config.js';
import { trustSubmissionEnabled,type XeroConnectorService } from '../../connectors/xero/xero-connector.service.js';
import type { TrustXeroPayment } from '../../connectors/xero/xero.client.js';
import { currentDispatch,checkDispatchInvoice } from './trust-dispatch-invoice-check.js';
import { lockSplitInvoices } from './trust-split-reservations.js';
import { lockReceiptAccount } from './trust-receipt-account.js';
import type { Snapshot } from './trust-receipt-proposals.js';

interface Submission {expires:Date;ackId:string|null;snapshot:Snapshot;receipt:string;started:boolean;paymentId:string|null}
export class TrustPaymentSubmission {
  constructor(private readonly database:DatabaseService,private readonly xero:Pick<XeroConnectorService,'trustPaymentSession'|'invoiceById'>) {}

  async run(tenant:string,connection:string,dispatch:string,action:'submit'|'recover') {
    const s=runtimeConfig().schema,ids=[tenant,connection,dispatch];
    const read=(db:PoolClient)=>db.query<Submission>(`SELECT q.expires_at AS expires,q.snapshot,q.verification_id AS receipt,
      ack.payment_id AS "ackId",a.dispatch_id IS NOT NULL AS started,c.payment_id AS "paymentId"
      FROM ${s}.student_trust_payment_dispatches q LEFT JOIN ${s}.student_trust_payment_submissions a USING(customer_id,connection_id,dispatch_id)
      LEFT JOIN ${s}.student_trust_submission_acknowledgements ack USING(customer_id,connection_id,dispatch_id)
      LEFT JOIN ${s}.student_trust_submission_confirmations c USING(customer_id,connection_id,dispatch_id)
      WHERE q.customer_id=$1 AND q.connection_id=$2 AND q.dispatch_id=$3`,ids);
    const {rows:[row]}=await this.database.tenantReadTransaction(tenant,read);
    if (!row) throw new NotFoundException('Dispatch unavailable.');
    if (row.paymentId) return {status:'confirmed',paymentId:row.paymentId};
    if (action==='recover' && !row.started) return {status:'unsubmitted'};
    const write=action==='submit' && !row.started;
    if (write && !trustSubmissionEnabled(tenant,connection)) throw new ConflictException('TRUST submission is disabled for this connection.');
    const {snapshot}=row,bank=snapshot.mappedAccount;
    if (!bank || !snapshot.contactId || snapshot.currency!=='AUD' || !snapshot.organisationId || !/^\d{1,12}\.\d{2}$/.test(snapshot.amount) || Number(snapshot.amount)<=0)
      throw new ConflictException('Review the approved receipt amount and account.');
    if (write) {
      const limit=process.env.XERO_TRUST_PAYMENT_MAX_AUD??'';
      if (!/^\d{1,12}(?:\.\d{1,2})?$/.test(limit) || Number(snapshot.amount)>Number(limit))
        throw new ConflictException('The payment exceeds the configured pilot limit.');
    }
    const payment:TrustXeroPayment={invoice:snapshot.invoice,contact:snapshot.contactId,account:bank.id,amount:snapshot.amount,date:snapshot.date,dispatch};
    const session=await this.xero.trustPaymentSession(tenant,connection,snapshot.organisationId,write);
    let knownId=row.ackId??undefined;
    if (write) {
      const scope:[string,string,string,string]=[tenant,connection,snapshot.invoice,row.receipt];
      const check=(db:PoolClient)=>currentDispatch(db,s,scope,'submission-worker',dispatch);
      const before=await this.database.tenantReadTransaction(tenant,check);
      if (!await session.bank(bank.id,bank.name)) throw new ConflictException('The approved Xero bank account changed.');
      const deadline=Math.min(row.expires.getTime(),Date.now()+60_000);
      const live=await this.xero.invoiceById(tenant,connection,snapshot.invoice,snapshot.organisationId);
      const claimed=await this.database.tenantTransaction(tenant,async db=>{
        await lockSplitInvoices(db,tenant,connection,[snapshot.invoice]);
        if ((await read(db)).rows[0]?.started) return false;
        await lockReceiptAccount(db,s,tenant,connection,'read');
        const after=await check(db),issue=checkDispatchInvoice(after,live);
        if (before.token!==after.token || issue) throw new ConflictException(issue??'Dispatch evidence changed.');
        if (Date.now()>=deadline) throw new ConflictException('The live invoice check expired.');
        const insert=await db.query(`INSERT INTO ${s}.student_trust_payment_submissions(customer_id,connection_id,dispatch_id,verification_id)
          SELECT q.customer_id,q.connection_id,q.dispatch_id,q.verification_id FROM ${s}.student_trust_payment_dispatches q
          JOIN ${s}.student_trust_receipt_verifications v USING(customer_id,connection_id,verification_id)
          WHERE q.customer_id=$1 AND q.connection_id=$2 AND q.dispatch_id=$3 AND q.evidence_token=$4 AND q.expires_at>clock_timestamp()
            AND EXISTS (SELECT 1 FROM ${s}.customers customer WHERE customer.customer_id=q.customer_id AND customer.status='active')
            AND (SELECT count(*) FROM ${s}.business_pack_entitlements e WHERE e.customer_id=q.customer_id
              AND e.identity_user_id IN (q.approver,q.released_by) AND e.pack_id='student-operations'
              AND e.role_key='chief_executive' AND e.status='active')=2
            AND (v.statement_record IS NOT NULL OR $5::boolean)
            AND EXISTS (SELECT 1 FROM ${s}.student_trust_dispatch_results r
              WHERE (r.customer_id,r.connection_id,r.dispatch_id)=(q.customer_id,q.connection_id,q.dispatch_id) AND outcome='matched')
          ON CONFLICT DO NOTHING RETURNING dispatch_id`,[...ids,after.token,process.env.XERO_TRUST_PREFEED_ENABLED==='true']);
        if (!insert.rowCount) throw new ConflictException('Review the manager permissions, worker check, receipt source and approval expiry.');
        return true;
      });
      if (claimed) {
        // The committed claim owns the only write. Every later invocation uses read-back.
        try {knownId=await session.submit(payment,deadline);} catch {return {status:'awaiting_verification'};}
        await this.database.tenantTransaction(tenant,db=>db.query(`INSERT INTO ${s}.student_trust_submission_acknowledgements
          (customer_id,connection_id,dispatch_id,payment_id) VALUES($1,$2,$3,$4)`,[...ids,knownId]));
      }
    }
    let paymentId:string|null;
    try {paymentId=await session.verify(payment,knownId);} catch {return {status:'awaiting_verification'};}
    if (!paymentId) return {status:'awaiting_verification'};
    await this.database.tenantTransaction(tenant,async db=>{
      await lockSplitInvoices(db,tenant,connection,[snapshot.invoice]);
      const prior=(await read(db)).rows[0];
      if (prior.paymentId===paymentId) return;
      const link=await db.query(`INSERT INTO ${s}.student_trust_receipt_payment_links
        (customer_id,connection_id,verification_id,payment_id,payment_amount,linked_by)
        VALUES($1,$2,$3,$4,$5,'trust-payment-worker') ON CONFLICT DO NOTHING`,[tenant,connection,row.receipt,paymentId,payment.amount]);
      if (!link.rowCount && !(await db.query(`SELECT 1 FROM ${s}.student_trust_receipt_payment_links WHERE customer_id=$1
        AND connection_id=$2 AND verification_id=$3 AND payment_id=$4 AND payment_amount=$5`,[tenant,connection,row.receipt,paymentId,payment.amount])).rowCount)
        throw new ConflictException('Review the existing receipt link before confirming this payment.');
      await db.query(`INSERT INTO ${s}.student_trust_submission_confirmations(customer_id,connection_id,dispatch_id,payment_id)
        VALUES($1,$2,$3,$4)`,[...ids,paymentId]);
    });
    return {status:'confirmed',paymentId};
  }
}
