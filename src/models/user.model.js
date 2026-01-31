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
        id, email, username, password, image, bio,
        name, address, cel, tel, contacts
     )
     VALUES (
        gen_random_uuid(), $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10
     )
     RETURNING
       ${USER_SELECT}`,
    [
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
  const filters = [`company_id = $1`];
  const params = [companyId];
  let i = 2;

  if (q) {
    filters.push(
      `(username ILIKE $${i} OR email ILIKE $${i} OR name ILIKE $${i})`,
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
     WHERE ${filters.join(" AND ")}
     ORDER BY createdat DESC
     LIMIT $${i++} OFFSET $${i}`,
    params,
  );
  return rows;
}

/** Count users by company (for pagination) */
export async function countUsersByCompany({ companyId, q, status, type }) {
  const filters = [`company_id = $1`];
  const params = [companyId];
  let i = 2;

  if (q) {
    filters.push(
      `(username ILIKE $${i} OR email ILIKE $${i} OR name ILIKE $${i})`,
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
     WHERE ${filters.join(" AND ")}`,
    params,
  );
  return rows[0]?.total ?? 0;
}

export async function isFollowing(followerId, followeeId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM follows WHERE follower_id = $1 AND followee_id = $2 LIMIT 1`,
    [followerId, followeeId],
  );
  return rows.length > 0;
}

export async function followUser(followerId, followeeId) {
  const { rows } = await pool.query(
    `INSERT INTO follows (follower_id, followee_id)
     VALUES ($1, $2)
     ON CONFLICT (follower_id, followee_id) DO NOTHING
     RETURNING follower_id`,
    [followerId, followeeId],
  );
  return rows.length > 0;
}

export async function unfollowUser(followerId, followeeId) {
  const res = await pool.query(
    `DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2`,
    [followerId, followeeId],
  );
  return res.rowCount > 0;
}

export async function getProfileWithFollowing(username, viewerId) {
  const { rows } = await pool.query(
    `SELECT
        u.username,
        COALESCE(u.image, '') AS image,
        COALESCE(u.bio,   '') AS bio,
        EXISTS (
          SELECT 1 FROM follows f
          WHERE f.follower_id = $2 AND f.followee_id = u.id
        ) AS following
     FROM users u
     WHERE u.username = $1
     LIMIT 1`,
    [username, viewerId],
  );
  return rows[0];
}

/** Return authors the viewer isn't following (and not themselves),
 *  ordered by most recently active (latest article date).
 */
export async function getSuggestedAuthors({
  viewerId,
  limit = 5,
  defaultAvatar = null,
}) {
  const { rows } = await pool.query(
    `
    WITH latest AS (
      SELECT author_id, MAX(createdat) AS last_post
      FROM articles
      GROUP BY author_id
    )
    SELECT
      u.username,
      COALESCE(u.bio, '')  AS bio,
      COALESCE(u.image, $3) AS image
    FROM users u
    LEFT JOIN latest l ON l.author_id = u.id
    WHERE u.id <> $1
      AND NOT EXISTS (
        SELECT 1 FROM follows f
        WHERE f.follower_id = $1 AND f.followee_id = u.id
      )
    ORDER BY l.last_post DESC NULLS LAST, u.username ASC
    LIMIT $2
    `,
    [viewerId, Math.max(1, Math.min(20, Number(limit))), defaultAvatar],
  );
  return rows;
}
