import pool from "../config/db.js";

export async function createReportRequestV2({
  token,
  email,
  addressLabel,
  placeId = null,
  lat,
  lng,
  planningSnapshot = null,
  inputsHash = null,
}) {
  const sql = `
    INSERT INTO townplanner_report_requests_v2
      (token, email, address_label, place_id, lat, lng, planning_snapshot, inputs_hash, status, started_at, updated_at)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', NULL, now())
    RETURNING
      id, token, email, address_label, place_id, lat, lng, planning_snapshot,
      status, created_at, expires_at, inputs_hash, pdf_url, pdf_key, report_json, error_message
  `;
  const params = [
    token,
    email,
    addressLabel,
    placeId,
    lat,
    lng,
    planningSnapshot,
    inputsHash,
  ];
  const { rows } = await pool.query(sql, params);
  return rows[0];
}

export async function getReportRequestByTokenV2(token) {
  const sql = `
    SELECT
      id, token, email, address_label, place_id, lat, lng, planning_snapshot,
      status, created_at, expires_at, inputs_hash,
      pdf_key, pdf_url, report_json, error_message, started_at, completed_at, updated_at
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
    SET status = $2, updated_at = now()
    WHERE token = $1
    RETURNING id, token, status
  `;
  const { rows } = await pool.query(sql, [token, status]);
  return rows[0] || null;
}

export async function markReportRunningV2({ token }) {
  const sql = `
    UPDATE townplanner_report_requests_v2
    SET status = 'running', started_at = COALESCE(started_at, now()), updated_at = now()
    WHERE token = $1
    RETURNING id, token, status, started_at
  `;
  const { rows } = await pool.query(sql, [token]);
  return rows[0] || null;
}

export async function markReportReadyV2({ token, pdfKey, pdfUrl, reportJson }) {
  const sql = `
    UPDATE townplanner_report_requests_v2
    SET status = 'ready',
        pdf_key = $2,
        pdf_url = $3,
        report_json = $4,
        error_message = NULL,
        completed_at = now(),
        updated_at = now()
    WHERE token = $1
    RETURNING id, token, status, pdf_url
  `;
  const { rows } = await pool.query(sql, [token, pdfKey, pdfUrl, reportJson]);
  return rows[0] || null;
}

export async function markReportFailedV2({ token, errorMessage }) {
  const sql = `
    UPDATE townplanner_report_requests_v2
    SET status = 'failed',
        error_message = $2,
        completed_at = now(),
        updated_at = now()
    WHERE token = $1
    RETURNING id, token, status, error_message
  `;
  const { rows } = await pool.query(sql, [token, errorMessage]);
  return rows[0] || null;
}

/**
 * Optional caching: find an existing READY report by inputs_hash.
 */
export async function findReadyReportByHashV2(inputsHash) {
  const sql = `
    SELECT
      id, token, status, pdf_url, pdf_key, report_json, created_at
    FROM townplanner_report_requests_v2
    WHERE inputs_hash = $1 AND status = 'ready'
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const { rows } = await pool.query(sql, [inputsHash]);
  return rows[0] || null;
}
