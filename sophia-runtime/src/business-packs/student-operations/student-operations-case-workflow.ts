import { BadRequestException } from '@nestjs/common';

export const CASE_STAGES = [
  'imported_pending_review', 'documents_requested', 'checklist_complete',
  'awaiting_payment', 'payment_received', 'invoices_created',
  'payment_monitoring', 'payments_complete',
] as const;
export const NEW_CASE_STAGES = CASE_STAGES.slice(1);
export const CASE_STATUSES = [
  'pre_sale', 'on_hold', 'in_progress', 'payment_overdue',
  'collections', 'payment_done', 'closed',
] as const;
export type CaseStage = typeof CASE_STAGES[number];
export type CaseStatus = typeof CASE_STATUSES[number];

export const ALLOWED_STAGE_STATUSES: Record<CaseStage, readonly CaseStatus[]> = {
  imported_pending_review: ['in_progress'],
  documents_requested: ['pre_sale', 'on_hold'],
  checklist_complete: ['pre_sale'],
  awaiting_payment: ['pre_sale', 'on_hold'],
  payment_received: ['in_progress'],
  invoices_created: ['in_progress'],
  payment_monitoring: ['payment_overdue', 'collections', 'payment_done'],
  payments_complete: ['closed'],
};

export const CASE_STAGE_LABELS: Record<CaseStage, string> = {
  imported_pending_review: 'Imported — Pending Review',
  documents_requested: 'Documents Requested',
  checklist_complete: 'Verified Documents',
  awaiting_payment: 'Awaiting Payment',
  payment_received: 'Payment Received',
  invoices_created: 'Invoices Created',
  payment_monitoring: 'Payment Monitoring',
  payments_complete: 'Payments Complete',
};

export const CASE_STATUS_LABELS: Record<CaseStatus, string> = {
  pre_sale: 'Pre-sale',
  on_hold: 'On hold',
  in_progress: 'In progress',
  payment_overdue: 'Payment overdue',
  collections: 'In collections',
  payment_done: 'Payment complete',
  closed: 'Closed',
};

export function publicCaseStatus(stored: string): CaseStatus | 'cancelled' {
  if (stored === 'open') return 'in_progress';
  if (stored === 'completed') return 'closed';
  return stored as CaseStatus | 'cancelled';
}

export function storedCaseStatus(status: CaseStatus): string {
  return status === 'in_progress' ? 'open' : status;
}

export function resolveCaseWorkflow(
  currentStage: string | null,
  currentStoredStatus: string | null,
  requestedStage?: CaseStage,
  requestedStatus?: CaseStatus,
): { stage: string; status: string } {
  if (currentStage === null) {
    const stage = requestedStage ?? 'documents_requested';
    if (stage === 'imported_pending_review') {
      throw new BadRequestException('Imported — Pending Review is only for migrated cases.');
    }
    const allowed = ALLOWED_STAGE_STATUSES[stage];
    const status = requestedStatus ?? (['documents_requested','awaiting_payment'].includes(stage) ? 'pre_sale' : allowed.length === 1 ? allowed[0] : null);
    if (!status || !allowed.includes(status)) {
      throw new BadRequestException('Select a status allowed for the current stage.');
    }
    return { stage, status: storedCaseStatus(status) };
  }

  if (!requestedStage && !requestedStatus) {
    return { stage: currentStage, status: currentStoredStatus! };
  }
  const stage = requestedStage ?? currentStage;
  if (stage === 'imported_pending_review' && currentStage !== stage) {
    throw new BadRequestException('Imported — Pending Review is only for migrated cases.');
  }
  const allowed = ALLOWED_STAGE_STATUSES[stage as CaseStage];
  if (!allowed) throw new BadRequestException('Select a current workflow stage.');
  const existingStatus = publicCaseStatus(currentStoredStatus!);
  const status = requestedStatus ?? (allowed.includes(existingStatus as CaseStatus)
    ? existingStatus : ['documents_requested','awaiting_payment'].includes(stage) ? 'pre_sale' : allowed.length === 1 ? allowed[0] : null);
  if (!status || !allowed.includes(status as CaseStatus)) {
    throw new BadRequestException('Select a status allowed for the current stage.');
  }
  return { stage, status: storedCaseStatus(status as CaseStatus) };
}
