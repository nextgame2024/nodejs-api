import pool from "../config/db.js";

/** Insert a single asset row (image | audio | video) */
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
    `INSERT INTO assets
       (article_id, type, url, s3_key, mime_type, duration_sec, width, height, metadata)
     VALUES ($1,        $2,   $3, $4,    $5,       $6,          $7,   $8,    $9)`,
    [
      articleId,
      type,
      url,
      s3Key,
      mimeType,
      durationSec,
      width,
      height,
      metadata,
    ]
  );
}

/** Returns Map<article_id, AssetDTO[]> for a batch of article ids */
export async function getAssetsByArticleIds(articleIds = []) {
  if (!articleIds.length) return new Map();

  const { rows } = await pool.query(
    `SELECT
       id, article_id, type, url, mime_type, duration_sec, width, height,
       createdat AS "createdAt",
       metadata
     FROM assets
     WHERE article_id = ANY($1::uuid[])
     ORDER BY createdat ASC`,
    [articleIds]
  );

  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.article_id)) map.set(r.article_id, []);
    map.get(r.article_id).push({
      id: r.id,
      type: r.type,
      url: r.url,
      mimeType: r.mime_type,
      durationSec: r.duration_sec !== null ? Number(r.duration_sec) : null,
      width: r.width,
      height: r.height,
      createdAt: r.createdAt,
      metadata: r.metadata ?? null,
    });
  }
  return map;
}

/** Returns AssetDTO[] for a single article id, optional type filter */
export async function getAssetsForArticleId(articleId, type = null) {
  const params = [articleId];
  let where = `article_id = $1`;
  if (type) {
    params.push(type);
    where += ` AND type = $2`;
  }

  const { rows } = await pool.query(
    `SELECT
       id, article_id, type, url, mime_type, duration_sec, width, height,
       createdat AS "createdAt",
       metadata
     FROM assets
     WHERE ${where}
     ORDER BY createdat ASC`,
    params
  );

  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    url: r.url,
    mimeType: r.mime_type,
    durationSec: r.duration_sec !== null ? Number(r.duration_sec) : null,
    width: r.width,
    height: r.height,
    createdAt: r.createdAt,
    metadata: r.metadata ?? null,
  }));
}

/** Return the most recent video asset for an article (url + s3_key, mime_type). */
export async function getLatestVideoForArticle(articleId) {
  const { rows } = await pool.query(
    `SELECT id, url, s3_key, mime_type
       FROM assets
      WHERE article_id = $1 AND type = 'video'
      ORDER BY createdAt DESC, id DESC
      LIMIT 1`,
    [articleId]
  );
  return rows?.[0] || null;
}

export async function getLatestAssetByType(articleId, type) {
  const { rows } = await pool.query(
    `SELECT id, url, s3_key, mime_type
       FROM assets
      WHERE article_id = $1 AND type = $2
      ORDER BY createdAt DESC, id DESC
      LIMIT 1`,
    [articleId, type]
  );
  return rows?.[0] || null;
}
