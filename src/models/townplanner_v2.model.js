import pool from "../config/db.js";

export async function createReportRequestV2({
  token,
  email,
  addressLabel,
  placeId = null,
  lat,
  lng,
  planningSnapshot = null,
}) {
  const sql = `
    INSERT INTO townplanner_report_requests_v2
      (token, email, address_label, place_id, lat, lng, planning_snapshot)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7)
    RETURNING
      id, token, email, address_label, place_id, lat, lng, status, created_at, expires_at
  `;
  const params = [
    token,
    email,
    addressLabel,
    placeId,
    lat,
    lng,
    planningSnapshot,
  ];
  const { rows } = await pool.query(sql, params);
  return rows[0];
}

export async function getReportRequestByTokenV2(token) {
  const sql = `
    SELECT
      id, token, email, address_label, place_id, lat, lng, planning_snapshot,
      status, created_at, expires_at
    FROM townplanner_report_requests_v2
    WHERE token = $1
    LIMIT 1
  `;
  const { rows } = await pool.query(sql, [token]);
  return rows[0] || null;
}

export async function markReportRequestStatusV2({ token, status }) {
  const sql = `
    UPDATE townplanner_report_requests_v2
    SET status = $2
    WHERE token = $1
    RETURNING id, token, status
  `;
  const { rows } = await pool.query(sql, [token, status]);
  return rows[0] || null;
}
