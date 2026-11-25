import {BadRequestException,ConflictException} from '@nestjs/common';
import {z} from 'zod';
import type {CommissionRule} from './student-commission-calculation.js';

const nullableDate=z.iso.date().nullable();
export const commissionConfiguration=z.object({
 eligibilityNote:z.string().trim().min(1).max(2000).optional(),maxTrimester:z.number().int().min(1).max(100).optional(),
 label:z.string().trim().min(1).max(300).optional(),choiceRequired:z.boolean().optional(),
 version:z.literal(2),state:z.enum(['ready','blocked']),blockedReason:z.string().trim().min(1).max(4000).nullable(),
 city:z.string().trim().min(1).max(200).nullable(),effectiveFrom:nullableDate,effectiveTo:nullableDate,dateBasis:z.literal('enrolment_date').nullable(),
 rateNumerator:z.number().int().min(0).max(1000000),rateDenominator:z.number().int().min(1).max(1000000),
 rateMethod:z.enum(['fixed','trimester','first_month']),laterRateNumerator:z.number().int().min(0).max(1000000),nonBulkOnly:z.boolean(),
 benefits:z.array(z.object({fixedAmountMinor:z.number().int().min(1).max(1000000000).optional(),classification:z.enum(['ELICOS','VET','HE']).optional(),source:z.enum(['enrolment','materials']),percentageBasisPoints:z.number().int().min(1).max(10000),gstInclusive:z.boolean(),itemCode:z.string().trim().min(1).max(100),saleName:z.string().trim().min(1).max(100),advisorName:z.string().trim().min(1).max(200).nullable()}).strict()).max(2).optional(),
 cashback:z.object({mode:z.enum(['none','enrolment_gross','fixed_net']),amountMinor:z.number().int().min(0).max(1_000_000_000)}).strict(),
}).strict().refine(v=>v.rateNumerator<=v.rateDenominator&&v.laterRateNumerator<=v.rateDenominator&&(v.state==='blocked')===Boolean(v.blockedReason)
 &&Boolean(v.effectiveFrom||v.effectiveTo)===Boolean(v.dateBasis)&&(!v.effectiveFrom||!v.effectiveTo||v.effectiveFrom<=v.effectiveTo)
 &&(v.rateMethod==='first_month'||v.laterRateNumerator===0)&&(v.rateMethod!=='trimester'||v.rateNumerator*5===v.rateDenominator)
 &&new Set(v.benefits?.map(b=>b.source)).size===(v.benefits?.length??0)&&!(v.cashback.mode!=='none'&&v.benefits?.some(b=>b.source==='enrolment'))
 &&(v.cashback.mode==='fixed_net'?v.cashback.amountMinor>0:v.cashback.amountMinor===0));
export type CommissionConfiguration=z.infer<typeof commissionConfiguration>;
export const commissionContext=z.object({eligibilityConfirmed:z.boolean().optional(),selectedRuleId:z.uuid().optional(),classification:z.enum(['ELICOS','VET','HE']).optional(),location:z.enum(['ON-SHORE','OFF-SHORE']).optional(),
 program:z.string().trim().min(1).max(300).optional(),city:z.string().trim().min(1).max(200).optional(),
 enrolmentDate:z.iso.date().optional(),courseMonth:z.number().int().min(1).max(1000).optional(),trimester:z.number().int().min(1).max(100).optional(),isBulk:z.boolean().optional(),
}).strict();
export type CommissionContext=z.infer<typeof commissionContext>;
type SourceLine={kind?:unknown;amountMinor?:unknown;itemCode?:unknown};
export type CommissionComponent={key:string;kind:'commission'|'cashback'|'bonus';itemCode?:string;saleName?:string;advisorName?:string;sourceLineIndexes:number[];baseMinor:number;amountMinor:number;rateNumerator:number;rateDenominator:number;itemId?:string;taxMinor?:number};
const normal=(v:unknown)=>String(v??'').normalize('NFKC').trim().toLowerCase();

export function configuredRule(rule:CommissionRule):CommissionConfiguration {
 const result=commissionConfiguration.safeParse(rule.configuration);
 if(!result.success)throw new ConflictException('The college commission configuration needs review before calculation.');
 return result.data;
}

