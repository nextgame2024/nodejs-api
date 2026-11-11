import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { DatabaseService } from '../../database/database.service.js';
import { runtimeConfig } from '../../config/runtime-config.js';
import type { PoolClient } from 'pg';
import type { StudentOperationsWorkspacePrincipal as Principal } from './student-operations-workspace.service.js';
import { hasStudentOperationsPermission } from './student-operations-policy.js';

const querySchema=z.object({page:z.coerce.number().int().min(1).default(1),limit:z.coerce.number().int().min(1).max(100).default(25),q:z.string().trim().max(200).default(''),status:z.enum(['all','unresolved','college','other']).default('unresolved'),direction:z.enum(['asc','desc']).default('asc')});
const decisionSchema=z.object({classification:z.enum(['college','other','unresolved']),collegeId:z.uuid().nullable(),expectedRevision:z.number().int().min(0)}).strict()
  .refine(v=>(v.classification==='college')===(v.collegeId!==null));

@Injectable()
export class StudentCollegeMatchingService {
  constructor(private readonly database:DatabaseService){}
  private authorize(p:Principal){if(!hasStudentOperationsPermission(p.role,'integrations.manage'))throw new ForbiddenException('Chief Executive access is required to review college mappings.');}
  private async connection(db:PoolClient,tenant:string,id:string){
    if(!z.uuid().safeParse(id).success)throw new NotFoundException('PTY organisation not found.');
    const s=runtimeConfig().schema;
    const result=await db.query(`SELECT c.xero_connection_id FROM ${s}.student_operations_xero_sync_configurations c
      JOIN ${s}.xero_connections x ON x.customer_id=c.customer_id AND x.xero_connection_id=c.xero_connection_id
      WHERE c.customer_id=$1 AND c.xero_connection_id=$2 AND c.organisation_role='operating' AND c.enabled AND x.status='active'`,[tenant,id]);
    if(!result.rows.length)throw new NotFoundException('PTY organisation not found.');
  }
  async list(p:Principal,connectionId:string,input:unknown){
    this.authorize(p);const parsed=querySchema.safeParse(input);if(!parsed.success)throw new BadRequestException('Check the college matching filters.');
    const {page,limit,q,status,direction}=parsed.data,s=runtimeConfig().schema;
    return this.database.tenantReadTransaction(p.tenantId,async db=>{
      await this.connection(db,p.tenantId,connectionId);
      const result=await db.query(`SELECT c.xero_contact_id AS "contactId",c.legal_name AS name,c.email,c.contact_status AS "contactStatus",
        m.college_id AS "collegeId",d.college_name AS "collegeName",COALESCE(m.classification,'unresolved') AS classification,
        COALESCE(m.revision,0) AS revision,count(*) OVER()::int AS total,
        (SELECT count(*)::int FROM ${s}.student_operations_xero_invoices i WHERE i.customer_id=c.customer_id AND i.xero_connection_id=c.xero_connection_id AND i.xero_contact_id=c.xero_contact_id) AS "invoiceCount"
        FROM ${s}.student_operations_xero_contacts c
        LEFT JOIN ${s}.student_college_xero_contact_links m USING(customer_id,xero_connection_id,xero_contact_id)
        LEFT JOIN ${s}.student_operations_college_directory d ON d.customer_id=m.customer_id AND d.college_id=m.college_id
        WHERE c.customer_id=$1 AND c.xero_connection_id=$2
          AND ($3='' OR c.legal_name ILIKE '%'||$3||'%' OR c.email ILIKE '%'||$3||'%')
          AND ($4='all' OR COALESCE(m.classification,'unresolved')=$4)
        ORDER BY lower(c.legal_name) ${direction.toUpperCase()},c.xero_contact_id LIMIT $5 OFFSET $6`,[p.tenantId,connectionId,q,status,limit,(page-1)*limit]);
      const colleges=await db.query(`SELECT college_id AS "collegeId",college_name AS name,trading_name AS "tradingName",acronym FROM ${s}.student_college_matching_directory WHERE customer_id=$1 ORDER BY lower(college_name),college_id`,[p.tenantId]);
      return {items:result.rows,total:Number(result.rows[0]?.total??0),page,limit,colleges:colleges.rows};
    });
  }
  async resolve(p:Principal,connectionId:string,contactId:string,input:unknown){
    this.authorize(p);const parsed=decisionSchema.safeParse(input);
    if(!parsed.success||!z.uuid().safeParse(contactId).success)throw new BadRequestException('Select a college or classify this contact.');
    const value=parsed.data,s=runtimeConfig().schema;
    return this.database.tenantTransaction(p.tenantId,async db=>{
      await this.connection(db,p.tenantId,connectionId);
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`college-auto-match:${p.tenantId}:${connectionId}`]);
      const contact=await db.query(`SELECT xero_contact_id FROM ${s}.student_operations_xero_contacts WHERE customer_id=$1 AND xero_connection_id=$2 AND xero_contact_id=$3 FOR UPDATE`,[p.tenantId,connectionId,contactId]);
      if(!contact.rows.length)throw new NotFoundException('Xero contact not found.');
      if(value.collegeId){const college=await db.query(`SELECT college_id FROM ${s}.student_operations_college_directory WHERE customer_id=$1 AND college_id=$2`,[p.tenantId,value.collegeId]);if(!college.rows.length)throw new BadRequestException('Select an available college.');}
      const previous=(await db.query(`SELECT college_id,classification,revision FROM ${s}.student_college_xero_contact_links WHERE customer_id=$1 AND xero_connection_id=$2 AND xero_contact_id=$3 FOR UPDATE`,[p.tenantId,connectionId,contactId])).rows[0];
      if(Number(previous?.revision??0)!==value.expectedRevision)throw new ConflictException('This mapping changed. Reload before reviewing it.');
      const updated=(await db.query(`INSERT INTO ${s}.student_college_xero_contact_links(customer_id,xero_connection_id,xero_contact_id,college_id,classification,reviewed_by)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(customer_id,xero_connection_id,xero_contact_id) DO UPDATE SET
        college_id=EXCLUDED.college_id,classification=EXCLUDED.classification,reviewed_by=EXCLUDED.reviewed_by,reviewed_at=now(),revision=student_college_xero_contact_links.revision+1
        RETURNING college_id,classification,revision`,[p.tenantId,connectionId,contactId,value.collegeId,value.classification,p.identityUserId])).rows[0];
      await db.query(`INSERT INTO ${s}.student_college_xero_mapping_events(customer_id,xero_connection_id,xero_contact_id,actor_identity,previous_value,confirmed_value)
        VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,[p.tenantId,connectionId,contactId,p.identityUserId,previous?JSON.stringify(previous):null,JSON.stringify(updated)]);
      return updated;
    });
  }
}
