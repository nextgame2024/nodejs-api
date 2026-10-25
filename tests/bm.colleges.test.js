import { describe, expect, jest, test } from '@jest/globals';

const query = jest.fn();
const connect = jest.fn();
jest.unstable_mockModule('../src/config/db.js', () => ({ default: { query, connect } }));
const colleges = await import('../src/models/bm.colleges.model.js');

describe('Business Manager college data isolation', () => {
  test('offer college creation serializes same-company names and reuses an active match on retry',async()=>{
    const existing={collegeId:'college-1',collegeName:'Example College',abn:'12345678901'};
    const db={query:jest.fn(async sql=>({rows:String(sql).includes('FROM bm_colleges')?[existing]:[]})),release:jest.fn()};connect.mockResolvedValueOnce(db);
    expect(await colleges.createFromOffer('company-1',{college_name:' Example College ',abn:'12345678901'})).toEqual(existing);
    expect(db.query.mock.calls[1][1]).toEqual(['offer-college:company-1:example college']);
    expect(db.query.mock.calls[2][1]).toEqual(['company-1','example college']);expect(db.query.mock.calls.some(c=>c[0].includes('INSERT'))).toBe(false);
    expect(db.query.mock.calls.at(-1)[0]).toBe('COMMIT');expect(db.release).toHaveBeenCalled();
  });
  test('offer college creation does not silently choose duplicates or overwrite a conflicting ABN',async()=>{
    const db={query:jest.fn(async sql=>({rows:String(sql).includes('FROM bm_colleges')?[{collegeId:'college-1',abn:'12345678901'}]:[]})),release:jest.fn()};connect.mockResolvedValueOnce(db);
    await expect(colleges.createFromOffer('company-1',{college_name:'Example',abn:'99999999999'})).rejects.toMatchObject({code:'COLLEGE_MATCH_CONFLICT'});expect(db.query.mock.calls.at(-1)[0]).toBe('ROLLBACK');
  });
  test('list and count use the caller company, with bounded paging', async () => {
    query.mockResolvedValueOnce({ rows: [{ collegeId: 'college-1' }] })
      .mockResolvedValueOnce({ rows: [{ total: 1 }] });
    const result = await colleges.list('company-1', { q: 'ATI', status: 'active', page: 1, limit: 20 });
    expect(result.total).toBe(1);
    expect(query.mock.calls[0][0]).toContain('company_id = $1');
    expect(query.mock.calls[0][0]).toContain('ORDER BY lower(college_name) ASC NULLS LAST, college_id ASC');
    expect(query.mock.calls[0][1]).toEqual(['company-1', 'active', '%ATI%', 20, 0]);
    expect(query.mock.calls[1][1]).toEqual(['company-1', 'active', '%ATI%']);
  });

  test('sorts the whole company list on the server with a stable tie-breaker', async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ total: 0 }] });
    await colleges.list('company-1', { q: '', page: 2, limit: 25, sort: 'email', direction: 'desc' });
    expect(query.mock.calls.at(-2)[0]).toContain('ORDER BY lower(email) DESC NULLS LAST, college_id ASC');
    expect(query.mock.calls.at(-2)[1]).toEqual(['company-1', 25, 25]);
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

  test('creates a college without site fields', async () => {
    query.mockResolvedValueOnce({ rows: [{ collegeId: 'college-1', city: null, category: null }] });
    const result = await colleges.create('company-1', {
      college_name: 'ATI', city: 'Brisbane', category: 'English language',
    });
    expect(result).toEqual({ collegeId: 'college-1', city: null, category: null });
    const [sql, params] = query.mock.calls.at(-1);
    expect(sql).toContain('(company_id, college_name, owner_name, abn, notes)');
    expect(sql).toContain('city, category');
    expect(params).toEqual(['company-1', 'ATI', null, null, null]);
  });

  test('College Details cannot overwrite the primary site projection', async () => {
    query.mockResolvedValueOnce({ rows: [{ collegeId: 'college-1', city: 'Sydney', category: 'University' }] });
    await colleges.update('company-1', 'college-1', { city: 'Sydney', category: 'University' });
    const [sql, params] = query.mock.calls.at(-1);
    expect(sql).toContain('WHERE company_id = $1 AND college_id = $2');
    expect(sql).not.toContain('city = $3');
    expect(params).toEqual(['company-1', 'college-1']);
  });

  test('creating a first site makes it primary and updates College Details atomically', async () => {
    const db = { query: jest.fn(), release: jest.fn() };
    connect.mockResolvedValueOnce(db);
    db.query.mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ college_id: 'college-1' }] })
      .mockResolvedValueOnce({ rows: [{ has_sites: false }] })
      .mockResolvedValueOnce({}) // unset existing primary
      .mockResolvedValueOnce({ rows: [{ siteId: 'site-1', isPrimary: true }] })
      .mockResolvedValueOnce({}) // project primary
      .mockResolvedValueOnce({}) // clear projection when no primary (no-op)
      .mockResolvedValueOnce({}); // COMMIT
    const site = await colleges.createSite('company-1', 'college-1', { city: 'Melbourne', email: 'info@example.edu.au' });
    expect(site.isPrimary).toBe(true);
    expect(db.query.mock.calls[1][0]).toContain('FOR UPDATE');
    expect(db.query.mock.calls[4][1]).toEqual([
      'company-1', 'college-1', 'info@example.edu.au', null, null, null, 'Melbourne', null, true,
    ]);
    expect(db.query.mock.calls[5][0]).toContain('UPDATE bm_colleges');
    expect(db.query.mock.calls.at(-1)[0]).toBe('COMMIT');
    expect(db.release).toHaveBeenCalled();
  });

  test('a primary site cannot be changed to No without selecting another primary', async () => {
    const db = { query: jest.fn(), release: jest.fn() };
    connect.mockResolvedValueOnce(db);
    db.query.mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ college_id: 'college-1' }] })
      .mockResolvedValueOnce({ rows: [{ siteId: 'site-1', isPrimary: true }] })
      .mockResolvedValueOnce({});
    await expect(colleges.updateSite('company-1', 'college-1', 'site-1', { is_primary: false }))
      .rejects.toMatchObject({ code: 'PRIMARY_SITE_REQUIRED' });
    expect(db.query.mock.calls.at(-1)[0]).toBe('ROLLBACK');
    expect(db.release).toHaveBeenCalled();
  });

  test('choosing another primary site clears the old primary in one transaction', async () => {
    const db = { query: jest.fn(), release: jest.fn() };
    connect.mockResolvedValueOnce(db);
    db.query.mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ college_id: 'college-1' }] })
      .mockResolvedValueOnce({ rows: [{ siteId: 'site-2', isPrimary: false }] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ siteId: 'site-2', isPrimary: true }] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    const site = await colleges.updateSite('company-1', 'college-1', 'site-2', {
      city: 'Sydney', is_primary: true,
    });
    expect(site.isPrimary).toBe(true);
    expect(db.query.mock.calls[3][0]).toContain('SET is_primary = false');
    expect(db.query.mock.calls[4][0]).toContain('is_primary = $5');
    expect(db.query.mock.calls[4][1]).toEqual(['company-1', 'college-1', 'site-2', 'Sydney', true]);
    expect(db.query.mock.calls.at(-1)[0]).toBe('COMMIT');
  });

  test('deleting the primary site promotes another site and refreshes Details', async () => {
    const db = { query: jest.fn(), release: jest.fn() };
    connect.mockResolvedValueOnce(db);
    db.query.mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ college_id: 'college-1' }] })
      .mockResolvedValueOnce({ rows: [{ isPrimary: true }] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    expect(await colleges.deleteSite('company-1', 'college-1', 'site-1')).toBe(true);
    expect(db.query.mock.calls[3][0]).toContain('SET is_primary = true');
    expect(db.query.mock.calls[4][0]).toContain('UPDATE bm_colleges');
    expect(db.query.mock.calls.at(-1)[0]).toBe('COMMIT');
  });
});
