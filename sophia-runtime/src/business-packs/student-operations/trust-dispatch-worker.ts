import { ConflictException, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { lockSplitInvoices } from './trust-split-reservations.js';
import { lockReceiptAccount } from './trust-receipt-account.js';
import type { XeroInvoiceRecord } from '../../connectors/xero/xero.client.js';
import type { DatabaseService } from '../../database/database.service.js';
import type { XeroConnectorService } from '../../connectors/xero/xero-connector.service.js';
import { runtimeConfig } from '../../config/runtime-config.js';
import { checkDispatchInvoice,currentDispatch } from './trust-dispatch-invoice-check.js';

interface Claim {id:string; invoice:string; receipt:string; attempt:number}
type Outcome='matched'|'review'|'unavailable';

export class TrustDispatchWorker {
  constructor(private readonly database:DatabaseService,private readonly xero:Pick<XeroConnectorService,'invoiceById'>) {}

  async processOne(tenant:string,connection:string) {
    const schema=runtimeConfig().schema;
    const attempts=schema+'.student_trust_dispatch_attempts',results=schema+'.student_trust_dispatch_results';
    const scope=[tenant,connection];
    // Serialize only short claim transactions. Provider reads run outside the lock.
    const claim=await this.database.tenantTransaction(tenant,async db=>{
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended('trust-dispatch-check/' || $1::uuid::text || '/' || $2::uuid::text,0))",scope);
      const {rows:[next]}=await db.query<Claim>(`
        SELECT q.dispatch_id AS id,q.snapshot->>'invoice' AS invoice,q.verification_id AS receipt,coalesce(a.attempt,0)+1 AS attempt
        FROM ${schema}.student_trust_payment_dispatches q
        JOIN ${schema}.student_operations_xero_sync_configurations cfg ON cfg.customer_id=q.customer_id
          AND cfg.xero_connection_id=q.connection_id AND cfg.enabled AND cfg.organisation_role='trust'
        JOIN ${schema}.xero_connections x ON x.customer_id=q.customer_id AND x.xero_connection_id=q.connection_id AND x.status='active'
        LEFT JOIN ${schema}.student_trust_dispatch_cancellations c ON (c.customer_id,c.connection_id,c.dispatch_id)=(q.customer_id,q.connection_id,q.dispatch_id)
        LEFT JOIN LATERAL (SELECT attempt,lease_until FROM ${attempts} a
          WHERE (a.customer_id,a.connection_id,a.dispatch_id)=(q.customer_id,q.connection_id,q.dispatch_id)
          ORDER BY attempt DESC LIMIT 1) a ON true
        LEFT JOIN ${results} r ON (r.customer_id,r.connection_id,r.dispatch_id,r.attempt)=(q.customer_id,q.connection_id,q.dispatch_id,a.attempt)
        WHERE q.customer_id=$1 AND q.connection_id=$2 AND c.dispatch_id IS NULL AND q.expires_at>clock_timestamp()
          AND (a.attempt IS NULL OR (a.attempt<3 AND ((r.outcome IS NULL AND a.lease_until<=clock_timestamp())
            OR (r.outcome='unavailable' AND r.checked_at+interval '2 minutes'<=clock_timestamp()))))
        ORDER BY q.queued_at,q.dispatch_id LIMIT 1`,scope);
      if (next) await db.query(`INSERT INTO ${attempts}(customer_id,connection_id,dispatch_id,attempt) VALUES ($1,$2,$3,$4)`,
        [...scope,next.id,next.attempt]);
      return next;
    });
    if (!claim) return {status:'idle'} as const;

    const read=(db:PoolClient)=>currentDispatch(db,schema,[tenant,connection,claim.invoice,claim.receipt],'worker',claim.id);
    let outcome:Outcome='unavailable',detail:string|null='Invoice verification was unavailable.';
    let token:string|undefined,live:XeroInvoiceRecord|undefined;
    try {
      const before=await this.database.tenantReadTransaction(tenant,read);
      token=before.token;
      live=await this.xero.invoiceById(tenant,connection,claim.invoice,before.snapshot.organisationId);
    } catch(error) {
      if (error instanceof ConflictException || error instanceof NotFoundException) {
        outcome='review';detail='Review the dispatch and its current Xero connection.';
      } else if (!(error instanceof Error)) throw error;
    }
    const recorded=await this.database.tenantTransaction(tenant,async db=>{
      if (live) {
        await lockSplitInvoices(db,tenant,connection,[claim.invoice]);
        await lockReceiptAccount(db,schema,tenant,connection,'read');
        try {
          const after=await read(db);
          detail=token===after.token?checkDispatchInvoice(after,live):'The dispatch evidence changed.';
        } catch(error) {
          if (!(error instanceof ConflictException || error instanceof NotFoundException)) throw error;
          detail='The dispatch changed during verification.';
        }
        outcome=detail?'review':'matched';
      }
      return db.query(`
        INSERT INTO ${results}(customer_id,connection_id,dispatch_id,attempt,outcome,detail)
        SELECT customer_id,connection_id,dispatch_id,attempt,$5,$6 FROM ${attempts}
        WHERE customer_id=$1 AND connection_id=$2 AND dispatch_id=$3 AND attempt=$4 AND lease_until>clock_timestamp()
        ON CONFLICT DO NOTHING RETURNING outcome`,[...scope,claim.id,claim.attempt,outcome,detail]);
    });
    return {status:recorded.rowCount?outcome:'lease_expired',dispatchId:claim.id,attempt:claim.attempt};
  }
}
