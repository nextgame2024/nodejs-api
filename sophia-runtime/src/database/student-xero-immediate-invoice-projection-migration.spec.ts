import { readFileSync } from 'node:fs';
import { describe,expect,it } from '@jest/globals';

const sql=readFileSync(new URL('./migrations/102_xero_immediate_invoice_projection.sql',import.meta.url),'utf8');
describe('immediate Xero invoice projection',()=>{
  it('allows an interactive provider-confirmed invoice before a register sync run exists',()=>{
    expect(sql).toContain('student_operations_xero_invoices');
    expect(sql).toContain('ALTER COLUMN last_seen_sync_run_id DROP NOT NULL');
    expect(sql).not.toContain('DROP TABLE');
    expect(sql).not.toContain('GRANT DELETE');
  });
});

