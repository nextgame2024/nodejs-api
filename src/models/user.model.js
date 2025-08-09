import pool from "../config/db.js";
import { v4 as uuid } from "uuid";

export async function findByEmail(email) {
  const [rows] = await pool.query(
    "SELECT * FROM users WHERE email = ? LIMIT 1",
    [email]
  );
  return rows[0];
}

export async function findByUsername(username) {
  const [rows] = await pool.query(
    "SELECT id, username, image, bio, email, createdAt, updatedAt, password FROM users WHERE username = ? LIMIT 1",
    [username]
  );
  return rows[0];
}

export async function findById(id) {
  const [rows] = await pool.query(
    "SELECT id, email, username, image, bio, createdAt, updatedAt FROM users WHERE id = ? LIMIT 1",
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
  const id = uuid();
  await pool.query(
    `INSERT INTO users (id, email, username, password, image, bio)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, email, username, passwordHash, image, bio]
  );
  return findById(id);
}

export async function updateUserById(
  id,
  { email, username, passwordHash, image, bio }
) {
  const sets = [];
  const params = [];

  if (email !== undefined) {
    sets.push("email = ?");
    params.push(email);
  }
  if (username !== undefined) {
    sets.push("username = ?");
    params.push(username);
  }
  if (passwordHash !== undefined) {
    sets.push("password = ?");
    params.push(passwordHash);
  }
  if (image !== undefined) {
    sets.push("image = ?");
    params.push(image);
  }
  if (bio !== undefined) {
    sets.push("bio = ?");
    params.push(bio);
  }

  if (sets.length) {
    const sql = `UPDATE users SET ${sets.join(", ")}, updatedAt = CURRENT_TIMESTAMP WHERE id = ?`;
    params.push(id);
    await pool.query(sql, params);
  }

  return findById(id);
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
      COALESCE(u.bio,   '') AS bio,
      EXISTS(
        SELECT 1 FROM follows f
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
