import { readFileSync } from 'node:fs';
import { describe,expect,it } from '@jest/globals';

const sql=readFileSync(new URL('./migrations/100_student_xero_invoice_exports.sql',import.meta.url),'utf8');
describe('student Xero invoice export receipts',()=>{
  it('enforces tenant isolation, one receipt per proposal sequence and no delete grant',()=>{
    expect(sql).toContain('PRIMARY KEY(customer_id,batch_id,sequence)');
    expect(sql).toContain("status IN ('not_attempted','creating','created','review_required')");
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('GRANT SELECT,INSERT,UPDATE');
    expect(sql).not.toContain('GRANT DELETE');
  });
});
