import {BadRequestException,Body,ConflictException,Controller,Get,NotFoundException,Param,ParseUUIDPipe,Post,Req,UseGuards} from '@nestjs/common';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {DatabaseService} from '../../database/database.service.js';
import {XeroConnectorService} from '../../connectors/xero/xero-connector.service.js';
import {StudentCommissionInvoicesService} from './student-commission-invoices.service.js';
import {StudentOperationsCasesService,caseSchema} from './student-operations-cases.service.js';
import {StudentOperationsWorkspaceGuard} from './student-operations-workspace.guard.js';
import {manager} from './trust-receipts.controller.js';
import {commissionHash} from './student-commission-calculation.js';
import {analysisToday} from './student-document-analysis-state.js';
import {currentPaymentList,currentTrustInvoice,importedInvoicePayments} from './trust-receipt-payment-candidates.js';

type Request=Parameters<typeof manager>[0];
type Principal=ReturnType<typeof manager>;
type Prepared=Awaited<ReturnType<StudentCommissionInvoicesService['settlementCalculation']>>;
type Entitlement=Prepared & {batch:string;sequence:number;studentId:string;eventHash:string;direct:boolean};
const review=z.object({requestId:z.uuid(),revision:z.number().int().nonnegative(),decision:z.enum(['eligible','uncertain','ineligible']),
  policy:z.string().trim().min(1).max(500),earnedOn:z.iso.date().nullable(),token:z.string().nullable()}).strict();
const invoice=z.object({revision:z.number().int().positive(),action:z.enum(['link','create']),invoiceId:z.uuid().nullable()}).strict();
const allocation=z.object({requestId:z.uuid(),revision:z.number().int().positive(),kind:z.enum(['cash','offset']),source:z.uuid(),
  minor:z.number().int().min(1).max(1_000_000_000)}).strict();
function parse<T>(schema:z.ZodType<T>,input:unknown){const result=schema.safeParse(input);
  if(!result.success)throw new BadRequestException('Check the commission details.');return result.data;}
type Key=[string,string,string];
const scope='customer_id=$1 AND case_id=$2 AND obligation_id=$3';

@Controller('business-packs/student-operations/v1/workspace/cases/:caseId/college-obligations/:id/commission')
@UseGuards(StudentOperationsWorkspaceGuard)
export class CommissionClaimsController {
  constructor(private readonly database:DatabaseService,private readonly cases:StudentOperationsCasesService,
    private readonly commissions:StudentCommissionInvoicesService,private readonly xero:XeroConnectorService){}

  private async state(db:PoolClient,p:Principal,key:Key,write:boolean){
    const s=caseSchema(),c=await this.cases.authorizedCase(db,p,key[1],write);
    if(write && c.lifecycle_status==='closed')throw new ConflictException('Reopen the case before recording commission.');
    const obligation=(await db.query(`SELECT o.*,b.batch_id FROM ${s}.student_college_obligations o
      LEFT JOIN ${s}.student_case_invoice_draft_batches b USING(customer_id,case_id,offer_id)
      WHERE o.customer_id=$1 AND o.case_id=$2 AND o.obligation_id=$3`,key)).rows[0];
    if(!obligation)throw new NotFoundException('College obligation not found.');
    const latest=(await db.query(`SELECT * FROM ${s}.student_commission_reviews WHERE ${scope} ORDER BY revision DESC LIMIT 1`,key)).rows[0];
    const link=(await db.query(`SELECT * FROM ${s}.student_commission_claim_invoices WHERE ${scope}`,key)).rows[0];
    const events=(await db.query(`SELECT event_id,kind,amount,offset_amount,occurred_on::text AS date FROM ${s}.student_college_settlement_events
      WHERE ${scope} AND kind<>'direct_proof' ORDER BY event_id`,key)).rows;
    return {obligation,latest,link,events,studentId:c.student_id};
  }
  private async prepared(db:PoolClient,p:Principal,key:Key,state:Awaited<ReturnType<CommissionClaimsController['state']>>):Promise<Entitlement>{
    const o=state.obligation;
    if(!o.batch_id || !o.offer_sequence)throw new ConflictException('Link a reviewed offer instalment and prepare its PTY commission calculation.');
    if(!state.events.some(e=>['direct_confirmation','agency_payment'].includes(e.kind)))throw new ConflictException('Record a confirmed college settlement before recognising commission.');
    const prepared=await this.commissions.settlementCalculation(db,p,key[1],o.batch_id,o.offer_sequence,o.college_id);
    if(!prepared.snapshot.totalMinor)throw new ConflictException('The reviewed rule produces no commission.');
    return {...prepared,studentId:state.studentId,batch:o.batch_id,sequence:o.offer_sequence,eventHash:commissionHash(state.events),
      direct:state.events.some(e=>e.kind==='direct_confirmation')};
  }

