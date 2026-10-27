import { BadRequestException,ConflictException,ForbiddenException,Inject,Injectable,NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
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
import { XeroConnectorService } from '../../connectors/xero/xero-connector.service.js';
import type { XeroInvoiceCreate } from '../../connectors/xero/xero.client.js';

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

/** Integer minor units and four-decimal quantities; round only once per line. */
export function lineTotal(quantity:string,unitAmountMinor:number){
  const [whole,fraction='']=quantity.split('.'),q=BigInt(whole)*10000n+BigInt(fraction.padEnd(4,'0'));
  return Number((q*BigInt(unitAmountMinor)+5000n)/10000n);
}
export function validateDraftSchedule(source:z.infer<typeof offerExtraction>,value:InvoiceDraftRequest,taxForLine:(line:InvoiceDraftRequest['invoices'][number]['lines'][number])=>number=()=>0,systemDefaultDate?:string){
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
    // The invoice editor deliberately starts both dates at the organisation's
    // current date. That generated default is not an operator change to the
    // offer schedule and therefore must not require a review explanation.
    const usesSystemDefaultDates=systemDefaultDate!==undefined&&invoice.issueDate===systemDefaultDate&&invoice.dueDate===systemDefaultDate;
    const changesSourceDueDate=Boolean(original.dueOn&&original.dueOn!==invoice.dueDate&&!usesSystemDefaultDates);
    if((difference!==0||changesSourceDueDate)&&!value.reviewNote)throw new BadRequestException('Explain changes from the offer amounts or dates in the review note.');
    return {...invoice,lines,subtotalMinor:base,taxMinor:tax,invoiceNumber:`INV-${invoice.sequence}`,status:'DRAFT' as const,paymentTrack:'PENDING' as const,
      sourceTotalMinor:original.totalMinor,sourceDueDate:original.dueOn,sourceDueTerm:original.dueTerm,
      sourceIncludedConditionalFeeMinor:original.includedConditionalFeeMinor,expectedTotalMinor:expected,differenceMinor:difference,totalMinor:total};
  }).sort((a,b)=>a.sequence-b.sequence);
}

