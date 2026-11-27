import { matchOutcomes, outcomeQuery } from './trust-match-outcomes.js';
import { createHash } from 'node:crypto';
import { currentTrustInvoice } from './trust-receipt-payment-candidates.js';
import { BadRequestException, Body, ConflictException, Controller, Get, Header, NotFoundException, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { runtimeConfig } from '../../config/runtime-config.js';
import { DatabaseService } from '../../database/database.service.js';
import { analysisToday } from './student-document-analysis-state.js';
import { StudentOperationsWorkspaceGuard } from './student-operations-workspace.guard.js';
import { manager, receiptFields } from './trust-receipts.controller.js';

const stageFields = receiptFields.pick({account:true,receivedOn:true,amount:true,reference:true,bankTransactionId:true,
  statementFileName:true,statementFileSha256:true,statementRecord:true}).required();
const queryFields = z.object({page:z.coerce.number().int().min(1).max(100000).default(1),q:z.string().trim().max(150).default('')}).strict();
const ruleVersion=1;
const decisionFields=queryFields.extend({
  invoiceId:z.uuid(), decision:z.enum(['accepted','dismissed']), reason:z.string().trim().min(1).max(500),
  revision:z.number().int().nonnegative(), evidenceToken:z.string().regex(/^[0-9a-f]{64}$/), requestId:z.uuid(),
});
function fingerprint(value:unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
type InvoiceEvidence = {
  id:string; invoiceNumber:string|null; reference:string|null; contact:string|null; balance:string; difference:string;
  numberMatch:boolean; numberInReference:boolean; referenceMatch:boolean; amountMatch:boolean; score:number; peers:number;
};
type Request = Parameters<typeof manager>[0];

@Controller('business-packs/student-operations/v1/workspace/trust-staged-deposits/:connectionId')
@UseGuards(StudentOperationsWorkspaceGuard)
export class TrustStagedDepositsController {
  constructor(private readonly database:DatabaseService) {}
  private async requireTrust(db:PoolClient,tenant:string,connection:string) {
    const schema=runtimeConfig().schema;
    const enabled=await db.query(`SELECT 1 FROM ${schema}.student_operations_xero_sync_configurations c
      JOIN ${schema}.xero_connections x USING(customer_id,xero_connection_id)
      WHERE c.customer_id=$1 AND c.xero_connection_id=$2 AND c.enabled AND c.organisation_role='trust' AND x.status='active'`,[tenant,connection]);
    if (!enabled.rowCount) throw new NotFoundException();
  }

  @Post()
  async stage(@Req() request:Request,@Param('connectionId',ParseUUIDPipe) connection:string,@Body() body:unknown) {
    const p=manager(request);
    const parsed=stageFields.safeParse(body);
    if (!parsed.success || !parsed.data.bankTransactionId || parsed.data.receivedOn>analysisToday()) {
      throw new BadRequestException('Check the deposit date, amount, account, transaction ID and CSV source.');
    }
    const d=parsed.data;
    const schema=runtimeConfig().schema;
    return this.database.tenantTransaction(p.tenantId,async db=>{
      await this.requireTrust(db,p.tenantId,connection);
      const params=[p.tenantId,connection,d.account,d.bankTransactionId,d.receivedOn,d.amount,d.reference,
        d.statementFileName,d.statementFileSha256,d.statementRecord,p.identityUserId];
      const inserted=await db.query(`INSERT INTO ${schema}.student_trust_staged_deposits
        (customer_id,connection_id,account_label,bank_transaction_id,received_on,amount,reference,
         statement_file_name,statement_file_sha256,statement_record,staged_by)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11 WHERE NOT EXISTS (
          SELECT 1 FROM ${schema}.student_trust_receipt_verifications r WHERE r.customer_id=$1 AND r.connection_id=$2
            AND ((lower(r.account_label)=lower($3) AND r.bank_transaction_id=$4)
              OR (r.statement_file_sha256=$9 AND r.statement_record=$10)))
        ON CONFLICT DO NOTHING RETURNING deposit_id AS id`,params);
      if (inserted.rowCount) return {id:inserted.rows[0].id,created:true};
      // A later export may contain the same movement. Keep its first source, and reject conflicting identities.
      const prior=await db.query(`SELECT deposit_id AS id,
        (lower(account_label)=lower($3) AND bank_transaction_id=$4 AND received_on=$5 AND amount=$6 AND reference=$7) AS same
        FROM ${schema}.student_trust_staged_deposits WHERE customer_id=$1 AND connection_id=$2
        AND ((lower(account_label)=lower($3) AND bank_transaction_id=$4) OR (statement_file_sha256=$8 AND statement_record=$9))`,
        [...params.slice(0,7),d.statementFileSha256,d.statementRecord]);
      if (prior.rowCount===1 && prior.rows[0].same) {
        const verified=await db.query(`SELECT 1 FROM ${schema}.student_trust_receipt_verifications
          WHERE customer_id=$1 AND connection_id=$2 AND lower(account_label)=lower($3) AND bank_transaction_id=$4`,
          params.slice(0,4));
        if (!verified.rowCount) return {id:prior.rows[0].id,created:false};
      }
      throw new ConflictException('This deposit is already verified or its bank or statement identity conflicts with existing evidence.');
    });
  }

  @Get('outcomes')
  @Header('Cache-Control','private, no-store')
  async outcomes(@Req() request:Request,@Param('connectionId',ParseUUIDPipe) connection:string,@Query() query:unknown) {
    const principal=manager(request);
    const parsed=outcomeQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException('Choose a valid deposit date range of up to 366 days, outcome and page.');
    return this.database.tenantReadTransaction(principal.tenantId,async db=>{
      await this.requireTrust(db,principal.tenantId,connection);
      return matchOutcomes(db,runtimeConfig().schema,principal.tenantId,connection,parsed.data);
    });
  }

  @Get(':depositId/invoices')
  @Header('Cache-Control','private, no-store')
  async candidates(@Req() request:Request,@Param('connectionId',ParseUUIDPipe) connection:string,
    @Param('depositId',ParseUUIDPipe) depositId:string,@Query() query:unknown) {
    const p=manager(request);
    const parsed=queryFields.safeParse(query);
    if (!parsed.success) throw new BadRequestException('Check the invoice search and page.');
    const {page,q}=parsed.data;
    return this.database.tenantReadTransaction(p.tenantId,async db=>{
      await this.requireTrust(db,p.tenantId,connection);
      return this.candidatePage(db,p.tenantId,connection,depositId,q,page);
    });
  }

  private async candidatePage(db:PoolClient,tenant:string,connection:string,depositId:string,q:string,page:number) {
      const schema=runtimeConfig().schema;
      const deposit=await db.query(`SELECT d.reference,d.amount::text,EXISTS (
          SELECT 1 FROM ${schema}.student_trust_receipt_verifications r
          WHERE r.customer_id=d.customer_id AND r.connection_id=d.connection_id
          AND ((lower(r.account_label)=lower(d.account_label) AND r.bank_transaction_id=d.bank_transaction_id)
            OR (r.statement_file_sha256=d.statement_file_sha256 AND r.statement_record=d.statement_record))
        ) AS used FROM ${schema}.student_trust_staged_deposits d
        WHERE d.customer_id=$1 AND d.connection_id=$2 AND d.deposit_id=$3`,[tenant,connection,depositId]);
      if (!deposit.rowCount) throw new NotFoundException();
      if (deposit.rows[0].used) throw new ConflictException('A verified receipt already uses this bank transaction or CSV record.');
      const reference:string=deposit.rows[0].reference;
      const numberTokens=(reference.toLowerCase().match(/[\p{L}\p{N}]+(?:[-_/][\p{L}\p{N}]+)*/gu) ?? [])
        .filter(token=>token!==reference.toLowerCase() && /[0-9]/.test(token) && /[a-z]/i.test(token));
      // Reference evidence takes precedence over a coincidentally equal balance.
      const result=await db.query<InvoiceEvidence>(`WITH evidence AS (
        SELECT i.xero_invoice_id AS id,i.invoice_number AS "invoiceNumber",i.invoice_reference AS reference,
          c.legal_name AS contact,round(i.amount_due,2) AS balance,
          ($3<>'' AND lower(btrim(i.invoice_number))=lower($3)) IS TRUE AS "numberMatch",
          (lower(btrim(i.invoice_number))=ANY($7::text[])) IS TRUE AS "numberInReference",
          ($3<>'' AND lower(btrim(i.invoice_reference))=lower($3)) IS TRUE AS "referenceMatch",
          round(i.amount_due,2)=$4::numeric AS "amountMatch"
        FROM ${schema}.student_operations_xero_invoices i
        JOIN ${schema}.student_operations_xero_contacts c USING(customer_id,xero_connection_id,xero_contact_id)
        WHERE i.customer_id=$1 AND i.xero_connection_id=$2 AND i.invoice_type='ACCREC'
          AND i.invoice_status='AUTHORISED' AND i.currency_code='AUD' AND round(i.amount_due,2)>0
          AND ${currentTrustInvoice(schema,'i')}
      ), ranked AS (
        SELECT *,8*"numberMatch"::int+4*"numberInReference"::int+2*"referenceMatch"::int+"amountMatch"::int AS score
        FROM evidence WHERE CASE WHEN $5='' THEN "numberMatch" OR "numberInReference" OR "referenceMatch" OR "amountMatch"
          ELSE strpos(lower("invoiceNumber"),lower($5))>0 OR strpos(lower(reference),lower($5))>0
            OR strpos(lower(contact),lower($5))>0 END
      )
      SELECT *,($4::numeric-balance)::text AS difference,count(*) OVER(PARTITION BY score)::int AS peers
      FROM ranked ORDER BY score DESC,"invoiceNumber" NULLS LAST,id LIMIT 11 OFFSET $6`,
        [tenant,connection,reference,deposit.rows[0].amount,q,(page-1)*10,numberTokens]);
      const candidates=result.rows.slice(0,10);
      const table=schema+'.student_trust_invoice_match_decisions';
      const scope=[tenant,connection,depositId];
      const scopeSql='customer_id=$1 AND connection_id=$2 AND deposit_id=$3';
      const {rows:[head]}=await db.query(`SELECT coalesce(max(revision),0) AS revision,
        max(revision) FILTER (WHERE decision='accepted') AS last_accept FROM ${table} WHERE ${scopeSql}`,scope);
      const latest=await db.query(`SELECT DISTINCT ON(invoice_id) invoice_id,revision,decision,evidence_token
        FROM ${table} WHERE ${scopeSql} AND invoice_id=ANY($4::uuid[])
        ORDER BY invoice_id,revision DESC`,[...scope,candidates.map(r=>r.id)]);
      const invoices=candidates.map(row=>{
        const evidenceToken=fingerprint([ruleVersion,depositId,row]);
        const previous=latest.rows.find(entry=>entry.invoice_id===row.id);
        const state=previous?.decision==='accepted' && previous.revision!==head.last_accept ? 'superseded' : previous?.decision;
        return {...row,evidenceToken,decision:state ?? null,evidenceChanged:!!previous && previous.evidence_token!==evidenceToken};
      });
      return {ruleVersion,revision:head.revision,invoices,hasMore:result.rows.length>10,page};
  }

  @Post(':depositId/decisions')
  async decide(@Req() request:Request,@Param('connectionId',ParseUUIDPipe) connection:string,
    @Param('depositId',ParseUUIDPipe) depositId:string,@Body() body:unknown) {
    const p=manager(request);
    const parsed=decisionFields.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Select an invoice and enter a reason of up to 500 characters.');
    const input=parsed.data, table=runtimeConfig().schema+'.student_trust_invoice_match_decisions';
    const scope=[p.tenantId,connection,depositId];
    const requestHash=fingerprint([p.identityUserId,input]);
    return this.database.tenantTransaction(p.tenantId,async db=>{
      await this.requireTrust(db,p.tenantId,connection);
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[scope.join('/').toLowerCase()]);
      const prior=await db.query(`SELECT revision,request_hash FROM ${table}
        WHERE customer_id=$1 AND connection_id=$2 AND deposit_id=$3 AND request_id=$4`,[...scope,input.requestId]);
      if (prior.rowCount) {
        if (prior.rows[0].request_hash!==requestHash) throw new ConflictException('This review request was already used with different details.');
        return {revision:prior.rows[0].revision};
      }
      const current=await this.candidatePage(db,p.tenantId,connection,depositId,input.q,input.page);
      const candidate=current.invoices.find(row=>row.id===input.invoiceId);
      if (!candidate || current.revision!==input.revision || candidate.evidenceToken!==input.evidenceToken) {
        throw new ConflictException('The matching evidence or a review decision changed. Refresh and review again.');
      }
      if (candidate.decision===input.decision && !candidate.evidenceChanged) throw new ConflictException('This decision is already current.');
      const {decision,evidenceChanged,evidenceToken,...evidence}=candidate;
      const revision=current.revision+1;
      await db.query(`INSERT INTO ${table}(customer_id,connection_id,deposit_id,invoice_id,revision,request_id,request_hash,
        decision,reason,reviewed_by,rule_version,evidence_token,evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [...scope,input.invoiceId,revision,input.requestId,requestHash,input.decision,input.reason,p.identityUserId,ruleVersion,
          evidenceToken,JSON.stringify({...evidence,lookup:input.q?'manual':'suggested'})]);
      return {revision};
    });
  }

  @Get(':depositId/decisions')
  @Header('Cache-Control','private, no-store')
  async decisions(@Req() request:Request,@Param('connectionId',ParseUUIDPipe) connection:string,
    @Param('depositId',ParseUUIDPipe) depositId:string,@Query() query:unknown) {
    const p=manager(request);
    const parsed=z.object({before:z.coerce.number().int().positive().optional()}).strict().safeParse(query);
    if (!parsed.success) throw new BadRequestException('Invalid review history cursor.');
    const schema=runtimeConfig().schema;
    return this.database.tenantReadTransaction(p.tenantId,async db=>{
      await this.requireTrust(db,p.tenantId,connection);
      const result=await db.query(`SELECT d.revision,d.decision,d.reason,d.reviewed_at AS "reviewedAt",
        coalesce(nullif(trim(staff.display_name),''),d.reviewed_by) AS reviewer,
        d.rule_version AS "ruleVersion",d.evidence FROM ${schema}.student_trust_invoice_match_decisions d
        LEFT JOIN ${schema}.student_operations_advisor_roster staff ON staff.customer_id=d.customer_id AND staff.user_id::text=d.reviewed_by
        WHERE d.customer_id=$1 AND d.connection_id=$2 AND d.deposit_id=$3 AND ($4::integer IS NULL OR d.revision<$4)
        ORDER BY d.revision DESC LIMIT 11`,[p.tenantId,connection,depositId,parsed.data.before ?? null]);
      return {entries:result.rows.slice(0,10),next:result.rows.length>10?result.rows[9].revision:null};
    });
  }

  @Get()
  @Header('Cache-Control','private, no-store')
  async list(@Req() request:Request,@Param('connectionId',ParseUUIDPipe) connection:string,@Query() query:unknown) {
    const p=manager(request);
    const parsed=queryFields.safeParse(query);
    if (!parsed.success) throw new BadRequestException('Check the deposit search and page.');
    const {page,q}=parsed.data;
    const schema=runtimeConfig().schema;
    return this.database.tenantReadTransaction(p.tenantId,async db=>{
      await this.requireTrust(db,p.tenantId,connection);
      const result=await db.query(`SELECT d.deposit_id AS id,d.account_label AS account,d.received_on::text AS date,
        d.amount::text,d.reference,d.bank_transaction_id AS "transactionId",
        jsonb_build_object('name',d.statement_file_name,'sha256',d.statement_file_sha256,'record',d.statement_record) AS source
        FROM ${schema}.student_trust_staged_deposits d WHERE d.customer_id=$1 AND d.connection_id=$2
        AND ($3='' OR d.bank_transaction_id=$3 OR strpos(lower(d.reference),lower($3))>0 OR strpos(lower(d.account_label),lower($3))>0)
        AND NOT EXISTS (SELECT 1 FROM ${schema}.student_trust_receipt_verifications r WHERE r.customer_id=d.customer_id
          AND r.connection_id=d.connection_id AND lower(r.account_label)=lower(d.account_label)
          AND r.bank_transaction_id=d.bank_transaction_id AND r.received_on=d.received_on AND r.amount=d.amount)
        ORDER BY d.received_on DESC,d.deposit_id LIMIT 26 OFFSET $4`,[p.tenantId,connection,q,(page-1)*25]);
      return {deposits:result.rows.slice(0,25),page,hasMore:result.rows.length>25};
    });
  }
}
