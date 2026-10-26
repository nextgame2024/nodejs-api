import { BadRequestException,ConflictException,ForbiddenException,Inject,Injectable } from '@nestjs/common';
import { z } from 'zod';
import { DatabaseService } from '../../database/database.service.js';
import { StudentOperationsCasesService,caseSchema } from './student-operations-cases.service.js';
import type { StudentOperationsWorkspacePrincipal as Principal } from './student-operations-workspace.service.js';
import { hasStudentOperationsPermission } from './student-operations-policy.js';
import { documentChecklistEvidence } from './student-document-checklist.js';
import { analysisToday,documentWorkflowEnabled } from './student-document-analysis-state.js';
import type { PoolClient } from 'pg';
import { offerExtraction,paymentWithConditionalFee } from './student-document-analysis.contracts.js';
import { readSalesCatalogue } from './student-xero-sales-catalogue.js';
import { decimal4,pricedLineMinor,lineTaxMinor } from '../../connectors/xero/xero-sales-catalogue.js';

const text=z.string().trim().min(1).max(500),money=z.number().int().min(0).max(1_000_000_000);
const date=z.iso.date();
const line=z.object({kind:z.enum(['tuition','enrolment','materials','visa','oshc','other']),description:text,itemId:z.uuid(),
  itemCode:text,quantity:z.string().regex(/^\d{1,6}(\.\d{1,4})?$/),unitAmountMinor:money.optional(),unitPrice:decimal4.optional(),amountMinor:money,
  accountCode:text,taxType:text}).strict().refine(l=>l.unitPrice!==undefined||l.unitAmountMinor!==undefined);
export const invoiceDraftRequest=z.object({offerId:z.uuid(),offerVersion:z.number().int().positive(),caseVersion:z.number().int().positive(),advisorId:z.uuid(),
  catalogueConnectionId:z.uuid(),catalogueRevision:z.number().int().positive(),
  reviewNote:z.string().trim().max(500),
  invoices:z.array(z.object({sequence:z.number().int().positive(),issueDate:date,dueDate:date,
    conditionalFeeApplies:z.boolean(),conditionalFeeMinor:money,lines:z.array(line).min(1).max(30)}).strict()).min(1).max(200),
}).strict();
export type InvoiceDraftRequest=z.infer<typeof invoiceDraftRequest>;

/** Integer minor units and four-decimal quantities; round only once per line. */
export function lineTotal(quantity:string,unitAmountMinor:number){
  const [whole,fraction='']=quantity.split('.'),q=BigInt(whole)*10000n+BigInt(fraction.padEnd(4,'0'));
  return Number((q*BigInt(unitAmountMinor)+5000n)/10000n);
}
export function validateDraftSchedule(source:z.infer<typeof offerExtraction>,value:InvoiceDraftRequest,taxForLine:(line:InvoiceDraftRequest['invoices'][number]['lines'][number])=>number=()=>0){
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
    if((difference!==0||(original.dueOn&&original.dueOn!==invoice.dueDate))&&!value.reviewNote)throw new BadRequestException('Explain changes from the offer amounts or dates in the review note.');
    return {...invoice,lines,subtotalMinor:base,taxMinor:tax,invoiceNumber:`INV-${invoice.sequence}`,status:'DRAFT' as const,paymentTrack:'PENDING' as const,
      sourceTotalMinor:original.totalMinor,sourceDueDate:original.dueOn,sourceDueTerm:original.dueTerm,
      sourceIncludedConditionalFeeMinor:original.includedConditionalFeeMinor,expectedTotalMinor:expected,differenceMinor:difference,totalMinor:total};
  }).sort((a,b)=>a.sequence-b.sequence);
}

