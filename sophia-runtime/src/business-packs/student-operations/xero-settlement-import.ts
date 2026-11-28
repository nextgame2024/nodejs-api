import { HttpException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { runtimeConfig } from '../../config/runtime-config.js';
import type { XeroConnectorService } from '../../connectors/xero/xero-connector.service.js';
import type { DatabaseService } from '../../database/database.service.js';

interface Target {
  connection:string; org:string; kind:'Payments'|'BatchPayments'|'BankAccounts';
  id:string; page:number; since_at:Date|null;
}

export class XeroSettlementImport {
  constructor(private readonly database:DatabaseService,private readonly xero:Pick<XeroConnectorService,'importSettlement'>) {}

  async processOne(tenant:string) {
    const s=runtimeConfig().schema,table=s+'.student_xero_import_resources',lease=randomUUID();
    const mapping=`SELECT DISTINCT ON (xero_connection_id) xero_connection_id,organisation_id,account_id
      FROM ${s}.student_trust_receipt_account_mappings WHERE customer_id=$1 ORDER BY xero_connection_id,revision DESC`;
    const target=await this.database.tenantTransaction(tenant,async db=>{
      await db.query(`INSERT INTO ${table}(customer_id,xero_connection_id,kind,resource_id)
        SELECT DISTINCT o.customer_id,o.xero_connection_id,'Payments',o.payment_id
        FROM ${s}.student_xero_payment_observations o
        JOIN ${s}.student_operations_xero_sync_configurations c USING(customer_id,xero_connection_id)
        WHERE o.customer_id=$1 AND c.enabled AND NOT EXISTS(SELECT 1 FROM ${table} r
          WHERE (r.customer_id,r.xero_connection_id,r.kind,r.resource_id)=(o.customer_id,o.xero_connection_id,'Payments',o.payment_id))
        ORDER BY o.customer_id,o.xero_connection_id,o.payment_id LIMIT 16 ON CONFLICT DO NOTHING`,[tenant]);
      await db.query(`INSERT INTO ${table}(customer_id,xero_connection_id,kind,resource_id)
        SELECT $1,xero_connection_id,'BankAccounts',account_id FROM (${mapping}) m
        WHERE account_id IS NOT NULL ON CONFLICT DO NOTHING`,[tenant]);
      const {rows:[row]}=await db.query<Target>(`SELECT r.xero_connection_id AS connection,x.xero_tenant_id AS org,
        r.kind,r.resource_id AS id,r.page,r.since_at FROM ${table} r
        JOIN ${s}.student_operations_xero_sync_configurations c USING(customer_id,xero_connection_id)
        JOIN ${s}.xero_connections x USING(customer_id,xero_connection_id)
        WHERE r.customer_id=$1 AND c.enabled AND x.status='active' AND r.kind<>'BankTransactions' AND r.due_at<=now()
          AND (r.kind<>'BankAccounts' OR (c.organisation_role='trust' AND EXISTS(SELECT 1 FROM (${mapping}) m
            WHERE m.xero_connection_id=r.xero_connection_id AND m.organisation_id=x.xero_tenant_id::text AND m.account_id=r.resource_id)))
        ORDER BY r.due_at,r.xero_connection_id,r.kind,r.resource_id LIMIT 1 FOR UPDATE OF r SKIP LOCKED`,[tenant]);
      if(row) await db.query(`UPDATE ${table} SET lease_id=$5,due_at=now()+interval '3 minutes',
        sweep_started_at=coalesce(sweep_started_at,now()) WHERE customer_id=$1 AND xero_connection_id=$2 AND kind=$3 AND resource_id=$4`,
        [tenant,row.connection,row.kind,row.id,lease]);
      return row;
    });
    if(!target) return false;
    const key=[tenant,target.connection,target.kind,target.id,lease];
    const owned='customer_id=$1 AND xero_connection_id=$2 AND kind=$3 AND resource_id=$4 AND lease_id=$5';
    let response:Awaited<ReturnType<XeroConnectorService['importSettlement']>>;
    try {
      response=await this.xero.importSettlement(tenant,target.connection,target.org,target.kind,target.id,target.page,target.since_at??undefined);
    } catch(error) {
      const body=error instanceof HttpException?error.getResponse():null;
      const failure=typeof body==='object'?body as {retryAfterSeconds?:number;providerStatus?:number}:null;
      const missing=target.kind!=='BankAccounts' && failure?.providerStatus===404;
      const retry=Math.max(900,Math.min(604800,Number(failure?.retryAfterSeconds)||0));
      await this.database.tenantTransaction(tenant,db=>db.query(`UPDATE ${table} SET lease_id=NULL,
        detail=CASE WHEN $7 THEN '{"status":"MISSING"}'::jsonb ELSE detail END,
        checked_at=CASE WHEN $7 THEN now() ELSE checked_at END,due_at=now()+$6*interval '1 second' WHERE ${owned}`,[...key,retry,missing]));
      return true;
    }
    await this.database.tenantTransaction(tenant,async db=>{
      const result=await db.query(`UPDATE ${table} SET checked_at=now(),lease_id=NULL,
        detail=CASE WHEN kind='BankAccounts' THEN NULL ELSE $6::jsonb END,
        page=CASE WHEN $7 THEN page+1 ELSE 1 END,
        since_at=CASE WHEN kind='BankAccounts' AND NOT $7 THEN sweep_started_at-interval '5 minutes' ELSE since_at END,
        sweep_started_at=CASE WHEN $7 THEN sweep_started_at END,
        due_at=CASE WHEN $7 THEN now() ELSE now()+interval '1 day' END
        WHERE ${owned}`,[...key,JSON.stringify(response.items[0]??null),response.more]);
      if (!result.rowCount) return;
      for(const item of response.items) {
        if(target.kind==='BankAccounts') await db.query(`INSERT INTO ${table}(customer_id,xero_connection_id,kind,resource_id,detail,checked_at)
          VALUES($1,$2,'BankTransactions',$3,$4,now()) ON CONFLICT(customer_id,xero_connection_id,kind,resource_id)
          DO UPDATE SET detail=excluded.detail,checked_at=excluded.checked_at`,[tenant,target.connection,item.id,JSON.stringify(item)]);
        if(item.batch && target.kind!=='BatchPayments') await db.query(`INSERT INTO ${table}(customer_id,xero_connection_id,kind,resource_id)
          VALUES($1,$2,'BatchPayments',$3) ON CONFLICT DO NOTHING`,[tenant,target.connection,item.batch]);
      }
    });
    return true;
  }
}