export function commissionFacts(lines:SourceLine[],provided:CommissionContext):CommissionContext {
 const v=commissionContext.parse(provided),tuition=lines.filter(l=>l.kind==='tuition');
 const codes=tuition.map(l=>normal(l.itemCode));
 const classifications=new Set(codes.map(c=>c.includes('elicos')?'ELICOS':/\bvet\b/.test(c)?'VET':c.includes('higher education')||/\bhe\b/.test(c)?'HE':null).filter(Boolean));
 const locations=new Set(codes.map(c=>c.includes('on-shore')?'ON-SHORE':c.includes('off-shore')?'OFF-SHORE':null).filter(Boolean));
 if(classifications.size>1||locations.size>1)throw new ConflictException('Use one course classification and student location per TRUST invoice.');
 const classification=[...classifications][0] as CommissionContext['classification'],location=[...locations][0] as CommissionContext['location'];
 if(classification&&v.classification&&classification!==v.classification||location&&v.location&&location!==v.location)throw new ConflictException('Commission course facts must agree with the TRUST tuition item.');
 return {...v,...classification?{classification}:{},...location?{location}:{}};
}

export function selectCommissionRule(rules:CommissionRule[],facts:CommissionContext):CommissionRule {
 const active=rules.filter(r=>r.active);
 if(!active.length)throw new ConflictException('Record an active college commission rule before preparing PTY invoices.');
 const states=active.map(rule=>{
  const c=configuredRule(rule);let unknown=false,matches=true;
  for(const [expected,actual] of [[rule.classification,facts.classification],[rule.location,facts.location],[rule.program,facts.program],[c.city,facts.city]]){
   if(!expected)continue;if(!actual)unknown=true;else if(normal(expected)!==normal(actual))matches=false;
  }
  if(c.effectiveFrom||c.effectiveTo){if(!facts.enrolmentDate)unknown=true;else if(c.effectiveFrom&&facts.enrolmentDate<c.effectiveFrom||c.effectiveTo&&facts.enrolmentDate>c.effectiveTo)matches=false;}
  return {rule,c,unknown,matches};
 });
 if(facts.selectedRuleId){
  const selected=states.find(s=>s.rule.rule_id===facts.selectedRuleId);
  if(!selected||!selected.matches)throw new ConflictException('The selected rule is unavailable or conflicts with the confirmed course facts.');
  if(selected.c.state==='blocked')throw new ConflictException(selected.c.blockedReason!);
  return selected.rule;
 }
 if(states.some(s=>s.matches&&s.c.choiceRequired))throw new ConflictException('Select the applicable college rule for this invoice.');
 if(states.some(s=>s.matches&&s.unknown))throw new ConflictException('Complete the course classification, student location, program and original enrolment date required by the college rules.');
 const matched=states.filter(s=>s.matches&&!s.unknown);
 if(!matched.length)throw new ConflictException('No college commission rule matches these course facts. Review the college configuration.');
 const narrower=(a:typeof matched[number],b:typeof matched[number])=>{
  const aa=[a.rule.classification,a.rule.location,a.rule.program,a.c.city],bb=[b.rule.classification,b.rule.location,b.rule.program,b.c.city];
  const contained=bb.every((v,i)=>!v||normal(v)===normal(aa[i]))&&(a.c.effectiveFrom??'0001-01-01')>=(b.c.effectiveFrom??'0001-01-01')&&(a.c.effectiveTo??'9999-12-31')<=(b.c.effectiveTo??'9999-12-31');
  return contained&&(aa.some((v,i)=>Boolean(v)&&!bb[i])||a.c.effectiveFrom!==b.c.effectiveFrom||a.c.effectiveTo!==b.c.effectiveTo);
 };
 const winners=matched.filter(a=>!matched.some(b=>a!==b&&narrower(b,a)));
 if(winners.length!==1)throw new ConflictException('Multiple college commission rules match. Select the applicable rule for this invoice.');
 if(winners[0].c.state==='blocked')throw new ConflictException(winners[0].c.blockedReason!);
 return winners[0].rule;
}

export function rationalMinor(base:number,numerator:number,denominator:number):number {
 if(!Number.isSafeInteger(base)||base<0||base>1_000_000_000||!Number.isSafeInteger(numerator)||numerator<0||!Number.isSafeInteger(denominator)||denominator<1)throw new BadRequestException('Check the commission base and exact rate.');
 const n=BigInt(base)*BigInt(numerator),d=BigInt(denominator),result=Number((n*2n+d)/(2n*d));
 if(!Number.isSafeInteger(result)||result>1_000_000_000)throw new BadRequestException('Commission exceeds the supported amount.');
 return result;
}

