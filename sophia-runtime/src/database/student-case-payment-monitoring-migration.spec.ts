import {readFileSync} from 'node:fs';
import {describe,expect,it} from '@jest/globals';

describe('case payment-monitoring definitions migration',()=>{
  it('changes constraints only, with no record backfill, invoice mutation or privilege changes',()=>{
    const sql=readFileSync(new URL('./migrations/106_payment_monitoring_case_statuses.sql',import.meta.url),'utf8');
    expect(sql).not.toMatch(/^\s*(UPDATE|INSERT|DELETE|GRANT|REVOKE)\b/im);
    expect(sql).not.toContain('student_operations_xero_invoices');
    expect(sql).toContain("current_stage='payment_monitoring' AND lifecycle_status IN ('awaiting_payment','payment_received'");
    expect(sql).toContain("current_stage='imported_pending_review' AND lifecycle_status='open' AND migration_key IS NOT NULL");
    expect(sql).toContain("current_stage='awaiting_payment' AND lifecycle_status IN ('pre_sale','on_hold')");
    expect(sql).not.toContain("current_stage IN ('payment_received','invoices_created')");
  });
});
