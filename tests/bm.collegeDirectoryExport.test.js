import { describe, expect, jest, test } from '@jest/globals';
import { exportCollegeDirectory } from '../scripts/export-college-directory.mjs';

describe('Business Manager college directory export', () => {
  test('exports the complete tenant-scoped directory with stable IDs', async () => {
    const query = jest.fn(async (sql) => {
      if (sql.includes('FROM bm_company')) return { rows: [{ company_id: 'company', company_name: 'Example' }] };
      if (sql.includes('FROM bm_colleges ')) return { rows: [{ college_id: 'college-1' }] };
      if (sql.includes('FROM bm_college_sites')) return { rows: [{ site_id: 'site-1' }] };
      return { rows: [{ id: 'contact-1' }] };
    });
    const result = await exportCollegeDirectory(
      { query },
      '80d5e42f-2de1-4792-86b5-54c7cdeb2660',
    );
    expect(result.counts).toEqual({ colleges: 1, sites: 1, contacts: 1 });
    expect(query.mock.calls.every((call) => call[1]?.[0] === '80d5e42f-2de1-4792-86b5-54c7cdeb2660')).toBe(true);
  });

  test('rejects an invalid company before querying', async () => {
    const query = jest.fn();
    await expect(exportCollegeDirectory({ query }, 'all')).rejects.toThrow('valid company UUID');
    expect(query).not.toHaveBeenCalled();
  });
});
