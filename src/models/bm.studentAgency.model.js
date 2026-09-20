import pool from "../config/db.js";

export async function searchStudentKnowledge(companyId, query) {
  const { rows } = await pool.query(
    `SELECT knowledge_id AS "knowledgeId", topic, question, answer,
       previous_rule AS "previousRule", current_rule AS "currentRule",
       new_student_impact AS "newStudentImpact",
       current_student_impact AS "currentStudentImpact",
       applicability, change_status AS "changeStatus",
       effective_from AS "effectiveFrom", effective_to AS "effectiveTo",
       sources, verified_at AS "verifiedAt", review_due_at AS "reviewDueAt"
     FROM bm_student_agency_knowledge
     WHERE company_id = $1 AND publication_status = 'approved'
       AND verified_at <= now() AND review_due_at > now()
       AND to_tsvector('english', topic || ' ' || question || ' ' || answer)
           @@ to_tsquery('english', replace(plainto_tsquery('english', $2)::text, ' & ', ' | '))
     ORDER BY verified_at DESC LIMIT 5`,
    [companyId, query],
  );
  return rows;
}
