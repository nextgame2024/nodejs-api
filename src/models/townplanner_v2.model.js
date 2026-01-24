import { pool } from "./db.js";

export async function createReportRequestV2({
  token,
  addressLabel,
  placeId,
  lat,
  lng,
  status = "queued",
  pdfUrl = null,
  pdfKey = null,
  reportJson = null,
  planningSnapshot = null,
  inputsHash = null,
}) {
  const { rows } = await pool.query(
    `
    INSERT INTO townplanner_report_requests_v2
      (token, address_label, place_id, lat, lng, status, pdf_url, pdf_key, report_json, planning_snapshot, inputs_hash)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT (token)
    DO UPDATE SET
      address_label = EXCLUDED.address_label,
      place_id = EXCLUDED.place_id,
      lat = EXCLUDED.lat,
      lng = EXCLUDED.lng,
      status = EXCLUDED.status,
      pdf_url = EXCLUDED.pdf_url,
      pdf_key = EXCLUDED.pdf_key,
      report_json = EXCLUDED.report_json,
      planning_snapshot = EXCLUDED.planning_snapshot,
      inputs_hash = EXCLUDED.inputs_hash,
      updated_at = NOW()
    RETURNING *
    `,
    [
      token,
      addressLabel,
      placeId,
      lat,
      lng,
      status,
      pdfUrl,
      pdfKey,
      reportJson,
      planningSnapshot,
      inputsHash,
    ]
  );

  return rows[0] || null;
}

export async function updateReportRequestV2(token, patch) {
  const fields = [];
  const values = [];
  let i = 1;

  for (const [k, v] of Object.entries(patch || {})) {
    fields.push(`${k} = $${i++}`);
    values.push(v);
  }

  if (fields.length === 0) return null;

  values.push(token);

  const { rows } = await pool.query(
    `
    UPDATE townplanner_report_requests_v2
    SET ${fields.join(", ")}, updated_at = NOW()
    WHERE token = $${i}
    RETURNING *
    `,
    values
  );

  return rows[0] || null;
}

export async function getReportRequestV2(token) {
  const { rows } = await pool.query(
    `
    SELECT *
    FROM townplanner_report_requests_v2
    WHERE token = $1
    LIMIT 1
    `,
    [token]
  );

  return rows[0] || null;
}

/**
 * Cache rule:
 * - Only return a ready report generated "today" (server time).
 * - This prevents stale PDFs from being served across days.
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
    LIMIT 1
    `,
    [inputsHash]
  );

  return rows[0] || null;
}
