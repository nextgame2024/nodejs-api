import pool from '../config/db.js';

const fields = `college_id AS "collegeId", company_id AS "companyId",
  college_name AS "collegeName", acronym, owner_name AS "ownerName", abn, address, city, category,
  email, cel, tel, notes, status, cricos_provider_code AS "cricosProviderCode",
  trading_name AS "tradingName", institution_type AS "institutionType",
  institution_capacity AS "institutionCapacity", website, postal_address AS "postalAddress",
  postal_city AS "postalCity", postal_state AS "postalState", postal_postcode AS "postalPostcode",
  cricos_synced_at AS "cricosSyncedAt", createdat AS "createdAt", updatedat AS "updatedAt"`;
const contactFields = `id AS "contactId", college_id AS "collegeId", name,
  role_title AS "roleTitle", email, cel, tel, fax, source,
  contact_type AS "contactType", source_url AS "sourceUrl",
  source_checked_at AS "sourceCheckedAt", source_active AS "sourceActive",
  createdat AS "createdAt", updatedat AS "updatedAt"`;
const siteFields = `site_id AS "siteId", college_id AS "collegeId", email, address,
  phone, mobile, city, category, location_name AS "locationName", location_type AS "locationType",
  state, postcode, is_primary AS "isPrimary"`;
const editable = ['college_name', 'acronym', 'owner_name', 'abn', 'notes', 'status'];
const contactEditable = ['name', 'role_title', 'email', 'cel', 'tel', 'fax'];
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
    where.push(`(college_name ILIKE $${args.length} OR owner_name ILIKE $${args.length}
      OR acronym ILIKE $${args.length} OR trading_name ILIKE $${args.length} OR cricos_provider_code ILIKE $${args.length}
      OR email ILIKE $${args.length} OR cel ILIKE $${args.length})`);
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
    (company_id, college_name, owner_name, abn, notes, acronym)
    VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${fields}`,
    [companyId, value.college_name, value.owner_name ?? null, value.abn ?? null,
      value.notes ?? null, value.acronym ?? null]);
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
    WHERE company_id = $1 AND college_id = $2
      AND (source <> 'cricos' OR source_active = true)
    ORDER BY lower(name), id`, [companyId, collegeId]);
  return result.rows;
}

export async function createContact(companyId, collegeId, value) {
  const result = await pool.query(`INSERT INTO bm_college_contacts
    (company_id, college_id, name, role_title, email, cel, tel, fax)
    SELECT $1,$2,$3,$4,$5,$6,$7,$8 WHERE EXISTS
      (SELECT 1 FROM bm_colleges WHERE company_id = $1 AND college_id = $2)
    RETURNING ${contactFields}`,
    [companyId, collegeId, value.name, value.role_title ?? null,
      value.email ?? null, value.cel ?? null, value.tel ?? null, value.fax ?? null]);
  return result.rows[0] ?? null;
}

export async function updateContact(companyId, collegeId, contactId, value) {
  const keys = contactEditable.filter((key) => value[key] !== undefined);
  const args = [companyId, collegeId, contactId, ...keys.map((key) => value[key])];
  const sets = keys.map((key, index) => `${key} = $${index + 4}`);
  const query = keys.length
    ? `UPDATE bm_college_contacts SET ${sets.join(', ')}, updatedat = now()
      WHERE company_id = $1 AND college_id = $2 AND id = $3 AND source = 'manual' RETURNING ${contactFields}`
    : `SELECT ${contactFields} FROM bm_college_contacts
      WHERE company_id = $1 AND college_id = $2 AND id = $3 AND source = 'manual'`;
  const result = await pool.query(query, args);
  return result.rows[0] ?? null;
}

export async function deleteContact(companyId, collegeId, contactId) {
  const result = await pool.query(`DELETE FROM bm_college_contacts
    WHERE company_id = $1 AND college_id = $2 AND id = $3 AND source = 'manual'`, [companyId, collegeId, contactId]);
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

const courseSortColumns = {
  name: 'lower(c.course_name)',
  code: 'lower(c.cricos_course_code)',
  level: 'lower(c.course_level)',
  duration: 'c.duration_weeks',
  cost: 'c.estimated_total_cost_cents',
  status: 'c.expired',
};

export async function courses(companyId, collegeId, { q, status, page, limit, sort = 'name', direction = 'asc' }) {
  const parent = await get(companyId, collegeId);
  if (!parent) return null;
  const where = ['c.company_id = $1', 'c.college_id = $2'];
  const args = [companyId, collegeId];
  if (status === 'active') where.push('c.expired = false');
  if (status === 'expired') where.push('c.expired = true');
  if (q) {
    args.push(`%${q}%`);
    where.push(`(c.course_name ILIKE $${args.length} OR c.cricos_course_code ILIKE $${args.length}
      OR c.vet_national_code ILIKE $${args.length} OR c.course_level ILIKE $${args.length})`);
  }
  const predicate = where.join(' AND ');
  const orderColumn = courseSortColumns[sort] || courseSortColumns.name;
  const orderDirection = direction === 'desc' ? 'DESC' : 'ASC';
  const offset = (page - 1) * limit;
  const [items, count] = await Promise.all([
    pool.query(`SELECT c.course_id AS "courseId", c.college_id AS "collegeId",
      c.cricos_course_code AS "cricosCourseCode", c.course_name AS "courseName",
      c.vet_national_code AS "vetNationalCode", c.dual_qualification AS "dualQualification",
      c.field_1_broad AS "field1Broad", c.field_1_narrow AS "field1Narrow",
      c.field_1_detailed AS "field1Detailed", c.field_2_broad AS "field2Broad",
      c.field_2_narrow AS "field2Narrow", c.field_2_detailed AS "field2Detailed",
      c.course_level AS "courseLevel", c.foundation_studies AS "foundationStudies",
      c.work_component AS "workComponent", c.work_component_hours_week AS "workComponentHoursWeek",
      c.work_component_weeks AS "workComponentWeeks", c.work_component_total_hours AS "workComponentTotalHours",
      c.course_language AS "courseLanguage", c.duration_weeks AS "durationWeeks",
      c.tuition_fee_cents::float8 AS "tuitionFeeCents", c.non_tuition_fee_cents::float8 AS "nonTuitionFeeCents",
      c.estimated_total_cost_cents::float8 AS "estimatedTotalCostCents", c.expired,
      count(l.site_id)::int AS "locationCount",
      coalesce(array_agg(s.location_name ORDER BY lower(s.location_name), s.site_id)
        FILTER (WHERE s.site_id IS NOT NULL), ARRAY[]::text[]) AS locations
      FROM bm_college_courses c
      LEFT JOIN bm_college_course_locations l
        ON l.company_id = c.company_id AND l.course_id = c.course_id
      LEFT JOIN bm_college_sites s
        ON s.company_id = l.company_id AND s.site_id = l.site_id
      WHERE ${predicate}
      GROUP BY c.course_id
      ORDER BY ${orderColumn} ${orderDirection} NULLS LAST, c.course_id ASC
      LIMIT $${args.length + 1} OFFSET $${args.length + 2}`, [...args, limit, offset]),
    pool.query(`SELECT count(*)::int AS total FROM bm_college_courses c WHERE ${predicate}`, args),
  ]);
  return { courses: items.rows, total: count.rows[0].total, page, limit };
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
