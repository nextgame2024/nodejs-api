import { runtimeConfig } from '../../config/runtime-config.js';
import type { DatabaseService } from '../../database/database.service.js';
import type { XeroConnectorService } from '../../connectors/xero/xero-connector.service.js';
import type { TrustBankOutcome } from '../../connectors/xero/xero.client.js';
import type { Snapshot } from './trust-receipt-proposals.js';

interface Target {connection:string;dispatch:string;payment:string;snapshot:Snapshot;attempt:number}

export class TrustBankCheckWorker {
  constructor(private readonly database:DatabaseService,private readonly xero:Pick<XeroConnectorService,'trustPaymentSession'>) {}

  async processOne(tenant:string,connection?:string) {
    const s=runtimeConfig().schema,claims=s+'.student_trust_bank_check_claims',results=s+'.student_trust_bank_check_results';
    const target=await this.database.tenantTransaction(tenant,async db=>{
      // The selection and claim share a short lock. A slow provider cannot block another tenant.
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended('trust-bank-check/'||$1::uuid::text,0))",[tenant]);
      const {rows:[row]}=await db.query<Target>(`SELECT f.connection_id AS connection,f.dispatch_id AS dispatch,
        f.payment_id AS payment,q.snapshot,coalesce(a.attempt,0)+1 AS attempt
        FROM ${s}.student_trust_submission_confirmations f JOIN ${s}.student_trust_payment_dispatches q USING(customer_id,connection_id,dispatch_id)
        JOIN ${s}.student_operations_xero_sync_configurations cfg ON cfg.customer_id=f.customer_id
          AND cfg.xero_connection_id=f.connection_id AND cfg.enabled AND cfg.organisation_role='trust'
        JOIN ${s}.xero_connections x ON x.customer_id=f.customer_id AND x.xero_connection_id=f.connection_id
          AND x.status='active' AND x.xero_tenant_id::text=q.snapshot->>'organisationId'
        LEFT JOIN LATERAL (SELECT attempt,started_at FROM ${claims} a WHERE
          (a.customer_id,a.connection_id,a.dispatch_id)=(f.customer_id,f.connection_id,f.dispatch_id)
          ORDER BY attempt DESC LIMIT 1) a ON true
        LEFT JOIN ${results} r ON (r.customer_id,r.connection_id,r.dispatch_id,r.attempt)=(f.customer_id,f.connection_id,f.dispatch_id,a.attempt)
        WHERE f.customer_id=$1 AND ($2::uuid IS NULL OR f.connection_id=$2) AND (a.attempt IS NULL OR
          coalesce(r.checked_at,a.started_at) <= clock_timestamp()-CASE WHEN r.outcome IS NULL THEN interval '2 minutes'
          WHEN r.outcome IN ('reconciled','deleted') THEN interval '24 hours' ELSE interval '15 minutes' END)
        ORDER BY coalesce(a.started_at,f.verified_at),f.dispatch_id LIMIT 1`,[tenant,connection??null]);
      if (row) await db.query(`INSERT INTO ${claims}(customer_id,connection_id,dispatch_id,attempt) VALUES($1,$2,$3,$4)`,
        [tenant,row.connection,row.dispatch,row.attempt]);
      return row;
    });
    if (!target) return false;
    const {snapshot}=target;
    let outcome:TrustBankOutcome='changed';
    if (snapshot.mappedAccount && snapshot.contactId) {
      try {
        const session=await this.xero.trustPaymentSession(tenant,target.connection,snapshot.organisationId,false);
        outcome=await session.bankStatus({dispatch:target.dispatch,account:snapshot.mappedAccount.id,invoice:snapshot.invoice,
          contact:snapshot.contactId,date:snapshot.date,amount:snapshot.amount},target.payment);
      } catch {outcome='unavailable';}
    }
    await this.database.tenantTransaction(tenant,db=>db.query(`INSERT INTO ${results}(customer_id,connection_id,dispatch_id,attempt,outcome)
      SELECT customer_id,connection_id,dispatch_id,attempt,$5 FROM ${claims}
      WHERE customer_id=$1 AND connection_id=$2 AND dispatch_id=$3 AND attempt=$4
        AND started_at>clock_timestamp()-interval '2 minutes' ON CONFLICT DO NOTHING`,
      [tenant,target.connection,target.dispatch,target.attempt,outcome]));
    return true;
  }
}
