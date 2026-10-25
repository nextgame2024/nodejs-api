import pool from '../config/db.js';

const fields = `college_id AS "collegeId", company_id AS "companyId",
  college_name AS "collegeName", owner_name AS "ownerName", abn, address, city, category,
  email, cel, tel, notes, status, createdat AS "createdAt", updatedat AS "updatedAt"`;
const contactFields = `id AS "contactId", college_id AS "collegeId", name,
  role_title AS "roleTitle", email, cel, tel, createdat AS "createdAt"`;
const siteFields = `site_id AS "siteId", college_id AS "collegeId", email, address,
  phone, mobile, city, category, is_primary AS "isPrimary"`;
const editable = ['college_name', 'owner_name', 'abn', 'notes', 'status'];
const contactEditable = ['name', 'role_title', 'email', 'cel', 'tel'];
const siteEditable = ['email', 'address', 'phone', 'mobile', 'city', 'category'];

const listSortColumns = {
  name: 'lower(college_name)',
  email: 'lower(email)',
  mobile: 'lower(cel)',
  status: 'lower(status)',
};

export async function list(companyId, { q, status, page, limit, sort = 'name', direction = 'asc' }) {
  const where = ['company_id = $1'];
  const args = [companyId];
  if (status) { args.push(status); where.push(`status = $${args.length}`); }
  if (q) {
    args.push(`%${q}%`);
    where.push(`(college_name ILIKE $${args.length} OR owner_name ILIKE $${args.length} OR email ILIKE $${args.length} OR cel ILIKE $${args.length})`);
  }
  const predicate = where.join(' AND ');
  const offset = (page - 1) * limit;
  const orderColumn = listSortColumns[sort] || listSortColumns.name;
  const orderDirection = direction === 'desc' ? 'DESC' : 'ASC';
  const [items, count] = await Promise.all([
    pool.query(`SELECT ${fields} FROM bm_colleges WHERE ${predicate}
      ORDER BY ${orderColumn} ${orderDirection} NULLS LAST, college_id ASC
      LIMIT $${args.length + 1} OFFSET $${args.length + 2}`, [...args, limit, offset]),
    pool.query(`SELECT count(*)::int AS total FROM bm_colleges WHERE ${predicate}`, args),
  ]);
  return { colleges: items.rows, total: count.rows[0].total, page, limit };
}

export async function get(companyId, collegeId) {
  const result = await pool.query(`SELECT ${fields} FROM bm_colleges WHERE company_id = $1 AND college_id = $2`, [companyId, collegeId]);
  return result.rows[0] ?? null;
}

export async function create(companyId, value) {
  const result = await pool.query(`INSERT INTO bm_colleges
    (company_id, college_name, owner_name, abn, notes)
    VALUES ($1,$2,$3,$4,$5) RETURNING ${fields}`,
    [companyId, value.college_name, value.owner_name ?? null, value.abn ?? null,
      value.notes ?? null]);
  return result.rows[0];
}

// Offer retries reuse a same-company active name instead of creating duplicates.
// Existing ambiguous directory entries or conflicting ABNs require selection.
export async function createFromOffer(companyId,value) {
  const db=await pool.connect();
  const normalized=value.college_name.trim().replace(/\s+/g,' ').toLocaleLowerCase('en');
  try{
    await db.query('BEGIN');
    await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`offer-college:${companyId}:${normalized}`]);
    const existing=await db.query(`SELECT ${fields} FROM bm_colleges WHERE company_id=$1 AND status='active'
      AND lower(regexp_replace(btrim(college_name),'[[:space:]]+',' ','g'))=$2 ORDER BY college_id FOR UPDATE`,[companyId,normalized]);
    const match=existing.rows[0];
    if(existing.rows.length>1||(match?.abn&&value.abn&&match.abn.replace(/\D/g,'')!==value.abn.replace(/\D/g,''))){const error=new Error('Select an existing college or resolve its ABN before creating another.');error.code='COLLEGE_MATCH_CONFLICT';throw error;}
    const college=match??(await db.query(`INSERT INTO bm_colleges(company_id,college_name,owner_name,abn,notes)
      VALUES($1,$2,$3,$4,$5) RETURNING ${fields}`,[companyId,value.college_name.trim(),value.owner_name??null,value.abn??null,value.notes??null])).rows[0];
    await db.query('COMMIT');return college;
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}

