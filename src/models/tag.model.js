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
