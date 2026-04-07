import pool from "../config/db.js";

/** build WHERE + params for optional filters */
function buildArticleFilters({ author, favoritedBy, tag }) {
  const where = [];
  const params = [];
  let i = 1;

  if (author) {
    where.push(`u.username = $${i++}`);
    params.push(author);
  }
  if (favoritedBy) {
    where.push(`EXISTS (
      SELECT 1 FROM article_favorites af2
      JOIN users favu ON favu.id = af2.user_id
      WHERE af2.article_id = a.id AND favu.username = $${i++}
    )`);
    params.push(favoritedBy);
  }
  if (tag) {
    where.push(`EXISTS (
      SELECT 1 FROM article_tags at
      JOIN tags t ON t.id = at.tag_id
      WHERE at.article_id = a.id AND t.name = $${i++}
    )`);
    params.push(tag);
  }
  return { where, params, nextIndex: i };
}

/** All articles with total count (pagination + filters) */
export async function getAllArticles({
  userId = null,
  limit = 1000,
  offset = 0,
  author,
  favoritedBy,
  tag,
} = {}) {
  const uid = userId ?? null;
  const { where, params, nextIndex } = buildArticleFilters({
    author,
    favoritedBy,
    tag,
  });
  const filters = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const rowsSql = `
    SELECT
      a.id, a.slug, a.title, a.description, a.body,
      a.createdat AS "createdAt",
      a.updatedat AS "updatedAt",
      a.status,
      u.username, u.image, u.bio,
      (SELECT COUNT(*) FROM article_favorites af WHERE af.article_id = a.id) AS "favoritesCount",
      EXISTS(
        SELECT 1 FROM article_favorites af2
        WHERE af2.article_id = a.id AND af2.user_id = $${nextIndex}
      ) AS favorited
    FROM articles a
    JOIN users u ON u.id = a.author_id
    ${filters}
    ORDER BY a.createdat DESC
    LIMIT $${nextIndex + 1} OFFSET $${nextIndex + 2}
  `;
  const rowsParams = [...params, uid, Number(limit), Number(offset)];
  const { rows } = await pool.query(rowsSql, rowsParams);

  const countSql = `
    SELECT COUNT(*)::int AS total
    FROM articles a
    JOIN users u ON u.id = a.author_id
    ${filters}
  `;
  const { rows: cnt } = await pool.query(countSql, params);
  const total = cnt[0]?.total ?? 0;

  return { rows, total };
}

/** One article by slug */
export async function findArticleBySlug({ slug, userId = "" }) {
  const uid = userId ?? null;
  const { rows } = await pool.query(
    `
    SELECT
      a.id, a.slug, a.title, a.description, a.body,
      a.createdat AS "createdAt",
      a.updatedat AS "updatedAt",
      a.status,
      u.username, u.image, u.bio,
      (SELECT COUNT(*) FROM article_favorites af WHERE af.article_id = a.id) AS "favoritesCount",
      EXISTS(
        SELECT 1 FROM article_favorites af2
        WHERE af2.article_id = a.id AND af2.user_id = $1
      ) AS favorited
    FROM articles a
    JOIN users u ON u.id = a.author_id
    WHERE a.slug = $2
    LIMIT 1
    `,
    [uid, slug]
  );
  return rows[0] || null;
}

export async function findArticleAuthorId(slug) {
  const { rows } = await pool.query(
    `SELECT author_id FROM articles WHERE slug = $1 LIMIT 1`,
    [slug]
  );
  return rows[0]?.author_id || null;
}

export async function deleteArticleBySlug({ slug, userId }) {
  const { rowCount } = await pool.query(
    `DELETE FROM articles WHERE slug = $1 AND author_id = $2`,
    [slug, userId]
  );
  return rowCount || 0;
}

export async function findArticleIdBySlug(slug) {
  const { rows } = await pool.query(
    `SELECT id FROM articles WHERE slug = $1 LIMIT 1`,
    [slug]
  );
  return rows[0]?.id || null;
}

export async function getArticleSlugById(id) {
  const { rows } = await pool.query(
    `SELECT slug FROM articles WHERE id=$1 LIMIT 1`,
    [id]
  );
  return rows[0]?.slug || null;
}

export async function addFavorite({ userId, articleId }) {
  await pool.query(
    `INSERT INTO article_favorites (user_id, article_id)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [userId, articleId]
  );
}

export async function removeFavorite({ userId, articleId }) {
  await pool.query(
    `DELETE FROM article_favorites WHERE user_id = $1 AND article_id = $2`,
    [userId, articleId]
  );
}

// Get prompt + title + slug by article id
export async function getArticlePromptById(articleId) {
  const { rows } = await pool.query(
    `SELECT prompt, title, slug FROM articles WHERE id = $1 LIMIT 1`,
    [articleId]
  );
  return rows[0] || null;
}

// Optional convenience
export async function getArticlePromptBySlug(slug) {
  const { rows } = await pool.query(
    `SELECT id, prompt, title, slug FROM articles WHERE slug = $1 LIMIT 1`,
    [slug]
  );
  return rows[0] || null;
}
