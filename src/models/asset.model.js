import pool from "../config/db.js";

/** Insert a single asset row */
export async function insertAsset({
  articleId,
  type, // 'image' | 'audio' | 'video'
  url,
  s3Key = null,
  mimeType = null,
  durationSec = null,
  width = null,
  height = null,
  metadata = null,
}) {
  await pool.query(
    `INSERT INTO assets (article_id, type, url, s3_key, mime_type, duration_sec, width, height, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      articleId,
      type,
      url,
      s3Key,
      mimeType,
      durationSec,
      width,
      height,
      metadata ? JSON.stringify(metadata) : null,
    ]
  );
}

/** Map<article_id, AssetDTO[]> */
export async function getAssetsByArticleIds(articleIds = []) {
  if (!articleIds.length) return new Map();
  const placeholders = articleIds.map(() => "?").join(",");
  const [rows] = await pool.query(
    `SELECT id, article_id, type, url, mime_type, duration_sec, width, height, createdAt
       FROM assets
      WHERE article_id IN (${placeholders})
      ORDER BY createdAt ASC`,
    articleIds
  );
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.article_id)) map.set(r.article_id, []);
    map.get(r.article_id).push({
      id: r.id,
      type: r.type,
      url: r.url,
      mimeType: r.mime_type,
      durationSec: r.duration_sec ? Number(r.duration_sec) : null,
      width: r.width,
      height: r.height,
      createdAt: r.createdAt,
    });
  }
  return map;
}
