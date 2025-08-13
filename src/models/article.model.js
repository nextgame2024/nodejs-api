import pool from "../config/db.js";

/**
 * List ALL articles with pagination.
 * Adds favoritesCount, favorited (for current user), and following (current user follows author).
 * Uses subqueries to avoid ONLY_FULL_GROUP_BY issues.
 */
export async function getAllArticles({
  userId = null,
  limit = 1000,
  offset = 0,
} = {}) {
  const [rows] = await pool.query(
    `
    SELECT
      a.id, a.slug, a.title, a.description, a.body,
      a.createdAt, a.updatedAt,
      u.username, u.image, u.bio,
      /* totals */
      (SELECT COUNT(*) FROM article_favorites af WHERE af.article_id = a.id) AS favoritesCount,
      /* booleans for current user (false if userId is NULL) */
      EXISTS(
        SELECT 1 FROM article_favorites af2
        WHERE af2.article_id = a.id AND af2.user_id = ?
      ) AS favorited,
      EXISTS(
        SELECT 1 FROM follows f
        WHERE f.follower_id = ? AND f.followee_id = a.author_id
      ) AS following
    FROM articles a
    JOIN users u ON u.id = a.author_id
    ORDER BY a.createdAt DESC
    LIMIT ? OFFSET ?;
    `,
    [userId, userId, Number(limit), Number(offset)]
  );
  return rows;
}

/**
 * Articles from authors the current user follows (the "feed").
 */
export async function getFeedArticles({ userId, limit = 1000, offset = 0 }) {
  const [rows] = await pool.query(
    `
    SELECT
      a.id, a.slug, a.title, a.description, a.body,
      a.createdAt, a.updatedAt,
      u.username, u.image, u.bio,
      (SELECT COUNT(*) FROM article_favorites af WHERE af.article_id = a.id) AS favoritesCount,
      EXISTS(
        SELECT 1 FROM article_favorites af2
        WHERE af2.article_id = a.id AND af2.user_id = ?
      ) AS favorited
    FROM follows f
    JOIN articles a ON a.author_id = f.followee_id
    JOIN users u    ON u.id        = a.author_id
    WHERE f.follower_id = ?
    ORDER BY a.createdAt DESC
    LIMIT ? OFFSET ?;
    `,
    [userId, userId, Number(limit), Number(offset)]
  );
  return rows;
}