export async function update(companyId, collegeId, value) {
  const keys = editable.filter((key) => value[key] !== undefined);
  if (!keys.length) return get(companyId, collegeId);
  const args = [companyId, collegeId, ...keys.map((key) => value[key])];
  const sets = keys.map((key, index) => `${key} = $${index + 3}`);
  const result = await pool.query(`UPDATE bm_colleges SET ${sets.join(', ')}, updatedat = now()
    WHERE company_id = $1 AND college_id = $2 RETURNING ${fields}`, args);
  return result.rows[0] ?? null;
}

export async function contacts(companyId, collegeId) {
  const parent = await get(companyId, collegeId);
  if (!parent) return null;
  const result = await pool.query(`SELECT ${contactFields} FROM bm_college_contacts
    WHERE company_id = $1 AND college_id = $2 ORDER BY lower(name), id`, [companyId, collegeId]);
  return result.rows;
}

export async function createContact(companyId, collegeId, value) {
  const result = await pool.query(`INSERT INTO bm_college_contacts
    (company_id, college_id, name, role_title, email, cel, tel)
    SELECT $1,$2,$3,$4,$5,$6,$7 WHERE EXISTS
      (SELECT 1 FROM bm_colleges WHERE company_id = $1 AND college_id = $2)
    RETURNING ${contactFields}`,
    [companyId, collegeId, value.name, value.role_title ?? null,
      value.email ?? null, value.cel ?? null, value.tel ?? null]);
  return result.rows[0] ?? null;
}

export async function updateContact(companyId, collegeId, contactId, value) {
  const keys = contactEditable.filter((key) => value[key] !== undefined);
  const args = [companyId, collegeId, contactId, ...keys.map((key) => value[key])];
  const sets = keys.map((key, index) => `${key} = $${index + 4}`);
  const query = keys.length
    ? `UPDATE bm_college_contacts SET ${sets.join(', ')} WHERE company_id = $1 AND college_id = $2 AND id = $3 RETURNING ${contactFields}`
    : `SELECT ${contactFields} FROM bm_college_contacts WHERE company_id = $1 AND college_id = $2 AND id = $3`;
  const result = await pool.query(query, args);
  return result.rows[0] ?? null;
}

export async function deleteContact(companyId, collegeId, contactId) {
  const result = await pool.query(`DELETE FROM bm_college_contacts
    WHERE company_id = $1 AND college_id = $2 AND id = $3`, [companyId, collegeId, contactId]);
  return result.rowCount > 0;
}

async function inLockedCollege(companyId, collegeId, operation) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const parent = await db.query(
      'SELECT college_id FROM bm_colleges WHERE company_id = $1 AND college_id = $2 FOR UPDATE',
      [companyId, collegeId],
    );
    if (!parent.rows.length) {
      await db.query('ROLLBACK');
      return null;
    }
    const result = await operation(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    db.release();
  }
}

async function projectPrimarySite(db, companyId, collegeId) {
  await db.query(`UPDATE bm_colleges c SET
      email = s.email, address = s.address, tel = s.phone, cel = s.mobile,
      city = s.city, category = s.category, updatedat = now()
    FROM (SELECT email, address, phone, mobile, city, category
      FROM bm_college_sites WHERE company_id = $1 AND college_id = $2 AND is_primary) s
    WHERE c.company_id = $1 AND c.college_id = $2`, [companyId, collegeId]);
  await db.query(`UPDATE bm_colleges c SET
      email = NULL, address = NULL, tel = NULL, cel = NULL,
      city = NULL, category = NULL, updatedat = now()
    WHERE c.company_id = $1 AND c.college_id = $2
      AND NOT EXISTS (SELECT 1 FROM bm_college_sites s
        WHERE s.company_id = $1 AND s.college_id = $2 AND s.is_primary)`, [companyId, collegeId]);
}

