import {describe,test,expect,jest} from '@jest/globals';
import {columns,planCommissionV2,blockedCsv,importCommissionV2} from '../scripts/import-college-commissions-v2.mjs';
import {validateCommissionConfiguration,commissionConditionsOverlap} from '../src/utils/collegeCommissionConfiguration.js';
const id='00000000-0000-4000-8000-000000000001';
const record=(v={})=>({acronym:'',college:`${id} - Fixture College`,site:'',type:'',city:'',program:'',afterDate:'',comissionRate:'30.00%',comissionFormula:'commission_net = ROUND(tuition_amount * 0.3,2)',cashbackFormula:'cashback_net = 0',bonus:'bonus_net=0; support_net=0',conditions:'',...v});
const csv=(...rs)=>[columns,...rs.map(r=>columns.map(k=>r[k]))].map(row=>row.map(v=>'"'+v.replaceAll('"','""')+'"').join(',')).join('\n');
describe('Reviewed v2 college import',()=>{
 test('compiles exact gross ratios and source-line cashback without evaluating prose',()=>{
  const plan=planCommissionV2(csv(record({comissionRate:'31.82%',comissionFormula:'Commission=ROUND(Tuition*(0.35/1.10),2)',cashbackFormula:'Cashback=ROUND(Enrolment/1.10,2)'})));
  expect(plan.rules[0].configuration).toMatchObject({rateNumerator:7,rateDenominator:22,state:'ready',cashback:{mode:'enrolment_gross'}});
  expect(plan.sourceRecords[0].comissionRate).toBe('31.82%');
 });
 test('unknown formula becomes a visible blocker, never a display-rate fallback',()=>{
  const plan=planCommissionV2(csv(record({comissionFormula:'throw new Error("must not execute")'})));
  expect(plan.blocked).toHaveLength(1);expect(plan.rules[0].configuration.state).toBe('blocked');
  expect(blockedCsv(plan).split('\r\n')[0]).toBe('\uFEFF'+columns.concat('reason').map(v=>'"'+v+'"').join(','));
 });
 test('preserves Kent/KOI classifications and rejects indistinguishable duplicate rules',()=>{
  const p=planCommissionV2(csv(record({type:'VET'}),record({type:'HE'})));
  expect(p.rules.map(r=>r.classification)).toEqual(['VET','HE']);
  expect(()=>planCommissionV2(csv(record(),record()))).toThrow('overlapping');
 });
 test('rejects invalid dates, malformed IDs and percentage/formula disagreement',()=>{
  expect(()=>planCommissionV2(csv(record({afterDate:'31/02/2025'})))).toThrow('invalid date');
  expect(()=>planCommissionV2(csv(record({college:'not an id'})))).toThrow('UUID');
  expect(()=>planCommissionV2(csv(record({comissionRate:'40%'})))).toThrow('disagree');
 });
 test('unknown required benefits are retained as blocked configurations',()=>{
  const p=planCommissionV2(csv(record({bonus:'Bonus based on an unknown agreement'})));
  expect(p.rules[0].original.bonus).toBe('Bonus based on an unknown agreement');expect(p.blocked[0].reason).toContain('silently omitted');
 });
 test('validates exact ratios, blocked state and date semantics',()=>{
  const c=planCommissionV2(csv(record())).rules[0].configuration;
  expect(()=>validateCommissionConfiguration({...c,rateDenominator:0})).toThrow();
  expect(()=>validateCommissionConfiguration({...c,state:'blocked'})).toThrow();
  expect(()=>validateCommissionConfiguration({...c,effectiveFrom:'2025-04-01'})).toThrow();
  expect(commissionConditionsOverlap({classification:'VET'},{location:'ON-SHORE',program:'Diploma'})).toBe(true);
 });
 test('dry-run is read-only, includes blocked rows and preserves out-of-scope configuration',async()=>{
  const plan=planCommissionV2(csv(record())),db={query:jest.fn(async(sql)=>({rows:sql.includes('SELECT college_id,status')?[{college_id:id,status:'active'}]:sql.includes('count(*)')?[{count:2}]:[]}))};
  const summary=await importCommissionV2(db,plan,id);
  expect(summary).toMatchObject({mode:'preview',create:1,archive:0,retain:0,unrelatedRulesRetained:2});
  expect(db.query.mock.calls[0][0]).toBe('BEGIN READ ONLY');expect(db.query.mock.calls.some(([s])=>/^(INSERT|UPDATE|DELETE)/.test(s))).toBe(false);
 });
 test('apply without a reviewed digest/backup fails before DB access',async()=>{
  const db={query:jest.fn()};await expect(importCommissionV2(db,planCommissionV2(csv(record())),id,{apply:true})).rejects.toThrow('backup');expect(db.query).not.toHaveBeenCalled();
 });
});