  private async invoices(db:PoolClient,key:Key,ent:Entitlement,submitted=false){
    const s=caseSchema(),v=ent.snapshot;
    return (await db.query(`SELECT i.xero_invoice_id AS id,i.invoice_number AS label,i.invoice_status AS status,
      e.xero_invoice_id IS NOT NULL AS paired,
      (e.xero_invoice_id IS NOT NULL OR i.invoice_reference=$8 OR EXISTS(
        SELECT 1 FROM ${s}.student_operations_case_invoice_links l WHERE
        (l.customer_id,l.xero_connection_id,l.xero_invoice_id,l.case_id)=(i.customer_id,i.xero_connection_id,i.xero_invoice_id,$7))) AS verified FROM ${s}.student_operations_xero_invoices i
      JOIN ${s}.student_operations_xero_sync_configurations cfg USING(customer_id,xero_connection_id)
      LEFT JOIN ${s}.student_commission_exports e ON (e.customer_id,e.xero_connection_id,e.xero_invoice_id)=(i.customer_id,i.xero_connection_id,i.xero_invoice_id)
      WHERE i.customer_id=$1 AND cfg.enabled AND cfg.organisation_role='operating' AND i.xero_connection_id=$2 AND i.xero_contact_id=$3
        AND i.invoice_type='ACCREC' AND i.invoice_status IN ('DRAFT','SUBMITTED','AUTHORISED','PAID') AND i.currency_code='AUD' AND i.total*100=$4
        AND (e.xero_invoice_id IS NULL OR (e.batch_id=$5 AND e.sequence=$6 AND e.case_id=$7))
        AND ((e.batch_id=$5 AND e.sequence=$6) OR i.invoice_reference=$8 OR (NOT $9 AND i.invoice_reference=$10))
        AND NOT EXISTS(SELECT 1 FROM ${s}.student_operations_case_invoice_links l WHERE (l.customer_id,l.xero_connection_id,l.xero_invoice_id)=(i.customer_id,i.xero_connection_id,i.xero_invoice_id) AND l.case_id<>$7)
        AND ${currentTrustInvoice(s,'i')} AND NOT EXISTS(SELECT 1 FROM ${s}.student_commission_claim_invoices other
          WHERE other.customer_id=i.customer_id AND other.connection_id=i.xero_connection_id AND other.invoice_id=i.xero_invoice_id AND other.obligation_id<>$11)
      ORDER BY i.invoice_date DESC NULLS LAST,i.xero_invoice_id LIMIT 100`,
      [key[0],v.connectionId,v.contactId,v.totalMinor,ent.batch,ent.sequence,key[1],this.reference(key),submitted,ent.student,key[2]])).rows;
  }
  private reference(key:Key){return 'College commission '+key[2];}

