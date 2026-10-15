import { describe, expect, jest, test } from '@jest/globals';

const query = jest.fn();
jest.unstable_mockModule('../src/config/db.js', () => ({ default: { query } }));
const colleges = await import('../src/models/bm.colleges.model.js');

describe('Business Manager college data isolation', () => {
  test('list and count use the caller company, with bounded paging', async () => {
    query.mockResolvedValueOnce({ rows: [{ collegeId: 'college-1' }] })
      .mockResolvedValueOnce({ rows: [{ total: 1 }] });
    const result = await colleges.list('company-1', { q: 'ATI', status: 'active', page: 1, limit: 20 });
    expect(result.total).toBe(1);
    expect(query.mock.calls[0][0]).toContain('company_id = $1');
    expect(query.mock.calls[0][1]).toEqual(['company-1', 'active', '%ATI%', 20, 0]);
    expect(query.mock.calls[1][1]).toEqual(['company-1', 'active', '%ATI%']);
  });

  test('contact creation checks the parent in the same company', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const result = await colleges.createContact('company-1', 'college-1', { name: 'Registrar' });
    expect(result).toBeNull();
    expect(query.mock.calls.at(-1)[0]).toContain('SELECT 1 FROM bm_colleges WHERE company_id = $1 AND college_id = $2');
    expect(query.mock.calls.at(-1)[1].slice(0, 3)).toEqual(['company-1', 'college-1', 'Registrar']);
  });

  test('updates cannot change company or college identity', async () => {
    query.mockResolvedValueOnce({ rows: [{ collegeId: 'college-1' }] });
    await colleges.update('company-1', 'college-1', { college_name: 'New name', company_id: 'other-company' });
    expect(query.mock.calls.at(-1)[0]).not.toContain('company_id = $3');
    expect(query.mock.calls.at(-1)[1]).toEqual(['company-1', 'college-1', 'New name']);
  });
});
