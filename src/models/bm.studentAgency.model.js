import pool from "../config/db.js";

export async function searchStudentKnowledge(companyId, query) {
  const { rows } = await pool.query(
    `WITH search AS (
       SELECT to_tsquery('english', replace(plainto_tsquery('english', $2)::text, ' & ', ' | ')) AS terms
     )
     SELECT knowledge_id AS "knowledgeId", topic, question, answer,
       previous_rule AS "previousRule", current_rule AS "currentRule",
       new_student_impact AS "newStudentImpact",
       current_student_impact AS "currentStudentImpact",
       applicability, change_status AS "changeStatus",
       effective_from AS "effectiveFrom", effective_to AS "effectiveTo",
       sources, verified_at AS "verifiedAt", review_due_at AS "reviewDueAt"
     FROM bm_student_agency_knowledge, search
     WHERE company_id = $1 AND publication_status = 'approved'
       AND verified_at <= now() AND review_due_at > now()
       AND (setweight(to_tsvector('english', question), 'A') ||
            setweight(to_tsvector('english', topic), 'B') ||
            setweight(to_tsvector('english', answer), 'C'))
           @@ search.terms
     ORDER BY CASE WHEN to_tsvector('english', topic) @@ search.terms THEN 1 ELSE 0 END DESC,
              ts_rank_cd(
                setweight(to_tsvector('english', question), 'A') ||
                setweight(to_tsvector('english', topic), 'B') ||
                setweight(to_tsvector('english', answer), 'C'),
                search.terms
              ) DESC,
              verified_at DESC
     LIMIT 3`,
    [companyId, query],
  );
  return rows;
}
