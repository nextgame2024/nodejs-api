import { BadRequestException, Body, ConflictException, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DatabaseService } from '../../database/database.service.js';
import { analysisToday } from './student-document-analysis-state.js';
import { caseSchema, StudentOperationsCasesService } from './student-operations-cases.service.js';
import { StudentOperationsWorkspaceGuard } from './student-operations-workspace.guard.js';
import { manager } from './trust-receipts.controller.js';
import { cents } from './trust-split-lines.js';

const amount=z.string().regex(/^(0|[1-9]\d{0,13})(\.\d{1,2})?$/);
const positive=amount.refine(v=>cents(v)>0n);
const label=z.string().trim().min(1).max(200);
const obligation=z.object({id:z.uuid(),collegeId:z.uuid(),scheduleId:z.uuid().nullable(),offer:z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]{1,8}$/i).nullable().default(null),instalment:label,
  policy:label,method:z.enum(['gross','net']),gross:positive,offsetLimit:amount,due:z.iso.date(),
  funding:z.iso.date().nullable(),bill:label.nullable()}).strict();
const event=z.object({id:z.uuid(),kind:z.enum(['direct_proof','direct_confirmation','agency_payment','applied_refund','unapplied_refund']),
  document:z.uuid().nullable().default(null),proof:z.uuid().nullable(),amount:positive,offset:amount,date:z.iso.date(),reference:label,evidence:z.string().trim().min(1).max(500)}).strict();
