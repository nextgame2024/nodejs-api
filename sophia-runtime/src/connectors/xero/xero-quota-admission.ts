import { BadGatewayException } from '@nestjs/common';
import { runtimeConfig } from '../../config/runtime-config.js';
import type { DatabaseService } from '../../database/database.service.js';
import type { XeroRequestTicket } from './xero-rate-limit.js';

export type XeroRequestKind='operational'|'discovery';
type Budget={daily_limit:number;discovery_reserve:number;remaining:number|null;generation_admissions:number;
  expired:boolean;probing:boolean;retry_seconds:number;generation:string;reservation_sequence:string};
type Observation={day:number|null;problem:string|null;retryAfterSeconds:number|null};
const denial=(code:string,retry:number)=>new BadGatewayException({
  message:code==='xero_quota_reserved'?'Document discovery is paused to preserve Xero allowance for updates and manual operations.'
    :'Xero allowance is not currently available. The background job will retry later.',
  errorCode:code,providerStatus:null,retryAfterSeconds:Math.max(60,retry),localQuotaDenial:true,upstreamAttempted:false,
});

export class XeroQuotaAdmission {
  constructor(private readonly database:DatabaseService) {}

  async reserve(customer:string,connection:string,kind:XeroRequestKind):Promise<XeroRequestTicket> {
    const table=`${runtimeConfig().schema}.xero_quota_admission`;
    // Return denials, rather than throw within the transaction: refreshing an
    // unknown epoch must commit so repeated discovery polls cannot renew it.
    const result=await this.database.tenantTransaction(customer,async db=>{
      const args=[customer,connection];
      await db.query(`INSERT INTO ${table}(customer_id,xero_connection_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,args);
      let row=(await db.query<Budget>(`SELECT *,refresh_after<=now() AS expired,probe_until>now() AS probing,
        greatest(60,ceil(extract(epoch FROM refresh_after-now())))::int AS retry_seconds
        FROM ${table} WHERE customer_id=$1 AND xero_connection_id=$2 FOR UPDATE`,args)).rows[0];
      if(row.expired) {
        await db.query(`UPDATE ${table} SET remaining=NULL,generation=generation+1,generation_admissions=0,
          refresh_after=CASE WHEN provider_reset_at IS NULL THEN now()+interval '24 hours'
            ELSE provider_reset_at+(floor(extract(epoch FROM now()-provider_reset_at)/86400)+1)*interval '24 hours' END,
          probe_until=NULL,probe_sequence=NULL,updated_at=now()
          WHERE customer_id=$1 AND xero_connection_id=$2`,args);
        row={...row,remaining:null,probing:false,generation_admissions:0,retry_seconds:60};
      }
      if(row.remaining===null && (kind==='discovery' || row.probing)) return {code:'xero_quota_unknown',retry:60};
      if(row.generation_admissions>=row.daily_limit || row.remaining===0) return {code:'xero_quota_exhausted',retry:row.retry_seconds};
      if(kind==='discovery' && row.remaining!<=row.discovery_reserve) return {code:'xero_quota_reserved',retry:row.retry_seconds};
      const admitted=await db.query<XeroRequestTicket>(`UPDATE ${table} SET
        remaining=CASE WHEN remaining IS NULL THEN NULL ELSE remaining-1 END,
        generation_admissions=generation_admissions+1,reservation_sequence=reservation_sequence+1,
        operational_admissions=operational_admissions+CASE WHEN $3='operational' THEN 1 ELSE 0 END,
        discovery_admissions=discovery_admissions+CASE WHEN $3='discovery' THEN 1 ELSE 0 END,
        probe_until=CASE WHEN remaining IS NULL THEN now()+interval '60 seconds' ELSE probe_until END,
        probe_sequence=CASE WHEN remaining IS NULL THEN reservation_sequence+1 ELSE probe_sequence END,updated_at=now()
        WHERE customer_id=$1 AND xero_connection_id=$2
        RETURNING generation::text, reservation_sequence::text AS sequence`,[...args,kind]);
      return {ticket:admitted.rows[0]};
    });
    if('ticket' in result) return result.ticket!;
    throw denial(result.code,result.retry);
  }

  async observe(customer:string,connection:string,ticket:XeroRequestTicket,value:Observation,status:number) {
    const table=`${runtimeConfig().schema}.xero_quota_admission`;
    await this.database.tenantTransaction(customer,async db=>{
      // Later admissions are subtracted from returned balances. A late high
      // header can lower but never replenish credits within an epoch.
      await db.query(`UPDATE ${table} SET remaining=CASE
        WHEN $7::boolean THEN 0
        WHEN $5::int IS NULL THEN remaining
        WHEN remaining IS NULL AND probe_sequence<>$4::bigint THEN NULL
        ELSE greatest(0,least(coalesce(remaining,daily_limit),daily_limit-generation_admissions,
          $5::bigint-greatest(0,reservation_sequence-$4::bigint))) END,
        refresh_after=CASE WHEN $7::boolean THEN now()+($6::int * interval '1 second') ELSE refresh_after END,
        provider_reset_at=CASE WHEN $8::boolean THEN now()+($6::int * interval '1 second')
          WHEN $7::boolean THEN NULL ELSE provider_reset_at END,
        probe_until=CASE WHEN probe_sequence=$4::bigint AND $5::int IS NOT NULL THEN NULL ELSE probe_until END,
        observed_at=now(),updated_at=now()
        WHERE customer_id=$1 AND xero_connection_id=$2 AND generation=$3::bigint`,
        [customer,connection,ticket.generation,ticket.sequence,value.day===null?null:Math.min(value.day,5000),
          value.retryAfterSeconds??86400,status===429 && (value.problem==='day' || value.problem===null),
          status===429 && value.problem==='day']);
    });
  }

  async exhaustedDelay(customer:string,connection:string,ticket:XeroRequestTicket,fallback:number) {
    const result=await this.database.tenantReadTransaction(customer,db=>db.query<{seconds:number}>(
      `SELECT greatest(1,ceil(extract(epoch FROM refresh_after-now())))::int AS seconds
       FROM ${runtimeConfig().schema}.xero_quota_admission WHERE customer_id=$1 AND xero_connection_id=$2
         AND generation=$3::bigint AND provider_reset_at IS NOT NULL AND refresh_after>now()`,
      [customer,connection,ticket.generation]));
    return Math.min(fallback,result.rows[0]?.seconds??fallback);
  }
}