  private async collections(db:PoolClient,key:Key,ent:Entitlement,link:{invoice_id:string|null}|undefined){
    const s=caseSchema();
    const sources=(await db.query(`SELECT 'offset' AS kind,event_id AS id,(offset_amount*100)::int AS minor,reference AS label,NULL::text AS account,true AS fresh
      FROM ${s}.student_college_settlement_events WHERE ${scope} AND kind='agency_payment' AND offset_amount>0
      UNION ALL SELECT 'cash',r.resource_id,( (r.detail->>'amount')::numeric*100)::int,r.detail->>'date',r.detail->>'account',r.checked_at>=now()-interval '25 hours'
      FROM ${s}.student_xero_import_resources r JOIN ${s}.student_operations_xero_invoices i ON
        (i.customer_id,i.xero_connection_id,i.xero_invoice_id)=(r.customer_id,r.xero_connection_id,$4::uuid)
      JOIN ${s}.student_operations_xero_sync_configurations cfg ON cfg.customer_id=i.customer_id AND cfg.xero_connection_id=i.xero_connection_id
      WHERE r.customer_id=$1 AND r.xero_connection_id=$5 AND r.kind='Payments' AND cfg.enabled AND cfg.organisation_role='operating'
        AND i.invoice_type='ACCREC' AND i.invoice_status IN ('AUTHORISED','PAID') AND i.xero_contact_id=$6 AND i.currency_code='AUD'
        AND i.total*100=$7 AND ${currentTrustInvoice(s,'i')}
        AND r.detail->>'invoice'=$4::uuid::text AND r.detail->>'contact'=$6::uuid::text AND r.detail->>'currency'='AUD'
        AND r.detail->>'type'='ACCRECPAYMENT' AND r.detail->>'status'='AUTHORISED' AND r.detail->>'reconciled'='true'
        AND r.detail->>'account' IS NOT NULL AND (r.detail->>'amount')::numeric BETWEEN 0.01 AND 10000000
        AND ${currentPaymentList} AND EXISTS(SELECT 1 FROM (${importedInvoicePayments()}) e WHERE e.id=r.resource_id::text
          AND e.payment_date=r.detail->>'date' AND e.amount=(r.detail->>'amount')::numeric)
        AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(i.settlement->'entries') e
          WHERE e->>'kind'='payment' AND lower(e->>'id')=r.resource_id::text AND e->>'isReconciled'='false')
      ORDER BY kind,id`,[...key,link?.invoice_id??null,ent.snapshot.connectionId,ent.snapshot.contactId,ent.snapshot.totalMinor])).rows;
    const allocations=(await db.query(`SELECT request_id AS id,kind,source_id AS source,amount_minor AS minor,actor,evidence,
      recorded_at AS "recordedAt" FROM ${s}.student_commission_collections WHERE ${scope} ORDER BY recorded_at,request_id`,key)).rows;
    let cash=0,offset=0,disputed=0;
    const consumed=new Map<string,number>();
    for(const a of allocations)consumed.set(a.kind+'/'+a.source,(consumed.get(a.kind+'/'+a.source)??0)+a.minor);
    for(const a of allocations){
      const source=sources.find(v=>v.kind===a.kind&&v.id===a.source);
      if(!source || (consumed.get(a.kind+'/'+a.source)??0)>source.minor || source.account!==a.evidence.account || source.label!==a.evidence.label || source.minor!==a.evidence.minor)disputed+=a.minor;
      else if(a.kind==='cash')cash+=a.minor;else offset+=a.minor;
    }
    return {cash,offset,disputed,outstanding:ent.snapshot.totalMinor-cash-offset,
      allocations:allocations.map(({evidence,...record})=>record),
      sources:sources.filter(v=>v.fresh).map(v=>({...v,available:v.minor-(consumed.get(v.kind+'/'+v.id)??0)})).filter(v=>v.available>0)};
  }

  @Get()
  async view(@Req() req:Request,@Param('caseId',ParseUUIDPipe) c:string,@Param('id',ParseUUIDPipe) id:string){
    const p=manager(req),key:Key=[p.tenantId,c,id];
    return this.database.tenantReadTransaction(p.tenantId,async db=>{
      const state=await this.state(db,p,key,false);let current:Entitlement|undefined,issue:string|null=null;
      try{current=await this.prepared(db,p,key,state);}catch(error){if(!(error instanceof ConflictException||error instanceof BadRequestException))throw error;issue=error.message;}
      const ent=state.latest?.snapshot as Entitlement|undefined;
      const history=(await db.query(`SELECT revision,decision,policy,earned_on::text AS date,actor FROM ${caseSchema()}.student_commission_reviews
        WHERE ${scope} ORDER BY revision DESC LIMIT 20`,key)).rows;
      return {history,issue,token:current?commissionHash(current):null,previewMinor:current?.snapshot.totalMinor??null,
        calculation:current?{student:current.student,college:current.snapshot.collegeName,base:current.snapshot.calculation.tuitionMinor,
          tax:current.snapshot.taxMinor,total:current.snapshot.totalMinor,rule:current.snapshot.rule.rule_id}:null,
        earnedMinor:ent?.snapshot.totalMinor??null,stale:!!ent&&commissionHash(ent)!==(current?commissionHash(current):null),
        link:state.link?{status:state.link.status,origin:state.link.origin,id:state.link.invoice_id}:null,
        candidates:ent&&!state.link?.invoice_id?await this.invoices(db,key,ent,!!state.link):[],
        totals:ent?await this.collections(db,key,ent,state.link):null,canCreate:!!current?.direct&&process.env.XERO_INVOICE_CREATION_ENABLED==='true'};
    });
  }