const pageNumber=z.coerce.number().int().min(1).max(100000).default(1);
type Request=Parameters<typeof manager>[0];
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function parse<T>(schema:z.ZodType<T>,body:unknown):T {
  const result=schema.safeParse(body);
  if(!result.success) throw new BadRequestException('Check the required fields, dates and AUD amounts.');
  return result.data;
}
function balances(s:string) {
  return `SELECT o.*,t.cash,t.used_offset,t.refunded,t.unapplied,t.direct,
    o.gross-t.cash-t.used_offset+t.refunded AS balance FROM ${s}.student_college_obligations o
    CROSS JOIN LATERAL (SELECT
      coalesce(sum(amount) FILTER(WHERE kind IN ('agency_payment','direct_confirmation')),0) AS cash,
      coalesce(sum(offset_amount),0) AS used_offset,
      coalesce(sum(amount) FILTER(WHERE kind='applied_refund'),0) AS refunded,
      coalesce(sum(amount) FILTER(WHERE kind='unapplied_refund'),0) AS unapplied,
      coalesce(sum(amount) FILTER(WHERE kind='direct_confirmation'),0) AS direct
      FROM ${s}.student_college_settlement_events e
      WHERE (e.customer_id,e.case_id,e.obligation_id)=(o.customer_id,o.case_id,o.obligation_id)) t`;
}
// A case-level overlap warrants review even when no single invoice is linked to the instalment.
function openTrustInvoice(s:string) {
  return `EXISTS(SELECT 1 FROM (
    SELECT xero_connection_id,xero_invoice_id FROM ${s}.student_operations_case_invoice_links WHERE customer_id=b.customer_id AND case_id=b.case_id
    UNION SELECT xero_connection_id,xero_invoice_id FROM ${s}.student_case_xero_invoice_exports WHERE customer_id=b.customer_id AND case_id=b.case_id AND status='created'
  ) linked JOIN ${s}.student_operations_xero_invoices i USING(xero_connection_id,xero_invoice_id)
    JOIN ${s}.student_operations_xero_sync_configurations cfg USING(customer_id,xero_connection_id)
    WHERE i.customer_id=b.customer_id AND cfg.organisation_role='trust' AND i.invoice_type='ACCREC'
      AND i.invoice_status='AUTHORISED' AND i.amount_due>0)`;
}
@Controller('business-packs/student-operations/v1/workspace')
@UseGuards(StudentOperationsWorkspaceGuard)
export class CollegeSettlementsController {
  constructor(private readonly db:DatabaseService,private readonly cases:StudentOperationsCasesService){}
  @Get('college-obligations')
  async queue(@Req() req:Request,@Query('page') input?:string,@Query('limit') size?:string,@Query('direction') sort?:string){
    const limit=Number(parse(z.enum(['25','50','100']).default('25'),size));
    const direction=parse(z.enum(['asc','desc']).default('asc'),sort);
    const p=manager(req),page=parse(pageNumber,input),s=caseSchema();
    return this.db.tenantReadTransaction(p.tenantId,async db=>{
      const result=await db.query(`WITH register AS (SELECT b.*,c.case_reference,n.college_name,
        (b.direct>0 AND ${openTrustInvoice(s)}) AS review
        FROM (${balances(s)}) b JOIN ${s}.student_operations_cases c USING(customer_id,case_id)
        JOIN ${s}.student_operations_colleges n USING(customer_id,college_id)
        WHERE b.customer_id=$1), open AS (SELECT * FROM register WHERE balance>0 OR unapplied>0 OR review), paged AS (
        SELECT case_id AS "caseId",case_reference AS "caseNumber",college_name AS college,instalment,due_on::text AS due,
        balance::text,unapplied::text,review,(balance>0 AND due_on<funding_on) IS TRUE AS "fundingRisk",obligation_id AS id
        FROM open ORDER BY due_on ${direction},obligation_id LIMIT $3 OFFSET $2)
        SELECT count(*)::int AS total,coalesce((SELECT jsonb_agg(paged ORDER BY due ${direction},id) FROM paged),'[]') AS rows FROM open`,[p.tenantId,(page-1)*limit,limit]);
      return result.rows[0];
    });
  }
  @Get('cases/:caseId/college-obligations')
  async list(@Req() req:Request,@Param('caseId',ParseUUIDPipe) caseId:string,@Query('page') input?:string){
    const p=manager(req),page=parse(pageNumber,input),s=caseSchema(),key=[p.tenantId,caseId];
    return this.db.tenantReadTransaction(p.tenantId,async db=>{
      await this.cases.authorizedCase(db,p,caseId);
      const colleges=(await db.query(`SELECT college_id AS value,college_name AS label FROM ${s}.student_operations_case_colleges
        JOIN ${s}.student_operations_colleges USING(customer_id,college_id) WHERE customer_id=$1 AND case_id=$2 ORDER BY college_name`,key)).rows;
      const offers=(await db.query(`SELECT o.offer_id::text||':'||i.sequence AS value,'Instalment '||i.sequence||' · AUD '||
        (i.total_minor/100.0)::numeric(16,2)::text AS label,o.resolved_college_id AS "collegeId"
        FROM ${s}.student_case_offers o JOIN ${s}.student_case_offer_instalments i USING(customer_id,offer_id)
        WHERE o.customer_id=$1 AND o.case_id=$2 AND o.is_current AND o.status='confirmed' AND o.currency='AUD'
        ORDER BY i.sequence`,key)).rows;
      const documents=(await db.query(`SELECT document_id AS value,file_name AS label FROM ${s}.student_operations_case_documents
        WHERE customer_id=$1 AND case_id=$2 AND deleted_at IS NULL ORDER BY discovered_at DESC,document_id LIMIT 100`,key)).rows;
      const schedules=(await db.query(`SELECT payment_schedule_id AS value, due_on::text||' · AUD '||amount::text AS label FROM ${s}.student_operations_case_payment_schedule ps
        WHERE customer_id=$1 AND case_id=$2 AND currency_code='AUD' AND status<>'cancelled' AND NOT EXISTS(
        SELECT 1 FROM ${s}.student_college_obligations o WHERE o.customer_id=ps.customer_id AND o.schedule_id=ps.payment_schedule_id) ORDER BY due_on,payment_schedule_id`,key)).rows;
      const total=(await db.query(`SELECT count(*)::int AS n FROM ${s}.student_college_obligations WHERE customer_id=$1 AND case_id=$2`,key)).rows[0].n;
      const rows=(await db.query(`SELECT b.obligation_id AS id,b.instalment,n.college_name AS college,b.policy_ref AS policy,b.method,b.gross,b.offset_limit AS "offsetLimit",
        b.due_on::text AS due,b.funding_on::text AS funding,b.bill_ref AS bill,b.bill_invoice_id AS "billId",b.cash,b.used_offset AS "usedOffset",b.balance,b.refunded,b.unapplied,
        (b.balance>0 AND b.due_on<b.funding_on) IS TRUE AS "fundingRisk",
        CASE WHEN cfg.organisation_role='trust' AND i.invoice_type='ACCREC' THEN i.amount_due END AS "trustDue",b.direct,(b.direct>0 AND ${openTrustInvoice(s)}) AS review
        FROM (${balances(s)}) b JOIN ${s}.student_operations_colleges n USING(customer_id,college_id)
        LEFT JOIN ${s}.student_operations_case_payment_schedule ps ON ps.customer_id=b.customer_id AND ps.payment_schedule_id=b.schedule_id
        LEFT JOIN ${s}.student_operations_case_invoice_links l ON l.customer_id=b.customer_id AND l.case_id=b.case_id AND l.case_invoice_link_id=ps.case_invoice_link_id
        LEFT JOIN ${s}.student_operations_xero_invoices i ON (i.customer_id,i.xero_connection_id,i.xero_invoice_id)=(l.customer_id,l.xero_connection_id,l.xero_invoice_id)
        LEFT JOIN ${s}.student_operations_xero_sync_configurations cfg ON cfg.customer_id=l.customer_id AND cfg.xero_connection_id=l.xero_connection_id
        WHERE b.customer_id=$1 AND b.case_id=$2 ORDER BY b.due_on,b.obligation_id LIMIT 1 OFFSET $3`,[...key,page-1])).rows;
      return {colleges,schedules,offers,documents,total,row:rows[0]??null};
    });
  }
  @Get('cases/:caseId/college-obligations/:id/history')
  async history(@Req() req:Request,@Param('caseId',ParseUUIDPipe) caseId:string,@Param('id',ParseUUIDPipe) id:string,@Query('page') input?:string){
    const p=manager(req),page=parse(pageNumber,input),s=caseSchema();
    return this.db.tenantReadTransaction(p.tenantId,async db=>{
      await this.cases.authorizedCase(db,p,caseId);
      const rows=(await db.query(`SELECT e.event_id AS id,e.kind,e.amount,e.offset_amount AS "offset",e.occurred_on::text AS date,e.reference,e.evidence,e.actor,e.document_snapshot AS document,
        CASE WHEN e.kind='direct_proof' THEN e.amount-coalesce((SELECT sum(a.amount) FROM ${s}.student_college_settlement_events a
          WHERE (a.customer_id,a.case_id,a.obligation_id,a.proof_id)=(e.customer_id,e.case_id,e.obligation_id,e.event_id)),0) END AS remaining
        FROM ${s}.student_college_settlement_events e WHERE customer_id=$1 AND case_id=$2 AND obligation_id=$3
        ORDER BY recorded_at DESC,event_id DESC LIMIT 26 OFFSET $4`,[p.tenantId,caseId,id,(page-1)*25])).rows;
      return {rows:rows.slice(0,25),more:rows.length>25};
    });
  }
  @Post('cases/:caseId/college-obligations')
  async create(@Req() req:Request,@Param('caseId',ParseUUIDPipe) caseId:string,@Body() body:unknown){
    const p=manager(req),v=parse(obligation,body),s=caseSchema(),key=[p.tenantId,caseId,v.id],hash=digest(v);
    if(cents(v.offsetLimit)>=cents(v.gross) || (v.method==='gross' && cents(v.offsetLimit)!==0n)) throw new BadRequestException('Check the offset against the contract amount and settlement method.');
    return this.db.tenantTransaction(p.tenantId,async db=>{
      await this.cases.authorizedCase(db,p,caseId,true);
      const prior=(await db.query(`SELECT fingerprint FROM ${s}.student_college_obligations WHERE customer_id=$1 AND case_id=$2 AND obligation_id=$3`,key)).rows[0];
      if(prior?.fingerprint===hash)return {id:v.id};
      if(prior)throw new ConflictException('This request was already used.');
      const [offer,sequence]=v.offer?.split(':')??[];
      if(offer){
        const valid=await db.query(`SELECT 1 FROM ${s}.student_case_offers o JOIN ${s}.student_case_offer_instalments i USING(customer_id,offer_id)
          WHERE o.customer_id=$1 AND o.case_id=$2 AND o.resolved_college_id=$3 AND o.is_current AND o.status='confirmed'
            AND o.currency='AUD' AND o.offer_id=$4 AND i.sequence=$5`,[p.tenantId,caseId,v.collegeId,offer,sequence]);
        if(!valid.rowCount)throw new ConflictException('Select a current reviewed offer instalment for this college.');
      }
      const bills=v.bill?(await db.query(`SELECT i.xero_connection_id,i.xero_invoice_id FROM ${s}.student_operations_xero_invoices i
        JOIN ${s}.student_college_xero_contact_links l USING(customer_id,xero_connection_id,xero_contact_id)
        WHERE i.customer_id=$1 AND l.college_id=$2 AND l.classification='college' AND i.invoice_type='ACCPAY' AND i.currency_code='AUD'
          AND i.invoice_status IN ('AUTHORISED','PAID') AND lower(i.invoice_number)=lower($3) LIMIT 2`,[p.tenantId,v.collegeId,v.bill])).rows:[];
      if(bills.length>1)throw new ConflictException('More than one imported supplier bill matches this reference and college.');
      const inserted=await db.query(`INSERT INTO ${s}.student_college_obligations
        (customer_id,case_id,obligation_id,college_id,schedule_id,instalment,policy_ref,method,gross,offset_limit,due_on,funding_on,bill_ref,actor,fingerprint,bill_connection_id,bill_invoice_id,offer_id,offer_sequence)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
        FROM ${s}.student_operations_case_colleges WHERE customer_id=$1 AND case_id=$2 AND college_id=$4
        AND ($5::uuid IS NULL OR EXISTS(SELECT 1 FROM ${s}.student_operations_case_payment_schedule WHERE customer_id=$1 AND case_id=$2
          AND payment_schedule_id=$5 AND status<>'cancelled' AND currency_code='AUD')) ON CONFLICT DO NOTHING`,
        [...key,v.collegeId,v.scheduleId,v.instalment,v.policy,v.method,v.gross,v.offsetLimit,v.due,v.funding,v.bill,p.identityUserId,hash,bills[0]?.xero_connection_id??null,bills[0]?.xero_invoice_id??null,offer??null,sequence??null]);
      if(!inserted.rowCount)throw new ConflictException('Check the case college, schedule and duplicate instalment.');
      return {id:v.id};
    });
  }
  @Post('cases/:caseId/college-obligations/:id/events')
  async record(@Req() req:Request,@Param('caseId',ParseUUIDPipe) caseId:string,@Param('id',ParseUUIDPipe) id:string,@Body() body:unknown){
    const p=manager(req),v=parse(event,body),s=caseSchema(),key=[p.tenantId,caseId,id],hash=digest(v);
    if(v.date>analysisToday() || (v.kind==='direct_confirmation')!==!!v.proof || (v.kind!=='agency_payment' && cents(v.offset)!==0n))
      throw new BadRequestException('Check the settlement date, proof and offset.');
    return this.db.tenantTransaction(p.tenantId,async db=>{
      await this.cases.authorizedCase(db,p,caseId,true);
      const table=s+'.student_college_settlement_events';
      const prior=(await db.query(`SELECT fingerprint FROM ${table} WHERE customer_id=$1 AND case_id=$2 AND obligation_id=$3 AND event_id=$4`,[...key,v.id])).rows[0];
      if(prior?.fingerprint===hash)return {id:v.id};
      if(prior)throw new ConflictException('This request was already used.');
      const row=(await db.query(`SELECT * FROM (${balances(s)}) b WHERE customer_id=$1 AND case_id=$2 AND obligation_id=$3`,key)).rows[0];
      if(!row)throw new NotFoundException();
      if(v.kind==='direct_confirmation'){
        const proof=(await db.query(`SELECT e.occurred_on::text AS date,e.amount-coalesce((SELECT sum(amount) FROM ${table}
          WHERE customer_id=$1 AND case_id=$2 AND obligation_id=$3 AND proof_id=$4),0) AS remaining
          FROM ${table} e WHERE customer_id=$1 AND case_id=$2 AND obligation_id=$3 AND event_id=$4 AND kind='direct_proof'`,[...key,v.proof])).rows[0];
        if(!proof || proof.date>v.date || cents(v.amount)>cents(proof.remaining))throw new ConflictException('Confirmation exceeds the available proof or predates it.');
      }
      if(['direct_confirmation','agency_payment'].includes(v.kind) && (cents(v.amount)+cents(v.offset)>cents(row.balance) ||
          cents(v.offset)+cents(row.used_offset)>cents(row.offset_limit)))throw new ConflictException('The settlement exceeds the outstanding amount or approved offset.');
      if(v.kind==='applied_refund' && cents(v.amount)>cents(row.cash)-cents(row.refunded))throw new ConflictException('The refund exceeds confirmed cash.');
      const document=v.document?(await db.query(`SELECT document_id AS id,file_name AS name,attachment_id AS attachment,xero_file_id AS "fileId"
        FROM ${s}.student_operations_case_documents WHERE customer_id=$1 AND case_id=$2 AND document_id=$3 AND deleted_at IS NULL`,
        [p.tenantId,caseId,v.document])).rows[0]:null;
      if(v.document && !document)throw new ConflictException('Select an available document from this case.');
      const result=await db.query(`INSERT INTO ${table}(customer_id,case_id,obligation_id,event_id,proof_id,kind,amount,offset_amount,occurred_on,reference,evidence,actor,fingerprint,document_snapshot)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT DO NOTHING`,[...key,v.id,v.proof,v.kind,v.amount,v.offset,v.date,v.reference,v.evidence,p.identityUserId,hash,document??null]);
      if(!result.rowCount)throw new ConflictException('That settlement reference has already been recorded.');
      return {id:v.id};
    });
  }
}
