import {describe,expect,it,jest} from '@jest/globals';
import {commissionAmount,commissionHash,commissionRuleIssue,type CommissionRule} from './student-commission-calculation.js';
import {StudentCommissionInvoicesController} from './student-commission-invoices.controller.js';
const rule:CommissionRule={rule_id:'rule',college_id:'college',commission_basis_points:3000,calculation_method:'tuition_fee_percentage',rounding_decimal_places:2,cashback_status:'not_recorded',bonus_status:'not_applicable',classification:null,location:null,program:null,application_conditions:'TRUST tuition fees only. Excludes Enrolment, Materials, and Other Fees.',active:true,updatedat:'2026-11-11T00:00:00Z'};
describe('standard college commissions',()=>{
 it('calculates 30 percent of tuition and excludes every other charge',()=>{
  expect(commissionAmount([{kind:'tuition',amountMinor:1_000_000},{kind:'enrolment',amountMinor:20000},{kind:'materials',amountMinor:5000},{kind:'other',amountMinor:10000}],3000)).toEqual({tuitionMinor:1_000_000,basisPoints:3000,commissionMinor:300000,rounding:'half_up_per_instalment'});
 });
 it('sums tuition before rounding once per instalment',()=>{
  expect(commissionAmount([{kind:'tuition',amountMinor:1},{kind:'tuition',amountMinor:1}],3000).commissionMinor).toBe(1);
  expect(commissionAmount([{kind:'tuition',amountMinor:157500}],3000).commissionMinor).toBe(47250);
 });
 it('uses exact integer cents including half-cent boundaries',()=>{
  expect(commissionAmount([{kind:'tuition',amountMinor:5}],1000).commissionMinor).toBe(1);
  expect(commissionAmount([{kind:'tuition',amountMinor:999999999}],3182).commissionMinor).toBe(318200000);
 });
 it.each([[],[{kind:'materials',amountMinor:100}],[{kind:'tuition',amountMinor:-1}],[{kind:'tuition',amountMinor:1.5}],[{kind:'tuition'}]].map(lines=>({lines})))('rejects an invalid tuition base %j',({lines})=>{expect(()=>commissionAmount(lines,3000)).toThrow();});
 it('accepts Not recorded as no benefit under the confirmed initial policy',()=>{expect(commissionRuleIssue([rule])).toBeNull();});
 it.each([{cashback_status:'specified'},{bonus_status:'specified'},{classification:'ELICOS'},{location:'ON-SHORE'},{program:'Special program'},{application_conditions:'Only after full payment'},{rounding_decimal_places:4},{commission_basis_points:0}])('blocks unsupported or conditional rules %j',change=>{expect(commissionRuleIssue([{...rule,...change}])).toBeTruthy();});
 it('does not silently choose a general rule when specific rules exist',()=>{expect(commissionRuleIssue([rule,{...rule,rule_id:'specific',classification:'ELICOS'}])).toBeTruthy();});
 it('rejects missing and ambiguous rules',()=>{expect(commissionRuleIssue([])).toBeTruthy();expect(commissionRuleIssue([rule,rule])).toBeTruthy();});
 it('hashes database JSON consistently regardless of key order',()=>{expect(commissionHash({b:[{x:1,y:2}],a:'date'})).toBe(commissionHash({a:'date',b:[{y:2,x:1}]}));});
});
describe('paired invoice ordering',()=>{
 const request={studentOperationsPrincipal:{tenantId:'tenant',identityUserId:'actor',role:'chief_executive'}} as never;
 it('drains the TRUST phase before PTY and keeps partial results',async()=>{
  const order:string[]=[],trust={createXero:jest.fn(async()=>{order.push('trust');return {created:1,skipped:1,results:[]};})},commissions={create:jest.fn(async()=>{expect(order).toEqual(['trust']);order.push('pty');return {created:1,skipped:1,results:[]};})};
  const controller=new StudentCommissionInvoicesController(commissions as never,trust as never);
  const result=await controller.createPaired(request,'case','batch',{trustSequences:[1,2],ptySequences:[1,2],confirmed:true});
  expect(order).toEqual(['trust','pty']);expect(result.trust.created).toBe(1);expect(result.pty.created).toBe(1);
 });
 it('does not reach PTY if TRUST authorization or validation fails',async()=>{
  const trust={createXero:jest.fn(async()=>{throw new Error('denied');})},commissions={create:jest.fn()};
  await expect(new StudentCommissionInvoicesController(commissions as never,trust as never).createPaired(request,'case','batch',{trustSequences:[1],ptySequences:[1],confirmed:true})).rejects.toThrow('denied');expect(commissions.create).not.toHaveBeenCalled();
 });
});
