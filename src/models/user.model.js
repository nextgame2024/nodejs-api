import pool from "../config/db.js";

export async function findByEmail(email) {
  const { rows } = await pool.query(
    `SELECT id, email, username, image, bio, password, createdAt, updatedAt
     FROM users WHERE email = $1 LIMIT 1`,
    [email]
  );
  return rows[0];
}

export async function findByUsername(username) {
  const { rows } = await pool.query(
    `SELECT id, username, image, bio, email, createdAt, updatedAt, password
     FROM users WHERE username = $1 LIMIT 1`,
    [username]
  );
  return rows[0];
}

export async function findById(id) {
  const { rows } = await pool.query(
    `SELECT id, email, username, image, bio, createdAt, updatedAt
     FROM users WHERE id = $1 LIMIT 1`,
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
     RETURNING id, email, username, image, bio, createdAt, updatedAt`,
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

  if (!sets.length) return findById(id);

  sets.push(`updatedAt = NOW()`);
  params.push(id);

  const { rows } = await pool.query(
    `UPDATE users SET ${sets.join(", ")} WHERE id = $${i} RETURNING id, email, username, image, bio, createdAt, updatedAt`,
    params
  );
  return rows[0];
}

export async function isFollowing(followerId, followeeId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM follows WHERE follower_id = $1 AND followee_id = $2 LIMIT 1`,
    [followerId, followeeId]
  );
  return !!rows.length;
}

export async function followUser(followerId, followeeId) {
  await pool.query(
    `INSERT INTO follows (follower_id, followee_id)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [followerId, followeeId]
  );
}

export async function unfollowUser(followerId, followeeId) {
  await pool.query(
    `DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2`,
    [followerId, followeeId]
  );
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
