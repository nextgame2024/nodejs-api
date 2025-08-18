import pool from "../config/db.js";

/** All articles with total count (for pagination) */
export async function getAllArticles({
  userId = null,
  limit = 1000,
  offset = 0,
} = {}) {
  const uid = userId || ""; // avoid NULL in EXISTS comparisons

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
    [uid, uid, Number(limit), Number(offset)]
  );

  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS total FROM articles;`
  );
  const total = countRows[0]?.total ?? 0;
  return { rows, total };
}

/** Feed with total count (for pagination) */
export async function getFeedArticles({ userId, limit = 1000, offset = 0 }) {
  const uid = userId || "";

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
    [uid, uid, Number(limit), Number(offset)]
  );

  const [countRows] = await pool.query(
    `
    SELECT COUNT(*) AS total
    FROM follows f
    JOIN articles a ON a.author_id = f.followee_id
    WHERE f.follower_id = ?;
    `,
    [uid]
  );
  const total = countRows[0]?.total ?? 0;
  return { rows, total };
}

/** One article by slug (with author + counts/flags) */
export async function findArticleBySlug({ slug, userId = "" }) {
  const uid = userId || "";

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
    WHERE a.slug = ?
    LIMIT 1;
    `,
    [uid, uid, slug]
  );
  return rows[0] || null;
}

export async function findArticleAuthorId(slug) {
  const [rows] = await pool.query(
    `SELECT author_id FROM articles WHERE slug = ? LIMIT 1`,
    [slug]
  );
  return rows[0]?.author_id || null;
}

export async function deleteArticleBySlug({ slug, userId }) {
  const [result] = await pool.query(
    `DELETE FROM articles WHERE slug = ? AND author_id = ? LIMIT 1`,
    [slug, userId]
  );
  return result.affectedRows || 0;
}
