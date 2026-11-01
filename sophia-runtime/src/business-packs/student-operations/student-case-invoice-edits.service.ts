import {BadRequestException,ConflictException,ForbiddenException,Inject,Injectable,NotFoundException} from '@nestjs/common';
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {PoolClient} from 'pg';
import {DatabaseService} from '../../database/database.service.js';
import {XeroConnectorService} from '../../connectors/xero/xero-connector.service.js';
import type {XeroInvoiceRecord,XeroInvoiceUpdate} from '../../connectors/xero/xero.client.js';
import {StudentOperationsCasesService,caseId,caseSchema} from './student-operations-cases.service.js';
import {StudentCaseInvoiceDraftsService} from './student-case-invoice-drafts.js';
import type {StudentOperationsWorkspacePrincipal as Principal} from './student-operations-workspace.service.js';
import {hasStudentOperationsPermission} from './student-operations-policy.js';
import {invoiceCanEdit,invoiceEditFingerprint,matchesEditedInvoice} from './student-invoice-edit-policy.js';
import {readSalesCatalogue} from './student-xero-sales-catalogue.js';
import {decimal4,pricedLineMinor,lineTaxMinor} from '../../connectors/xero/xero-sales-catalogue.js';
import {projectCaseInvoice} from './student-invoice-projection.js';
import {reconcileDocumentChecklist} from './student-document-checklist.js';

const date=z.iso.date(),money=z.number().int().min(0).max(1_000_000_000);
const request=z.object({expectedFingerprint:z.string().regex(/^[a-f0-9]{64}$/),confirmed:z.literal(true),advisorId:z.uuid(),reference:z.string().trim().max(255),
  referenceMode:z.enum(['reference','college']),collegeId:z.uuid().optional(),brandingThemeId:z.uuid().optional(),currency:z.string().regex(/^[A-Z]{3}$/),reviewNote:z.string().max(500),
  issueDate:date,dueDate:date,conditionalFeeMinor:money,conditionalFeeLineId:z.uuid().optional(),
  lines:z.array(z.object({lineItemId:z.uuid().optional(),itemCode:z.string().max(50),description:z.string().trim().min(1).max(4000),
    quantity:z.string().regex(/^\d{1,6}(\.\d{1,4})?$/),unitPrice:decimal4,accountCode:z.string().min(1).max(50),taxType:z.string().min(1).max(100)}).strict()).min(1).max(30),
}).strict();
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const advisorCategory=(name:string)=>/^(sales representative|advisor|adviser|counsellor|consultant|agent)$/i.test(name.trim());

