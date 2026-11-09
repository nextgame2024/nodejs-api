import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';
const query=jest.fn(), connect=jest.fn();
jest.unstable_mockModule('../src/config/db.js',()=>({default:{query,connect}}));
jest.unstable_mockModule('../src/middlewares/authJwt.js',()=>({authRequired:(req,res,next)=>{
  if(req.headers.authorization!=='Bearer test')return res.status(401).json({error:'Authorization required'});
  req.user={companyId:'company'};next();
}}));
const {validateCommission,assertUnambiguousCommission,listCommissions,saveCommission}=await import('../src/models/bm.collegeCommissions.model.js');
const {default:router}=await import('../src/routes/bm.colleges.routes.js');
const app=express();app.use(express.json());app.use(router);
const value={classification:null,location:null,program:null,commission_basis_points:2500,cashback_status:'not_recorded',bonus_status:'not_applicable'};
const stamp='2026-11-08T10:00:00.000Z';
beforeEach(()=>{query.mockReset();connect.mockReset();});
describe('College commission API rules',()=>{
  test('HTTP endpoint requires authentication and uses the authenticated company for reads',async()=>{
    const url='/bm/colleges/00000000-0000-4000-8000-000000000001/commissions';
    expect((await request(app).get(url)).status).toBe(401);expect(query).not.toHaveBeenCalled();
    query.mockResolvedValueOnce({rows:[{}]}).mockResolvedValueOnce({rows:[]});
    const response=await request(app).get(`${url}?company_id=other`).set('Authorization','Bearer test');
    expect(response.status).toBe(200);expect(response.body).toEqual({rules:[]});
    expect(query.mock.calls[0][1]).toEqual(['company','00000000-0000-4000-8000-000000000001']);
  });
  test('HTTP endpoint rejects client tenant fields and missing revision before database writes',async()=>{
    const url='/bm/colleges/00000000-0000-4000-8000-000000000001/commissions';
    const response=await request(app).post(url).set('Authorization','Bearer test').send({rule:{...value,company_id:'other'}});
    expect(response.status).toBe(400);
    const archived=await request(app).delete(`${url}/00000000-0000-4000-8000-000000000002`).set('Authorization','Bearer test').send({rule:{}});
    expect(archived.status).toBe(400);expect(connect).not.toHaveBeenCalled();
  });
  test('validates percentages and rejects client authority/provenance fields',()=>{
    expect(validateCommission({...value,program:'  Undergraduate   Grupo ECA  '})).toMatchObject({program:'Undergraduate Grupo ECA',commission_basis_points:2500});
    for(const rate of [-1,10001,31.82,'2500']) expect(()=>validateCommission({...value,commission_basis_points:rate})).toThrow();
    for(const extra of [{company_id:'other'},{active:false},{import_id:'fake'},{calculation_method:'other'}]) expect(()=>validateCommission({...value,...extra})).toThrow();
    expect(()=>validateCommission({...value,cashback_status:'specified'})).toThrow('numeric value');
  });
  test('preserves two-decimal benefits and distinguishes zero from unspecified',()=>{
    expect(validateCommission(value)).toMatchObject({cashback_calculation:null,bonus_amount:null});
    expect(validateCommission({...value,cashback_status:'specified',cashback_calculation:'12.30',bonus_status:'specified',bonus_amount:0}))
      .toMatchObject({cashback_calculation:'12.30',bonus_amount:'0.00'});
    for(const amount of ['12.345',-1,'NaN','Infinity','1000000000000',{},true]) {
      expect(()=>validateCommission({...value,cashback_status:'specified',cashback_calculation:amount})).toThrow('two decimal places');
    }
    expect(()=>validateCommission({...value,bonus_amount:'1.00'})).toThrow('Choose Specified');
  });
  test('permits default/specific exceptions but rejects duplicate or equally specific intersecting conditions',()=>{
    expect(()=>assertUnambiguousCommission({...value,location:'OFF-SHORE'},[value])).not.toThrow();
    expect(()=>assertUnambiguousCommission(value,[value])).toThrow('same specificity');
    expect(()=>assertUnambiguousCommission({...value,classification:'VET'},[{...value,location:'OFF-SHORE'}])).toThrow();
    expect(()=>assertUnambiguousCommission({...value,program:'APIC Undergraduate'},[{...value,program:'APIC Postgraduate'}])).not.toThrow();
    expect(()=>assertUnambiguousCommission({...value,program:'apic undergraduate'},[{...value,program:'APIC Undergraduate'}])).toThrow();
  });
  test('does not read rules when parent is outside the company',async()=>{
    query.mockResolvedValueOnce({rows:[]});
    expect(await listCommissions('company','college')).toBeNull();expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toEqual(['company','college']);
  });
  test('replacement archives original and inserts a new version under the locked company/college',async()=>{
    const db={query:jest.fn(async sql=>({rows:sql.includes('SELECT college_id')?[{}]:sql.includes('SELECT rule_id')?[{rule_id:'old',updatedat:stamp}]:sql.includes('INSERT')?[{ruleId:'new'}]:[]})),release:jest.fn()};connect.mockResolvedValueOnce(db);
    const edit=validateCommission({...value,cashback_status:'specified',cashback_calculation:'12.30',bonus_status:'specified',bonus_amount:'0.00',expected_updated_at:stamp},true);
    expect(await saveCommission('company','college','old',edit)).toEqual({ruleId:'new'});
    expect(db.query.mock.calls[1][0]).toContain('FOR UPDATE');expect(db.query.mock.calls[1][1]).toEqual(['company','college']);
    const archived=db.query.mock.calls.find(([sql])=>sql.startsWith('UPDATE'));
    expect(archived[1]).toEqual(['company','college','old']);
    const inserted=db.query.mock.calls.find(([sql])=>sql.includes('INSERT'));
    expect(inserted[1].slice(0,2)).toEqual(['company','college']);
    expect(inserted[1].slice(-2)).toEqual(['12.30','0.00']);
    expect(db.query.mock.calls.at(-1)[0]).toBe('COMMIT');expect(db.release).toHaveBeenCalled();
  });
  test('stale edits roll back before any rule write',async()=>{
    const db={query:jest.fn(async sql=>({rows:sql.includes('SELECT college_id')?[{}]:sql.includes('SELECT rule_id')?[{rule_id:'old',updatedat:stamp}]:[]})),release:jest.fn()};connect.mockResolvedValueOnce(db);
    await expect(saveCommission('company','college','old',{...value,expected_updated_at:'2020-01-01'})).rejects.toMatchObject({code:'COMMISSION_CONFLICT'});
    expect(db.query.mock.calls.some(([sql])=>sql.startsWith('UPDATE')||sql.includes('INSERT'))).toBe(false);
    expect(db.query.mock.calls.at(-1)[0]).toBe('ROLLBACK');
  });
  test('another company cannot mutate the college',async()=>{
    const db={query:jest.fn(async()=>({rows:[]})),release:jest.fn()};connect.mockResolvedValueOnce(db);
    expect(await saveCommission('other','college',null,value)).toBeNull();expect(db.query.mock.calls.at(-1)[0]).toBe('ROLLBACK');expect(db.query).toHaveBeenCalledTimes(3);
  });
});
