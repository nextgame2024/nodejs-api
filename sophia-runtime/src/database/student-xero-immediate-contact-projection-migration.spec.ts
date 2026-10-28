import { readFileSync } from 'node:fs';
import { describe,expect,it } from '@jest/globals';

describe('immediate Xero contact projection',()=>{
  it('allows a provider receipt before the first nightly sync without widening privileges',()=>{
    const sql=readFileSync(new URL('./migrations/103_xero_immediate_contact_projection.sql',import.meta.url),'utf8');
    expect(sql).toContain('student_operations_xero_contacts');
    expect(sql).toContain('ALTER COLUMN last_seen_sync_run_id DROP NOT NULL');
    expect(sql).not.toMatch(/\bGRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)|DROP TABLE|DISABLE ROW LEVEL/i);
  });
});
