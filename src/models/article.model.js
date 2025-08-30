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
  const uid = userId || "";

  const { where, params, nextIndex } = buildArticleFilters({
    author,
    favoritedBy,
    tag,
  });
  const filters = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const rowsSql = `
    SELECT
      a.id, a.slug, a.title, a.description, a.body,
      a.createdAt, a.updatedAt, a.status,
      u.username, u.image, u.bio,
      (SELECT COUNT(*) FROM article_favorites af WHERE af.article_id = a.id) AS "favoritesCount",
      EXISTS(
        SELECT 1 FROM article_favorites af2
        WHERE af2.article_id = a.id AND af2.user_id = $${nextIndex}
      ) AS favorited,
      EXISTS(
        SELECT 1 FROM follows f
        WHERE f.follower_id = $${nextIndex + 1} AND f.followee_id = a.author_id
      ) AS following
    FROM articles a
    JOIN users u ON u.id = a.author_id
    ${filters}
    ORDER BY a.createdAt DESC
    LIMIT $${nextIndex + 2} OFFSET $${nextIndex + 3}
  `;

  const rowsParams = [...params, uid, uid, Number(limit), Number(offset)];
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

/** Feed (followed authors) with total count */
export async function getFeedArticles({ userId, limit = 1000, offset = 0 }) {
  const uid = userId || "";
  const rowsSql = `
    SELECT
      a.id, a.slug, a.title, a.description, a.body,
      a.createdAt, a.updatedAt, a.status,
      u.username, u.image, u.bio,
      (SELECT COUNT(*) FROM article_favorites af WHERE af.article_id = a.id) AS "favoritesCount",
      EXISTS(
        SELECT 1 FROM article_favorites af2
        WHERE af2.article_id = a.id AND af2.user_id = $1
      ) AS favorited
    FROM follows f
    JOIN articles a ON a.author_id = f.followee_id
    JOIN users u    ON u.id        = a.author_id
    WHERE f.follower_id = $1
    ORDER BY a.createdAt DESC
    LIMIT $2 OFFSET $3
  `;
  const { rows } = await pool.query(rowsSql, [
    uid,
    Number(limit),
    Number(offset),
  ]);

  const { rows: cnt } = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM follows f
     JOIN articles a ON a.author_id = f.followee_id
     WHERE f.follower_id = $1`,
    [uid]
  );

  return { rows, total: cnt[0]?.total ?? 0 };
}

/** One article by slug */
export async function findArticleBySlug({ slug, userId = "" }) {
  const uid = userId || "";
  const { rows } = await pool.query(
    `
    SELECT
      a.id, a.slug, a.title, a.description, a.body,
      a.createdAt, a.updatedAt, a.status,
      u.username, u.image, u.bio,
      (SELECT COUNT(*) FROM article_favorites af WHERE af.article_id = a.id) AS "favoritesCount",
      EXISTS(
        SELECT 1 FROM article_favorites af2
        WHERE af2.article_id = a.id AND af2.user_id = $1
      ) AS favorited,
      EXISTS(
        SELECT 1 FROM follows f
        WHERE f.follower_id = $2 AND f.followee_id = a.author_id
      ) AS following
    FROM articles a
    JOIN users u ON u.id = a.author_id
    WHERE a.slug = $3
    LIMIT 1
    `,
    [uid, uid, slug]
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

export async function insertArticle({
  authorId,
  slug,
  title,
  description,
  body,
}) {
  const { rows } = await pool.query(
    `INSERT INTO articles (id, slug, title, description, body, author_id)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
     RETURNING id`,
    [slug, title, description, body, authorId]
  );
  return rows[0].id;
}

export async function updateArticleBySlugForAuthor({
  slug,
  authorId,
  title,
  description,
  body,
  newSlug,
}) {
  const sets = [];
  const params = [];
  let i = 1;

  if (title !== undefined) {
    sets.push(`title = $${i++}`);
    params.push(title);
  }
  if (description !== undefined) {
    sets.push(`description = $${i++}`);
    params.push(description);
  }
  if (body !== undefined) {
    sets.push(`body = $${i++}`);
    params.push(body);
  }
  if (newSlug !== undefined) {
    sets.push(`slug = $${i++}`);
    params.push(newSlug);
  }

  if (!sets.length) return true;

  sets.push(`updatedAt = NOW()`);
  params.push(authorId, slug);

  const { rowCount } = await pool.query(
    `UPDATE articles SET ${sets.join(", ")} WHERE author_id = $${i++} AND slug = $${i} `,
    params
  );
  return rowCount > 0;
}

export async function findArticleIdBySlug(slug) {
  const { rows } = await pool.query(
    `SELECT id FROM articles WHERE slug = $1 LIMIT 1`,
    [slug]
  );
  return rows[0]?.id || null;
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
