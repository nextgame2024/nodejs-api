import pool from "../config/db.js";

/** All articles with total count (for pagination) */
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
      (SELECT COUNT(*) FROM article_favorites af WHERE af.article_id = a.id) AS favoritesCount,
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

  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS total FROM articles;`
  );
  const total = countRows[0]?.total ?? 0;
  return { rows, total };
}

/** Feed with total count (for pagination) */
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

  const [countRows] = await pool.query(
    `
    SELECT COUNT(*) AS total
    FROM follows f
    JOIN articles a ON a.author_id = f.followee_id
    WHERE f.follower_id = ?;
    `,
    [userId]
  );
  const total = countRows[0]?.total ?? 0;
  return { rows, total };
}

// Get a single article row (with author + counts/flags) by slug
export async function findArticleBySlug({ slug, userId = "" }) {
  const [rows] = await pool.query(
    `
      SELECT
        a.id, a.slug, a.title, a.description, a.body,
        a.createdAt, a.updatedAt,
        u.username, u.image, u.bio,
        /* totals */
        (SELECT COUNT(*) FROM article_favorites af WHERE af.article_id = a.id) AS favoritesCount,
        /* booleans dependent on current user (empty string when anonymous => false) */
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
      WHERE a.slug = ?
      LIMIT 1;
      `,
    [userId || "", userId || "", slug]
  );
  return rows[0] || null;
}
