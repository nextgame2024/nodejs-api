import {describe,it,expect} from '@jest/globals';
import {calculateCommission,commissionFacts,rationalMinor,selectCommissionRule,type CommissionConfiguration} from './student-commission-rules.js';
import type {CommissionRule} from './student-commission-calculation.js';
import {buildCommissionV2,commissionSourceLines} from './student-commission-invoice-v2.js';
const config=(v:Partial<CommissionConfiguration>={}):CommissionConfiguration=>({version:2,state:'ready',blockedReason:null,city:null,effectiveFrom:null,effectiveTo:null,dateBasis:null,rateNumerator:3,rateDenominator:10,rateMethod:'fixed',laterRateNumerator:0,nonBulkOnly:false,cashback:{mode:'none',amountMinor:0},...v});
const rule=(v:Partial<CommissionRule>={},c:Partial<CommissionConfiguration>={}):CommissionRule=>({rule_id:'r',college_id:'college',classification:null,location:null,program:null,active:true,commission_basis_points:3000,calculation_method:'tuition_fee_percentage',rounding_decimal_places:2,cashback_status:'not_applicable',bonus_status:'not_applicable',application_conditions:null,updatedat:'2026-11-24T00:00:00Z',configuration:config(c),...v});
const tuition={kind:'tuition',amountMinor:72000,itemCode:'ELICOS ON-SHORE',quantity:'5',unitAmountMinor:14400,accountCode:'812',taxType:'BASEXCLUDED',description:'Anonymized tuition'};
describe('Versioned commission selection and calculation',()=>{
 it('selects Kent VET/HE and allows an unrestricted KOI rate',()=>{
  const vet=rule({rule_id:'vet',classification:'VET'}),he=rule({rule_id:'he',classification:'HE'},{rateNumerator:2});
  expect(selectCommissionRule([vet,he],{classification:'HE'})).toBe(he);
  expect(()=>selectCommissionRule([vet,he],{})).toThrow('Complete the course');
  expect(selectCommissionRule([rule()],{}).rule_id).toBe('r');
 });
 it('uses specific rules only with sufficient facts and ignores impossible candidates',()=>{
  const general=rule({rule_id:'general'}),special=rule({rule_id:'special',classification:'ELICOS',program:'General English'});
  expect(()=>selectCommissionRule([general,special],{classification:'ELICOS'})).toThrow('Complete');
  expect(selectCommissionRule([general,special],{classification:'VET'})).toBe(general);
  expect(selectCommissionRule([general,special],{classification:'ELICOS',program:'general english'})).toBe(special);
 });
 it('blocks incomparable overlaps even with different condition counts',()=>{
  const a=rule({classification:'VET',program:'Diploma'}),b=rule({location:'ON-SHORE'});
  expect(()=>selectCommissionRule([a,b],{classification:'VET',program:'Diploma',location:'ON-SHORE'})).toThrow('Multiple');
 });
 it('cannot fall back past a matching blocked special contract',()=>{
  const blocked=rule({classification:'VET'},{state:'blocked',blockedReason:'Confirm benefit eligibility.'});
  expect(()=>selectCommissionRule([rule(),blocked],{classification:'VET'})).toThrow('Confirm benefit');
 });
 it('uses complementary inclusive Macallan enrolment intervals, not invoice date',()=>{
  const old=rule({rule_id:'old'},{effectiveTo:'2025-03-31',dateBasis:'enrolment_date'}),current=rule({rule_id:'new'},{rateNumerator:4,effectiveFrom:'2025-04-01',dateBasis:'enrolment_date'});
  expect(selectCommissionRule([old,current],{enrolmentDate:'2025-03-31'})).toBe(old);
  expect(selectCommissionRule([old,current],{enrolmentDate:'2025-04-01'})).toBe(current);
  expect(selectCommissionRule([old,current],{enrolmentDate:'2025-12-01'})).toBe(current);
  expect(()=>selectCommissionRule([old,current],{})).toThrow('original enrolment');
 });
 it('uses exact gross-derived rates and half-up cents instead of rounded display rates',()=>{
  expect(rationalMinor(1000000,35,110)).toBe(318182);
  expect(rationalMinor(1000000,3182,10000)).toBe(318200);
  expect(rationalMinor(1,1,2)).toBe(1);
  expect(()=>rationalMinor(-1,3,10)).toThrow();
 });
 it('adds cashback independently per eligible source line and excludes unrelated fees',()=>{
  const r=rule({}, {cashback:{mode:'enrolment_gross',amountMinor:0}});
  const result=calculateCommission(r,[tuition,{kind:'enrolment',amountMinor:20000},{kind:'materials',amountMinor:5000},{kind:'agency_discount',amountMinor:-10000}],{});
  expect(result).toMatchObject({tuitionMinor:72000,commissionMinor:21600,subtotalMinor:39782});
  expect(result.components[1]).toMatchObject({key:'enrolment:1',amountMinor:18182,sourceLineIndexes:[1]});
  expect(calculateCommission(r,[tuition],{}).components).toHaveLength(1);
 });
 it('uses fixed NET Aura cashback regardless of fee magnitude and does not pay zero fees',()=>{
  const r=rule({}, {cashback:{mode:'fixed_net',amountMinor:18182}});
  expect(calculateCommission(r,[tuition,{kind:'enrolment',amountMinor:5000}],{}).components[1].amountMinor).toBe(18182);
  expect(calculateCommission(r,[tuition,{kind:'enrolment',amountMinor:0}],{}).components).toHaveLength(1);
 });
 it.each([[1,14400],[2,14400],[3,10800],[4,10800],[5,0]])('handles JMC trimester %s', (trimester,commissionMinor)=>{
  expect(calculateCommission(rule({}, {rateMethod:'trimester',rateNumerator:2}),[tuition],{trimester})).toMatchObject({commissionMinor,noRevenue:commissionMinor===0});
 });
 it('requires known trimester/month/bulk status and keeps year/month rules independent',()=>{
  expect(()=>calculateCommission(rule({}, {rateMethod:'trimester',rateNumerator:2}),[tuition],{})).toThrow('trimester');
  const r=rule({}, {rateMethod:'first_month',rateNumerator:20,rateDenominator:100,laterRateNumerator:15});
  expect(calculateCommission(r,[tuition],{courseMonth:1}).commissionMinor).toBe(14400);
  expect(calculateCommission(r,[tuition],{courseMonth:2}).commissionMinor).toBe(10800);
  expect(()=>calculateCommission(r,[tuition],{})).toThrow('course month');
  expect(()=>calculateCommission(rule({}, {nonBulkOnly:true}),[tuition],{})).toThrow('non-bulk');
  expect(()=>calculateCommission(rule({}, {nonBulkOnly:true}),[tuition],{isBulk:true})).toThrow('non-bulk');
 });
 it('derives facts from TRUST and rejects contradictory or mixed course items',()=>{
  expect(commissionFacts([tuition],{})).toEqual({classification:'ELICOS',location:'ON-SHORE'});
  expect(()=>commissionFacts([tuition],{classification:'VET'})).toThrow('agree');
  expect(()=>commissionFacts([tuition,{...tuition,itemCode:'VET OFF-SHORE'}],{})).toThrow('one course');
 });
 it('keeps separate-discount invoiced tuition even if an old offer base differs',()=>{
  const invoice:any={commissionTuitionMinor:80000,lines:[tuition,{kind:'agency_discount',amountMinor:-5000}]};
  expect(commissionSourceLines(invoice)[0].amountMinor).toBe(72000);
  expect(commissionSourceLines({...invoice,lines:[{...tuition,amountMinor:67000}]} as any)[0].amountMinor).toBe(80000);
 });
});
describe('PTY v2 component payload',()=>{
 const item=(itemId:string,code:string)=>({itemId,code,name:code,accountCode:'200',taxType:'OUTPUT',unitPrice:null,description:null});
 const catalogue:any={items:[item('tuition','ELICOS ON-SHORE'),item('cashback','CASH BACK')],accounts:[{code:'200',name:'Sales Commissions',taxType:'OUTPUT'}],taxRates:[{taxType:'OUTPUT',name:'GST on Income',rate:'10'}],trackingCategories:[{trackingCategoryId:'sales',name:'Type of Sale',options:[{trackingOptionId:'inst',name:'Instalment'},{trackingOptionId:'cash',name:'Cash Back'}]}]};
 const invoice:any={sequence:1,issueDate:'2026-11-24',dueDate:'2026-12-01',lines:[tuition,{...tuition,kind:'enrolment',itemCode:'Enrolment fee',amountMinor:20000,quantity:'1'}]};
 const input:any={rules:[rule({}, {cashback:{mode:'enrolment_gross',amountMinor:0}})],context:{},invoice,batch:{studentName:'Fixture Student',advisorName:'Fixture Advisor',currency:'AUD'},catalogue,connectionId:'PTY',catalogueRevision:1,contactId:'contact',mappingRevision:1,collegeId:'college',collegeName:'Fixture College',brandingThemeId:'theme'};
 it('produces two positive revenue lines with exact quantities, source lineage and tax',()=>{
  const s=buildCommissionV2(input);
  expect(s.value.lines).toEqual([expect.objectContaining({itemCode:'ELICOS ON-SHORE',quantity:'5',unitAmount:'43.20'}),expect.objectContaining({itemCode:'CASH BACK',quantity:'1',unitAmount:'181.82'})]);
  expect(s.value.lines[1].tracking[0].option).toBe('Cash Back');
  expect(s).toMatchObject({taxMinor:3978,totalMinor:43760,noRevenue:false});
  expect(s.calculation.components[1]).toMatchObject({itemId:'cashback',sourceLineIndexes:[1]});
 });
 it('refuses an unavailable tax mapping instead of applying a global fallback',()=>{
  const c=structuredClone(catalogue);c.items[1].taxType=null;
  expect(()=>buildCommissionV2({...input,catalogue:c})).toThrow('tax default');
 });
 it('does not construct an empty provider invoice for a legitimate zero rule',()=>{
  const s=buildCommissionV2({...input,rules:[rule({}, {rateNumerator:0})]});
  expect(s.noRevenue).toBe(true);expect(s.value.lines).toEqual([]);expect(s.totalMinor).toBe(0);
 });
 it('uses current advisor tracking when available, and rejects mismatches',()=>{
  const c=structuredClone(catalogue);c.trackingCategories.push({trackingCategoryId:'rep',name:'Sales Representative',options:[{trackingOptionId:'advisor',name:'Fixture Advisor'}]});
  expect(buildCommissionV2({...input,catalogue:c}).value.lines[1].tracking[1].trackingOptionId).toBe('advisor');
  expect(()=>buildCommissionV2({...input,catalogue:c,batch:{...input.batch,advisorName:'Unmapped'}})).toThrow('Map the invoice advisor');
 });
});
