import { BadRequestException,ConflictException,NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';

export const mappingCommand=z.object({
  revision:z.number().int().nonnegative(),catalogueRevision:z.number().int().nonnegative(),requestId:z.uuid(),
  accountId:z.uuid().transform(id=>id.toLowerCase()).nullable(),receiptLabel:z.string().trim().min(1).max(120).nullable(),
  reason:z.string().trim().min(1).max(500),
}).strict().refine(row=>(row.accountId===null)===(row.receiptLabel===null));
export interface Account {id:string;name:string}
export interface Mapping {
  revision:number;catalogueRevision:number;organisationId:string;accountId:string|null;accountName:string|null;
  receiptLabel:string|null;actor:string;reason:string;recordedAt:Date;
}
export async function receiptAccount(db:PoolClient,s:string,tenant:string,connection:string) {
  const {rows:[row]}=await db.query<{organisationId:string;revision:number;accounts:Account[]|null;fresh:boolean;importedAt:Date|null}>(`
    SELECT x.xero_tenant_id AS "organisationId",coalesce(c.revision,0) AS revision,
      c.snapshot->'receiptBankAccounts' AS accounts,c.last_synced_at AS "importedAt",
      (c.error_code IS NULL AND c.last_synced_at>=clock_timestamp()-interval '24 hours') IS TRUE AS fresh
    FROM ${s}.student_operations_xero_sync_configurations cfg JOIN ${s}.xero_connections x USING(customer_id,xero_connection_id)
    LEFT JOIN ${s}.student_xero_sales_catalogues c USING(customer_id,xero_connection_id)
    WHERE cfg.customer_id=$1 AND cfg.xero_connection_id=$2 AND cfg.enabled AND cfg.organisation_role='trust' AND x.status='active'`,[tenant,connection]);
  if (!row) throw new NotFoundException();
  const {rows:history}=await db.query<Mapping>(`SELECT revision,catalogue_revision AS "catalogueRevision",organisation_id AS "organisationId",
    account_id AS "accountId",account_name AS "accountName",receipt_label AS "receiptLabel",actor,reason,recorded_at AS "recordedAt"
    FROM ${s}.student_trust_receipt_account_mappings WHERE customer_id=$1 AND xero_connection_id=$2 ORDER BY revision DESC LIMIT 10`,[tenant,connection]);
  const accounts=row.accounts ?? [],head=history[0];
  const fresh=row.fresh && Array.isArray(row.accounts);
  const active=!!head?.accountId && fresh && row.organisationId===head.organisationId &&
    accounts.filter(a=>a.id===head.accountId).length===1 && accounts.some(a=>a.id===head.accountId && a.name===head.accountName);
  return {organisationId:row.organisationId,catalogueRevision:row.revision,importedAt:row.importedAt,fresh,active,
    accounts,revision:head?.revision ?? 0,history};
}
export async function lockReceiptAccount(db:PoolClient,s:string,tenant:string,connection:string,mode:'read'|'write') {
  const lock=mode==='write'?'pg_advisory_xact_lock':'pg_advisory_xact_lock_shared';
  await db.query(`SELECT ${lock}(hashtextextended($1,0))`,['receipt-account/'+tenant.toLowerCase()+'/'+connection.toLowerCase()]);
  await db.query(`SELECT 1 FROM ${s}.student_xero_sales_catalogues WHERE customer_id=$1 AND xero_connection_id=$2 FOR SHARE`,[tenant,connection]);
}
export async function changeReceiptAccount(db:PoolClient,s:string,tenant:string,connection:string,actor:string,input:z.infer<typeof mappingCommand>) {
  await lockReceiptAccount(db,s,tenant,connection,'write');
  const state=await receiptAccount(db,s,tenant,connection);
  const table=s+'.student_trust_receipt_account_mappings';
  const prior=(await db.query(`SELECT * FROM ${table} WHERE customer_id=$1 AND xero_connection_id=$2 AND request_id=$3`,
    [tenant,connection,input.requestId])).rows[0];
  if (prior) {
    if (prior.revision!==input.revision+1 || prior.catalogue_revision!==input.catalogueRevision || prior.actor!==actor ||
        prior.reason!==input.reason || prior.receipt_label!==input.receiptLabel || prior.account_id!==input.accountId)
      throw new ConflictException('This account mapping request changed.');
    return {revision:prior.revision};
  }
  if (state.revision!==input.revision) throw new ConflictException('Refresh the current account mapping.');
  const candidates=state.accounts.filter(a=>a.id===input.accountId),head=state.history[0];
  if (input.accountId && (!state.fresh || candidates.length!==1 || state.catalogueRevision!==input.catalogueRevision))
    throw new ConflictException('Refresh the account catalogue and review the selected bank account.');
  if (input.accountId===null ? !head?.accountId : state.active && input.accountId===head.accountId &&
      input.receiptLabel===head.receiptLabel) throw new BadRequestException('The account mapping is already current.');
  const revision=state.revision+1;
  await db.query(`INSERT INTO ${table} (customer_id,xero_connection_id,revision,request_id,catalogue_revision,organisation_id,
    receipt_label,account_id,account_name,actor,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [tenant,connection,revision,input.requestId,input.catalogueRevision,state.organisationId,input.receiptLabel,input.accountId,candidates[0]?.name ?? null,actor,input.reason]);
  return {revision};
}
