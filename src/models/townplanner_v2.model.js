import pool from "../config/db.js";

export async function createReportRequestV2({
  token,
  email,
  addressLabel,
  placeId,
  lat,
  lng,
  planningSnapshot = null,
  inputsHash = null,
}) {
  const sql = `
    INSERT INTO townplanner_report_requests_v2
      (token, email, address_label, place_id, lat, lng, planning_snapshot, status, created_at, updated_at, expires_at, inputs_hash)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7, 'queued', NOW(), NOW(), NOW() + INTERVAL '7 days', $8)
    RETURNING *;
  `;

  const { rows } = await pool.query(sql, [
    token,
    email,
    addressLabel,
    placeId,
    lat,
    lng,
    planningSnapshot,
    inputsHash,
  ]);

  return rows[0] || null;
}

export async function getReportRequestByTokenV2(token) {
  const { rows } = await pool.query(
    `SELECT * FROM townplanner_report_requests_v2 WHERE token = $1 LIMIT 1`,
    [token]
  );
  return rows[0] || null;
}

export async function markReportRequestStatusV2({ token, status }) {
  const { rows } = await pool.query(
    `
    UPDATE townplanner_report_requests_v2
    SET status = $2, updated_at = NOW()
    WHERE token = $1
    RETURNING *;
    `,
    [token, status]
  );
  return rows[0] || null;
}

/**
 * SAME-DAY CACHE POLICY:
 * Reuse cached PDF only if it was generated/updated today.
 * Otherwise, force generation of a new report (even if inputs_hash matches).
 */
export async function findReadyReportByHashV2(inputsHash) {
  if (!inputsHash) return null;

  const { rows } = await pool.query(
    `
    SELECT token, pdf_url, pdf_key, status, updated_at
    FROM townplanner_report_requests_v2
    WHERE inputs_hash = $1
      AND status = 'ready'
      AND pdf_url IS NOT NULL
      AND updated_at >= date_trunc('day', NOW())
    ORDER BY updated_at DESC
    LIMIT 1;
    `,
    [inputsHash]
  );

  return rows[0] || null;
}

export async function markReportRunningV2({ token }) {
  const { rows } = await pool.query(
    `
    UPDATE townplanner_report_requests_v2
    SET status = 'running',
        started_at = COALESCE(started_at, NOW()),
        error_message = NULL,
        updated_at = NOW()
    WHERE token = $1
    RETURNING *;
    `,
    [token]
  );
  return rows[0] || null;
}

export async function markReportReadyV2({
  token,
  pdfKey,
  pdfUrl,
  reportJson,
  inputsHash = null,
  planningSnapshot = null,
}) {
  const { rows } = await pool.query(
    `
    UPDATE townplanner_report_requests_v2
    SET status = 'ready',
        pdf_key = $2,
        pdf_url = $3,
        report_json = $4,
        inputs_hash = COALESCE($5, inputs_hash),
        planning_snapshot = COALESCE($6, planning_snapshot),
        completed_at = NOW(),
        error_message = NULL,
        updated_at = NOW()
    WHERE token = $1
    RETURNING *;
    `,
    [token, pdfKey, pdfUrl, reportJson, inputsHash, planningSnapshot]
  );
  return rows[0] || null;
}

export async function markReportFailedV2({ token, errorMessage }) {
  const { rows } = await pool.query(
    `
    UPDATE townplanner_report_requests_v2
    SET status = 'failed',
        error_message = $2,
        completed_at = NOW(),
        updated_at = NOW()
    WHERE token = $1
    RETURNING *;
    `,
    [token, String(errorMessage || "Unknown error")]
  );
  return rows[0] || null;
}
