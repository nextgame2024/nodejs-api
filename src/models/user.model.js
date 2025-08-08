import pool from "../config/db.js";

export async function findByEmail(email) {
  const [rows] = await pool.query("SELECT * FROM users WHERE email = ?", [
    email,
  ]);
  return rows[0];
}

export async function findByUsername(username) {
  const [rows] = await pool.query(
    "SELECT id, username, image, bio FROM users WHERE username = ? LIMIT 1",
    [username]
  );
  return rows[0];
}

export async function isFollowing(followerId, followeeId) {
  const [rows] = await pool.query(
    "SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ? LIMIT 1",
    [followerId, followeeId]
  );
  return !!rows.length;
}

export async function followUser(followerId, followeeId) {
  await pool.query(
    "INSERT IGNORE INTO follows (follower_id, followee_id) VALUES (?, ?)",
    [followerId, followeeId]
  );
}

export async function getProfileWithFollowing(username, viewerId) {
  const [rows] = await pool.query(
    `
    SELECT
      u.username,
      COALESCE(u.image, '') AS image,
      COALESCE(u.bio, '')   AS bio,
      EXISTS(
        SELECT 1
        FROM follows f
        WHERE f.follower_id = ? AND f.followee_id = u.id
      ) AS following
    FROM users u
    WHERE u.username = ?
    LIMIT 1
    `,
    [viewerId, username]
  );
  return rows[0];
}
