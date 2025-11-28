import pool from "../config/db.js";

export async function createPreAssessment({
  userId,
  siteInput,
  planningData,
  geminiSummary,
  pdfUrl,
  status = "completed",
}) {
  const query = `
    INSERT INTO pre_assessments
      (user_id, site_input, planning_data, gemini_summary, pdf_url, status)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *;
  `;
  const values = [
    userId,
    siteInput,
    planningData,
    geminiSummary,
    pdfUrl,
    status,
  ];
  const { rows } = await pool.query(query, values);
  return rows[0];
}

export async function getPreAssessmentById(id, userId) {
  const { rows } = await pool.query(
    `SELECT * FROM pre_assessments WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  return rows[0] || null;
}

export async function listPreAssessmentsForUser(
  userId,
  limit = 20,
  offset = 0
) {
  const { rows } = await pool.query(
    `
      SELECT * FROM pre_assessments
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
    `,
    [userId, limit, offset]
  );
  return rows;
}
