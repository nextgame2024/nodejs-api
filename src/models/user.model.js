import pool from "../config/db.js";

// Centralized selection so all endpoints stay consistent
const USER_SELECT = `
  id,
  email,
  username,
  image,
  bio,
  name,
  address,
  cel,
  tel,
  contacts,
  type,
  status,
  company_id AS "companyId",
  (
    SELECT c.company_name
    FROM bm_company c
    WHERE c.company_id = users.company_id
    LIMIT 1
  ) AS "companyName",
  createdat AS "createdAt",
  updatedat AS "updatedAt"
`;

export async function findByEmail(email) {
  const { rows } = await pool.query(
    `SELECT
       ${USER_SELECT},
       password
     FROM users
     WHERE email = $1
     LIMIT 1`,
    [email],
  );
  return rows[0];
}

export async function findByUsername(username) {
  const { rows } = await pool.query(
    `SELECT
       ${USER_SELECT},
       password
     FROM users
     WHERE username = $1
     LIMIT 1`,
    [username],
  );
  return rows[0];
}

export async function findById(id) {
  const { rows } = await pool.query(
    `SELECT
       ${USER_SELECT}
     FROM users
     WHERE id = $1
     LIMIT 1`,
    [id],
  );
  return rows[0];
}

export async function createUser({
  email,
  username,
  passwordHash,
  companyId = null,
  image = "",
  bio = "",
  // New fields (optional) — safe defaults; will not break existing callers
  name = null,
  address = null,
  cel = null,
  tel = null,
  contacts = null,
}) {
  const { rows } = await pool.query(
    `INSERT INTO users (
        id, company_id, email, username, password, image, bio,
        name, address, cel, tel, contacts
     )
     VALUES (
        gen_random_uuid(), $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10, $11
     )
     RETURNING
       ${USER_SELECT}`,
    [
      companyId,
      email,
      username,
      passwordHash,
      image,
      bio,
      name,
      address,
      cel,
      tel,
      contacts,
    ],
  );
  return rows[0];
}

export async function updateUserById(
  id,
  {
    email,
    username,
    passwordHash,
    image,
    bio,
    // New fields (optional)
    name,
    address,
    cel,
    tel,
    contacts,
    companyId,
    // Intentionally not allowing type/status here unless you explicitly add it later
  },
) {
  const sets = [];
  const params = [];
  let i = 1;

  if (email !== undefined) {
    sets.push(`email = $${i++}`);
    params.push(email);
  }
  if (username !== undefined) {
    sets.push(`username = $${i++}`);
    params.push(username);
  }
  if (passwordHash !== undefined) {
    sets.push(`password = $${i++}`);
    params.push(passwordHash);
  }
  if (image !== undefined) {
    sets.push(`image = $${i++}`);
    params.push(image);
  }
  if (bio !== undefined) {
    sets.push(`bio = $${i++}`);
    params.push(bio);
  }

  if (name !== undefined) {
    sets.push(`name = $${i++}`);
    params.push(name);
  }
  if (address !== undefined) {
    sets.push(`address = $${i++}`);
    params.push(address);
  }
  if (cel !== undefined) {
    sets.push(`cel = $${i++}`);
    params.push(cel);
  }
  if (tel !== undefined) {
    sets.push(`tel = $${i++}`);
    params.push(tel);
  }
  if (contacts !== undefined) {
    sets.push(`contacts = $${i++}`);
    params.push(contacts);
  }
  if (companyId !== undefined) {
    sets.push(`company_id = $${i++}`);
    params.push(companyId);
  }

  if (!sets.length) return findById(id);

  sets.push(`updatedat = NOW()`);
  params.push(id);

  const { rows } = await pool.query(
    `UPDATE users
     SET ${sets.join(", ")}
     WHERE id = $${i}
     RETURNING
       ${USER_SELECT}`,
    params,
  );
  return rows[0];
}

/** List users by company (company‑scoped) */
export async function listUsersByCompany({
  companyId,
  q,
  status,
  type,
  limit,
  offset,
}) {
  const filters = [];
  const params = [];
  let i = 1;

  if (companyId) {
    filters.push(`company_id = $${i++}`);
    params.push(companyId);
  }

  if (q) {
    filters.push(
      `(username ILIKE $${i} OR email ILIKE $${i} OR name ILIKE $${i} OR EXISTS (
          SELECT 1
          FROM bm_company c
          WHERE c.company_id = users.company_id
            AND c.company_name ILIKE $${i}
        ))`,
    );
    params.push(`%${q}%`);
    i++;
  }

  if (status) {
    filters.push(`status = $${i++}`);
    params.push(status);
  }

  if (type) {
    filters.push(`type = $${i++}`);
    params.push(type);
  }

  params.push(limit, offset);

  const { rows } = await pool.query(
    `SELECT
       ${USER_SELECT}
     FROM users
     ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
     ORDER BY name ASC NULLS LAST, username ASC NULLS LAST, createdat DESC
     LIMIT $${i++} OFFSET $${i}`,
    params,
  );
  return rows;
}

/** Count users by company (for pagination) */
export async function countUsersByCompany({ companyId, q, status, type }) {
  const filters = [];
  const params = [];
  let i = 1;

  if (companyId) {
    filters.push(`company_id = $${i++}`);
    params.push(companyId);
  }

  if (q) {
    filters.push(
      `(username ILIKE $${i} OR email ILIKE $${i} OR name ILIKE $${i} OR EXISTS (
          SELECT 1
          FROM bm_company c
          WHERE c.company_id = users.company_id
            AND c.company_name ILIKE $${i}
        ))`,
    );
    params.push(`%${q}%`);
    i++;
  }

  if (status) {
    filters.push(`status = $${i++}`);
    params.push(status);
  }

  if (type) {
    filters.push(`type = $${i++}`);
    params.push(type);
  }

  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM users
     ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}`,
    params,
  );
  return rows[0]?.total ?? 0;
}