@Injectable()
export class StudentCaseInvoiceEditsService{
  constructor(@Inject(DatabaseService) private readonly database:DatabaseService,private readonly cases:StudentOperationsCasesService,
    private readonly drafts:StudentCaseInvoiceDraftsService,private readonly xero:XeroConnectorService){}
  private permit(p:Principal){
    if(!hasStudentOperationsPermission(p.role,'cases.manage')||!hasStudentOperationsPermission(p.role,'payments.prepare')||!hasStudentOperationsPermission(p.role,'payments.approve')||!hasStudentOperationsPermission(p.role,'payments.read_all'))throw new ForbiddenException();
  }
  private editable(invoice:XeroInvoiceRecord,lockDate:string|null){
    if(!invoiceCanEdit(invoice))throw new ConflictException('This invoice can no longer be edited in full. Refresh the invoice list.');
    if(lockDate&&(!invoice.invoiceDate||invoice.invoiceDate<=lockDate))throw new ConflictException('This invoice belongs to a locked accounting period.');
    if(invoice.lineAmountTypes&&invoice.lineAmountTypes!=='Exclusive'||invoice.lineItems.some(l=>Number(l.discountRate??0)!==0))throw new ConflictException('This invoice uses inclusive tax or discounts. Edit it in the accounting system to preserve those values.');
    if(!invoice.lineItems.length||invoice.lineItems.length>30||invoice.lineItems.some(l=>l.quantity==null||l.quantity<=0||!decimal4.safeParse(String(l.quantity)).success||l.unitAmount==null||!decimal4.safeParse(String(l.unitAmount)).success||l.lineAmount==null||Math.round(l.lineAmount*100)!==pricedLineMinor(String(l.quantity),String(l.unitAmount))))throw new ConflictException('This invoice has adjustments or incomplete line amounts that need a specialised editor.');
  }
  private async publish(db:PoolClient,p:Principal,id:string,connectionId:string,updated:XeroInvoiceRecord){
    const s=caseSchema(),invoiceId=updated.invoiceId;
    await projectCaseInvoice(db,p.tenantId,id,connectionId,updated,p.identityUserId);
    await db.query(`UPDATE ${s}.student_case_xero_invoice_exports SET provider_status=$4,verified_invoice=$5,projection_next_attempt_at=NULL WHERE customer_id=$1 AND xero_connection_id=$2 AND xero_invoice_id=$3`,[p.tenantId,connectionId,invoiceId,updated.status,JSON.stringify(updated)]);
    await db.query(`UPDATE ${s}.student_case_invoice_edits SET completed=true,lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE customer_id=$1 AND xero_connection_id=$2 AND xero_invoice_id=$3`,[p.tenantId,connectionId,invoiceId]);
    await this.cases.activity(db,p,id,'case.invoice_updated','Invoice updated');await reconcileDocumentChecklist(db,p.tenantId,id);
  }
  private async linked(p:Principal,id:string,connectionId:string,invoiceId:string){
    this.permit(p);[id,connectionId,invoiceId].forEach(caseId);
    return this.database.tenantReadTransaction(p.tenantId,async db=>{
      const c=await this.cases.authorizedCase(db,p,id),s=caseSchema();
      if(c.lifecycle_status==='closed')throw new ConflictException('Invoices cannot be edited for a closed case.');
      const row=(await db.query(`SELECT coalesce(i.xero_contact_id,e.xero_contact_id) AS contact_id FROM (
        SELECT xero_connection_id,xero_invoice_id FROM ${s}.student_operations_case_invoice_links WHERE customer_id=$1 AND case_id=$2
        UNION SELECT xero_connection_id,xero_invoice_id FROM ${s}.student_case_xero_invoice_exports WHERE customer_id=$1 AND case_id=$2 AND status='created') l
        LEFT JOIN ${s}.student_operations_xero_invoices i ON i.customer_id=$1 AND i.xero_connection_id=l.xero_connection_id AND i.xero_invoice_id=l.xero_invoice_id
        LEFT JOIN ${s}.student_case_xero_invoice_exports e ON e.customer_id=$1 AND e.case_id=$2 AND e.xero_connection_id=l.xero_connection_id AND e.xero_invoice_id=l.xero_invoice_id
        WHERE l.xero_connection_id=$3 AND l.xero_invoice_id=$4`,[p.tenantId,id,connectionId,invoiceId])).rows[0];
      if(!row?.contact_id)throw new NotFoundException('Linked invoice not found.');
      return String(row.contact_id);
    });
  }
  async options(p:Principal,id:string,connectionId:string,invoiceId:string){
    const contactId=await this.linked(p,id,connectionId,invoiceId);
    const session=await this.xero.invoiceRemovalSession(p.tenantId,connectionId);
    const [invoice,organisation,options]=await Promise.all([session.invoiceById(invoiceId),session.organisation(),this.drafts.manualOptions(p,id,true)]);
    if(invoice.invoiceId!==invoiceId||invoice.contactId!==contactId)throw new ConflictException('The invoice no longer matches this case.');
    // Read repair after a lost response never sends another provider mutation.
    const pending=await this.database.tenantTransaction(p.tenantId,async db=>{
      await this.cases.authorizedCase(db,p,id,true);
      const row=(await db.query(`SELECT *,lease_expires_at>now() AS leased FROM ${caseSchema()}.student_case_invoice_edits WHERE customer_id=$1 AND xero_connection_id=$2 AND xero_invoice_id=$3 AND NOT completed AND NOT failed FOR UPDATE`,[p.tenantId,connectionId,invoiceId])).rows[0];
      if(!row||row.leased)return null;
      if(matchesEditedInvoice(invoice,row.desired.value,row.desired.totalMinor)){
        await this.publish(db,{...p,identityUserId:row.actor_identity_user_id},id,connectionId,invoice);return null;
      }
      if(row.actor_identity_user_id===p.identityUserId&&row.desired.request)return {key:row.idempotency_key,input:row.desired.request as z.infer<typeof request>};
      throw new ConflictException('An earlier invoice save needs confirmation by its original reviewer.');
    });
    const lockDate=[organisation.periodLockDate,organisation.endOfYearLockDate].filter((v):v is string=>!!v).sort().at(-1)??null;
    this.editable(invoice,lockDate);
    if(options.catalogue?.connectionId!==connectionId)throw new ConflictException('The item catalogue for this invoice is not available.');
    return {...options,invoice,expectedFingerprint:invoiceEditFingerprint(invoice),pending};
  }
  async update(p:Principal,id:string,connectionId:string,invoiceId:string,input:unknown,key?:string){
    const contactId=await this.linked(p,id,connectionId,invoiceId),parsed=request.safeParse(input);
    if(!parsed.success||!key||!/^[A-Za-z0-9._:-]{8,160}$/.test(key))throw new BadRequestException('Review the invoice fields and confirm your changes.');
    const v=parsed.data;if(v.dueDate<v.issueDate)throw new BadRequestException('Due date must be on or after the issue date.');
    const s=caseSchema(),lease=randomUUID(),requestHash=hash(v);
    // The case lock serializes mutation claims, including invoice deletion.
    let observedRevision:string|null=null;
    const prior=await this.database.tenantTransaction(p.tenantId,async db=>{
      await this.cases.authorizedCase(db,p,id,true);
      const removing=await db.query(`SELECT 1 FROM ${s}.student_case_invoice_removals WHERE customer_id=$1 AND xero_connection_id=$2 AND xero_invoice_id=$3 AND (completed OR lease_expires_at>now())`,[p.tenantId,connectionId,invoiceId]);
      if(removing.rowCount)throw new ConflictException('This invoice is being removed. Refresh the list.');
      const row=(await db.query(`SELECT *,lease_expires_at>now() AS leased FROM ${s}.student_case_invoice_edits WHERE customer_id=$1 AND xero_connection_id=$2 AND xero_invoice_id=$3 FOR UPDATE`,[p.tenantId,connectionId,invoiceId])).rows[0];
      observedRevision=row?`${row.request_hash}:${new Date(row.updated_at).toISOString()}`:null;
      if(row?.leased)throw new ConflictException('An invoice update is processing. Retry the same changes shortly.');
      const same=row&&row.idempotency_key===key&&row.actor_identity_user_id===p.identityUserId;
      if(same&&row.request_hash!==requestHash)throw new ConflictException('The edit request changed. Reopen the invoice.');
      if(row&&!same&&!row.completed&&!row.failed)throw new ConflictException('A previous invoice update needs confirmation. Retry the original changes before editing again.');
      return same?row:null;
    });
    if(prior?.completed)return {invoiceId,status:'updated'};
    const session=await this.xero.invoiceRemovalSession(p.tenantId,connectionId);
    const [live,organisation]=await Promise.all([session.invoiceById(invoiceId),session.organisation()]);
    if(live.invoiceId!==invoiceId||live.contactId!==contactId)throw new ConflictException('The invoice no longer matches this case.');
    const lockDate=[organisation.periodLockDate,organisation.endOfYearLockDate].filter((v):v is string=>!!v).sort().at(-1)??null;
    let desired=prior?.desired as {value:XeroInvoiceUpdate;totalMinor:number}|undefined;
    const alreadyApplied=desired&&matchesEditedInvoice(live,desired.value,desired.totalMinor);
    if(!alreadyApplied){
      this.editable(live,lockDate);
      if(invoiceEditFingerprint(live)!==v.expectedFingerprint)throw new ConflictException('The invoice changed since you opened it. Close and reopen it before saving.');
    }
    if(!desired){
      desired=await this.database.tenantReadTransaction(p.tenantId,async db=>{
        const catalogue=await readSalesCatalogue(db,p.tenantId);
        if(!catalogue||catalogue.connectionId!==connectionId)throw new ConflictException('The invoice catalogue is not available.');
        const advisor=(await db.query(`SELECT code,name FROM ${s}.student_operations_advisor_directory WHERE customer_id=$1 AND advisor_id=$2 AND status='active'`,[p.tenantId,v.advisorId])).rows[0];
        if(!advisor)throw new BadRequestException('Select an active advisor.');
        let reference=v.reference;
        if(v.referenceMode==='college'){
          const college=(await db.query(`SELECT college_name FROM ${s}.student_operations_college_directory WHERE customer_id=$1 AND college_id=$2`,[p.tenantId,v.collegeId??null])).rows[0];
          if(!college)throw new BadRequestException('Select an available college.');reference=college.college_name;
        }
        // Currency is retained: changing currency on existing invoices has additional Xero constraints.
        if(v.currency!==live.currencyCode)throw new BadRequestException('The currency of an existing invoice cannot be changed here.');
        const ids=[...v.lines.map(l=>l.lineItemId),v.conditionalFeeLineId].filter(Boolean);
        if(new Set(ids).size!==ids.length||ids.some(id=>!live.lineItems.some(line=>line.lineItemId===id)))throw new BadRequestException('Invoice line identities changed. Reopen the invoice.');
        const tracking=(lineId?:string)=>{
          const original=live.lineItems.find(l=>l.lineItemId===lineId)?.tracking??live.lineItems[0]?.tracking??[];
          const result=original.map(t=>advisorCategory(t.name)?{...t,option:`${advisor.code} ${advisor.name}`}:{...t});
          if(!result.some(t=>advisorCategory(t.name)))result.push({name:'Sales Representative',option:`${advisor.code} ${advisor.name}`});
          if(result.length>2)throw new BadRequestException('This invoice already uses both tracking categories.');return result;
        };
        let totalMinor=0;
        const lines:XeroInvoiceUpdate['lines']=v.lines.map(line=>{
          if(Number(line.quantity)<=0)throw new BadRequestException('Enter a quantity greater than zero.');
          const account=catalogue.accounts.find(a=>a.code===line.accountCode),tax=catalogue.taxRates.find(t=>t.taxType===line.taxType);
          if(!account||!tax||tax.rate===null||line.itemCode&&!catalogue.items.some(i=>i.code===line.itemCode))throw new BadRequestException('Select valid items, accounts and tax rates.');
          const amount=pricedLineMinor(line.quantity,line.unitPrice);totalMinor+=amount+lineTaxMinor(amount,tax.rate);
          return {lineItemId:line.lineItemId,itemCode:line.itemCode,description:line.description,quantity:line.quantity,unitAmount:line.unitPrice,accountCode:line.accountCode,taxType:line.taxType,tracking:tracking(line.lineItemId)};
        });
        if(v.conditionalFeeMinor){
          if(!catalogue.taxRates.some(t=>t.taxType==='BASEXCLUDED'&&Number(t.rate)===0))throw new BadRequestException('The conditional fee tax rate is unavailable.');
          const accountCode=live.lineItems.find(l=>l.lineItemId===v.conditionalFeeLineId)?.accountCode??lines[0].accountCode;
          if(!catalogue.accounts.some(a=>a.code===accountCode))throw new BadRequestException('The conditional fee account is unavailable.');
          lines.push({lineItemId:v.conditionalFeeLineId,description:'Conditional transfer fee',quantity:'1',unitAmount:(v.conditionalFeeMinor/100).toFixed(2),accountCode,taxType:'BASEXCLUDED',tracking:tracking(v.conditionalFeeLineId)});totalMinor+=v.conditionalFeeMinor;
        }
        if(totalMinor<=0||totalMinor>1_000_000_000)throw new BadRequestException('Check the invoice total.');
        return {totalMinor,value:{contactId,status:live.status,date:v.issueDate,dueDate:v.dueDate,reference,currencyCode:v.currency,brandingThemeId:v.brandingThemeId??live.brandingThemeId??undefined,lines}};
      });
    }
    const planned={...desired,request:v};
    await this.database.tenantTransaction(p.tenantId,async db=>{
      const c=await this.cases.authorizedCase(db,p,id,true);
      if(c.lifecycle_status==='closed')throw new ConflictException('Invoices cannot be edited for a closed case.');
      const removing=await db.query(`SELECT 1 FROM ${s}.student_case_invoice_removals WHERE customer_id=$1 AND xero_connection_id=$2 AND xero_invoice_id=$3 AND (completed OR lease_expires_at>now())`,[p.tenantId,connectionId,invoiceId]);
      if(removing.rowCount)throw new ConflictException('This invoice is being removed.');
      const row=(await db.query(`SELECT *,lease_expires_at>now() AS leased FROM ${s}.student_case_invoice_edits WHERE customer_id=$1 AND xero_connection_id=$2 AND xero_invoice_id=$3 FOR UPDATE`,[p.tenantId,connectionId,invoiceId])).rows[0];
      if((row?`${row.request_hash}:${new Date(row.updated_at).toISOString()}`:null)!==observedRevision)throw new ConflictException('The invoice changed while you were saving. Reopen it before trying again.');
      if(row?.leased||row&&!row.completed&&!row.failed&&row.request_hash!==requestHash)throw new ConflictException('An invoice update is processing. Retry the original changes.');
      await db.query(`INSERT INTO ${s}.student_case_invoice_edits(customer_id,case_id,xero_connection_id,xero_invoice_id,actor_identity_user_id,idempotency_key,request_hash,expected_fingerprint,desired,lease_token,lease_expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()+interval '2 minutes') ON CONFLICT(customer_id,xero_connection_id,xero_invoice_id) DO UPDATE SET
        actor_identity_user_id=$5,idempotency_key=$6,request_hash=$7,expected_fingerprint=$8,desired=$9,completed=false,failed=false,lease_token=$10,lease_expires_at=now()+interval '2 minutes',updated_at=now()`,[p.tenantId,id,connectionId,invoiceId,p.identityUserId,key,requestHash,v.expectedFingerprint,JSON.stringify(planned),lease]);
    });
    try{
      if(lockDate&&v.issueDate<=lockDate)throw new BadRequestException('The issue date belongs to a locked accounting period.');
      const updated=alreadyApplied?live:await session.updateInvoice(invoiceId,planned.value,hash([p.tenantId,connectionId,invoiceId,key,requestHash]));
      if(updated.invoiceId!==invoiceId||!matchesEditedInvoice(updated,planned.value,planned.totalMinor))throw new ConflictException('The invoice update could not be confirmed. Retry the same changes.');
      await this.database.tenantTransaction(p.tenantId,async db=>{
        await this.cases.authorizedCase(db,p,id,true);
        const owned=await db.query(`SELECT 1 FROM ${s}.student_case_invoice_edits WHERE customer_id=$1 AND xero_connection_id=$2 AND xero_invoice_id=$3 AND lease_token=$4 FOR UPDATE`,[p.tenantId,connectionId,invoiceId,lease]);
        if(!owned.rowCount)throw new ConflictException('The invoice update is being finalized. Retry shortly.');
        await this.publish(db,p,id,connectionId,updated);
      });
      return {invoiceId,status:'updated'};
    }catch(error){
      try{await this.database.tenantTransaction(p.tenantId,db=>db.query(`UPDATE ${s}.student_case_invoice_edits SET lease_token=NULL,lease_expires_at=NULL,failed=$5 WHERE customer_id=$1 AND xero_connection_id=$2 AND xero_invoice_id=$3 AND lease_token=$4`,[p.tenantId,connectionId,invoiceId,lease,error instanceof BadRequestException]));}catch{}
      throw error;
    }
  }
}
