import pool from '../config/db.js';

const fields = `college_id AS "collegeId", company_id AS "companyId",
  college_name AS "collegeName", owner_name AS "ownerName", abn, address,
  email, cel, tel, notes, status, createdat AS "createdAt", updatedat AS "updatedAt"`;
const contactFields = `id AS "contactId", college_id AS "collegeId", name,
  role_title AS "roleTitle", email, cel, tel, createdat AS "createdAt"`;
const editable = ['college_name', 'owner_name', 'abn', 'address', 'email', 'cel', 'tel', 'notes', 'status'];
const contactEditable = ['name', 'role_title', 'email', 'cel', 'tel'];

export async function list(companyId, { q, status, page, limit }) {
  const where = ['company_id = $1'];
  const args = [companyId];
  if (status) { args.push(status); where.push(`status = $${args.length}`); }
  if (q) {
    args.push(`%${q}%`);
    where.push(`(college_name ILIKE $${args.length} OR owner_name ILIKE $${args.length} OR email ILIKE $${args.length} OR cel ILIKE $${args.length})`);
  }
  const predicate = where.join(' AND ');
  const offset = (page - 1) * limit;
  const [items, count] = await Promise.all([
    pool.query(`SELECT ${fields} FROM bm_colleges WHERE ${predicate}
      ORDER BY (status = 'archived'), lower(college_name), college_id
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
    (company_id, college_name, owner_name, abn, address, email, cel, tel, notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${fields}`,
    [companyId, value.college_name, value.owner_name ?? null, value.abn ?? null,
      value.address ?? null, value.email ?? null, value.cel ?? null,
      value.tel ?? null, value.notes ?? null]);
  return result.rows[0];
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
