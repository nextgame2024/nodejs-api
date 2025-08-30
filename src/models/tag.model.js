import pool from "../config/db.js";

export async function getAllTags({ limit = 1000, offset = 0 } = {}) {
  const { rows } = await pool.query(
    `SELECT name FROM tags ORDER BY name ASC LIMIT $1 OFFSET $2`,
    [Number(limit), Number(offset)]
  );
  return rows.map((r) => r.name);
}

export async function getTagsByArticleIds(articleIds = []) {
  if (!articleIds.length) return new Map();

  const params = articleIds;
  const placeholders = articleIds.map((_, i) => `$${i + 1}`).join(", ");

  const { rows } = await pool.query(
    `SELECT at.article_id, t.name
     FROM article_tags at
     JOIN tags t ON t.id = at.tag_id
     WHERE at.article_id IN (${placeholders})
     ORDER BY t.name`,
    params
  );

  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.article_id)) map.set(r.article_id, []);
    map.get(r.article_id).push(r.name);
  }
  return map;
}

export async function ensureTags(names = []) {
  const ids = [];
  for (const name of names) {
    const ins = await pool.query(
      `INSERT INTO tags (name) VALUES ($1)
       ON CONFLICT (name) DO NOTHING
       RETURNING id`,
      [name]
    );
    if (ins.rows[0]) {
      ids.push(ins.rows[0].id);
    } else {
      const sel = await pool.query(`SELECT id FROM tags WHERE name = $1`, [
        name,
      ]);
      ids.push(sel.rows[0].id);
    }
  }
  return ids;
}

export async function setArticleTags(articleId, names = []) {
  const ids = await ensureTags(names);
  await pool.query(`DELETE FROM article_tags WHERE article_id = $1`, [
    articleId,
  ]);
  if (!ids.length) return;

  // bulk insert
  const values = ids.map((_, i) => `($1, $${i + 2})`).join(", ");
  await pool.query(
    `INSERT INTO article_tags (article_id, tag_id) VALUES ${values}
     ON CONFLICT DO NOTHING`,
    [articleId, ...ids]
  );
}
