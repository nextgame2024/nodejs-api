import {ConflictException} from '@nestjs/common';
import type {PoolClient} from 'pg';
import {caseSchema} from './student-operations-cases.service.js';

/** Serialize a new college assignment with the last-case contact archive decision. */
export async function assertCollegeContactAvailable(db:PoolClient,tenant:string,collegeId:string){
  const s=caseSchema();
  await db.query(`SELECT xc.xero_contact_id FROM ${s}.student_college_xero_contact_links m
    JOIN ${s}.student_operations_xero_contacts xc USING(customer_id,xero_connection_id,xero_contact_id)
    WHERE m.customer_id=$1 AND m.college_id=$2
    ORDER BY xc.xero_connection_id,xc.xero_contact_id FOR UPDATE OF xc`,[tenant,collegeId]);
  const reserved=await db.query(`SELECT 1 FROM ${s}.student_college_xero_contact_links m
    JOIN ${s}.student_case_deletions d ON d.customer_id=m.customer_id
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(d.targets->'contacts','[]')) c
    WHERE m.customer_id=$1 AND m.college_id=$2 AND d.completed_at IS NULL
      AND c->>'connectionId'=m.xero_connection_id::text AND c->>'contactId'=m.xero_contact_id::text LIMIT 1`,[tenant,collegeId]);
  if(reserved.rowCount)throw new ConflictException('Finish the case deletion using this college contact before assigning it to another case.');
}
