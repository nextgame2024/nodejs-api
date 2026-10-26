import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { runtimeConfig } from '../../config/runtime-config.js';
import type { DatabaseService } from '../../database/database.service.js';
import type { XeroConnectorService } from '../../connectors/xero/xero-connector.service.js';
import type { XeroSalesCatalogue } from '../../connectors/xero/xero-sales-catalogue.js';

export async function readSalesCatalogue(db:PoolClient,tenant:string,lock=false){
  const s=runtimeConfig().schema;
  const rows=(await db.query(`SELECT c.xero_connection_id AS "connectionId",c.snapshot,c.revision,c.last_synced_at AS "lastSyncedAt",c.error_code AS "errorCode"
    FROM ${s}.student_xero_sales_catalogues c
    JOIN ${s}.student_operations_xero_sync_configurations cfg ON cfg.customer_id=c.customer_id AND cfg.xero_connection_id=c.xero_connection_id AND cfg.organisation_role='trust'
    JOIN ${s}.xero_connections x ON x.customer_id=c.customer_id AND x.xero_connection_id=c.xero_connection_id AND x.status='active'
    WHERE c.customer_id=$1 ORDER BY c.xero_connection_id ${lock?'FOR SHARE OF c':''}`,[tenant])).rows;
  if(rows.length!==1||!rows[0].lastSyncedAt)return null;
  const row=rows[0];return {connectionId:String(row.connectionId),revision:Number(row.revision),lastSyncedAt:row.lastSyncedAt,errorCode:row.errorCode as string|null,...row.snapshot as XeroSalesCatalogue};
}

/** One in-flight durable lease, daily refresh, safe bounded retry, no user-facing provider request. */
export class StudentXeroSalesCatalogueSync {
  constructor(private readonly database:DatabaseService,private readonly xero:XeroConnectorService){}
  async processOne(tenant:string){
    if(process.env.STUDENT_DOCUMENT_WORKFLOW_ENABLED!=='true')return false;
    const s=runtimeConfig().schema,token=randomUUID();
    const claim=await this.database.tenantTransaction(tenant,async db=>{
      await db.query(`INSERT INTO ${s}.student_xero_sales_catalogues(customer_id,xero_connection_id)
        SELECT cfg.customer_id,cfg.xero_connection_id FROM ${s}.student_operations_xero_sync_configurations cfg
        JOIN ${s}.xero_connections x ON x.customer_id=cfg.customer_id AND x.xero_connection_id=cfg.xero_connection_id AND x.status='active'
        WHERE cfg.customer_id=$1 AND cfg.organisation_role='trust' ON CONFLICT DO NOTHING`,[tenant]);
      const row=(await db.query(`SELECT c.xero_connection_id FROM ${s}.student_xero_sales_catalogues c
        JOIN ${s}.student_operations_xero_sync_configurations cfg ON cfg.customer_id=c.customer_id AND cfg.xero_connection_id=c.xero_connection_id AND cfg.organisation_role='trust'
        JOIN ${s}.xero_connections x ON x.customer_id=c.customer_id AND x.xero_connection_id=c.xero_connection_id AND x.status='active'
        WHERE c.customer_id=$1 AND c.next_attempt_at<=now() AND (c.lease_expires_at IS NULL OR c.lease_expires_at<now())
        ORDER BY c.next_attempt_at,c.xero_connection_id LIMIT 1 FOR UPDATE OF c SKIP LOCKED`,[tenant])).rows[0];
      if(!row)return null;
      await db.query(`UPDATE ${s}.student_xero_sales_catalogues SET lease_token=$3,lease_expires_at=now()+interval '5 minutes',attempts=attempts+1
        WHERE customer_id=$1 AND xero_connection_id=$2`,[tenant,row.xero_connection_id,token]);return String(row.xero_connection_id);
    });
    if(!claim)return false;
    try{
      const snapshot=await this.xero.salesCatalogue(tenant,claim);
      await this.database.tenantTransaction(tenant,db=>db.query(`UPDATE ${s}.student_xero_sales_catalogues SET snapshot=$4,revision=revision+1,last_synced_at=now(),next_attempt_at=now()+interval '24 hours',attempts=0,
        lease_token=NULL,lease_expires_at=NULL,error_code=NULL WHERE customer_id=$1 AND xero_connection_id=$2 AND lease_token=$3 AND lease_expires_at>now()`,[tenant,claim,token,JSON.stringify(snapshot)]));
    }catch(error){
      const body=(error as {getResponse?:()=>unknown})?.getResponse?.() as {providerStatus?:number;errorCode?:string;retryAfterSeconds?:number}|undefined;
      const code=body?.providerStatus===429||body?.errorCode==='xero_rate_limited'?'rate_limited':body?.errorCode==='xero_authorization_rejected'?'authorization':'provider_unavailable';
      const delay=Math.max(900,Math.min(Number(body?.retryAfterSeconds)||0,604800));
      await this.database.tenantTransaction(tenant,db=>db.query(`UPDATE ${s}.student_xero_sales_catalogues SET error_code=$4,next_attempt_at=now()+greatest($5::int,least(86400,900*power(2,least(attempts,7))::int))*interval '1 second',
        lease_token=NULL,lease_expires_at=NULL WHERE customer_id=$1 AND xero_connection_id=$2 AND lease_token=$3 AND lease_expires_at>now()`,[tenant,claim,token,code,delay]));
    }
    return true;
  }
}
