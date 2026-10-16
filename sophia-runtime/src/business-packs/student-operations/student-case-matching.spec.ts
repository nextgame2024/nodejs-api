import { collegeSimilarity,matchCollege } from './student-case-matching.js';
import { buildCasePlan } from '../../../scripts/migrate-student-cases.js';
describe('Case migration decisions',()=>{
  test('normalizes casing but keeps weak and ambiguous college matches unresolved',()=>{
    expect(collegeSimilarity('YORK BUSINESS','York Business')).toBe(1);
    expect(matchCollege('York Busines',[{college_id:'1',college_name:'York Business'}]).match?.college_id).toBe('1');
    expect(matchCollege('Visa',[{college_id:'1',college_name:'York Business'}]).match).toBeNull();
    expect(matchCollege('York Business',[{college_id:'1',college_name:'York Business'},{college_id:'2',college_name:'YORK BUSINESS'}]).reason).toBe('ambiguous_match');
  });
  test('creates one plan per student and chooses earliest invoice advisor; reports unlinked invoices',()=>{
    const base={xero_connection_id:'connection',xero_contact_id:'contact',invoice_number:null,invoice_type:'ACCREC',invoice_status:'PAID',college_name:null,invoice_reference:'York Business'};
    const plan=buildCasePlan([{user_id:'u',student_reference:'STD-1',profile_id:null,account_status:'active'}],[
      {...base,xero_invoice_id:'b',student_id:'STD-1',invoice_date:'2025-01-01',advisor_name:'Second'},
      {...base,xero_invoice_id:'a',student_id:'STD-1',invoice_date:'2024-01-01',advisor_name:'S15 First'},
      {...base,xero_invoice_id:'c',student_id:null,invoice_date:'2024-01-01',advisor_name:null},
      {...base,xero_invoice_id:'d',student_id:'STD-1',invoice_date:'2023-01-01',advisor_name:'Wrong',invoice_status:'VOIDED'},
    ],[{college_id:'c',college_name:'York Business'}],[{user_id:'advisor',display_name:'First'}]);
    expect(plan.cases).toHaveLength(1);
    expect(plan.cases[0].invoices).toHaveLength(2);
    expect(plan.cases[0].advisorUserId).toBe('advisor');
    expect(plan.cases[0].college?.college_id).toBe('c');
    expect(plan.unlinked).toHaveLength(1);
    expect(plan.excludedTransactions).toBe(1);
  });
});
