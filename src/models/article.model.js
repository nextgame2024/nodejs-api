import pool from "../config/db.js";

/** Build dynamic WHERE and params for filters */
function buildArticleFilters({ author, favoritedBy, tag }) {
  const where = [];
  const params = [];

  if (author) {
    where.push(`u.username = ?`);
    params.push(author);
  }

  if (favoritedBy) {
    // articles favorited by username
    where.push(
      `EXISTS (
         SELECT 1
         FROM article_favorites af
         JOIN users u2 ON u2.id = af.user_id
        WHERE af.article_id = a.id AND u2.username = ?
      )`
    );
    params.push(favoritedBy);
  }

  if (tag) {
    // articles that have tag name
    where.push(
      `EXISTS (
         SELECT 1
           FROM article_tags at2
           JOIN tags t2 ON t2.id = at2.tag_id
          WHERE at2.article_id = a.id AND t2.name = ?
       )`
    );
    params.push(tag);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return { whereSql, params };
}

/** All articles (with optional filters) + total count for pagination */
/** All articles with total count + author/favorited/tag filters */
export async function getAllArticles({
  userId = null,
  limit = 1000,
  offset = 0,
  author,
  favoritedBy,
  tag,
} = {}) {
  const uid = userId || "";
  const { whereSql, params } = buildArticleFilters({
    author,
    favoritedBy,
    tag,
  });

  const sql = `
    SELECT
      a.id, a.slug, a.title, a.description, a.body,
      a.createdAt, a.updatedAt, a.status,
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
    ${whereSql}
    ORDER BY a.createdAt DESC
    LIMIT ? OFFSET ?;
  `;

  const [rows] = await pool.query(sql, [
    uid,
    uid,
    ...params,
    Number(limit),
    Number(offset),
  ]);

  const [countRows] = await pool.query(
    `
    SELECT COUNT(*) AS total
    FROM articles a
    JOIN users u ON u.id = a.author_id
    ${whereSql};
    `,
    params
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
      a.createdAt, a.updatedAt, a.status,
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
      a.id, a.slug, a.title, a.description, a.body, a.status,
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

/** CREATE (returns new article id) */
export async function insertArticle({
  authorId,
  slug,
  title,
  description,
  body,
  status = "draft",
}) {
  await pool.query(
    `
      INSERT INTO articles (id, slug, title, description, body, author_id, status)
      VALUES (UUID(), ?, ?, ?, ?, ?, ?)
    `,
    [slug, title, description, body, authorId, status]
  );
  const [rows] = await pool.query(
    `SELECT id FROM articles WHERE slug = ? LIMIT 1`,
    [slug]
  );
  return rows[0].id;
}

/** UPDATE (by slug, only if owned by authorId). Returns true if updated. */
export async function updateArticleBySlugForAuthor({
  slug,
  authorId,
  title,
  description,
  body,
  newSlug,
  status,
}) {
  const fields = [];
  const params = [];

  if (title !== undefined) {
    fields.push("title = ?");
    params.push(title);
  }
  if (description !== undefined) {
    fields.push("description = ?");
    params.push(description);
  }
  if (body !== undefined) {
    fields.push("body = ?");
    params.push(body);
  }
  if (newSlug !== undefined) {
    fields.push("slug = ?");
    params.push(newSlug);
  }
  if (status !== undefined) {
    fields.push("status = ?");
    params.push(status);
  }

  if (!fields.length) return true;
  fields.push("updatedAt = NOW()");

  params.push(authorId, slug);
  const [result] = await pool.query(
    `
      UPDATE articles
         SET ${fields.join(", ")}
       WHERE author_id = ? AND slug = ?
       LIMIT 1
    `,
    params
  );
  return result.affectedRows > 0;
}

// Return article id by slug (helper)
export async function findArticleIdBySlug(slug) {
  const [rows] = await pool.query(
    `SELECT id FROM articles WHERE slug = ? LIMIT 1`,
    [slug]
  );
  return rows[0]?.id || null;
}

export async function addFavorite({ userId, articleId }) {
  await pool.query(
    `INSERT IGNORE INTO article_favorites (user_id, article_id) VALUES (?, ?)`,
    [userId, articleId]
  );
}

export async function removeFavorite({ userId, articleId }) {
  await pool.query(
    `DELETE FROM article_favorites WHERE user_id = ? AND article_id = ? LIMIT 1`,
    [userId, articleId]
  );
}
