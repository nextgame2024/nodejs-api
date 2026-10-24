import type { PoolClient } from 'pg';
import { caseSchema } from './student-operations-cases.service.js';

// Count typed files across the whole case, not only the displayed file page.
export async function documentRequirements(db:PoolClient,tenantId:string,status:string,caseId:string|null=null) {
  const s=caseSchema();
  const result=await db.query(`WITH requirements AS (
    SELECT r.requirement_key,r.document_type_id,t.name,r.required,r.sort_order,t.status='active' AS available
      FROM ${s}.student_operations_status_document_requirements r
      JOIN ${s}.student_operations_document_types t ON t.customer_id=r.customer_id AND t.document_type_id=r.document_type_id
      WHERE r.customer_id=$1 AND r.case_status=$2 AND r.status='active'
    UNION ALL
    SELECT d.requirement_key,NULL::uuid,d.name,true,d.sort_order,false
      FROM ${s}.student_operations_document_requirement_defaults d
      WHERE d.case_status=$2 AND NOT EXISTS(SELECT 1 FROM ${s}.student_operations_status_document_requirements r
        WHERE r.customer_id=$1 AND r.case_status=d.case_status AND r.requirement_key=d.requirement_key)
  ) SELECT r.requirement_key AS "requirementKey",r.document_type_id AS "documentTypeId",r.name,r.required,r.available,
    EXISTS(SELECT 1 FROM ${s}.student_operations_case_documents d WHERE d.customer_id=$1 AND d.case_id=$3 AND d.document_type_id=r.document_type_id) AS uploaded
    FROM requirements r ORDER BY r.sort_order,lower(r.name),r.requirement_key`,[tenantId,status,caseId]);
  return result.rows;
}
