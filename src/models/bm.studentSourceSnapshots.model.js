import pool from "../config/db.js";
export async function getLatestSnapshot(sourceId) {
  const { rows } = await pool.query(`SELECT snapshot FROM bm_student_source_snapshots
    WHERE source_id=$1 ORDER BY last_checked_at DESC LIMIT 1`, [sourceId]);
  return rows[0]?.snapshot || null;
}
export async function saveSnapshot(sourceId, snapshot) {
  await pool.query(`INSERT INTO bm_student_source_snapshots(source_id, content_hash, snapshot, last_checked_at)
    VALUES ($1,$2,$3,$4) ON CONFLICT(source_id, content_hash) DO UPDATE
    SET snapshot=EXCLUDED.snapshot, last_checked_at=EXCLUDED.last_checked_at`,
  [sourceId, snapshot.contentHash, snapshot, snapshot.fetchedAt]);
}
