import type {PoolClient} from 'pg';
import {runtimeConfig} from '../../config/runtime-config.js';
import {planCollegeNameMatches,collegeNameAliases} from './student-college-name-matching.js';

export async function autoMatchCollegeContacts(db:PoolClient,tenant:string,connectionId:string){
 const s=runtimeConfig().schema;
 const config=await db.query<{organisation_role:string}>(`SELECT organisation_role FROM ${s}.student_operations_xero_sync_configurations WHERE customer_id=$1 AND xero_connection_id=$2 AND enabled`,[tenant,connectionId]);
 if(config.rows[0]?.organisation_role!=='operating')return {matched:0,unresolved:0,compared:0};
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`college-auto-match:${tenant}:${connectionId}`]);
 const contacts=(await db.query<{id:string;name:string;classification:string|null;collegeId:string|null}>(`SELECT c.xero_contact_id AS id,c.legal_name AS name,m.classification,m.college_id AS "collegeId"
  FROM ${s}.student_operations_xero_contacts c LEFT JOIN ${s}.student_college_xero_contact_links m USING(customer_id,xero_connection_id,xero_contact_id)
  WHERE c.customer_id=$1 AND c.xero_connection_id=$2 AND c.contact_status='ACTIVE' ORDER BY c.xero_contact_id LIMIT 20001`,[tenant,connectionId])).rows;
 const colleges=(await db.query<{id:string;name:string;tradingName:string|null;acronym:string|null}>(`SELECT college_id AS id,college_name AS name,trading_name AS "tradingName",acronym FROM ${s}.student_college_matching_directory WHERE customer_id=$1 ORDER BY college_id LIMIT 20001`,[tenant])).rows;
 if(contacts.length>20000||colleges.length>20000)return {matched:0,unresolved:contacts.filter(c=>!c.classification).length,compared:0,capacityReview:true};
 const plan=planCollegeNameMatches(contacts,colleges.map(c=>({...c,aliases:collegeNameAliases(c.tradingName,c.acronym)})));
 if(!plan.matches.length)return {matched:0,unresolved:plan.unresolved,compared:plan.compared};
 // One bulk statement records mappings and audit. Concurrent human decisions
 // win ON CONFLICT; automatic passes never replace existing classifications.
 const inserted=await db.query(`WITH proposed AS (SELECT * FROM jsonb_to_recordset($3::jsonb) AS p("contactId" uuid,"collegeId" uuid,confidence numeric,method text)),
  added AS (INSERT INTO ${s}.student_college_xero_contact_links(customer_id,xero_connection_id,xero_contact_id,college_id,classification,reviewed_by)
   SELECT $1::uuid,$2::uuid,p."contactId",p."collegeId",'college','system:college-name-match:v1' FROM proposed p
   JOIN ${s}.student_operations_xero_contacts c ON c.customer_id=$1 AND c.xero_connection_id=$2 AND c.xero_contact_id=p."contactId" AND c.contact_status='ACTIVE'
   ON CONFLICT(customer_id,xero_connection_id,xero_contact_id) DO NOTHING RETURNING *)
  INSERT INTO ${s}.student_college_xero_mapping_events(customer_id,xero_connection_id,xero_contact_id,actor_identity,previous_value,confirmed_value)
   SELECT a.customer_id,a.xero_connection_id,a.xero_contact_id,a.reviewed_by,NULL,
    jsonb_build_object('college_id',a.college_id,'classification',a.classification,'revision',a.revision,'confidence',p.confidence,'method',p.method,'algorithm','college-name-v1')
   FROM added a JOIN proposed p ON p."contactId"=a.xero_contact_id RETURNING event_id`,[tenant,connectionId,JSON.stringify(plan.matches)]);
 return {matched:inserted.rowCount??0,unresolved:contacts.filter(c=>!c.classification).length-(inserted.rowCount??0),compared:plan.compared};
}
