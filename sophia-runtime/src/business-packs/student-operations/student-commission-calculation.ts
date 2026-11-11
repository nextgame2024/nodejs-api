import {createHash} from 'node:crypto';
import {BadRequestException} from '@nestjs/common';

export type CommissionRule={rule_id:string;college_id:string;commission_basis_points:number;calculation_method:string;rounding_decimal_places:number;
  cashback_status:string;bonus_status:string;classification:string|null;location:string|null;program:string|null;application_conditions:string|null;active:boolean;updatedat:Date|string};
export function commissionRuleIssue(rules:CommissionRule[]):string|null{
  const active=rules.filter(r=>r.active);
  if(!active.length)return 'Record an active college commission rule before preparing PTY invoices.';
  // No reliable classification/location/program has been captured for invoice
  // commissions yet. Never pick a general fallback when a specific rule may apply.
  if(active.some(r=>r.classification||r.location||r.program))return 'This college has course or location conditions that need commission review.';
  if(active.length!==1)return 'Resolve the overlapping college commission rules before continuing.';
  const r=active[0];
  if(r.calculation_method!=='tuition_fee_percentage'||r.rounding_decimal_places!==2||!Number.isInteger(r.commission_basis_points)||r.commission_basis_points<=0||r.commission_basis_points>10000)return 'This commission calculation is outside the standard percentage workflow.';
  if(!['not_applicable','not_recorded'].includes(r.cashback_status)||!['not_applicable','not_recorded'].includes(r.bonus_status))return 'Cashback or bonus arrangements require separate commission review.';
  const conditions=(r.application_conditions??'').trim().toLowerCase().replace(/\s+/g,' ');
  if(conditions&&!['trust tuition fees only. excludes enrolment, materials, and other fees.','tuition fees only','tuition fees only.'].includes(conditions))return 'Review the college application conditions before using automatic commission invoicing.';
  return null;
}
export function commissionAmount(lines:Array<{kind?:unknown;amountMinor?:unknown}>,basisPoints:number){
  const tuition=lines.filter(l=>l.kind==='tuition');
  if(!tuition.length||tuition.some(l=>!Number.isSafeInteger(l.amountMinor)||Number(l.amountMinor)<0))throw new BadRequestException('Confirm the TRUST tuition lines before calculating commission.');
  const tuitionMinor=tuition.reduce((n,l)=>n+BigInt(Number(l.amountMinor)),0n);
  if(tuitionMinor<=0n||tuitionMinor>1_000_000_000n||!Number.isInteger(basisPoints)||basisPoints<=0||basisPoints>10000)throw new BadRequestException('Check the tuition base and commission percentage.');
  const commissionMinor=(tuitionMinor*BigInt(basisPoints)+5000n)/10000n;
  if(commissionMinor<=0n)throw new BadRequestException('The calculated commission must be at least one cent.');
  return {tuitionMinor:Number(tuitionMinor),basisPoints,commissionMinor:Number(commissionMinor),rounding:'half_up_per_instalment' as const};
}
function canonical(value:unknown):unknown{
  if(value instanceof Date)return value.toISOString();
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)]));
  return value;
}
export function commissionHash(value:unknown){return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');}