export async function sites(companyId, collegeId) {
  const parent = await get(companyId, collegeId);
  if (!parent) return null;
  const result = await pool.query(`SELECT ${siteFields} FROM bm_college_sites
    WHERE company_id = $1 AND college_id = $2
    ORDER BY is_primary DESC, lower(coalesce(city, '')), createdat, site_id`, [companyId, collegeId]);
  return result.rows;
}

export async function createSite(companyId, collegeId, value) {
  return inLockedCollege(companyId, collegeId, async (db) => {
    const existing = await db.query(
      'SELECT EXISTS (SELECT 1 FROM bm_college_sites WHERE company_id = $1 AND college_id = $2) AS has_sites',
      [companyId, collegeId],
    );
    const primary = !existing.rows[0].has_sites || value.is_primary === true;
    if (primary) await db.query(
      'UPDATE bm_college_sites SET is_primary = false WHERE company_id = $1 AND college_id = $2 AND is_primary',
      [companyId, collegeId],
    );
    const result = await db.query(`INSERT INTO bm_college_sites
      (company_id, college_id, email, address, phone, mobile, city, category, is_primary)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${siteFields}`,
    [companyId, collegeId, value.email ?? null, value.address ?? null,
      value.phone ?? null, value.mobile ?? null, value.city ?? null,
      value.category ?? null, primary]);
    if (primary) await projectPrimarySite(db, companyId, collegeId);
    return result.rows[0];
  });
}

export async function updateSite(companyId, collegeId, siteId, value) {
  return inLockedCollege(companyId, collegeId, async (db) => {
    const current = await db.query(
      `SELECT ${siteFields} FROM bm_college_sites WHERE company_id = $1 AND college_id = $2 AND site_id = $3`,
      [companyId, collegeId, siteId],
    );
    if (!current.rows.length) return null;
    if (current.rows[0].isPrimary && value.is_primary === false) {
      const error = new Error('Choose another primary site first.');
      error.code = 'PRIMARY_SITE_REQUIRED';
      throw error;
    }
    const primary = value.is_primary === true || current.rows[0].isPrimary;
    if (value.is_primary === true && !current.rows[0].isPrimary) await db.query(
      'UPDATE bm_college_sites SET is_primary = false WHERE company_id = $1 AND college_id = $2 AND is_primary',
      [companyId, collegeId],
    );
    const keys = siteEditable.filter((key) => value[key] !== undefined);
    const args = [companyId, collegeId, siteId, ...keys.map((key) => value[key])];
    const sets = keys.map((key, index) => `${key} = $${index + 4}`);
    args.push(primary);
    sets.push(`is_primary = $${args.length}`, 'updatedat = now()');
    const result = await db.query(`UPDATE bm_college_sites SET ${sets.join(', ')}
      WHERE company_id = $1 AND college_id = $2 AND site_id = $3 RETURNING ${siteFields}`, args);
    if (primary) await projectPrimarySite(db, companyId, collegeId);
    return result.rows[0];
  });
}

export async function deleteSite(companyId, collegeId, siteId) {
  return inLockedCollege(companyId, collegeId, async (db) => {
    const removed = await db.query(`DELETE FROM bm_college_sites
      WHERE company_id = $1 AND college_id = $2 AND site_id = $3 RETURNING is_primary AS "isPrimary"`,
    [companyId, collegeId, siteId]);
    if (!removed.rows.length) return false;
    if (removed.rows[0].isPrimary) {
      await db.query(`UPDATE bm_college_sites SET is_primary = true, updatedat = now()
        WHERE site_id = (SELECT site_id FROM bm_college_sites
          WHERE company_id = $1 AND college_id = $2
          ORDER BY createdat, site_id LIMIT 1)`, [companyId, collegeId]);
      await projectPrimarySite(db, companyId, collegeId);
    }
    return true;
  });
}
