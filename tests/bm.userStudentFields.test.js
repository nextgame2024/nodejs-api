import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const query = jest.fn();
const release = jest.fn();
const connect = jest.fn(async () => ({ query, release }));
const poolQuery = jest.fn(async () => ({}));

jest.unstable_mockModule('../src/config/db.js', () => ({
  default: { query: poolQuery, connect },
}));
jest.unstable_mockModule('../src/models/bm.sites.model.js', () => ({
  ensureSitesSchema: jest.fn(async () => {}),
}));

const { createUser, updateUserById } = await import('../src/models/user.model.js');
const { normalizeStudentNameInXero } = await import('../src/utils/userStudentFields.js');
const companyId = '11111111-1111-4111-8111-111111111111';
const actorUserId = '22222222-2222-4222-8222-222222222222';

const base = {
  email: 'person@example.com', username: 'person', passwordHash: 'hash',
  companyId,
};

describe('Business Manager student user fields', () => {
  beforeEach(() => {
    query.mockReset();
    release.mockClear();
    connect.mockClear();
  });

  test('stores a Xero student name only for Student type in Student Operations', () => {
    expect(normalizeStudentNameInXero(' Jane Doe ', 'student', 'student_operations'))
      .toBe('Jane Doe');
    expect(normalizeStudentNameInXero('Jane Doe', 'advisor', 'student_operations'))
      .toBeNull();
    expect(normalizeStudentNameInXero('Jane Doe', 'student', 'project_map'))
      .toBeNull();
  });

  test('allocates a server-owned Student ID in the insert transaction', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes('UPDATE bm_student_id_counter')) return { rows: [{ last_value: 1 }] };
      if (sql.includes('INSERT INTO users')) return { rows: [{ id: 'student-1', studentId: 'STD-1' }] };
      return { rows: [] };
    });

    const user = await createUser({ ...base, type: 'student' });

    expect(user.studentId).toBe('STD-1');
    const insert = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO users'));
    expect(insert[0]).toContain('student_id, student_name_in_xero');
    expect(insert[1]).toContain('STD-1');
    expect(query).toHaveBeenCalledWith('COMMIT');
    expect(release).toHaveBeenCalled();
  });

  test('assigns Advisor automatically for a non-Chief Executive in the same student operations company', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes('INSERT INTO users')) return { rows: [{ id: 'advisor-1', status: 'active' }] };
      if (sql.includes('FROM bm_company c')) return {
        rows: [{ workspace_profile: 'student_operations', customer_id: companyId }],
      };
      if (sql.includes('SELECT 1 FROM users WHERE id')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes("role_key = 'chief_executive'")) return { rows: [] };
      if (sql.includes('INSERT INTO sophia_runtime.business_pack_entitlements')) {
        return { rows: [{ entitlement_id: 'entitlement-1' }] };
      }
      return { rows: [] };
    });

    await createUser({ ...base, type: 'advisor', actorUserId });

    expect(query.mock.calls.some(([sql]) =>
      sql.includes('INSERT INTO sophia_runtime.business_pack_entitlements'))).toBe(true);
    expect(query.mock.calls.some(([sql]) =>
      sql.includes('INSERT INTO sophia_runtime.business_pack_access_audit_events'))).toBe(true);
    expect(query).toHaveBeenCalledWith('COMMIT');
  });

  test('assigns a Student ID when an existing user first becomes a Student', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT type, student_id')) return { rows: [{ type: 'employee', student_id: null }] };
      if (sql.includes('UPDATE bm_student_id_counter')) return { rows: [{ last_value: 2 }] };
      if (sql.includes('UPDATE users')) return { rows: [{ id: 'student-2', studentId: 'STD-2' }] };
      return { rows: [] };
    });

    const user = await updateUserById('student-2', { type: 'student' });

    expect(user.studentId).toBe('STD-2');
    const update = query.mock.calls.find(([sql]) => sql.includes('UPDATE users'));
    expect(update[0]).toContain('student_id =');
    expect(update[1]).toContain('STD-2');
  });

  test('assigns Advisor for a Chief Executive creating another Advisor user', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes('INSERT INTO users')) return { rows: [{ id: 'advisor-2', status: 'active' }] };
      if (sql.includes('FROM bm_company c')) return {
        rows: [{ workspace_profile: 'student_operations', customer_id: companyId }],
      };
      if (sql.includes('SELECT 1 FROM users WHERE id')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes("role_key = 'chief_executive'")) return { rows: [{ '?column?': 1 }] };
      if (sql.includes('INSERT INTO sophia_runtime.business_pack_entitlements')) {
        return { rows: [{ entitlement_id: 'entitlement-2' }] };
      }
      return { rows: [] };
    });

    await createUser({ ...base, type: 'advisor', actorUserId });

    expect(query.mock.calls.some(([sql]) =>
      sql.includes('INSERT INTO sophia_runtime.business_pack_entitlements'))).toBe(true);
  });

  test('does not allow a Chief Executive to demote themselves through Advisor type', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes('UPDATE users')) return { rows: [{ id: actorUserId, companyId, status: 'active' }] };
      if (sql.includes('FROM bm_company c')) return {
        rows: [{ workspace_profile: 'student_operations', customer_id: companyId }],
      };
      if (sql.includes('SELECT 1 FROM users WHERE id')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes("role_key = 'chief_executive'")) return { rows: [{ '?column?': 1 }] };
      return { rows: [] };
    });

    await expect(updateUserById(actorUserId, { type: 'advisor', actorUserId }))
      .rejects.toMatchObject({ status: 409 });
    expect(query).toHaveBeenCalledWith('ROLLBACK');
  });

  test('updates an existing Operations entitlement to Advisor for an Advisor user type', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes('UPDATE users')) return { rows: [{ id: 'advisor-3', companyId, status: 'active' }] };
      if (sql.includes('FROM bm_company c')) return {
        rows: [{ workspace_profile: 'student_operations', customer_id: companyId }],
      };
      if (sql.includes('SELECT 1 FROM users WHERE id')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes("role_key = 'chief_executive'")) return { rows: [] };
      if (sql.includes('SELECT role_key, status')) return {
        rows: [{ role_key: 'operations', status: 'active' }],
      };
      if (sql.includes('INSERT INTO sophia_runtime.business_pack_entitlements')) {
        return { rows: [{ entitlement_id: 'entitlement-3' }] };
      }
      return { rows: [] };
    });

    await updateUserById('advisor-3', { type: 'advisor', actorUserId });

    const audit = query.mock.calls.find(([sql]) =>
      sql.includes('INSERT INTO sophia_runtime.business_pack_access_audit_events'));
    expect(audit[1][2]).toBe('business_pack.entitlement.role_changed');
    expect(query).toHaveBeenCalledWith('COMMIT');
  });

  test('rejects a non-Chief Executive changing a Chief Executive entitlement through Advisor type', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes('UPDATE users')) return { rows: [{ id: 'chief-1', companyId, status: 'active' }] };
      if (sql.includes('FROM bm_company c')) return {
        rows: [{ workspace_profile: 'student_operations', customer_id: companyId }],
      };
      if (sql.includes('SELECT 1 FROM users WHERE id')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes("role_key = 'chief_executive'")) return { rows: [] };
      if (sql.includes('SELECT role_key, status')) return {
        rows: [{ role_key: 'chief_executive', status: 'active' }],
      };
      return { rows: [] };
    });

    await expect(updateUserById('chief-1', { type: 'advisor', actorUserId }))
      .rejects.toMatchObject({ status: 409 });
    expect(query).toHaveBeenCalledWith('ROLLBACK');
  });
});
