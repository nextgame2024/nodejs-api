import { readFileSync } from 'node:fs';
import { describe,expect,it } from '@jest/globals';

const sql=readFileSync(new URL('./migrations/101_student_editable_invoice_drafts.sql',import.meta.url),'utf8');
describe('editable Sophia invoice proposals',()=>{
  it('allows only the proposal columns needed for reviewed draft updates',()=>{
    expect(sql).toContain('ADD COLUMN updated_at');
    expect(sql).toContain('ADD COLUMN revision integer NOT NULL DEFAULT 1');
    expect(sql).toContain('GRANT UPDATE(advisor_id,advisor_label,snapshot,actor_identity_user_id,updated_at,revision)');
    expect(sql).not.toContain('GRANT DELETE');
  });
});
