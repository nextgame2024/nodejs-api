import { describe, expect, it, jest } from '@jest/globals';
import type { DatabaseService } from '../../database/database.service.js';
import { StudentOperationsCasesService } from './student-operations-cases.service.js';
import type { StudentOperationsWorkspacePrincipal } from './student-operations-workspace.service.js';

describe('Case view data', () => {
  it('loads tenant-scoped advisor and college edit choices only for case managers', async () => {
    const tenantId = '11111111-1111-4111-8111-111111111111';
    const queries: string[] = [];
    const db = { query: jest.fn(async (sql: string) => {
      queries.push(sql);
      return { rows: sql.includes('advisor_directory') ? [{ advisorId: 'advisor-1', code: 'S15', name: 'Advisor One', xeroLabel: 'S15 Advisor One' }] : [{ collegeId: 'college-1', name: 'College One' }] };
    }) };
    const database = { tenantReadTransaction: async (_tenant: string, work: (client: typeof db) => Promise<unknown>) => work(db) } as unknown as DatabaseService;
    const principal: StudentOperationsWorkspacePrincipal = {
      tenantId, externalCompanyId: tenantId, identityUserId: tenantId,
      entitlementId: tenantId, role: 'chief_executive', authorizationRevision: 1,
    };
    const service = new StudentOperationsCasesService(database);
    expect(await service.editOptions(principal)).toEqual({
      advisors: [{ advisorId: 'advisor-1', code: 'S15', name: 'Advisor One', xeroLabel: 'S15 Advisor One' }],
      colleges: [{ collegeId: 'college-1', name: 'College One' }],
    });
    expect(queries).toHaveLength(2);
    expect(queries.every(sql => sql.includes('customer_id=$1'))).toBe(true);
    await expect(service.editOptions({ ...principal, role: 'advisor' })).rejects.toThrow('Case management permission required');
  });
  it('returns invoice reference and payment track only to roles with full payment access', async () => {
    const tenantId = '11111111-1111-4111-8111-111111111111';
    const caseId = '22222222-2222-4222-8222-222222222222';
    const queries: string[] = [];
    const db = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes('student_operations_student_user_links')) {
          return { rows: [{ case_id: caseId, student_id: '33333333-3333-4333-8333-333333333333',
            student_reference: 'STD-1' }] };
        }
        if (sql.includes('WITH invoice_ids')) {
          return { rows: [{ invoiceId: 'invoice-1', invoiceNumber: 'INV-8602', status: 'PAID',
            ...(sql.includes(' AS reference') ? { reference: 'ECA COLLEGE', paymentTrack: 'Pending' } : {}) }] };
        }
        if (sql.includes('count(*)::int total')) return { rows: [{ total: 1 }] };
        return { rows: [] };
      }),
    };
    const database = { tenantReadTransaction: async (_tenant: string, work: (client: typeof db) => Promise<unknown>) => work(db) } as unknown as DatabaseService;
    const principal: StudentOperationsWorkspacePrincipal = {
      tenantId, externalCompanyId: tenantId, identityUserId: tenantId,
      entitlementId: tenantId, role: 'chief_executive', authorizationRevision: 1,
    };
    const service = new StudentOperationsCasesService(database);
    const full = await service.invoices(principal, caseId, {});
    expect(full.invoices[0]).toMatchObject({ reference: 'ECA COLLEGE', paymentTrack: 'Pending' });
    expect(queries.find(sql => sql.includes('WITH invoice_ids'))).toContain(' AS "paymentTrack"');

    queries.length = 0;
    const limited = await service.invoices({ ...principal, role: 'advisor' }, caseId, {});
    expect(limited.invoices[0]).not.toHaveProperty('reference');
    expect(limited.invoices[0]).not.toHaveProperty('paymentTrack');
    expect(queries.find(sql => sql.includes('WITH invoice_ids'))).not.toContain(' AS reference');
  });
  it('authorizes the case before returning its student identity and related details', async () => {
    const tenantId = '11111111-1111-4111-8111-111111111111';
    const caseId = '22222222-2222-4222-8222-222222222222';
    const studentId = '33333333-3333-4333-8333-333333333333';
    const queries: string[] = [];
    const db = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes('JOIN sophia_runtime.student_operations_student_user_links')) {
          return { rows: [{ case_id: caseId, case_reference: 'CASE-1', student_id: studentId,
            user_id: '44444444-4444-4444-8444-444444444444', student_reference: 'STD-1',
            lifecycle_status: 'open', current_stage: 'imported_pending_review',
            opened_on: '2026-10-16', created_at: '2026-10-16', updated_at: '2026-10-16' }] };
        }
        if (sql.includes('FROM sophia_runtime.student_operations_students')) {
          return { rows: [{ legalName: 'Example Student', email: 'student@example.test', studentPhone: '0412 345 678' }] };
        }
        return { rows: [] };
      }),
    };
    const database = { tenantReadTransaction: async (_tenant: string, work: (client: typeof db) => Promise<unknown>) => work(db) } as unknown as DatabaseService;
    const principal: StudentOperationsWorkspacePrincipal = {
      tenantId, externalCompanyId: tenantId, identityUserId: tenantId,
      entitlementId: tenantId, role: 'chief_executive', authorizationRevision: 1,
    };
    const result = await new StudentOperationsCasesService(database).get(principal, caseId);
    expect(result.studentName).toBe('Example Student');
    expect(result.studentEmail).toBe('student@example.test');
    expect(result.studentPhone).toBe('0412 345 678');
    expect(result.status).toBe('in_progress');
    expect(queries[0]).toContain('student_operations_student_user_links');
    expect(queries[1]).toContain('student_operations_students');
    expect(queries[1]).toContain('student_operations_case_contact');
    expect(queries[1]).toContain('contact.case_id=$3');
  });
});
