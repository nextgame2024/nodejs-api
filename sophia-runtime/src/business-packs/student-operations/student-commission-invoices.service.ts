import {BadRequestException,ConflictException,ForbiddenException,Injectable,NotFoundException} from '@nestjs/common';
import {randomBytes} from 'node:crypto';
import {z} from 'zod';
import type {PoolClient} from 'pg';
import {DatabaseService} from '../../database/database.service.js';
import {XeroConnectorService} from '../../connectors/xero/xero-connector.service.js';
import type {XeroInvoiceCreate,XeroInvoiceRecord} from '../../connectors/xero/xero.client.js';
import {lineTaxMinor,scaled4} from '../../connectors/xero/xero-sales-catalogue.js';
import {StudentOperationsCasesService,caseSchema} from './student-operations-cases.service.js';
import type {StudentOperationsWorkspacePrincipal as Principal} from './student-operations-workspace.service.js';
import {hasStudentOperationsPermission} from './student-operations-policy.js';
import {invoiceSnapshot,xeroPreflightFailure,type InvoiceSnapshot} from './student-case-invoice-drafts.js';
import {invoiceDraftXeroValue,matchesXeroInvoice,exactXeroInvoiceMatches} from './student-case-invoice-matching.js';
import {readSalesCatalogue} from './student-xero-sales-catalogue.js';
import {commissionTuitionItemCode} from './student-commission-items.js';
import {commissionAmount,commissionPricing,commissionHash,commissionRuleIssue,type CommissionRule} from './student-commission-calculation.js';

const selection=z.object({sequence:z.number().int().positive(),itemId:z.uuid().optional(),typeOfSaleOptionId:z.uuid().optional()}).strict();
const prepare=z.object({batchRevision:z.number().int().positive(),selections:z.array(selection).min(1).max(200)}).strict();
const create=z.object({sequences:z.array(z.number().int().positive()).min(1).max(200),confirmed:z.literal(true)}).strict();
type Calculation=ReturnType<typeof commissionAmount>;
type Snapshot={connectionId:string;contactId:string;mappingRevision:number;collegeId:string;collegeName:string;catalogueRevision:number;rule:CommissionRule;
 calculation:Calculation;taxMinor:number;totalMinor:number;value:XeroInvoiceCreate};
type Result={sequence:number;status:string;invoiceId?:string;invoiceNumber?:string|null;message?:string;errorCode?:string};
const sourceValue=(s:InvoiceSnapshot,i:InvoiceSnapshot['invoices'][number])=>({studentName:s.studentName,currency:s.currency,collegeId:s.collegeId,collegeName:i.collegeName??s.collegeName,connectionId:s.catalogueConnectionId,invoice:i});