@Injectable()
export class StudentCaseInvoiceDraftsService {
  constructor(@Inject(DatabaseService) private readonly database:DatabaseService,private readonly cases:StudentOperationsCasesService,private readonly xero:XeroConnectorService){}
  async onModuleInit(){
    if(!documentWorkflowEnabled())return;
    const missing=['STUDENT_DOCUMENT_CHECKLIST_ENABLED','STUDENT_DOCUMENT_ANALYSIS_ENABLED','STUDENT_OFFER_ANALYSIS_ENABLED'].filter(k=>process.env[k]!=='true');
    if(missing.length)throw new Error(`Document workflow requires exactly true: ${missing.join(', ')}.`);
    const ready=await this.database.query<{ready:boolean}>(`SELECT to_regclass($1) IS NOT NULL AND to_regclass($2) IS NOT NULL AND to_regclass($3) IS NOT NULL
      AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=$4 AND table_name='student_case_invoice_draft_batches' AND column_name='updated_at') AS ready`,
      [`${caseSchema()}.student_case_invoice_draft_batches`,`${caseSchema()}.student_xero_sales_catalogues`,`${caseSchema()}.student_case_xero_invoice_exports`,caseSchema()]);
    if(!ready.rows[0]?.ready)throw new Error('Document workflow requires Runtime migrations 098 through 101.');
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
      const hasEditableInvoice=!savedBatch||savedBatch.snapshot.invoices.some((invoice:{sequence:number})=>{
        const receipt=savedBatch.exports[String(invoice.sequence)];return !receipt||receipt.status==='not_attempted';
      });
      if(!hasEditableInvoice)return {batches,preparation:null,canCreateXero:this.canCreate(p)};
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
      const invoices=validateDraftSchedule(offer.source,value,l=>lineTaxMinor(l.amountMinor,catalogue.taxRates.find(t=>t.taxType===l.taxType)!.rate!),analysisToday()),advisorLabel=`${advisor.code} ${advisor.name}`;
      const student=(await db.query(`SELECT legal_name FROM ${s}.student_operations_students WHERE customer_id=$1 AND student_id=$2`,[p.tenantId,c.student_id])).rows[0];
      const snapshot={studentName:student.legal_name,advisorLabel,category:null,location:null,billingUnit:null,currency:offer.source.currency,
        catalogueConnectionId:value.catalogueConnectionId??null,catalogueRevision:value.catalogueRevision??null,
        collegeName:offer.source.collegeName,reviewNote:value.reviewNote,invoices};
      if(existing){
        const previous=invoiceSnapshot.parse(existing.snapshot);
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
        await this.cases.activity(db,p,id,'case.invoice_drafts_prepared',`${invoices.length} Sophia invoice drafts updated — Payment Track PENDING`);
        return {batchId:existing.batch_id,count:invoices.length,updated:true,revision:updated.revision,updatedAt:updated.updatedAt};
      }
      const batch=(await db.query(`INSERT INTO ${s}.student_case_invoice_draft_batches(customer_id,case_id,offer_id,advisor_id,advisor_label,snapshot,actor_identity_user_id)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING batch_id,revision,updated_at AS "updatedAt"`,[p.tenantId,id,value.offerId,value.advisorId,advisorLabel,JSON.stringify(snapshot),p.identityUserId])).rows[0];
      await this.cases.activity(db,p,id,'case.invoice_drafts_prepared',`${invoices.length} Sophia invoice drafts prepared — Payment Track PENDING`);
      return {batchId:batch.batch_id,count:invoices.length,updated:false,revision:batch.revision,updatedAt:batch.updatedAt};
    });
  }

  async createXero(p:Principal,id:string,batchId:string,input:unknown){
    this.financial(p);if(!hasStudentOperationsPermission(p.role,'payments.approve'))throw new ForbiddenException('Xero invoice approval is required.');
    if(process.env.XERO_INVOICE_CREATION_ENABLED!=='true')throw new ConflictException('Xero invoice creation is not enabled.');
    const parsed=exportRequest.safeParse(input),parsedBatch=z.uuid().safeParse(batchId);if(!parsed.success||!parsedBatch.success)throw new BadRequestException('Review confirmation and invoice selection are required.');
    batchId=parsedBatch.data;
    const selected=[...new Set(parsed.data.sequences)].sort((a,b)=>a-b),s=caseSchema();
    const claim=await this.database.tenantTransaction(p.tenantId,async db=>{
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
      if(!contact)throw new ConflictException('Link this student to an active Xero Contact before creating invoices.');
      const rows=[] as Array<{invoice:InvoiceSnapshot['invoices'][number];status:string;provider_key:string;owned:boolean}>;
      for(const invoice of targets){
        const providerKey=createHash('sha256').update(`student-invoice:${p.tenantId}:${batchId}:${invoice.sequence}`).digest('hex');
        const inserted=await db.query(`INSERT INTO ${s}.student_case_xero_invoice_exports(customer_id,case_id,batch_id,sequence,xero_connection_id,xero_contact_id,provider_key,status,requested_by_identity_user_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,'creating',$8) ON CONFLICT(customer_id,batch_id,sequence) DO NOTHING RETURNING 1`,[p.tenantId,id,batchId,invoice.sequence,connectionId,contact,providerKey,p.identityUserId]);
        let receipt=(await db.query(`SELECT status,provider_key FROM ${s}.student_case_xero_invoice_exports WHERE customer_id=$1 AND batch_id=$2 AND sequence=$3`,[p.tenantId,batchId,invoice.sequence])).rows[0];
        let owned=inserted.rowCount===1;
        if(!owned&&receipt.status==='not_attempted'){
          const retry=await db.query(`UPDATE ${s}.student_case_xero_invoice_exports SET status='creating',requested_by_identity_user_id=$4,requested_at=now()
            WHERE customer_id=$1 AND batch_id=$2 AND sequence=$3 AND status='not_attempted' RETURNING status,provider_key`,[p.tenantId,batchId,invoice.sequence,p.identityUserId]);
          if(retry.rowCount){receipt=retry.rows[0];owned=true;}
        }
        rows.push({invoice,status:receipt.status,provider_key:receipt.provider_key,owned});
      }
      return {snapshot,connectionId,contact,rows};
    });
    const results=[] as Array<{sequence:number;status:string;invoiceId?:string;invoiceNumber?:string|null}>;
    for(const item of claim.rows){
      if(!item.owned){results.push({sequence:item.invoice.sequence,status:item.status==='created'?'already_created':item.status});continue;}
      const tracking=[{name:'Payment Track',option:'PENDING'},{name:'Sales Representative',option:claim.snapshot.advisorLabel}];
      const first=item.invoice.lines[0];
      const lines:XeroInvoiceCreate['lines']=item.invoice.lines.map(line=>({description:line.description,quantity:line.quantity,unitAmount:line.unitPrice??(line.unitAmountMinor/100).toFixed(2),itemCode:line.itemCode,
        accountCode:line.accountCode,taxType:line.taxType,tracking}));
      if(item.invoice.conditionalFeeMinor>0)lines.push({description:'Conditional transfer fee',quantity:'1',unitAmount:(item.invoice.conditionalFeeMinor/100).toFixed(2),
        accountCode:first.accountCode,taxType:'BASEXCLUDED',tracking});
      let providerReturned=false;
      try{
        const receipt=await this.xero.createInvoice(p.tenantId,claim.connectionId,{contactId:claim.contact,date:item.invoice.issueDate,dueDate:item.invoice.dueDate,
          reference:claim.snapshot.collegeName||null,currencyCode:claim.snapshot.currency,lines},item.provider_key);
        providerReturned=true;
        await this.database.tenantTransaction(p.tenantId,async db=>{
          const updated=await db.query(`UPDATE ${s}.student_case_xero_invoice_exports SET status='created',xero_invoice_id=$4,xero_invoice_number=$5,provider_status=$6,completed_at=now()
            WHERE customer_id=$1 AND batch_id=$2 AND sequence=$3 AND status='creating' RETURNING 1`,[p.tenantId,batchId,item.invoice.sequence,receipt.invoiceId,receipt.invoiceNumber,receipt.status]);
          if(!updated.rowCount)throw new ConflictException('Invoice creation receipt requires review.');
          await db.query(`INSERT INTO ${s}.student_operations_xero_invoices(customer_id,xero_connection_id,xero_invoice_id,xero_contact_id,student_id,invoice_number,invoice_type,invoice_status,invoice_date,due_date,advisor_name,invoice_reference,college_name,payment_track,total,amount_paid,amount_due,currency_code)
            VALUES($1,$2,$3,$4,$5,$6,'ACCREC',$7,$8,$9,$10,$11,$11,'PENDING',$12,0,$12,$13) ON CONFLICT(customer_id,xero_connection_id,xero_invoice_id) DO NOTHING`,
            [p.tenantId,claim.connectionId,receipt.invoiceId,claim.contact,(await this.cases.authorizedCase(db,p,id)).student_reference,receipt.invoiceNumber,receipt.status,item.invoice.issueDate,item.invoice.dueDate,claim.snapshot.advisorLabel,claim.snapshot.collegeName,receipt.total,claim.snapshot.currency]);
          await db.query(`INSERT INTO ${s}.student_operations_case_invoice_links(customer_id,case_id,student_id,student_reference,xero_connection_id,xero_invoice_id,linked_by_identity)
            SELECT $1,$2,c.student_id,c.student_reference,$3,$4,$5 FROM ${s}.student_operations_cases c WHERE c.customer_id=$1 AND c.case_id=$2 ON CONFLICT DO NOTHING`,
            [p.tenantId,id,claim.connectionId,receipt.invoiceId,p.identityUserId]);
          await this.cases.activity(db,p,id,'case.xero_invoice_created',`${item.invoice.invoiceNumber} created as a Xero draft`);
        });
        results.push({sequence:item.invoice.sequence,status:'created',invoiceId:receipt.invoiceId,invoiceNumber:receipt.invoiceNumber});
      }catch(error){
        const status=!providerReturned&&error instanceof ConflictException?'not_attempted':'review_required';
        await this.database.tenantTransaction(p.tenantId,db=>db.query(`UPDATE ${s}.student_case_xero_invoice_exports SET status=$4,completed_at=NULL WHERE customer_id=$1 AND batch_id=$2 AND sequence=$3 AND status='creating'`,[p.tenantId,batchId,item.invoice.sequence,status]));
        results.push({sequence:item.invoice.sequence,status});
      }
    }
    return {created:results.filter(r=>r.status==='created').length,skipped:results.filter(r=>r.status!=='created').length,results};
  }
}

const invoiceSnapshot=z.object({studentName:text,advisorLabel:text,currency:z.string().regex(/^[A-Z]{3}$/),collegeName:z.string().nullable(),catalogueConnectionId:z.uuid(),
  invoices:z.array(z.object({sequence:z.number().int().positive(),issueDate:date,dueDate:date,conditionalFeeMinor:money,invoiceNumber:text,
    lines:z.array(z.object({description:z.string().min(1).max(4000),quantity:z.string(),unitPrice:z.string().optional(),unitAmountMinor:money,itemCode:text,accountCode:text,taxType:text}).passthrough())}).passthrough())}).passthrough();
type InvoiceSnapshot=z.infer<typeof invoiceSnapshot>;
