import {BadRequestException,ConflictException} from '@nestjs/common';
import type {XeroInvoiceCreate} from '../../connectors/xero/xero.client.js';
import {lineTaxMinor,type XeroSalesCatalogue} from '../../connectors/xero/xero-sales-catalogue.js';
import type {InvoiceSnapshot} from './student-case-invoice-drafts.js';
import {commissionHash,commissionPricing,type CommissionRule} from './student-commission-calculation.js';
import {commissionTuitionItemCode} from './student-commission-items.js';
import {calculateCommission,commissionFacts,selectCommissionRule,type CommissionContext} from './student-commission-rules.js';
export function commissionSourceLines(invoice:InvoiceSnapshot['invoices'][number]){
 const lines=invoice.lines.map(l=>({...l,kind:l.kind,amountMinor:l.amountMinor}));
 // Separate discounts never reduce commission. Legacy inline discounts have an explicit gross base.
 if(typeof invoice.commissionTuitionMinor==='number'&&!lines.some(l=>l.kind==='agency_discount')){
  const tuition=lines.filter(l=>l.kind==='tuition');
  if(tuition.length===1)tuition[0].amountMinor=invoice.commissionTuitionMinor;
  else if(tuition.length>1){const total=tuition.reduce((n,l)=>n+Number(l.amountMinor),0);tuition[0].amountMinor=Number(tuition[0].amountMinor)+invoice.commissionTuitionMinor-total;}
 }
 return lines;
}
export function buildCommissionV2(input:{rules:CommissionRule[];context:CommissionContext;invoice:InvoiceSnapshot['invoices'][number];batch:InvoiceSnapshot;
 catalogue:XeroSalesCatalogue;connectionId:string;catalogueRevision:number;contactId:string;mappingRevision:number;collegeId:string;collegeName:string;brandingThemeId:string;typeOfSaleOptionId?:string}){
 const {invoice,batch,catalogue}=input;
 if(batch.currency!=='AUD')throw new ConflictException('Review the commission contract for this currency before preparing PTY.');
 const source=commissionSourceLines(invoice),context=commissionFacts(source,input.context),rule=selectCommissionRule(input.rules,context),calculation=calculateCommission(rule,source,context);
 const sale=catalogue.trackingCategories?.filter(c=>c.name.trim().toLowerCase()==='type of sale')??[];
 const rep=catalogue.trackingCategories?.filter(c=>c.name.trim().toLowerCase()==='sales representative')??[];
 const warnings:string[]=[];
 if(rep.length===0)warnings.push('Sales Representative is not in the active PTY catalogue. No advisor tracking will be sent; review this before creating the invoice.');
 if(rep.length>1)throw new ConflictException('Resolve the duplicate Sales Representative category in PTY.');
 const advisor=rep[0]?.options.filter(o=>o.name.trim().toLowerCase()===String(invoice.advisorLabel??batch.advisorLabel??batch.advisorName??'').trim().toLowerCase())??[];
 if(rep.length&&advisor.length!==1)throw new ConflictException('Map the invoice advisor to one active PTY Sales Representative option.');
 const lines:XeroInvoiceCreate['lines']=[];let taxMinor=0;
 for(const component of calculation.components){
  let code:string;try{code=component.kind==='commission'?commissionTuitionItemCode(source):'cash back';}catch(e){throw new BadRequestException((e as Error).message);}
  const items=catalogue.items.filter(i=>i.code.trim().toLowerCase()===code&&i.accountCode&&catalogue.accounts.some(a=>a.code===i.accountCode));
  if(items.length!==1)throw new ConflictException(`Configure one PTY “${code}” item with a valid sales account.`);
  const item=items[0],taxes=catalogue.taxRates.filter(t=>t.taxType===item.taxType&&t.rate!==null);
  if(taxes.length!==1)throw new ConflictException(`Configure a valid tax default for PTY item “${item.code}”.`);
  if(sale.length!==1)throw new ConflictException('Configure one active PTY Type of Sale category.');
  const saleId=input.typeOfSaleOptionId??invoice.typeOfSaleOptionId;
  const options=sale[0].options.filter(o=>component.kind==='cashback'?o.name.trim().toLowerCase()==='cash back':saleId?o.trackingOptionId===saleId:o.name.trim().toLowerCase()==='instalment');
  if(options.length!==1)throw new ConflictException(component.kind==='cashback'?'Configure the active Cash Back Type of Sale option in PTY.':'Select an active PTY Type of Sale.');
  const pricing=component.kind==='commission'?commissionPricing(source,component.amountMinor):{quantity:'1',unitAmount:(component.amountMinor/100).toFixed(2)};
  component.itemId=item.itemId;component.taxMinor=lineTaxMinor(component.amountMinor,taxes[0].rate!);taxMinor+=component.taxMinor;
  const description=component.kind==='commission'?`Student Name: ${batch.studentName}\nCommission for INV-${invoice.sequence}\n${source.filter(l=>l.kind==='tuition').map(l=>l.description).join('\n')}`:`Enrolment cashback for ${batch.studentName}\nTRUST INV-${invoice.sequence}, source line ${component.sourceLineIndexes[0]+1}\n${source[component.sourceLineIndexes[0]].description}`;
  lines.push({description:description.slice(0,4000),quantity:pricing.quantity,unitAmount:pricing.unitAmount,itemCode:item.code,accountCode:item.accountCode!,taxType:taxes[0].taxType,
   tracking:[{name:sale[0].name,option:options[0].name,trackingCategoryId:sale[0].trackingCategoryId,trackingOptionId:options[0].trackingOptionId},...(rep[0]?[{name:rep[0].name,option:advisor[0].name,trackingCategoryId:rep[0].trackingCategoryId,trackingOptionId:advisor[0].trackingOptionId}]:[])]});
 }
 const totalMinor=calculation.subtotalMinor+taxMinor;if(totalMinor>1_000_000_000)throw new BadRequestException('Commission total exceeds the supported limit.');
 const value:XeroInvoiceCreate={contactId:input.contactId,date:invoice.issueDate,dueDate:invoice.dueDate,reference:batch.studentName,currencyCode:batch.currency,brandingThemeId:input.brandingThemeId,lines};
 return {schemaVersion:2 as const,connectionId:input.connectionId,contactId:input.contactId,mappingRevision:input.mappingRevision,collegeId:input.collegeId,collegeName:input.collegeName,catalogueRevision:input.catalogueRevision,
  rule,ruleSetHash:commissionHash(input.rules),context,calculation,taxMinor,totalMinor,value,warnings,noRevenue:calculation.noRevenue};
}