@Injectable()
export class StudentCaseInvoiceDraftsService {
  constructor(@Inject(DatabaseService) private readonly database:DatabaseService,private readonly cases:StudentOperationsCasesService){}
  async onModuleInit(){
    if(!documentWorkflowEnabled())return;
    const missing=['STUDENT_DOCUMENT_CHECKLIST_ENABLED','STUDENT_DOCUMENT_ANALYSIS_ENABLED','STUDENT_OFFER_ANALYSIS_ENABLED'].filter(k=>process.env[k]!=='true');
    if(missing.length)throw new Error(`Document workflow requires exactly true: ${missing.join(', ')}.`);
    const ready=await this.database.query<{ready:boolean}>('SELECT to_regclass($1) IS NOT NULL AND to_regclass($2) IS NOT NULL AS ready',[`${caseSchema()}.student_case_invoice_draft_batches`,`${caseSchema()}.student_xero_sales_catalogues`]);
    if(!ready.rows[0]?.ready)throw new Error('Document workflow requires Runtime migrations 098 and 099.');
  }
  private financial(p:Principal){if(!hasStudentOperationsPermission(p.role,'payments.read_all'))throw new ForbiddenException('Invoice financial access required.');}
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
      const batches=(await db.query(`SELECT b.batch_id AS "batchId",b.offer_id AS "offerId",b.snapshot,b.created_at AS "createdAt",o.is_current AS "currentOffer"
        FROM ${s}.student_case_invoice_draft_batches b JOIN ${s}.student_case_offers o ON o.customer_id=b.customer_id AND o.offer_id=b.offer_id
        WHERE b.customer_id=$1 AND b.case_id=$2 ORDER BY b.created_at DESC,b.batch_id LIMIT 20`,[p.tenantId,id])).rows;
      const eligible=documentWorkflowEnabled()&&hasStudentOperationsPermission(p.role,'payments.prepare')&&c.lifecycle_status==='pre_sale'&&c.current_stage==='checklist_complete';
      if(!eligible)return {batches,preparation:null};
      const evidence=await documentChecklistEvidence(db,p.tenantId,id),offer=await this.offer(db,p,id);
      if(!offer||!evidence.completed.signed_engagement_letter||!evidence.completed.document_completeness||batches.some(b=>b.offerId===offer.row.offer_id))return {batches,preparation:null};
      const advisors=(await db.query(`SELECT advisor_id AS "advisorId",code,name FROM ${s}.student_operations_advisor_directory WHERE customer_id=$1 AND status='active' ORDER BY lower(name),advisor_id`,[p.tenantId])).rows;
      const student=(await db.query(`SELECT legal_name AS name,advisor_id AS "advisorId" FROM ${s}.student_operations_students WHERE customer_id=$1 AND student_id=$2`,[p.tenantId,c.student_id])).rows[0];
      const catalogue=await readSalesCatalogue(db,p.tenantId);
      return {batches,preparation:{offerId:offer.row.offer_id,offerVersion:offer.row.record_version,caseVersion:c.record_version,source:offer.source,advisors,student,today:analysisToday(),catalogue}};
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
      const existing=(await db.query(`SELECT batch_id FROM ${s}.student_case_invoice_draft_batches WHERE customer_id=$1 AND case_id=$2 AND offer_id=$3`,[p.tenantId,id,value.offerId])).rows[0];
      if(existing)throw new ConflictException('Drafts already exist for this approved offer.');
      const advisor=(await db.query(`SELECT code,name FROM ${s}.student_operations_advisor_directory WHERE customer_id=$1 AND advisor_id=$2 AND status='active'`,[p.tenantId,value.advisorId])).rows[0];
      if(!advisor)throw new BadRequestException('Select an active advisor in this organisation.');
      const catalogue=await readSalesCatalogue(db,p.tenantId,true);
      if(!catalogue||catalogue.connectionId!==value.catalogueConnectionId||catalogue.revision!==value.catalogueRevision)throw new ConflictException('The Xero item catalogue changed. Reload the preview.');
      for(const invoice of value.invoices)for(const line of invoice.lines){
        const item=catalogue.items.find(i=>i.itemId===line.itemId),account=catalogue.accounts.find(a=>a.code===item?.accountCode),tax=catalogue.taxRates.find(t=>t.taxType===item?.taxType);
        if(!item||item.code!==line.itemCode||!account||account.code!==line.accountCode||!tax||tax.taxType!==line.taxType||tax.rate===null)throw new BadRequestException('Select an available Xero item with valid sales account and tax defaults.');
      }
      const invoices=validateDraftSchedule(offer.source,value,l=>lineTaxMinor(l.amountMinor,catalogue.taxRates.find(t=>t.taxType===l.taxType)!.rate!)),advisorLabel=`${advisor.code} ${advisor.name}`;
      const student=(await db.query(`SELECT legal_name FROM ${s}.student_operations_students WHERE customer_id=$1 AND student_id=$2`,[p.tenantId,c.student_id])).rows[0];
      const snapshot={studentName:student.legal_name,advisorLabel,category:null,location:null,billingUnit:null,currency:offer.source.currency,
        catalogueConnectionId:value.catalogueConnectionId??null,catalogueRevision:value.catalogueRevision??null,
        collegeName:offer.source.collegeName,reviewNote:value.reviewNote,invoices};
      const batch=(await db.query(`INSERT INTO ${s}.student_case_invoice_draft_batches(customer_id,case_id,offer_id,advisor_id,advisor_label,snapshot,actor_identity_user_id)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING batch_id`,[p.tenantId,id,value.offerId,value.advisorId,advisorLabel,JSON.stringify(snapshot),p.identityUserId])).rows[0];
      await this.cases.activity(db,p,id,'case.invoice_drafts_prepared',`${invoices.length} Sophia invoice drafts prepared — Payment Track PENDING`);
      return {batchId:batch.batch_id,count:invoices.length};
    });
  }
}