  @Post('review')
  async decide(@Req() req:Request,@Param('caseId',ParseUUIDPipe) c:string,@Param('id',ParseUUIDPipe) id:string,@Body() body:unknown){
    const p=manager(req),v=parse(review,body),key:Key=[p.tenantId,c,id],s=caseSchema();
    return this.database.tenantTransaction(p.tenantId,async db=>{
      const state=await this.state(db,p,key,true);
      const prior=(await db.query(`SELECT revision,fingerprint FROM ${s}.student_commission_reviews WHERE ${scope} AND request_id=$4`,[...key,v.requestId])).rows[0];
      if(prior?.fingerprint===commissionHash(v))return {revision:prior.revision};
      const used=await db.query(`SELECT amount_minor FROM ${s}.student_commission_collections WHERE ${scope}`,key);
      if(prior||v.revision!==(state.latest?.revision??0)||state.link)throw new ConflictException('Reload the claim. An invoiced entitlement is fixed.');
      const ent=v.decision==='eligible'?await this.prepared(db,p,key,state):null;
      if(used.rows.length && (!ent || ent.snapshot.connectionId!==state.latest.snapshot.snapshot.connectionId ||
        ent.snapshot.contactId!==state.latest.snapshot.snapshot.contactId || ent.snapshot.totalMinor<used.rows.reduce((n,r)=>n+r.amount_minor,0)))
        throw new ConflictException('Preserve approved allocations when revising the entitlement.');
      if(ent && (!v.earnedOn||v.earnedOn>analysisToday()||v.token!==commissionHash(ent)))throw new ConflictException('Review the current calculation and contractual earning date.');
      if(!ent && v.earnedOn)throw new BadRequestException('Only eligible commission has an earning date.');
      await db.query(`INSERT INTO ${s}.student_commission_reviews(customer_id,case_id,obligation_id,revision,decision,policy,earned_on,snapshot,actor,request_id,fingerprint)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[...key,v.revision+1,v.decision,v.policy,v.earnedOn,ent,p.identityUserId,v.requestId,commissionHash(v)]);
      return {revision:v.revision+1};
    });
  }

  @Post('invoice')
  async attach(@Req() req:Request,@Param('caseId',ParseUUIDPipe) c:string,@Param('id',ParseUUIDPipe) id:string,@Body() body:unknown){
    const p=manager(req),v=parse(invoice,body),key:Key=[p.tenantId,c,id],s=caseSchema();
    if((v.action==='link')!==!!v.invoiceId)throw new BadRequestException('Select a PTY invoice or approve creation.');
    const reserve=async(db:PoolClient,write:boolean)=>{
      const state=await this.state(db,p,key,write),ent=state.latest?.snapshot as Entitlement|undefined;
      if(!ent||state.latest.revision!==v.revision)throw new ConflictException('Approve the current entitlement first.');
      if(state.link?.invoice_id){
        if(v.invoiceId&&state.link.invoice_id!==v.invoiceId)throw new ConflictException('Another invoice is already linked.');
        return {done:true,id:state.link.invoice_id as string};
      }
      const pending=!!state.link;
      if(pending&&v.action==='create')throw new ConflictException('Creation was submitted. Refresh PTY and verify the resulting invoice before linking it.');
      if(!pending && commissionHash(await this.prepared(db,p,key,state))!==commissionHash(ent))throw new ConflictException('The rule or settlement evidence changed. Review eligibility again.');
      const candidates=await this.invoices(db,key,ent,pending);
      const paired=(await db.query(`SELECT status,xero_invoice_id FROM ${s}.student_commission_exports WHERE customer_id=$1 AND batch_id=$2 AND sequence=$3`,[p.tenantId,ent.batch,ent.sequence])).rows[0];
      const candidate=v.invoiceId?candidates.find(i=>i.id===v.invoiceId):null;
      if(v.action==='link' && (!candidate?.verified || (paired && paired.xero_invoice_id!==candidate.id)))throw new ConflictException('Verify the matching imported PTY invoice for this student, college and instalment.');
      if(v.action==='create' && (!ent.direct||paired||candidates.length))throw new ConflictException('Review the confirmed direct payment and existing PTY invoices first.');
      const token=commissionHash([key,v.revision]);
      if(write){
        if(v.action==='create'){
          await db.query(`SELECT 1 FROM ${s}.student_operations_xero_contacts WHERE customer_id=$1 AND xero_connection_id=$2 AND xero_contact_id=$3 FOR UPDATE`,[p.tenantId,ent.snapshot.connectionId,ent.snapshot.contactId]);
          const archiving=await db.query(`SELECT 1 FROM ${s}.student_case_deletions d,jsonb_array_elements(d.targets->'contacts') target WHERE d.customer_id=$1 AND d.completed_at IS NULL AND target->>'connectionId'=$2 AND target->>'contactId'=$3 LIMIT 1`,[p.tenantId,ent.snapshot.connectionId,ent.snapshot.contactId]);
          if(archiving.rowCount)throw new ConflictException('Finish the case deletion using this college contact before creating a commission.');
        }
        if(pending)await db.query(`UPDATE ${s}.student_commission_claim_invoices SET status='linked',invoice_id=$4 WHERE ${scope} AND status='submitted'`,[...key,v.invoiceId]);
        else await db.query(`INSERT INTO ${s}.student_commission_claim_invoices(customer_id,case_id,obligation_id,revision,batch_id,sequence,connection_id,contact_id,origin,status,invoice_id,provider_key,actor)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[...key,v.revision,ent.batch,ent.sequence,ent.snapshot.connectionId,
          ent.snapshot.contactId,candidate?(candidate.paired?'paired':'historical'):'direct',candidate?'linked':'submitted',v.invoiceId,token,p.identityUserId]);
      }
      return {done:false,ent,token,id:v.invoiceId};
    };
    if(v.action==='link')return {id:(await this.database.tenantTransaction(p.tenantId,db=>reserve(db,true))).id};
    const preliminary=await this.database.tenantReadTransaction(p.tenantId,db=>reserve(db,false));
    if(!preliminary.ent)return {id:preliminary.id};
    const session=await this.xero.invoiceCreationSession(p.tenantId,preliminary.ent.snapshot.connectionId,'operating');
    const claim=await this.database.tenantTransaction(p.tenantId,db=>reserve(db,true));
    if(!claim.ent)return {id:claim.id};
    const value=claim.ent.snapshot.value;
    const receipt=await session.createInvoice({...value,reference:this.reference(key),
      lines:value.lines.map(line=>({...line,description:line.description.replace(/(?:TRUST )?INV-\d+/g,'college instalment '+claim.ent.sequence)}))},claim.token);
    if(receipt.status!=='DRAFT' || !z.uuid().safeParse(receipt.invoiceId).success || Math.round(receipt.total*100)!==claim.ent.snapshot.totalMinor)
      throw new ConflictException('Review the submitted draft in PTY and verify its imported invoice.');
    await this.database.tenantTransaction(p.tenantId,async db=>{const updated=await db.query(`UPDATE ${s}.student_commission_claim_invoices SET status='linked',invoice_id=$4 WHERE ${scope} AND status='submitted'`,[...key,receipt.invoiceId]);
      if(!updated.rowCount){
        const existing=await db.query(`SELECT invoice_id FROM ${s}.student_commission_claim_invoices WHERE ${scope}`,key);
        if(existing.rows[0]?.invoice_id!==receipt.invoiceId)throw new ConflictException('Verify the submitted invoice against the imported PTY record.');
      }
    });
    return {id:receipt.invoiceId};
  }

