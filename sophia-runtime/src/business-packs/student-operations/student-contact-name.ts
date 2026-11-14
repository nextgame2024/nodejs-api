import {ConflictException} from '@nestjs/common';
import type {PoolClient} from 'pg';
import {caseSchema} from './student-operations-cases.service.js';

export function studentContactName(name:string):string {
  return name.trim().replace(/\s+/g,' ');
}

// Exact normalized names only: similar names are not evidence of identity.
// Identity remains the student UUID / provider ContactID, never this label.
export async function assertStudentContactNameAvailable(db:PoolClient,tenant:string,studentId:string,connectionId:string,name:string,contactId:string|null){
  const s=caseSchema();
  const conflicts=await db.query(`SELECT 1 FROM ${s}.student_operations_students
    WHERE customer_id=$1 AND student_id<>$2 AND lower(regexp_replace(btrim(legal_name),'\\s+',' ','g'))=lower($4)
    UNION ALL SELECT 1 FROM ${s}.student_operations_xero_contacts
    WHERE customer_id=$1 AND xero_connection_id=$3 AND contact_status='ACTIVE' AND ($5::uuid IS NULL OR xero_contact_id<>$5)
      AND contact_number IS DISTINCT FROM ('sophia:'||$2::text)
      AND lower(regexp_replace(btrim(legal_name),'\\s+',' ','g'))=lower($4)
    LIMIT 1`,[tenant,studentId,connectionId,studentContactName(name),contactId]);
  if(conflicts.rows.length)throw new ConflictException({errorCode:'student_contact_name_conflict',message:'Another student or Xero contact has this exact name. Review the existing record before continuing; similar names are allowed.'});
}