export function calculateCommission(rule:CommissionRule,lines:SourceLine[],facts:CommissionContext){
 const c=configuredRule(rule);
 if(c.state==='blocked')throw new ConflictException(c.blockedReason!);
 if(c.eligibilityNote&&facts.eligibilityConfirmed!==true)throw new ConflictException(c.eligibilityNote);
 if(c.maxTrimester&&facts.trimester&&facts.trimester>c.maxTrimester)throw new ConflictException('No agreed commission rate is configured for this trimester.');
 if(c.nonBulkOnly&&facts.isBulk!==false)throw new ConflictException('Confirm this is a normal, non-bulk enrolment before calculating commission.');
 let numerator=c.rateNumerator,denominator=c.rateDenominator;
 if(c.rateMethod==='trimester'){
  if(!Number.isSafeInteger(facts.trimester)||facts.trimester!<1)throw new ConflictException('Enter the confirmed trimester number (1 or greater).');
  numerator=facts.trimester!<=2?20:facts.trimester!<=4?15:0;denominator=100;
 }
 if(c.rateMethod==='first_month'){if(!Number.isSafeInteger(facts.courseMonth)||facts.courseMonth!<1)throw new ConflictException('Enter the confirmed course month (1 or greater).');if(facts.courseMonth!==1)numerator=c.laterRateNumerator;}
 const tuition=lines.map((l,i)=>({...l,index:i})).filter(l=>l.kind==='tuition');
 if(!tuition.length||tuition.some(l=>!Number.isSafeInteger(l.amountMinor)||Number(l.amountMinor)<0))throw new BadRequestException('Confirm the invoiced tuition before discounts.');
 const tuitionMinor=tuition.reduce((n,l)=>n+Number(l.amountMinor),0),commissionMinor=rationalMinor(tuitionMinor,numerator,denominator);
 const components:CommissionComponent[]=[];
 if(commissionMinor>0)components.push({key:'tuition',kind:'commission',sourceLineIndexes:tuition.map(l=>l.index),baseMinor:tuitionMinor,amountMinor:commissionMinor,rateNumerator:numerator,rateDenominator:denominator});
 if(c.cashback.mode!=='none')for(const [index,l] of lines.entries()){
  if(l.kind!=='enrolment')continue;
  if(!Number.isSafeInteger(l.amountMinor)||Number(l.amountMinor)<0)throw new BadRequestException('Check the eligible enrolment fee.');
  if(!l.amountMinor)continue;
  const amountMinor=c.cashback.mode==='fixed_net'?c.cashback.amountMinor:rationalMinor(Number(l.amountMinor),10,11);
  if(amountMinor>0)components.push({key:`enrolment:${index}`,kind:'cashback',sourceLineIndexes:[index],baseMinor:Number(l.amountMinor),amountMinor,rateNumerator:c.cashback.mode==='fixed_net'?0:10,rateDenominator:c.cashback.mode==='fixed_net'?1:11});
 }
 for(const benefit of c.benefits??[]){
  if(benefit.classification&&!facts.classification)throw new ConflictException('Confirm the course classification for this benefit.');
  if(benefit.classification&&benefit.classification!==facts.classification)continue;
  for(const [index,line] of lines.entries()){
   if(line.kind!==benefit.source)continue;
   if(!Number.isSafeInteger(line.amountMinor)||Number(line.amountMinor)<0)throw new BadRequestException('Check the eligible benefit fee.');
   if(!line.amountMinor)continue;
   const amountMinor=benefit.fixedAmountMinor!==undefined?rationalMinor(benefit.fixedAmountMinor,benefit.gstInclusive?10:1,benefit.gstInclusive?11:1):rationalMinor(Number(line.amountMinor),benefit.percentageBasisPoints,benefit.gstInclusive?11000:10000);
   if(amountMinor>0)components.push({key:`${benefit.source}:${index}`,kind:benefit.source==='enrolment'?'cashback':'bonus',sourceLineIndexes:[index],baseMinor:Number(line.amountMinor),amountMinor,rateNumerator:benefit.percentageBasisPoints,rateDenominator:benefit.gstInclusive?11000:10000,itemCode:benefit.itemCode,saleName:benefit.saleName,advisorName:benefit.advisorName??undefined});
  }
 }
 const subtotalMinor=components.reduce((n,c)=>n+c.amountMinor,0);
 if(subtotalMinor>1_000_000_000)throw new BadRequestException('Commission exceeds the supported amount.');
 return {tuitionMinor,basisPoints:numerator*10000/denominator,commissionMinor,subtotalMinor,rateNumerator:numerator,rateDenominator:denominator,rounding:'half_up_per_instalment' as const,components,noRevenue:components.length===0};
}
