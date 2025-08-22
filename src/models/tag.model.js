import pool from "../config/db.js";

export async function getAllTags({ limit = 1000, offset = 0 } = {}) {
  const [rows] = await pool.query(
    `
    SELECT name
    FROM tags
    ORDER BY name ASC
    LIMIT ? OFFSET ?;
    `,
    [Number(limit), Number(offset)]
  );
  return rows.map((r) => r.name);
}

export async function getTagsByArticleIds(articleIds = []) {
  if (!articleIds.length) return new Map();

  const placeholders = articleIds.map(() => "?").join(",");
  const [rows] = await pool.query(
    `
    SELECT at.article_id, t.name
    FROM article_tags at
    JOIN tags t ON t.id = at.tag_id
    WHERE at.article_id IN (${placeholders})
    ORDER BY t.name;
    `,
    articleIds
  );

  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.article_id)) map.set(r.article_id, []);
    map.get(r.article_id).push(r.name);
  }
  return map;
}

/* Insert tags by name (id is AUTO_INCREMENT), return their ids */
export async function ensureTags(names = []) {
  const ids = [];
  for (const name of names) {
    await pool.query(
      "INSERT INTO tags (name) VALUES (?) ON DUPLICATE KEY UPDATE name = name",
      [name]
    );
    const [row] = await pool.query(
      "SELECT id FROM tags WHERE name = ? LIMIT 1",
      [name]
    );
    ids.push(row[0].id);
  }
  return ids;
}

/* Replace an article's tags with provided names */
export async function setArticleTags(articleId, names = []) {
  const ids = await ensureTags(names);
  await pool.query("DELETE FROM article_tags WHERE article_id = ?", [
    articleId,
  ]);
  if (!ids.length) return;
  const values = ids.map((id) => [articleId, id]);
  await pool.query(
    "INSERT IGNORE INTO article_tags (article_id, tag_id) VALUES ?",
    [values]
  );
}
