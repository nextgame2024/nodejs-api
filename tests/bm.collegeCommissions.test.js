import {describe,test,expect,jest} from '@jest/globals';
import {planCommissions,importCommissions} from '../scripts/import-college-commissions.mjs';
const company='00000000-0000-4000-8000-000000000001';
const id='00000000-0000-4000-8000-000000000002';
const header='acronym,college,classification,location,program,commission,comission_calculation,cashback,cashback_calculation,bonus,aplication_conditions';
const row=(rate='25.00%',classification='',location='',program='',acronym='TEST')=>[acronym,`${id} - Test College`,classification,location,program,rate,'Tuition fee x commission (2 decimals)','Not recorded','No aplica','Not applicable','Tuition only'].join(',');
const parse=(...rows)=>planCommissions([header,...rows].join('\n'));
describe('College commission configuration import',()=>{
  test('preserves exact percentages, unrestricted conditions and unknown benefits',()=>{
    const p=parse(row('31.82%'));
    expect(p.rules[0]).toMatchObject({commissionBasisPoints:3182,classification:null,location:null,program:null,cashbackStatus:'not_recorded',bonusStatus:'not_applicable'});
  });
  test('retains general fallback plus specific rules and consolidates duplicates without losing source rows',()=>{
    const p=parse(row(),row('30.00%','','OFF-SHORE'),row());
    expect(p.rules).toHaveLength(2);expect(p.duplicateRows).toBe(1);expect(p.rules[0].sourceRows).toEqual([2,4]);expect(p.sourceRecords).toHaveLength(3);
  });
  test('keeps different programs as separate rules',()=>{
    expect(parse(row('20%','','','Undergraduate Grupo ECA'),row('15%','','','Postgraduate Grupo ECA')).rules).toHaveLength(2);
  });
  test('imports numeric cashback and bonus while preserving original CSV fields',()=>{
    const input=row().replace('Not recorded,No aplica,Not applicable','Not recorded,15.20,0.00');
    const p=parse(input);expect(p.rules[0]).toMatchObject({cashbackCalculation:'15.20',bonusAmount:'0.00',cashbackStatus:'specified',bonusStatus:'specified'});
    expect(p.sourceRecords[0].cashback_calculation).toBe('15.20');
    expect(()=>parse(input.replace('15.20','15.205'))).toThrow('two decimal places');
    expect(parse(row()).rules[0]).toMatchObject({cashbackCalculation:null,bonusAmount:null});
  });
  test('rejects conflicting rates, acronyms, malformed rates and equally specific overlaps',()=>{
    expect(()=>parse(row(),row('30%'))).toThrow('conflicting');
    expect(()=>parse(row(),row('25%','','','','OTHER'))).toThrow('inconsistent');
    expect(()=>parse(row('101%'))).toThrow('percentage');
    expect(()=>parse(row('31.825%'))).toThrow('percentage');
    expect(()=>parse(row('25%','VET'),row('30%','','OFF-SHORE'))).toThrow('ambiguous');
  });
  test('blank acronym on later rows does not erase an explicit acronym',()=>{
    expect(parse(row(),row('30%','','OFF-SHORE','','')).colleges[0].acronym).toBe('TEST');
  });
  test('preview checks college ownership and performs no writes',async()=>{
    const db={query:jest.fn(async(sql,args)=>{
      if(sql.includes('FROM bm_colleges')) {expect(args).toEqual([company,[id]]);return {rows:[{college_id:id,college_name:'Test College',status:'active',acronym:null}]};}
      return {rows:[]};
    })};
    expect(await importCommissions(db,parse(row()),company)).toMatchObject({mode:'preview',newRules:1});
    expect(db.query.mock.calls[0][0]).toBe('BEGIN READ ONLY');
    expect(db.query.mock.calls.some(([sql])=>/INSERT|UPDATE|DELETE/.test(sql))).toBe(false);
  });
  test('rejects missing or other-company colleges before writing',async()=>{
    const db={query:jest.fn(async()=>({rows:[]}))};
    await expect(importCommissions(db,parse(row()),company,{apply:true,backupPath:'/unused'})).rejects.toThrow('College validation failed');
    expect(db.query.mock.calls.at(-1)[0]).toBe('ROLLBACK');
    expect(db.query.mock.calls.some(([sql])=>/^INSERT|^UPDATE|^DELETE/.test(sql))).toBe(false);
  });
});
