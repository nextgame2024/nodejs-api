import { BadRequestException,ConflictException,ForbiddenException,HttpException,Inject,Injectable,Logger,NotFoundException } from '@nestjs/common';
import { createHash,randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { DatabaseService } from '../../database/database.service.js';
import { StudentOperationsCasesService,caseSchema } from './student-operations-cases.service.js';
import type { StudentOperationsWorkspacePrincipal as Principal } from './student-operations-workspace.service.js';
import { hasStudentOperationsPermission } from './student-operations-policy.js';
import { documentChecklistEvidence,documentChecklistEnabled,reconcileDocumentChecklist } from './student-document-checklist.js';
import {matchesXeroInvoice,exactXeroInvoiceMatches,invoiceDraftXeroValue} from './student-case-invoice-matching.js';
export {matchesXeroInvoice,matchesXeroInvoiceHeader,exactXeroInvoiceMatches} from './student-case-invoice-matching.js';
import { analysisToday,documentWorkflowEnabled } from './student-document-analysis-state.js';
import type { PoolClient } from 'pg';
import { offerExtraction,paymentWithConditionalFee } from './student-document-analysis.contracts.js';
import { readSalesCatalogue } from './student-xero-sales-catalogue.js';
import { decimal4,pricedLineMinor,lineTaxMinor } from '../../connectors/xero/xero-sales-catalogue.js';
import { XeroConnectorService } from '../../connectors/xero/xero-connector.service.js';
import type { XeroInvoiceCreate,XeroInvoiceRecord } from '../../connectors/xero/xero.client.js';
import { publishXeroContact } from './student-xero-contact-projection.js';

class MissingContactProjection extends Error {
  constructor(readonly connectionId:string,readonly contactId:string){super('Contact projection missing');}
}

const text=z.string().trim().min(1).max(500),money=z.number().int().min(0).max(1_000_000_000);
const date=z.iso.date();
const line=z.object({kind:z.enum(['tuition','enrolment','materials','visa','oshc','other']),description:z.string().trim().min(1).max(4000),itemId:z.uuid(),
  itemCode:text,quantity:z.string().regex(/^\d{1,6}(\.\d{1,4})?$/),unitAmountMinor:money.optional(),unitPrice:decimal4.optional(),amountMinor:money,
  accountCode:text,taxType:text}).strict().refine(l=>l.unitPrice!==undefined||l.unitAmountMinor!==undefined);
export const invoiceDraftRequest=z.object({offerId:z.uuid(),offerVersion:z.number().int().positive(),caseVersion:z.number().int().positive(),advisorId:z.uuid(),
  draftBatchId:z.uuid().optional(),draftRevision:z.number().int().positive().optional(),
  catalogueConnectionId:z.uuid(),catalogueRevision:z.number().int().positive(),
  reviewNote:z.string().trim().max(500),
  invoices:z.array(z.object({sequence:z.number().int().positive(),issueDate:date,dueDate:date,
    conditionalFeeApplies:z.boolean(),conditionalFeeMinor:money,lines:z.array(line).min(1).max(30)}).strict()).min(1).max(200),
}).strict().refine(value=>(value.draftBatchId===undefined)===(value.draftRevision===undefined),{message:'Draft identity and revision must be provided together.'});
export type InvoiceDraftRequest=z.infer<typeof invoiceDraftRequest>;
const exportRequest=z.object({sequences:z.array(z.number().int().positive()).min(1).max(200),confirmed:z.literal(true)}).strict();
const reconcileRequest=z.object({sequence:z.number().int().positive()}).strict();

export function xeroPreflightFailure(error:unknown){
  if(!(error instanceof HttpException))return {};
  const response=error.getResponse();
  const detail=typeof response==='string'?{message:response}:response&&typeof response==='object'?response as {errorCode?:unknown;message?:unknown}:{};
  return {
    ...(typeof detail.errorCode==='string'?{errorCode:detail.errorCode}:{}),
    ...(typeof detail.message==='string'?{message:detail.message}:{}),
  };
}

/** Integer minor units and four-decimal quantities; round only once per line. */
export function lineTotal(quantity:string,unitAmountMinor:number){
  const [whole,fraction='']=quantity.split('.'),q=BigInt(whole)*10000n+BigInt(fraction.padEnd(4,'0'));
  return Number((q*BigInt(unitAmountMinor)+5000n)/10000n);
}
type AcceptedDraftDates={sequence:number;issueDate:string;dueDate:string};
export function validateDraftSchedule(source:z.infer<typeof offerExtraction>,value:InvoiceDraftRequest,taxForLine:(line:InvoiceDraftRequest['invoices'][number]['lines'][number])=>number=()=>0,systemDefaultDate?:string,acceptedDefaultDates:AcceptedDraftDates[]=[]){
  const sequences=value.invoices.map(i=>i.sequence);
  if(new Set(sequences).size!==sequences.length||value.invoices.length!==source.instalments.length||source.instalments.some(i=>!sequences.includes(i.sequence)))throw new BadRequestException('Prepare exactly one invoice for each offer instalment.');
  return value.invoices.map(invoice=>{
    const original=source.instalments.find(i=>i.sequence===invoice.sequence)!;
    if(invoice.dueDate<invoice.issueDate)throw new BadRequestException('Due dates must not precede issue dates.');
    if(invoice.lines.some(l=>Number(l.quantity)<=0||(l.unitPrice!==undefined?pricedLineMinor(l.quantity,l.unitPrice):lineTotal(l.quantity,l.unitAmountMinor!))!==l.amountMinor))throw new BadRequestException('Check line quantities, prices and amounts.');
    if(!invoice.lines.some(l=>l.kind==='tuition'))throw new BadRequestException('Each invoice needs a tuition line.');
    // The client confirms the applicable conditional amount per payment; never infer it from location.
    const fee=invoice.conditionalFeeApplies?invoice.conditionalFeeMinor:0;
    if(invoice.conditionalFeeApplies&&fee===0)throw new BadRequestException('Confirm the conditional fee amount or choose not to apply it.');
    if(!invoice.conditionalFeeApplies&&invoice.conditionalFeeMinor!==0)throw new BadRequestException('An excluded conditional fee must be zero.');
    const expected=paymentWithConditionalFee(original.totalMinor,original.includedConditionalFeeMinor,Math.max(original.includedConditionalFeeMinor,invoice.conditionalFeeMinor),invoice.conditionalFeeApplies);
    const lines=invoice.lines.map(l=>({...l,unitAmountMinor:l.unitPrice!==undefined?Number(l.unitPrice)*100:l.unitAmountMinor!,taxAmountMinor:taxForLine(l)}));
    const base=lines.reduce((n,l)=>n+l.amountMinor,0),tax=lines.reduce((n,l)=>n+l.taxAmountMinor,0),total=base+tax+fee;
    if(total>1_000_000_000)throw new BadRequestException('Invoice amount exceeds the supported limit.');
    const difference=total-expected;
    // Legacy editors started both dates at the organisation's current date.
    // Retain those accepted defaults without requiring a new review note.
    // New editors use the offer schedule; its due date already matches above.
    // Previously accepted defaults remain defaults after midnight. This list
    // comes only from the locked, revision-checked server snapshot, never from
    // request metadata. Both dates and the instalment identity must match.
    const retainsAcceptedDefault=acceptedDefaultDates.some(saved=>saved.sequence===invoice.sequence&&saved.issueDate===saved.dueDate&&saved.issueDate===invoice.issueDate&&saved.dueDate===invoice.dueDate);
    const usesSystemDefaultDates=(systemDefaultDate!==undefined&&invoice.issueDate===systemDefaultDate&&invoice.dueDate===systemDefaultDate)||retainsAcceptedDefault;
    const changesSourceDueDate=Boolean(original.dueOn&&original.dueOn!==invoice.dueDate&&!usesSystemDefaultDates);
    if((difference!==0||changesSourceDueDate)&&!value.reviewNote)throw new BadRequestException('Explain changes from the offer amounts or dates in the review note.');
    return {...invoice,lines,subtotalMinor:base,taxMinor:tax,invoiceNumber:`INV-${invoice.sequence}`,status:'DRAFT' as const,paymentTrack:'PENDING' as const,
      sourceTotalMinor:original.totalMinor,sourceDueDate:original.dueOn,sourceDueTerm:original.dueTerm,
      sourceIncludedConditionalFeeMinor:original.includedConditionalFeeMinor,expectedTotalMinor:expected,differenceMinor:difference,totalMinor:total};
  }).sort((a,b)=>a.sequence-b.sequence);
}

@Injectable()
export class StudentCaseInvoiceDraftsService {
  private readonly logger=new Logger(StudentCaseInvoiceDraftsService.name);
  constructor(@Inject(DatabaseService) private readonly database:DatabaseService,private readonly cases:StudentOperationsCasesService,private readonly xero:XeroConnectorService){}
  async onModuleInit(){
    if(!documentWorkflowEnabled())return;
    const missing=['STUDENT_DOCUMENT_CHECKLIST_ENABLED','STUDENT_DOCUMENT_ANALYSIS_ENABLED','STUDENT_OFFER_ANALYSIS_ENABLED'].filter(k=>process.env[k]!=='true');
    if(missing.length)throw new Error(`Document workflow requires exactly true: ${missing.join(', ')}.`);
    const ready=await this.database.query<{ready:boolean}>(`SELECT to_regclass($1) IS NOT NULL AND to_regclass($2) IS NOT NULL AND to_regclass($3) IS NOT NULL
      AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=$4 AND table_name='student_case_invoice_draft_batches' AND column_name='updated_at')
      AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=$4 AND table_name='student_operations_xero_invoices' AND column_name='last_seen_sync_run_id' AND is_nullable='YES')
      AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=$4 AND table_name='student_operations_xero_contacts' AND column_name='last_seen_sync_run_id' AND is_nullable='YES') AS ready`,
      [`${caseSchema()}.student_case_invoice_draft_batches`,`${caseSchema()}.student_xero_sales_catalogues`,`${caseSchema()}.student_case_xero_invoice_exports`,caseSchema()]);
    if(!ready.rows[0]?.ready)throw new Error('Document workflow requires Runtime migrations 098 through 103.');
  }
  private financial(p:Principal){if(!hasStudentOperationsPermission(p.role,'payments.read_all'))throw new ForbiddenException('Invoice financial access required.');}
  private canCreate(p:Principal){return process.env.XERO_INVOICE_CREATION_ENABLED==='true'&&hasStudentOperationsPermission(p.role,'payments.approve');}
  private async offer(db:PoolClient,p:Principal,id:string){
    const row=(await db.query(`SELECT o.*,v.corrections,r.extraction FROM ${caseSchema()}.student_case_offers o
      JOIN ${caseSchema()}.student_document_analysis_results r ON r.customer_id=o.customer_id AND r.result_id=o.result_id
      JOIN ${caseSchema()}.student_document_reviews v ON v.customer_id=o.customer_id AND v.review_id=o.review_id
      WHERE o.customer_id=$1 AND o.case_id=$2 AND o.is_current AND o.status='confirmed'`,[p.tenantId,id])).rows[0];
    return row?{row,source:offerExtraction.parse(row.corrections??row.extraction)}:null;
  }
  async list(p:Principal,id:string){
    this.financial(p);
    return this.database.tenantReadTransaction(p.tenantId,async db=>{
      const c=await this.cases.authorizedCase(db,p,id),s=caseSchema();
      const batches=(await db.query(`SELECT b.batch_id AS "batchId",b.offer_id AS "offerId",b.advisor_id AS "advisorId",b.revision,b.snapshot,b.created_at AS "createdAt",b.updated_at AS "updatedAt",o.is_current AS "currentOffer",
        COALESCE((SELECT jsonb_object_agg(e.sequence,jsonb_build_object('status',e.status,'invoiceId',e.xero_invoice_id,'invoiceNumber',e.xero_invoice_number))
          FROM ${s}.student_case_xero_invoice_exports e WHERE e.customer_id=b.customer_id AND e.batch_id=b.batch_id),'{}'::jsonb) AS exports
        FROM ${s}.student_case_invoice_draft_batches b JOIN ${s}.student_case_offers o ON o.customer_id=b.customer_id AND o.offer_id=b.offer_id
        WHERE b.customer_id=$1 AND b.case_id=$2 ORDER BY b.created_at DESC,b.batch_id LIMIT 20`,[p.tenantId,id])).rows;
      const eligible=documentWorkflowEnabled()&&hasStudentOperationsPermission(p.role,'payments.prepare')&&c.lifecycle_status==='pre_sale'&&c.current_stage==='checklist_complete';
      if(!eligible)return {batches,preparation:null,canCreateXero:this.canCreate(p)};
      const evidence=await documentChecklistEvidence(db,p.tenantId,id),offer=await this.offer(db,p,id);
      if(!offer||!evidence.completed.signed_engagement_letter||!evidence.completed.document_completeness)return {batches,preparation:null,canCreateXero:this.canCreate(p)};
      const advisors=(await db.query(`SELECT advisor_id AS "advisorId",code,name FROM ${s}.student_operations_advisor_directory WHERE customer_id=$1 AND status='active' ORDER BY lower(name),advisor_id`,[p.tenantId])).rows;
      const student=(await db.query(`SELECT legal_name AS name,advisor_id AS "advisorId" FROM ${s}.student_operations_students WHERE customer_id=$1 AND student_id=$2`,[p.tenantId,c.student_id])).rows[0];
      const catalogue=await readSalesCatalogue(db,p.tenantId);
      const savedBatch=batches.find(batch=>batch.offerId===offer.row.offer_id)??null;
      const hasUnresolvedInvoice=!savedBatch||savedBatch.snapshot.invoices.some((invoice:{sequence:number})=>{
        const receipt=savedBatch.exports[String(invoice.sequence)];return !receipt||receipt.status!=='created';
      });
      if(!hasUnresolvedInvoice)return {batches,preparation:null,canCreateXero:this.canCreate(p)};
      return {batches,preparation:{offerId:offer.row.offer_id,offerVersion:offer.row.record_version,caseVersion:c.record_version,source:offer.source,advisors,student,today:analysisToday(),catalogue,
        savedBatch:savedBatch?{batchId:savedBatch.batchId,revision:savedBatch.revision,advisorId:savedBatch.advisorId,snapshot:savedBatch.snapshot,exports:savedBatch.exports}:null},canCreateXero:this.canCreate(p)};
    });
  }
  async prepare(p:Principal,id:string,input:unknown,key?:string){
    this.financial(p);if(!hasStudentOperationsPermission(p.role,'payments.prepare'))throw new ForbiddenException();
    if(!documentWorkflowEnabled())throw new ConflictException('Document workflow is not enabled.');
    const parsed=invoiceDraftRequest.safeParse(input);if(!parsed.success)throw new BadRequestException('Complete and confirm the invoice preview fields.');
    const value=parsed.data;
    return this.cases.write(p,'case.invoice_drafts.prepare',{caseId:id,...value},key,async db=>{
      const c=await this.cases.authorizedCase(db,p,id,true),s=caseSchema();
      if(c.record_version!==value.caseVersion||c.lifecycle_status!=='pre_sale'||c.current_stage!=='checklist_complete')throw new ConflictException('The case changed or its documents are not verified. Reload the preview.');
      const evidence=await documentChecklistEvidence(db,p.tenantId,id),offer=await this.offer(db,p,id);
      if(!evidence.completed.signed_engagement_letter||!evidence.completed.document_completeness||!offer||offer.row.offer_id!==value.offerId||offer.row.record_version!==value.offerVersion)throw new ConflictException('The approved offer or required documents changed. Reload the preview.');
      const existing=(await db.query(`SELECT batch_id,advisor_id,revision,snapshot FROM ${s}.student_case_invoice_draft_batches WHERE customer_id=$1 AND case_id=$2 AND offer_id=$3 FOR UPDATE`,[p.tenantId,id,value.offerId])).rows[0];
      if(existing&&(value.draftBatchId!==existing.batch_id||value.draftRevision!==existing.revision))throw new ConflictException('The saved invoice drafts changed. Reload them before saving.');
      if(!existing&&value.draftBatchId!==undefined)throw new ConflictException('The saved invoice drafts no longer exist. Reload before saving.');
      const advisor=(await db.query(`SELECT code,name FROM ${s}.student_operations_advisor_directory WHERE customer_id=$1 AND advisor_id=$2 AND status='active'`,[p.tenantId,value.advisorId])).rows[0];
      if(!advisor)throw new BadRequestException('Select an active advisor in this organisation.');
      const catalogue=await readSalesCatalogue(db,p.tenantId,true);
      if(!catalogue||catalogue.connectionId!==value.catalogueConnectionId||catalogue.revision!==value.catalogueRevision)throw new ConflictException('The Xero item catalogue changed. Reload the preview.');
      for(const invoice of value.invoices)for(const line of invoice.lines){
        const item=catalogue.items.find(i=>i.itemId===line.itemId),account=catalogue.accounts.find(a=>a.code===item?.accountCode),tax=catalogue.taxRates.find(t=>t.taxType===item?.taxType);
        if(!item||item.code!==line.itemCode||!account||account.code!==line.accountCode||!tax||tax.taxType!==line.taxType||tax.rate===null)throw new BadRequestException('Select an available Xero item with valid sales account and tax defaults.');
      }
      const previous=existing?invoiceSnapshot.parse(existing.snapshot):null;
      // A saved date accepted without a review explanation is a trusted default.
      // Keep requiring explanations for manually reviewed exceptions.
      const acceptedDefaultDates=previous&&existing.snapshot.reviewNote===''?previous.invoices:[];
      const invoices=validateDraftSchedule(offer.source,value,l=>lineTaxMinor(l.amountMinor,catalogue.taxRates.find(t=>t.taxType===l.taxType)!.rate!),analysisToday(),acceptedDefaultDates),advisorLabel=`${advisor.code} ${advisor.name}`;
      const student=(await db.query(`SELECT legal_name FROM ${s}.student_operations_students WHERE customer_id=$1 AND student_id=$2`,[p.tenantId,c.student_id])).rows[0];
      const snapshot={studentName:student.legal_name,advisorLabel,category:null,location:null,billingUnit:null,currency:offer.source.currency,
        catalogueConnectionId:value.catalogueConnectionId??null,catalogueRevision:value.catalogueRevision??null,
        collegeName:offer.source.collegeName,reviewNote:value.reviewNote,invoices};
      if(existing&&previous){
        const frozen=(await db.query(`SELECT sequence,status FROM ${s}.student_case_xero_invoice_exports
          WHERE customer_id=$1 AND batch_id=$2 AND status<>'not_attempted' FOR UPDATE`,[p.tenantId,existing.batch_id])).rows as Array<{sequence:number;status:string}>;
        if(frozen.length&&existing.advisor_id!==value.advisorId)throw new ConflictException('The advisor cannot change after Xero invoice creation has started.');
        if(frozen.length&&previous.catalogueConnectionId!==snapshot.catalogueConnectionId)throw new ConflictException('The Xero organisation cannot change after invoice creation has started.');
        for(const receipt of frozen){
          const before=previous.invoices.find(invoice=>invoice.sequence===receipt.sequence),after=invoices.find(invoice=>invoice.sequence===receipt.sequence);
          if(!before||!after||!isDeepStrictEqual(before,after))throw new ConflictException(`INV-${receipt.sequence} is read-only because Xero invoice creation has started.`);
        }
        const updated=(await db.query(`UPDATE ${s}.student_case_invoice_draft_batches SET advisor_id=$4,advisor_label=$5,snapshot=$6,actor_identity_user_id=$7,updated_at=now(),revision=revision+1
          WHERE customer_id=$1 AND case_id=$2 AND batch_id=$3 RETURNING revision,updated_at AS "updatedAt"`,[p.tenantId,id,existing.batch_id,value.advisorId,advisorLabel,JSON.stringify(snapshot),p.identityUserId])).rows[0];
        await this.cases.activity(db,p,id,'case.invoice_drafts_prepared',`${invoices.length} invoice drafts updated — Payment Track PENDING`);
        return {batchId:existing.batch_id,count:invoices.length,updated:true,revision:updated.revision,updatedAt:updated.updatedAt};
      }
      const batch=(await db.query(`INSERT INTO ${s}.student_case_invoice_draft_batches(customer_id,case_id,offer_id,advisor_id,advisor_label,snapshot,actor_identity_user_id)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING batch_id,revision,updated_at AS "updatedAt"`,[p.tenantId,id,value.offerId,value.advisorId,advisorLabel,JSON.stringify(snapshot),p.identityUserId])).rows[0];
      await this.cases.activity(db,p,id,'case.invoice_drafts_prepared',`${invoices.length} invoice drafts prepared — Payment Track PENDING`);
      return {batchId:batch.batch_id,count:invoices.length,updated:false,revision:batch.revision,updatedAt:batch.updatedAt};
    });
  }

  private xeroValue(snapshot:InvoiceSnapshot,invoice:InvoiceSnapshot['invoices'][number],contactId:string):XeroInvoiceCreate{
    return invoiceDraftXeroValue(snapshot,invoice,contactId);
  }

  private async refreshWorkflow(p:Principal,id:string){
    if(!documentChecklistEnabled()||!documentWorkflowEnabled())return;
    try{await this.database.tenantTransaction(p.tenantId,async db=>{
      await this.cases.authorizedCase(db,p,id,true);await reconcileDocumentChecklist(db,p.tenantId,id);
    });}catch{this.logger.warn({event:'xero_invoice_workflow_refresh_pending'});}
  }

  private async confirmCreated(p:Principal,id:string,batchId:string,connectionId:string,contactId:string,snapshot:InvoiceSnapshot,invoice:InvoiceSnapshot['invoices'][number],receipt:{invoiceId:string;invoiceNumber:string|null;status:string;total:number},verified?:XeroInvoiceRecord){
    const s=caseSchema();
    await this.database.tenantTransaction(p.tenantId,async db=>{
      const updated=await db.query(`UPDATE ${s}.student_case_xero_invoice_exports SET status='created',xero_invoice_id=$4,xero_invoice_number=$5,provider_status=$6,completed_at=now()
        WHERE customer_id=$1 AND batch_id=$2 AND sequence=$3 AND status IN ('creating','review_required') RETURNING 1`,[p.tenantId,batchId,invoice.sequence,receipt.invoiceId,receipt.invoiceNumber,receipt.status]);
      if(!updated.rowCount){
        const existing=(await db.query(`SELECT status,xero_invoice_id FROM ${s}.student_case_xero_invoice_exports WHERE customer_id=$1 AND batch_id=$2 AND sequence=$3`,[p.tenantId,batchId,invoice.sequence])).rows[0];
        if(existing?.status!=='created'||existing.xero_invoice_id!==receipt.invoiceId)throw new ConflictException('Invoice creation receipt requires review.');
      }
      await this.cases.activity(db,p,id,'case.xero_invoice_created',`${invoice.invoiceNumber} created as Xero ${receipt.invoiceNumber??receipt.invoiceId}`);
    });
    try{
      await this.database.tenantTransaction(p.tenantId,async db=>{
        const c=await this.cases.authorizedCase(db,p,id),lineItems=verified?.lineItems??[],total=verified?.total??receipt.total;
        await db.query(`INSERT INTO ${s}.student_operations_xero_invoices(customer_id,xero_connection_id,xero_invoice_id,xero_contact_id,student_id,invoice_number,invoice_type,invoice_status,invoice_date,due_date,advisor_name,invoice_reference,college_name,payment_track,total,amount_paid,amount_due,currency_code,sent_to_contact,line_items,provider_updated_at)
          VALUES($1,$2,$3,$4,$5,$6,'ACCREC',$7,$8,$9,$10,$11,$11,$17,$12,$18,$19,$13,$14,$15,$16)
          ON CONFLICT(customer_id,xero_connection_id,xero_invoice_id) DO UPDATE SET invoice_number=EXCLUDED.invoice_number,invoice_status=EXCLUDED.invoice_status,invoice_date=EXCLUDED.invoice_date,due_date=EXCLUDED.due_date,
            advisor_name=EXCLUDED.advisor_name,invoice_reference=EXCLUDED.invoice_reference,college_name=EXCLUDED.college_name,payment_track=EXCLUDED.payment_track,total=EXCLUDED.total,amount_paid=EXCLUDED.amount_paid,amount_due=EXCLUDED.amount_due,
            currency_code=EXCLUDED.currency_code,sent_to_contact=EXCLUDED.sent_to_contact,line_items=EXCLUDED.line_items,provider_updated_at=EXCLUDED.provider_updated_at,updated_at=now()
            WHERE student_operations_xero_invoices.provider_updated_at IS NULL OR (EXCLUDED.provider_updated_at IS NOT NULL AND EXCLUDED.provider_updated_at>=student_operations_xero_invoices.provider_updated_at)`,
          [p.tenantId,connectionId,receipt.invoiceId,contactId,c.student_reference,receipt.invoiceNumber,verified?.status??receipt.status,verified?.invoiceDate??invoice.issueDate,verified?.dueDate??invoice.dueDate,
            verified?verified.advisorName:snapshot.advisorLabel,verified?verified.invoiceReference:snapshot.collegeName,total,verified?.currencyCode??snapshot.currency,verified?.sentToContact??false,JSON.stringify(lineItems),verified?.updatedAt??null,
            verified?verified.paymentTrack:'PENDING',verified?.amountPaid??0,verified?.amountDue??total]);
        await db.query(`INSERT INTO ${s}.student_operations_case_invoice_links(customer_id,case_id,student_id,student_reference,xero_connection_id,xero_invoice_id,linked_by_identity)
          VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
          [p.tenantId,id,c.student_id,c.student_reference,connectionId,receipt.invoiceId,p.identityUserId]);
      });
      return false;
    }catch(error){
      // Safe classification only: never log provider payloads, SQL detail or tokens.
      const code=(error as {code?:unknown})?.code;
      this.logger.warn({event:'xero_invoice_projection_pending',code:typeof code==='string'&&/^[A-Z0-9]{5}$/.test(code)?code:'projection_failed'});
      try{await this.database.tenantTransaction(p.tenantId,db=>db.query(`UPDATE ${s}.student_operations_xero_sync_configurations SET next_sync_at=now(),updated_at=now() WHERE customer_id=$1 AND xero_connection_id=$2`,[p.tenantId,connectionId]));}catch{}
      return true;
    }
  }

  async createXero(p:Principal,id:string,batchId:string,input:unknown){
    const startedAt=Date.now();
    this.financial(p);if(!hasStudentOperationsPermission(p.role,'payments.approve'))throw new ForbiddenException('Xero invoice approval is required.');
    if(process.env.XERO_INVOICE_CREATION_ENABLED!=='true')throw new ConflictException('Xero invoice creation is not enabled.');
    const parsed=exportRequest.safeParse(input),parsedBatch=z.uuid().safeParse(batchId);if(!parsed.success||!parsedBatch.success)throw new BadRequestException('Review confirmation and invoice selection are required.');
    batchId=parsedBatch.data;
    const selected=[...new Set(parsed.data.sequences)].sort((a,b)=>a-b),s=caseSchema();
    const claimInvoices=()=>this.database.tenantTransaction(p.tenantId,async db=>{
      const c=await this.cases.authorizedCase(db,p,id,true);
      const batch=(await db.query(`SELECT b.snapshot,b.offer_id,o.is_current FROM ${s}.student_case_invoice_draft_batches b
        JOIN ${s}.student_case_offers o ON o.customer_id=b.customer_id AND o.offer_id=b.offer_id
        WHERE b.customer_id=$1 AND b.case_id=$2 AND b.batch_id=$3 FOR UPDATE OF b`,[p.tenantId,id,batchId])).rows[0];
      if(!batch)throw new NotFoundException('Invoice proposal batch not found.');
      if(!batch.is_current)throw new ConflictException('The source offer was replaced. Create invoices only from the current offer.');
      const snapshot=invoiceSnapshot.parse(batch.snapshot),invoices=snapshot.invoices,targets=invoices.filter(invoice=>selected.includes(invoice.sequence));
      if(targets.length!==selected.length)throw new BadRequestException('One or more selected invoices do not exist.');
      const connectionId=snapshot.catalogueConnectionId;
      const connection=(await db.query(`SELECT 1 FROM ${s}.xero_connections x JOIN ${s}.student_operations_xero_sync_configurations cfg USING(customer_id,xero_connection_id)
        WHERE x.customer_id=$1 AND x.xero_connection_id=$2 AND x.status='active' AND cfg.organisation_role='trust'`,[p.tenantId,connectionId])).rows[0];
      if(!connection)throw new ConflictException('The reviewed TRUST Xero connection is no longer available.');
      const contact=(await db.query(`SELECT coalesce(primary_contact.xero_contact_id,latest.xero_contact_id) AS xero_contact_id FROM (SELECT 1) seed
        LEFT JOIN LATERAL (SELECT pc.xero_contact_id FROM ${s}.student_operations_primary_xero_contacts pc JOIN ${s}.student_operations_xero_contacts xc
          ON xc.customer_id=pc.customer_id AND xc.xero_connection_id=pc.xero_connection_id AND xc.xero_contact_id=pc.xero_contact_id AND xc.contact_status='ACTIVE'
          WHERE pc.customer_id=$1 AND pc.student_id=$2 AND pc.xero_connection_id=$3) primary_contact ON true
        LEFT JOIN LATERAL (SELECT i.xero_contact_id FROM ${s}.student_operations_xero_invoices i JOIN ${s}.student_operations_xero_contacts xc
          ON xc.customer_id=i.customer_id AND xc.xero_connection_id=i.xero_connection_id AND xc.xero_contact_id=i.xero_contact_id AND xc.contact_status='ACTIVE'
          WHERE i.customer_id=$1 AND i.student_id=$4 AND i.xero_connection_id=$3
          AND i.invoice_status NOT IN ('DELETED','VOIDED') ORDER BY i.invoice_date DESC NULLS LAST,i.xero_invoice_id DESC LIMIT 1) latest ON true`,
        [p.tenantId,c.student_id,connectionId,c.student_reference])).rows[0]?.xero_contact_id;
      if(!contact){
        // Repair pre-fix bindings by reading the exact provider ID, never by
        // name/email and never by creating another Contact. No claim exists yet.
        const missing=(await db.query(`SELECT pc.xero_contact_id FROM ${s}.student_operations_primary_xero_contacts pc
          WHERE pc.customer_id=$1 AND pc.student_id=$2 AND pc.xero_connection_id=$3 AND pc.xero_contact_id IS NOT NULL
          AND NOT EXISTS(SELECT 1 FROM ${s}.student_operations_xero_contacts xc WHERE xc.customer_id=pc.customer_id
            AND xc.xero_connection_id=pc.xero_connection_id AND xc.xero_contact_id=pc.xero_contact_id)`,[p.tenantId,c.student_id,connectionId])).rows[0];
        if(missing)throw new MissingContactProjection(connectionId,missing.xero_contact_id);
        throw new ConflictException({errorCode:'student_invoice_contact_unavailable',message:'Link this student to an active Xero Contact before creating invoices.'});
      }
      const rows=[] as Array<{invoice:InvoiceSnapshot['invoices'][number];status:string;provider_key:string;owned:boolean}>;
      for(const invoice of targets){
        const providerKey=createHash('sha256').update(`student-invoice:${p.tenantId}:${batchId}:${invoice.sequence}`).digest('hex');
        const inserted=await db.query(`INSERT INTO ${s}.student_case_xero_invoice_exports(customer_id,case_id,batch_id,sequence,xero_connection_id,xero_contact_id,provider_key,status,requested_by_identity_user_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,'creating',$8) ON CONFLICT(customer_id,batch_id,sequence) DO NOTHING RETURNING 1`,[p.tenantId,id,batchId,invoice.sequence,connectionId,contact,providerKey,p.identityUserId]);
        let receipt=(await db.query(`SELECT status,provider_key FROM ${s}.student_case_xero_invoice_exports WHERE customer_id=$1 AND batch_id=$2 AND sequence=$3`,[p.tenantId,batchId,invoice.sequence])).rows[0];
        let owned=inserted.rowCount===1;
        if(!owned&&receipt.status==='not_attempted'){
          const retry=await db.query(`UPDATE ${s}.student_case_xero_invoice_exports SET status='creating',requested_by_identity_user_id=$4,requested_at=now(),provider_key=$5
            WHERE customer_id=$1 AND batch_id=$2 AND sequence=$3 AND status='not_attempted' RETURNING status,provider_key`,[p.tenantId,batchId,invoice.sequence,p.identityUserId,randomBytes(32).toString('hex')]);
          if(retry.rowCount){receipt=retry.rows[0];owned=true;}
        }
        rows.push({invoice,status:receipt.status,provider_key:receipt.provider_key,owned});
      }
      return {snapshot,connectionId,contact,rows};
    });
    const claim=await claimInvoices().catch(async error=>{
      if(!(error instanceof MissingContactProjection))throw error;
      // Provider I/O is outside the transaction/locks and remains quota governed.
      const contact=await this.xero.contactById(p.tenantId,error.connectionId,error.contactId);
      if(contact.contactId!==error.contactId||contact.status!=='ACTIVE')
        throw new ConflictException({errorCode:'student_invoice_contact_unavailable',message:'The linked Xero Contact is not active. Ask an administrator to review the student contact.'});
      await this.database.tenantTransaction(p.tenantId,async db=>{
        const c=await this.cases.authorizedCase(db,p,id,true);
        const binding=await db.query(`SELECT 1 FROM ${s}.student_operations_primary_xero_contacts
          WHERE customer_id=$1 AND student_id=$2 AND xero_connection_id=$3 AND xero_contact_id=$4`,[p.tenantId,c.student_id,error.connectionId,error.contactId]);
        if(!binding.rowCount)throw new ConflictException('The student contact changed. Reload the invoice drafts.');
        await publishXeroContact(db,p.tenantId,error.connectionId,contact);
      });
      // Reauthorize, revalidate the current offer/connection and ACTIVE cache
      // after publication, including a concurrent sync/archive. Retry only once.
      return claimInvoices();
    });
    const claimMs=Date.now()-startedAt;
    type Result={sequence:number;status:string;invoiceId?:string;invoiceNumber?:string|null;errorCode?:string;message?:string};
    let session:ReturnType<XeroConnectorService['invoiceCreationSession']>|undefined;
    const execute=async(item:typeof claim.rows[number]):Promise<Result>=>{
      if(!item.owned)return {sequence:item.invoice.sequence,status:item.status==='created'?'already_created':item.status};
      const value=this.xeroValue(claim.snapshot,item.invoice,claim.contact);
      let providerReturned=false;
      try{
        const connection=await (session??=this.xero.invoiceCreationSession(p.tenantId,claim.connectionId));
        const receipt=await connection.createInvoice(value,item.provider_key);
        providerReturned=true;
        let verified=receipt.invoice&&matchesXeroInvoice(receipt.invoice,value,item.invoice.totalMinor)?receipt.invoice:undefined;
        if(!verified)try{const candidate=await connection.invoiceById(receipt.invoiceId);if(candidate.invoiceId===receipt.invoiceId&&matchesXeroInvoice(candidate,value,item.invoice.totalMinor))verified=candidate;}catch{}
        const projectionPending=await this.confirmCreated(p,id,batchId,claim.connectionId,claim.contact,claim.snapshot,item.invoice,receipt,verified);
        return {sequence:item.invoice.sequence,status:'created',invoiceId:receipt.invoiceId,invoiceNumber:receipt.invoiceNumber,...(projectionPending?{message:'Created in Xero. A register refresh was queued to complete local indexing.'}:{})};
      }catch(error){
        const status=!providerReturned&&(error instanceof ConflictException||error instanceof BadRequestException)?'not_attempted':'review_required';
        await this.database.tenantTransaction(p.tenantId,db=>db.query(`UPDATE ${s}.student_case_xero_invoice_exports SET status=$4,completed_at=NULL WHERE customer_id=$1 AND batch_id=$2 AND sequence=$3 AND status='creating'`,[p.tenantId,batchId,item.invoice.sequence,status]));
        const detail=xeroPreflightFailure(error);
        return {sequence:item.invoice.sequence,status,...detail};
      }
    };
    // Three workers leave provider capacity for other operations. Each invoice
    // retains its own durable claim and provider idempotency key. Results stay
    // in proposal order, regardless of provider completion order.
    const results:Result[]=new Array(claim.rows.length);let next=0,stopped=false;
    const workers=await Promise.allSettled(Array.from({length:Math.min(3,claim.rows.length)},async()=>{
      while(!stopped){
        const index=next++;if(index>=claim.rows.length)return;
        try{results[index]=await execute(claim.rows[index]);}
        catch(error){stopped=true;throw error;}
      }
    }));
    // Drain in-flight work before returning a fatal storage failure. The
    // persisted claims still prevent duplicate sends after a lost response.
    const failed=workers.find(worker=>worker.status==='rejected');if(failed?.status==='rejected')throw failed.reason;
    await this.refreshWorkflow(p,id);
    this.logger.log({event:'xero_invoice_batch_completed',durationMs:Date.now()-startedAt,claimMs,selected:results.length,created:results.filter(r=>r.status==='created').length});
    return {created:results.filter(r=>r.status==='created').length,skipped:results.filter(r=>r.status!=='created').length,results};
  }

  async reconcileXero(p:Principal,id:string,batchId:string,input:unknown){
    this.financial(p);if(!hasStudentOperationsPermission(p.role,'payments.approve'))throw new ForbiddenException('Xero invoice approval is required.');
    const parsed=reconcileRequest.safeParse(input),parsedBatch=z.uuid().safeParse(batchId);if(!parsed.success||!parsedBatch.success)throw new BadRequestException('Select one invoice that needs Xero review.');
    batchId=parsedBatch.data;const s=caseSchema();
    const claim=await this.database.tenantReadTransaction(p.tenantId,async db=>{
      await this.cases.authorizedCase(db,p,id);
      const row=(await db.query(`SELECT b.snapshot,e.status,e.xero_connection_id AS "connectionId",e.xero_contact_id AS "contactId"
        FROM ${s}.student_case_invoice_draft_batches b JOIN ${s}.student_case_xero_invoice_exports e ON e.customer_id=b.customer_id AND e.batch_id=b.batch_id
        WHERE b.customer_id=$1 AND b.case_id=$2 AND b.batch_id=$3 AND e.sequence=$4`,[p.tenantId,id,batchId,parsed.data.sequence])).rows[0];
      if(!row)throw new NotFoundException('Invoice review receipt not found.');
      if(row.status==='created')return {...row,alreadyCreated:true,snapshot:invoiceSnapshot.parse(row.snapshot)};
      if(row.status!=='review_required'&&row.status!=='creating')throw new ConflictException('This invoice does not require Xero reconciliation.');
      return {...row,alreadyCreated:false,snapshot:invoiceSnapshot.parse(row.snapshot)};
    });
    const invoice=claim.snapshot.invoices.find((item:InvoiceSnapshot['invoices'][number])=>item.sequence===parsed.data.sequence);if(!invoice)throw new NotFoundException('Invoice draft not found.');
    if(claim.alreadyCreated)return {created:1,skipped:0,results:[{sequence:invoice.sequence,status:'already_created'}]};
    const value=this.xeroValue(claim.snapshot,invoice,claim.contactId);
    try{
      const candidates=await this.xero.invoiceCandidates(p.tenantId,claim.connectionId,claim.contactId,invoice.issueDate);
      const matches=await exactXeroInvoiceMatches(candidates,value,invoice.totalMinor,invoiceId=>this.xero.invoiceById(p.tenantId,claim.connectionId,invoiceId));
      if(matches.length!==1)return {created:0,skipped:1,results:[{sequence:invoice.sequence,status:'review_required',message:matches.length
        ?'More than one exact Xero invoice matches this draft. An administrator must resolve the duplicate records in Xero.'
        :candidates.length?'Xero invoices were found for this contact and date, but none exactly match the reviewed invoice. Review the Xero invoice details; do not resend it.':'No matching Xero invoice is visible yet. Wait briefly, then check Xero again; do not resend this invoice.'}]};
      const candidate=matches[0],projectionPending=await this.confirmCreated(p,id,batchId,claim.connectionId,claim.contactId,claim.snapshot,invoice,
        {invoiceId:candidate.invoiceId,invoiceNumber:candidate.invoiceNumber,status:candidate.status,total:candidate.total},candidate);
      await this.refreshWorkflow(p,id);
      return {created:1,skipped:0,results:[{sequence:invoice.sequence,status:'created',invoiceId:candidate.invoiceId,invoiceNumber:candidate.invoiceNumber,
        message:(projectionPending?'Confirmed in Xero. A register refresh was queued to complete local indexing.':'Confirmed against the invoice in Xero.')+
          (candidate.lineItems.some(line=>!line.tracking.some(item=>item.name.trim().toLowerCase()==='payment track'))?' Payment Track is unassigned in Xero; the local payment status remains PENDING.':'')}]};
    }catch(error){
      const detail=xeroPreflightFailure(error);
      return {created:0,skipped:1,results:[{sequence:invoice.sequence,status:'review_required',...detail,message:detail.message??'The Xero verification could not be completed. Try Check Xero status again.'}]};
    }
  }
}

const invoiceSnapshot=z.object({studentName:text,advisorLabel:text,currency:z.string().regex(/^[A-Z]{3}$/),collegeName:z.string().nullable(),catalogueConnectionId:z.uuid(),
  invoices:z.array(z.object({sequence:z.number().int().positive(),issueDate:date,dueDate:date,conditionalFeeMinor:money,totalMinor:money,invoiceNumber:text,
    lines:z.array(z.object({description:z.string().min(1).max(4000),quantity:z.string(),unitPrice:z.string().optional(),unitAmountMinor:money,itemCode:text,accountCode:text,taxType:text}).passthrough())}).passthrough())}).passthrough();
export type InvoiceSnapshot=z.infer<typeof invoiceSnapshot>;