@Injectable()
export class StudentCommissionInvoicesService{
 constructor(private readonly database:DatabaseService,private readonly cases:StudentOperationsCasesService,private readonly xero:XeroConnectorService){}
 private authorize(p:Principal,write=false){
  if(!hasStudentOperationsPermission(p.role,'payments.read_all')||write&&!hasStudentOperationsPermission(p.role,'payments.prepare'))throw new ForbiddenException('Invoice financial access required.');
 }
 private approve(p:Principal){this.authorize(p,true);if(!hasStudentOperationsPermission(p.role,'payments.approve'))throw new ForbiddenException('Invoice creation permission required.');if(process.env.XERO_INVOICE_CREATION_ENABLED!=='true')throw new ConflictException('Xero invoice creation is not enabled.');}
 private async ready(db:PoolClient){return Boolean((await db.query('SELECT to_regclass($1) IS NOT NULL AS ready',[`${caseSchema()}.student_commission_drafts`])).rows[0]?.ready);}
 private async optionsIn(db:PoolClient,p:Principal,collegeId:string){
  const s=caseSchema(),catalogue=await readSalesCatalogue(db,p.tenantId,false,'operating');
  const college=(await db.query(`SELECT college_name FROM ${s}.student_operations_college_directory WHERE customer_id=$1 AND college_id=$2`,[p.tenantId,collegeId])).rows[0];
  const rules=(await db.query(`SELECT * FROM ${s}.student_college_commission_rules WHERE customer_id=$1 AND college_id=$2 AND active ORDER BY rule_id`,[p.tenantId,collegeId])).rows as CommissionRule[];
  const mappings=catalogue?(await db.query(`SELECT m.xero_contact_id,m.revision,m.reviewed_by FROM ${s}.student_college_xero_contact_links m JOIN ${s}.student_operations_xero_contacts c USING(customer_id,xero_connection_id,xero_contact_id)
    WHERE m.customer_id=$1 AND m.xero_connection_id=$2 AND m.college_id=$3 AND m.classification='college' AND c.contact_status='ACTIVE' ORDER BY m.xero_contact_id`,[p.tenantId,catalogue.connectionId,collegeId])).rows:[];
  const taxes=catalogue?.taxRates.filter(t=>t.name.trim().toLowerCase()==='gst on income'&&t.rate!==null)??[];
  const themes=catalogue?.brandingThemes?.filter(t=>t.name.trim().toLowerCase()==='pty open for australia account')??[];
  const confirmed=mappings.filter(m=>!String(m.reviewed_by).startsWith('system:college-name-match:'));
  // Automatic identity matching can link several historical numbered contacts.
  // A single explicit human confirmation chooses the new-invoice recipient.
  // Multiple human confirmations still require review; no name guess chooses it.
  const mapping=confirmed.length===1?confirmed[0]:confirmed.length===0&&mappings.length===1?mappings[0]:null;
  const issue=!college?'Select an available college.':commissionRuleIssue(rules)??(!catalogue?'The PTY catalogue is waiting for background import.':!mapping?'Confirm one active PTY invoice recipient for this college in Sync colleges.':taxes.length!==1?'Configure one active GST on Income tax rate in PTY.':themes.length!==1?'Configure the PTY Open for Australia Account branding theme and refresh the catalogue.':null);
  const categories=catalogue?.trackingCategories?.filter(c=>c.name.trim().toLowerCase()==='type of sale')??[];
  const saleCategory=categories.length===1?categories[0]:null;
  const saleOptions=saleCategory?.options??[];
  const defaults=saleOptions.filter(o=>o.name.trim().toLowerCase()==='instalment');
  const defaultSaleOption=defaults.length===1?defaults[0]:null;
  const typeOfSaleIssue=catalogue?.trackingCategories===undefined?'Type of Sale options are waiting for background import.':!saleCategory?'Configure one active PTY Type of Sale category.':!saleOptions.length?'No active PTY Type of Sale options are available.':null;
  const items=catalogue?.items.filter(i=>i.accountCode&&catalogue.accounts.some(a=>a.code===i.accountCode))??[];
  return {available:true,issue,collegeId,collegeName:college?.college_name??null,rule:!commissionRuleIssue(rules)?rules[0]:null,catalogue,items,saleCategory,saleOptions,defaultSaleOption,typeOfSaleIssue,tax:taxes.length===1?taxes[0]:null,theme:themes.length===1?themes[0]:null,mapping};
 }
 async options(p:Principal,id:string,collegeId:string){
  this.authorize(p);if(!z.uuid().safeParse(collegeId).success)throw new BadRequestException('Select a college.');
  return this.database.tenantReadTransaction(p.tenantId,async db=>{
   await this.cases.authorizedCase(db,p,id);if(!await this.ready(db))return {available:false,issue:'PTY invoice preparation is not available yet.'};
   const o=await this.optionsIn(db,p,collegeId);
   // Send the selectable items once; the full catalogue and mapping identifiers
   // remain server-side. Tab changes reuse this local response.
   const itemAccounts=new Set(o.items.map(i=>i.accountCode));
   return {typeOfSaleOptions:o.saleOptions.map(v=>({value:v.trackingOptionId,label:v.name})),defaultTypeOfSaleOptionId:o.defaultSaleOption?.trackingOptionId??null,typeOfSaleIssue:o.typeOfSaleIssue,accounts:o.catalogue?.accounts.filter(a=>itemAccounts.has(a.code))??[],available:o.available,issue:o.issue,collegeId:o.collegeId,collegeName:o.collegeName,rule:o.rule?{rule_id:o.rule.rule_id,commission_basis_points:o.rule.commission_basis_points,application_conditions:o.rule.application_conditions}:null,items:o.items,tax:o.tax};
  });
 }
 private async batch(db:PoolClient,p:Principal,id:string,batchId:string,lock=false){
  await this.cases.authorizedCase(db,p,id,lock);
  const b=(await db.query(`SELECT b.snapshot,b.revision,b.offer_id,o.is_current FROM ${caseSchema()}.student_case_invoice_draft_batches b LEFT JOIN ${caseSchema()}.student_case_offers o ON o.customer_id=b.customer_id AND o.offer_id=b.offer_id
    WHERE b.customer_id=$1 AND b.case_id=$2 AND b.batch_id=$3 ${lock?'FOR UPDATE OF b':''}`,[p.tenantId,id,batchId])).rows[0];
  if(!b)throw new NotFoundException('Invoice draft batch not found.');
  return {...b,snapshot:invoiceSnapshot.parse(b.snapshot)} as {snapshot:InvoiceSnapshot;revision:number;offer_id:string|null;is_current:boolean|null};
 }
 async list(p:Principal,id:string,batchId:string){
  this.authorize(p);if(!z.uuid().safeParse(batchId).success)throw new BadRequestException('Select a draft batch.');
  return this.database.tenantReadTransaction(p.tenantId,async db=>{
   const b=await this.batch(db,p,id,batchId);if(!await this.ready(db))return {items:[]};
   const rows=(await db.query(`SELECT d.sequence,d.revision,d.source_hash AS "sourceHash",d.snapshot,e.status,e.xero_invoice_id AS "invoiceId",e.xero_invoice_number AS "invoiceNumber",
    e.trust_connection_id AS "trustConnectionId",e.trust_invoice_id AS "trustInvoiceId",i.invoice_status AS "providerStatus",i.invoice_date AS "providerDate",i.due_date AS "providerDueDate",i.amount_paid AS "amountPaid",i.amount_due AS "amountDue",
    t.invoice_status AS "trustStatus",t.total AS "trustTotal"
    FROM ${caseSchema()}.student_commission_drafts d LEFT JOIN ${caseSchema()}.student_commission_exports e USING(customer_id,batch_id,sequence)
    LEFT JOIN ${caseSchema()}.student_operations_xero_invoices i ON i.customer_id=e.customer_id AND i.xero_connection_id=e.xero_connection_id AND i.xero_invoice_id=e.xero_invoice_id
    LEFT JOIN ${caseSchema()}.student_operations_xero_invoices t ON t.customer_id=e.customer_id AND t.xero_connection_id=e.trust_connection_id AND t.xero_invoice_id=e.trust_invoice_id
    WHERE d.customer_id=$1 AND d.case_id=$2 AND d.batch_id=$3 ORDER BY d.sequence`,[p.tenantId,id,batchId])).rows;
   return {items:rows.map(row=>{const source=b.snapshot.invoices.find(i=>i.sequence===row.sequence);return {...row,stale:!source||commissionHash(sourceValue(b.snapshot,source))!==row.sourceHash,
    adjustmentRequired:Boolean(row.status==='created'&&(!source||['VOIDED','DELETED'].includes(row.trustStatus)||row.trustTotal!=null&&Math.round(Number(row.trustTotal)*100)!==source.totalMinor))};})};
  });
 }
 async prepare(p:Principal,id:string,batchId:string,input:unknown){
  this.authorize(p,true);const v=prepare.safeParse(input);if(!v.success||!z.uuid().safeParse(batchId).success)throw new BadRequestException('Select the PTY items to prepare.');
  if(new Set(v.data.selections.map(i=>i.sequence)).size!==v.data.selections.length)throw new BadRequestException('Select each instalment once.');
  return this.database.tenantTransaction(p.tenantId,async db=>{
   const c=await this.cases.authorizedCase(db,p,id,true);if(c.lifecycle_status==='closed')throw new ConflictException('The case is closed.');
   const b=await this.batch(db,p,id,batchId,true),s=caseSchema();
   if(b.revision!==v.data.batchRevision||b.offer_id&&!b.is_current)throw new ConflictException('The TRUST drafts changed. Reload before preparing PTY.');
   if(!b.snapshot.collegeId)throw new BadRequestException('Select a college on the TRUST invoice.');
   const o=await this.optionsIn(db,p,b.snapshot.collegeId);
   if(o.issue||!o.rule||!o.catalogue||!o.tax||!o.theme||!o.mapping)throw new ConflictException(o.issue??'PTY settings are incomplete.');
   const itemsByCode=new Map<string,typeof o.items>();
   for(const item of o.items){const code=item.code.trim().toLowerCase();itemsByCode.set(code,[...(itemsByCode.get(code)??[]),item]);}
   for(const selected of v.data.selections){
    const invoice=b.snapshot.invoices.find(i=>i.sequence===selected.sequence);
    if(!invoice)throw new BadRequestException('Select an available TRUST instalment.');
    if(invoice.collegeName!==undefined&&invoice.collegeName!==o.collegeName)throw new ConflictException('This TRUST invoice belongs to a different college. Review its original college before preparing commission.');
    const frozen=(await db.query(`SELECT status FROM ${s}.student_commission_exports WHERE customer_id=$1 AND batch_id=$2 AND sequence=$3`,[p.tenantId,batchId,selected.sequence])).rows[0];
    if(frozen&&frozen.status!=='not_attempted')continue;
    let code:string;try{code=commissionTuitionItemCode(invoice.lines);}catch(error){throw new BadRequestException((error as Error).message);}
    const matches=itemsByCode.get(code)??[];
    if(matches.length!==1)throw new BadRequestException(`The TRUST tuition item “${code}” needs one matching item with an account in PTY. Refresh the item catalogue or check its setup.`);
    const item=matches[0];
    if(!item.accountCode)throw new BadRequestException('The matching PTY item needs a sales account.');
    if(selected.itemId&&selected.itemId!==item.itemId)throw new BadRequestException('The PTY item must match the corresponding TRUST tuition item. Reload the invoice preview.');
    const calculation=commissionAmount(invoice.lines.map(l=>({kind:l.kind,amountMinor:l.amountMinor})),o.rule.commission_basis_points),taxMinor=lineTaxMinor(calculation.commissionMinor,o.tax.rate!);
    const pricing=commissionPricing(invoice.lines,calculation.commissionMinor);
    const saleOption=selected.typeOfSaleOptionId?o.saleOptions.find(option=>option.trackingOptionId===selected.typeOfSaleOptionId):o.defaultSaleOption;
    // Existing clients omitted a selection and used Instalment. Keep that
    // behaviour until their catalogue imports tracking; dispatch still validates Xero.
    if(!saleOption&&(selected.typeOfSaleOptionId||o.catalogue.trackingCategories!==undefined))throw new BadRequestException('Select an active Type of Sale option from the PTY Xero organisation.');
    const saleTracking=saleOption&&o.saleCategory?{name:o.saleCategory.name,option:saleOption.name,trackingCategoryId:o.saleCategory.trackingCategoryId,trackingOptionId:saleOption.trackingOptionId}:{name:'Type of Sale',option:'Instalment'};
    const value:XeroInvoiceCreate={contactId:o.mapping.xero_contact_id,date:invoice.issueDate,dueDate:invoice.dueDate,reference:b.snapshot.studentName,currencyCode:b.snapshot.currency,brandingThemeId:o.theme.brandingThemeId,
     lines:[{description:`Student Name: ${b.snapshot.studentName}\nCommission for INV-${invoice.sequence}\n${invoice.lines.filter(l=>l.kind==='tuition').map(l=>l.description).join('\n')}`.slice(0,4000),quantity:pricing.quantity,unitAmount:pricing.unitAmount,itemCode:item.code,accountCode:item.accountCode,taxType:o.tax.taxType,tracking:[saleTracking]}]};
    const snapshot:Snapshot={connectionId:o.catalogue.connectionId,contactId:o.mapping.xero_contact_id,mappingRevision:o.mapping.revision,collegeId:o.collegeId,collegeName:o.collegeName,catalogueRevision:o.catalogue.revision,rule:o.rule,calculation,taxMinor,totalMinor:calculation.commissionMinor+taxMinor,value};
    await db.query(`INSERT INTO ${s}.student_commission_drafts(customer_id,case_id,batch_id,sequence,source_hash,snapshot,prepared_by) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)
     ON CONFLICT(customer_id,batch_id,sequence) DO UPDATE SET source_hash=EXCLUDED.source_hash,snapshot=EXCLUDED.snapshot,prepared_by=EXCLUDED.prepared_by,prepared_at=now(),revision=student_commission_drafts.revision+1`,[p.tenantId,id,batchId,selected.sequence,commissionHash(sourceValue(b.snapshot,invoice)),JSON.stringify(snapshot),p.identityUserId]);
   }
   await this.cases.activity(db,p,id,'case.commission_drafts_prepared',`${v.data.selections.length} PTY commission drafts reviewed`);
   return {prepared:v.data.selections.length};
  });
 }
 private async complete(p:Principal,id:string,batchId:string,sequence:number,receipt:{invoiceId:string;invoiceNumber:string|null;status:string}){
  await this.database.tenantTransaction(p.tenantId,async db=>{
   const r=await db.query(`UPDATE ${caseSchema()}.student_commission_exports SET status='created',xero_invoice_id=$4,xero_invoice_number=$5,provider_status=$6,completed_at=now()
    WHERE customer_id=$1 AND batch_id=$2 AND sequence=$3 AND status IN ('creating','review_required') RETURNING xero_connection_id`,[p.tenantId,batchId,sequence,receipt.invoiceId,receipt.invoiceNumber,receipt.status]);
   if(!r.rowCount)throw new ConflictException('The commission receipt needs review.');
   await this.cases.activity(db,p,id,'case.commission_invoice_created',`INV-${sequence} PTY created as Xero ${receipt.invoiceNumber??receipt.invoiceId}`);
   await db.query(`UPDATE ${caseSchema()}.student_operations_xero_sync_configurations SET next_sync_at=now() WHERE customer_id=$1 AND xero_connection_id=$2 AND next_sync_at>now()`,[p.tenantId,r.rows[0].xero_connection_id]);
  });
 }
 async create(p:Principal,id:string,batchId:string,input:unknown){
  this.approve(p);const v=create.safeParse(input);if(!v.success||!z.uuid().safeParse(batchId).success)throw new BadRequestException('Review the PTY invoice selection.');
  const results:Result[]=[];
  // Read the large catalogue once per request, outside per-invoice locks. Small
  // revision checks below detect changes before each durable claim.
  const current=await this.database.tenantReadTransaction(p.tenantId,async db=>{
   const b=await this.batch(db,p,id,batchId);return b.snapshot.collegeId?this.optionsIn(db,p,b.snapshot.collegeId):null;
  });
  const sessions=new Map<string,ReturnType<XeroConnectorService['invoiceCreationSession']>>();
  const sessionFor=(connectionId:string,role:'trust'|'operating')=>{
   const key=`${role}:${connectionId}`;let session=sessions.get(key);if(!session){session=this.xero.invoiceCreationSession(p.tenantId,connectionId,role);sessions.set(key,session);}return session;
  };
  const execute=async(sequence:number)=>{
   let owned=false,providerStarted=false,providerReturned=false;
   try{
    const claim=await this.database.tenantTransaction(p.tenantId,async db=>{
     const c=await this.cases.authorizedCase(db,p,id,true);if(c.lifecycle_status==='closed')throw new ConflictException('The case is closed.');
     const b=await this.batch(db,p,id,batchId,true),s=caseSchema();
     if(b.offer_id&&!b.is_current)throw new ConflictException('The offer was replaced. Review the commission.');
     const d=(await db.query(`SELECT * FROM ${s}.student_commission_drafts WHERE customer_id=$1 AND batch_id=$2 AND sequence=$3 FOR UPDATE`,[p.tenantId,batchId,sequence])).rows[0];
     if(!d)throw new ConflictException('Prepare this PTY commission before creating it.');
     const e=(await db.query(`SELECT * FROM ${s}.student_commission_exports WHERE customer_id=$1 AND batch_id=$2 AND sequence=$3`,[p.tenantId,batchId,sequence])).rows[0];
     if(e&&e.status!=='not_attempted')return {existing:e.status};
     const source=b.snapshot.invoices.find(i=>i.sequence===sequence),snapshot=d.snapshot as Snapshot;
     if(!source||commissionHash(sourceValue(b.snapshot,source))!==d.source_hash)throw new ConflictException('The TRUST draft changed. Prepare the PTY calculation again.');
     const pricing=commissionPricing(source.lines,snapshot.calculation.commissionMinor),line=snapshot.value.lines[0];
     if(snapshot.value.lines.length!==1||scaled4(line.quantity)!==scaled4(pricing.quantity)||scaled4(line.unitAmount)!==scaled4(pricing.unitAmount))throw new ConflictException('The PTY quantity or price no longer matches TRUST. Prepare the PTY calculation again.');
     if(current?.catalogue?.trackingCategories!==undefined){
      const selected=line.tracking.filter(t=>t.name.trim().toLowerCase()==='type of sale');
      const options=current.saleOptions.filter(o=>selected[0]?.trackingOptionId?o.trackingOptionId===selected[0].trackingOptionId&&o.name===selected[0].option:o.name===selected[0]?.option);
      if(selected.length!==1||!current.saleCategory||options.length!==1||selected[0].trackingCategoryId&&selected[0].trackingCategoryId!==current.saleCategory.trackingCategoryId)throw new ConflictException('The PTY Type of Sale changed. Review and prepare this commission again.');
     }
     if(!current||current.issue||current.collegeId!==snapshot.collegeId||current.catalogue?.connectionId!==snapshot.connectionId||commissionHash(current.rule)!==commissionHash(snapshot.rule)||current.mapping?.xero_contact_id!==snapshot.contactId||current.mapping?.revision!==snapshot.mappingRevision||current.catalogue?.revision!==snapshot.catalogueRevision)throw new ConflictException('The PTY rule, contact or catalogue changed. Review the calculation again.');
     const fresh=await db.query(`SELECT 1 FROM ${s}.student_xero_sales_catalogues cat
      JOIN ${s}.student_operations_xero_sync_configurations cfg USING(customer_id,xero_connection_id)
      JOIN ${s}.xero_connections x USING(customer_id,xero_connection_id)
      JOIN ${s}.student_college_xero_contact_links m USING(customer_id,xero_connection_id)
      JOIN ${s}.student_operations_xero_contacts xc USING(customer_id,xero_connection_id,xero_contact_id)
      JOIN ${s}.student_college_commission_rules r ON r.customer_id=m.customer_id AND r.college_id=m.college_id
      WHERE cat.customer_id=$1 AND cat.xero_connection_id=$2 AND cat.revision=$3 AND cfg.enabled AND cfg.organisation_role='operating' AND x.status='active'
       AND m.xero_contact_id=$4 AND m.revision=$5 AND m.college_id=$6 AND m.classification='college' AND xc.contact_status='ACTIVE' AND r.rule_id=$7 AND r.active AND date_trunc('milliseconds',r.updatedat)=$8::timestamptz
       AND NOT EXISTS(SELECT 1 FROM ${s}.student_college_xero_contact_links other
        WHERE other.customer_id=$1 AND other.xero_connection_id=$2 AND other.college_id=$6 AND other.classification='college' AND other.xero_contact_id<>$4 AND other.reviewed_by NOT LIKE 'system:college-name-match:%')`,
       [p.tenantId,snapshot.connectionId,snapshot.catalogueRevision,snapshot.contactId,snapshot.mappingRevision,snapshot.collegeId,snapshot.rule.rule_id,snapshot.rule.updatedat]);
     if(!fresh.rowCount)throw new ConflictException('PTY settings changed during creation. Review the calculation again.');
     const t=(await db.query(`SELECT * FROM ${s}.student_case_xero_invoice_exports WHERE customer_id=$1 AND batch_id=$2 AND sequence=$3 AND status='created'`,[p.tenantId,batchId,sequence])).rows[0];
     if(!t)throw new ConflictException('Create the corresponding TRUST invoice first.');
     const key=randomBytes(32).toString('hex');
     await db.query(`INSERT INTO ${s}.student_commission_exports(customer_id,case_id,batch_id,sequence,trust_connection_id,trust_invoice_id,xero_connection_id,xero_contact_id,provider_key,status,requested_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'creating',$10) ON CONFLICT(customer_id,batch_id,sequence) DO UPDATE SET status='creating',provider_key=EXCLUDED.provider_key,requested_by=EXCLUDED.requested_by,requested_at=now(),
       trust_connection_id=EXCLUDED.trust_connection_id,trust_invoice_id=EXCLUDED.trust_invoice_id,xero_connection_id=EXCLUDED.xero_connection_id,xero_contact_id=EXCLUDED.xero_contact_id`,[p.tenantId,id,batchId,sequence,t.xero_connection_id,t.xero_invoice_id,snapshot.connectionId,snapshot.contactId,key,p.identityUserId]);
     return {snapshot,key,trust:t,source,batch:b.snapshot};
    });
    if('existing' in claim){results.push({sequence,status:claim.existing==='created'?'already_created':claim.existing});return;}
    owned=true;
    const trust=await (await sessionFor(claim.trust.xero_connection_id,'trust')).invoiceById(claim.trust.xero_invoice_id);
    if(!matchesXeroInvoice(trust,invoiceDraftXeroValue(claim.batch,claim.source,claim.trust.xero_contact_id),claim.source.totalMinor))throw new ConflictException('The TRUST invoice changed in Xero. Review it before creating PTY.');
    const session=await sessionFor(claim.snapshot.connectionId,'operating');
    // A final local authorization check occurs after provider reads.
    await this.database.tenantReadTransaction(p.tenantId,db=>this.cases.authorizedCase(db,p,id));
    providerStarted=true;const receipt=await session.createInvoice(claim.snapshot.value,claim.key);providerReturned=true;
    await this.complete(p,id,batchId,sequence,receipt);
    results.push({sequence,status:'created',invoiceId:receipt.invoiceId,invoiceNumber:receipt.invoiceNumber});
   }catch(error){
    const status=providerReturned||providerStarted&&!(error instanceof BadRequestException||error instanceof ConflictException)?'review_required':'not_attempted';
    if(owned)await this.database.tenantTransaction(p.tenantId,db=>db.query(`UPDATE ${caseSchema()}.student_commission_exports SET status=$4 WHERE customer_id=$1 AND batch_id=$2 AND sequence=$3 AND status='creating'`,[p.tenantId,batchId,sequence,status]));
    results.push({sequence,status,...xeroPreflightFailure(error)});
   }
  };
  const selected=[...new Set(v.data.sequences)].sort((a,b)=>a-b);let next=0,stopped=false;
  const workers=await Promise.allSettled(Array.from({length:Math.min(3,selected.length)},async()=>{while(!stopped){const index=next++;if(index>=selected.length)return;try{await execute(selected[index]);}catch(error){stopped=true;throw error;}}}));
  const failed=workers.find(r=>r.status==='rejected');if(failed?.status==='rejected')throw failed.reason;
  results.sort((a,b)=>a.sequence-b.sequence);
  return {created:results.filter(r=>r.status==='created').length,skipped:results.filter(r=>r.status!=='created').length,results};
 }
 async reconcile(p:Principal,id:string,batchId:string,sequence:number){
  this.approve(p);if(!z.uuid().safeParse(batchId).success||!Number.isSafeInteger(sequence)||sequence<1)throw new BadRequestException('Select an invoice.');
  const r=await this.database.tenantReadTransaction(p.tenantId,async db=>{
   await this.batch(db,p,id,batchId);
   return (await db.query(`SELECT d.snapshot,e.status,e.requested_at FROM ${caseSchema()}.student_commission_drafts d JOIN ${caseSchema()}.student_commission_exports e USING(customer_id,batch_id,sequence)
    WHERE d.customer_id=$1 AND d.batch_id=$2 AND d.sequence=$3`,[p.tenantId,batchId,sequence])).rows[0];
  });
  if(!r)throw new NotFoundException('PTY creation receipt not found.');
  if(r.status==='created')return {created:0,skipped:1,results:[{sequence,status:'already_created'}]};
  if(!['creating','review_required'].includes(r.status)||Date.now()-new Date(r.requested_at).getTime()<120_000)throw new ConflictException('Wait for the current PTY request to complete before checking Xero.');
  const snapshot=r.snapshot as Snapshot,candidates=await this.xero.invoiceCandidates(p.tenantId,snapshot.connectionId,snapshot.contactId,snapshot.value.date);
  const matches=await exactXeroInvoiceMatches(candidates,snapshot.value,snapshot.totalMinor,invoiceId=>this.xero.invoiceById(p.tenantId,snapshot.connectionId,invoiceId));
  if(matches.length!==1)return {created:0,skipped:1,results:[{sequence,status:'review_required',message:'No unique exact PTY invoice was found. Review Xero before any retry.'}]};
  const match=matches[0];await this.complete(p,id,batchId,sequence,{invoiceId:match.invoiceId,invoiceNumber:match.invoiceNumber,status:match.status});
  return {created:1,skipped:0,results:[{sequence,status:'created',invoiceId:match.invoiceId,invoiceNumber:match.invoiceNumber}]};
 }
}
