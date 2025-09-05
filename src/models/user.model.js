import pool from "../config/db.js";

export async function findByEmail(email) {
  const { rows } = await pool.query(
    `SELECT
       id, email, username, image, bio, password,
       createdat AS "createdAt",
       updatedat AS "updatedAt"
     FROM users
     WHERE email = $1
     LIMIT 1`,
    [email]
  );
  return rows[0];
}

export async function findByUsername(username) {
  const { rows } = await pool.query(
    `SELECT
       id, username, image, bio, email, password,
       createdat AS "createdAt",
       updatedat AS "updatedAt"
     FROM users
     WHERE username = $1
     LIMIT 1`,
    [username]
  );
  return rows[0];
}

export async function findById(id) {
  const { rows } = await pool.query(
    `SELECT
       id, email, username, image, bio,
       createdat AS "createdAt",
       updatedat AS "updatedAt"
     FROM users
     WHERE id = $1
     LIMIT 1`,
    [id]
  );
  return rows[0];
}

export async function createUser({
  email,
  username,
  passwordHash,
  image = "",
  bio = "",
}) {
  const { rows } = await pool.query(
    `INSERT INTO users (id, email, username, password, image, bio)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
     RETURNING
       id, email, username, image, bio,
       createdat AS "createdAt",
       updatedat AS "updatedAt"`,
    [email, username, passwordHash, image, bio]
  );
  return rows[0];
}

export async function updateUserById(
  id,
  { email, username, passwordHash, image, bio }
) {
  const sets = [];
  const params = [];
  let i = 1;

  if (email !== undefined) { sets.push(`email = $${i++}`); params.push(email); }
  if (username !== undefined) { sets.push(`username = $${i++}`); params.push(username); }
  if (passwordHash !== undefined) { sets.push(`password = $${i++}`); params.push(passwordHash); }
  if (image !== undefined) { sets.push(`image = $${i++}`); params.push(image); }
  if (bio !== undefined) { sets.push(`bio = $${i++}`); params.push(bio); }

  if (!sets.length) return findById(id);
  sets.push(`updatedat = NOW()`);
  params.push(id);

  const { rows } = await pool.query(
    `UPDATE users
     SET ${sets.join(", ")}
     WHERE id = $${i}
     RETURNING
       id, email, username, image, bio,
       createdat AS "createdAt",
       updatedat AS "updatedAt"`,
    params
  );
  return rows[0];
}

export async function isFollowing(followerId, followeeId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM follows WHERE follower_id = $1 AND followee_id = $2 LIMIT 1`,
    [followerId, followeeId]
  );
  return rows.length > 0;
}

export async function followUser(followerId, followeeId) {
  const { rows } = await pool.query(
    `INSERT INTO follows (follower_id, followee_id)
     VALUES ($1, $2)
     ON CONFLICT (follower_id, followee_id) DO NOTHING
     RETURNING follower_id`,
    [followerId, followeeId]
  );
  return rows.length > 0;
}

export async function unfollowUser(followerId, followeeId) {
  const res = await pool.query(
    `DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2`,
    [followerId, followeeId]
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
    [username, viewerId]
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
    [viewerId, Math.max(1, Math.min(20, Number(limit))), defaultAvatar]
  );
  return rows;
}