  @Post('allocate')
  async allocate(@Req() req:Request,@Param('caseId',ParseUUIDPipe) c:string,@Param('id',ParseUUIDPipe) id:string,@Body() body:unknown){
    const p=manager(req),v=parse(allocation,body),key:Key=[p.tenantId,c,id],s=caseSchema();
    return this.database.tenantTransaction(p.tenantId,async db=>{
      const state=await this.state(db,p,key,true),ent=state.latest?.snapshot as Entitlement|undefined;
      const prior=(await db.query(`SELECT * FROM ${s}.student_commission_collections WHERE customer_id=$1 AND request_id=$2`,[p.tenantId,v.requestId])).rows[0];
      if(prior?.obligation_id===id && prior.case_id===c && prior.kind===v.kind && prior.source_id===v.source && prior.amount_minor===v.minor && prior.revision===v.revision)return {id:v.requestId};
      if(prior || !ent || state.latest.revision!==v.revision)throw new ConflictException('Reload the current claim before approving a collection.');
      if(!state.link?.invoice_id && commissionHash(await this.prepared(db,p,key,state))!==commissionHash(ent))
        throw new ConflictException('Review the changed entitlement before approving an allocation.');
      const totals=await this.collections(db,key,ent,state.link),source=totals.sources.find(a=>a.kind===v.kind&&a.id===v.source);
      if(!source || totals.disputed || v.minor>source.available || v.minor>totals.outstanding)throw new ConflictException('Review the source, previous allocations and outstanding balance.');
      await db.query(`INSERT INTO ${s}.student_commission_collections(customer_id,case_id,obligation_id,revision,request_id,kind,source_id,amount_minor,evidence,actor)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[...key,v.revision,v.requestId,v.kind,v.source,v.minor,source,p.identityUserId]);
      return {id:v.requestId};
    });
  }
}
