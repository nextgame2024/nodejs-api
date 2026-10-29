import { describe, expect, it } from '@jest/globals';
import { ALLOWED_STAGE_STATUSES, CASE_STAGES, resolveCaseWorkflow } from './student-operations-case-workflow.js';

describe('Student case workflow', () => {
  it('defaults new cases to Documents Requested and never permits the imported stage', () => {
    expect(resolveCaseWorkflow(null, null)).toEqual({ stage: 'documents_requested', status: 'pre_sale' });
    expect(resolveCaseWorkflow(null, null, 'payment_monitoring','payment_received')).toEqual({ stage: 'payment_monitoring', status: 'payment_received' });
    expect(() => resolveCaseWorkflow(null, null, 'imported_pending_review')).toThrow('only for migrated');
    expect(() => resolveCaseWorkflow(null, null, 'documents_requested', 'in_progress')).toThrow('allowed for the current stage');
    expect(() => resolveCaseWorkflow(null, null, 'payment_monitoring')).toThrow('Select a status');
  });

  it('keeps the migration stage one-way and switches to the normal flow', () => {
    expect(resolveCaseWorkflow('imported_pending_review', 'open', 'checklist_complete')).toEqual({
      stage: 'checklist_complete', status: 'pre_sale',
    });
    expect(() => resolveCaseWorkflow('checklist_complete', 'pre_sale', 'imported_pending_review')).toThrow('only for migrated');
    expect(() => resolveCaseWorkflow('imported_pending_review', 'open', undefined, 'on_hold')).toThrow('allowed for the current stage');
  });
  it('removes retired stages and limits In progress to Imported — Pending Review',()=>{
    expect(CASE_STAGES).not.toContain('payment_received');expect(CASE_STAGES).not.toContain('invoices_created');
    expect(CASE_STAGES.filter(stage=>ALLOWED_STAGE_STATUSES[stage].includes('in_progress'))).toEqual(['imported_pending_review']);
    for(const retired of ['payment_received','invoices_created'])expect(()=>resolveCaseWorkflow(null,null,retired as never)).toThrow('current workflow stage');
    expect(resolveCaseWorkflow('awaiting_payment','pre_sale','payment_monitoring','awaiting_payment')).toEqual({stage:'payment_monitoring',status:'awaiting_payment'});
    expect(()=>resolveCaseWorkflow('awaiting_payment','pre_sale','awaiting_payment','payment_received')).toThrow('allowed for the current stage');
  });

  it('validates every stage/status combination', () => {
    expect(Object.keys(ALLOWED_STAGE_STATUSES)).toEqual([...CASE_STAGES]);
    for (const stage of CASE_STAGES) {
      for (const status of ALLOWED_STAGE_STATUSES[stage]) {
        expect(resolveCaseWorkflow(stage, status === 'in_progress' ? 'open' : status, stage, status)).toEqual({
          stage, status: status === 'in_progress' ? 'open' : status,
        });
      }
    }
    expect(() => resolveCaseWorkflow('awaiting_payment', 'pre_sale', undefined, 'payment_done')).toThrow('allowed for the current stage');
    expect(resolveCaseWorkflow('imported_pending_review', 'open', 'awaiting_payment')).toEqual({ stage: 'awaiting_payment', status: 'pre_sale' });
    expect(() => resolveCaseWorkflow('payment_monitoring', 'payment_overdue', 'payments_complete', 'payment_done')).toThrow('allowed for the current stage');
    expect(() => resolveCaseWorkflow('invoices_created', 'open', 'payment_monitoring')).toThrow('Select a status');
    expect(resolveCaseWorkflow('invoices_created', 'open', 'payment_monitoring', 'collections')).toEqual({
      stage: 'payment_monitoring', status: 'collections',
    });
  });
});
