import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { DatabaseService } from '../../database/database.service.js';
import { runtimeConfig } from '../../config/runtime-config.js';
import type { PoolClient } from 'pg';
import type { StudentOperationsWorkspacePrincipal as Principal } from './student-operations-workspace.service.js';
import { hasStudentOperationsPermission } from './student-operations-policy.js';

const querySchema=z.object({page:z.coerce.number().int().min(1).default(1),limit:z.coerce.number().int().min(1).max(100).default(25),q:z.string().trim().max(200).default(''),status:z.enum(['all','unresolved','college','supplier','other']).default('unresolved'),direction:z.enum(['asc','desc']).default('asc'),scope:z.enum(['sales','active','all']).default('sales'),includeColleges:z.enum(['true','false']).default('true')});
const decisionSchema=z.object({
  classification:z.enum(['college','supplier','other','unresolved']),
  collegeId:z.uuid().nullable(),supplierId:z.uuid().nullable().optional(),
  expectedRevision:z.number().int().min(0),
  create:z.object({name:z.string().trim().min(1).max(200),email:z.union([z.email(),z.literal('')]).optional(),phone:z.string().trim().max(50).optional(),notes:z.string().trim().max(4000).optional(),closed:z.boolean(),supplierType:z.enum(['services','products']).default('services')}).strict().optional(),
}).strict().refine(v=>{
  if(v.create)return ['college','supplier'].includes(v.classification)&&!v.collegeId&&!v.supplierId;
  return (v.classification==='college')===(v.collegeId!==null)&&(v.classification==='supplier')===!!v.supplierId;
});

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
    const {page,limit,q,status,direction,scope,includeColleges}=parsed.data,s=runtimeConfig().schema;
    return this.database.tenantReadTransaction(p.tenantId,async db=>{
      await this.connection(db,p.tenantId,connectionId);
      // Aggregate the local sales read model once, using the register's visibility rules.
      // The review queue counts contacts, never individual invoices or archived suppliers.
      const result=await db.query(`WITH sales AS (
        SELECT i.xero_contact_id,count(*)::int AS transactions
        FROM ${s}.student_operations_xero_invoices i
        JOIN ${s}.student_operations_xero_sync_runs seen ON seen.customer_id=i.customer_id AND seen.sync_run_id=i.last_seen_sync_run_id
        WHERE i.customer_id=$1 AND i.xero_connection_id=$2
          AND i.invoice_type IN ('ACCREC','ACCRECCREDIT','RECEIVE-PREPAYMENT','RECEIVE-OVERPAYMENT')
          AND i.invoice_status IN ('DRAFT','SUBMITTED','AUTHORISED','PAID')
          AND seen.created_at>=COALESCE((SELECT max(r.created_at) FROM ${s}.student_operations_xero_sync_runs r
            WHERE r.customer_id=$1 AND r.xero_connection_id=$2 AND r.status='succeeded' AND r.mode IN ('initial','reconciliation')),seen.created_at)
        GROUP BY i.xero_contact_id
      ), contacts AS (
        SELECT c.xero_contact_id AS "contactId",c.legal_name AS name,c.email,c.contact_status AS "contactStatus",
          m.college_id AS "collegeId",d.name AS "collegeName",m.supplier_id AS "supplierId",sd.name AS "supplierName",COALESCE(m.classification,'unresolved') AS classification,
          COALESCE(m.revision,0) AS revision,COALESCE(sales.transactions,0) AS "invoiceCount"
        FROM ${s}.student_operations_xero_contacts c
        LEFT JOIN sales USING(xero_contact_id)
        LEFT JOIN ${s}.student_college_xero_contact_links m USING(customer_id,xero_connection_id,xero_contact_id)
        LEFT JOIN ${s}.student_contact_review_directory d ON d.customer_id=m.customer_id AND d.id=m.college_id AND d.kind='college'
        LEFT JOIN ${s}.student_contact_review_directory sd ON sd.customer_id=m.customer_id AND sd.id=m.supplier_id AND sd.kind='supplier'
        WHERE c.customer_id=$1 AND c.xero_connection_id=$2
      ), filtered AS (
        SELECT * FROM contacts WHERE ($3='' OR name ILIKE '%'||$3||'%' OR email ILIKE '%'||$3||'%')
          AND ($4='all' OR classification=$4)
          AND ($7='all' OR ("contactStatus"='ACTIVE' AND ($7='active' OR "invoiceCount">0)))
      ), page AS (
        SELECT * FROM filtered ORDER BY lower(name) ${direction.toUpperCase()},"contactId" LIMIT $5 OFFSET $6
      ) SELECT COALESCE((SELECT jsonb_agg(p ORDER BY lower(p.name) ${direction.toUpperCase()},p."contactId") FROM page p),'[]'::jsonb) AS items,
        (SELECT count(*)::int FROM filtered) AS total,
        (SELECT jsonb_build_object('importedContacts',count(*),'activeContacts',count(*) FILTER(WHERE "contactStatus"='ACTIVE'),
          'archivedContacts',count(*) FILTER(WHERE "contactStatus"='ARCHIVED'),
          'salesContacts',count(*) FILTER(WHERE "invoiceCount">0),
          'pendingSalesContacts',count(*) FILTER(WHERE "contactStatus"='ACTIVE' AND "invoiceCount">0 AND classification='unresolved'),
          'salesTransactions',COALESCE(sum("invoiceCount"),0),
          'linkedTransactions',COALESCE(sum("invoiceCount") FILTER(WHERE classification='college' AND "collegeName" IS NOT NULL),0)) FROM contacts) AS summary`,
        [p.tenantId,connectionId,q,status,limit,(page-1)*limit,scope]);
      const directory=includeColleges==='true'?await db.query(`SELECT id,name,kind,status,trading_name AS "tradingName",acronym FROM ${s}.student_contact_review_directory WHERE customer_id=$1 ORDER BY lower(name),id`,[p.tenantId]):null;
      return {...result.rows[0],page,limit,...(directory?{
        colleges:directory.rows.filter(r=>r.kind==='college').map(r=>({...r,collegeId:r.id})),
        suppliers:directory.rows.filter(r=>r.kind==='supplier').map(r=>({...r,supplierId:r.id}))}: {})};
    });
  }
  async resolve(p:Principal,connectionId:string,contactId:string,input:unknown){
    this.authorize(p);const parsed=decisionSchema.safeParse(input);
    if(!parsed.success||!z.uuid().safeParse(contactId).success)throw new BadRequestException('Select a college or supplier, or complete the new record details.');
    const value=parsed.data,s=runtimeConfig().schema;
    return this.database.tenantTransaction(p.tenantId,async db=>{
      await this.connection(db,p.tenantId,connectionId);
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`college-auto-match:${p.tenantId}:${connectionId}`]);
      const contact=await db.query(`SELECT xero_contact_id FROM ${s}.student_operations_xero_contacts WHERE customer_id=$1 AND xero_connection_id=$2 AND xero_contact_id=$3 FOR UPDATE`,[p.tenantId,connectionId,contactId]);
      if(!contact.rows.length)throw new NotFoundException('Xero contact not found.');
      if(value.collegeId){const college=await db.query(`SELECT id AS college_id FROM ${s}.student_contact_review_directory WHERE customer_id=$1 AND id=$2 AND kind='college'`,[p.tenantId,value.collegeId]);if(!college.rows.length)throw new BadRequestException('Select an available college.');}
      const previous=(await db.query(`SELECT college_id,classification,revision,supplier_id FROM ${s}.student_college_xero_contact_links WHERE customer_id=$1 AND xero_connection_id=$2 AND xero_contact_id=$3 FOR UPDATE`,[p.tenantId,connectionId,contactId])).rows[0];
      if(Number(previous?.revision??0)!==value.expectedRevision)throw new ConflictException('This mapping changed. Reload before reviewing it.');
      if(value.supplierId){const supplier=await db.query(`SELECT id FROM ${s}.student_contact_review_directory WHERE customer_id=$1 AND id=$2 AND kind='supplier'`,[p.tenantId,value.supplierId]);if(!supplier.rows.length)throw new BadRequestException('Select an available supplier.');}
      if(value.create){
        const record=(await db.query(`SELECT ${s}.create_contact_review_record($1,$2::jsonb,$3) AS id`,[value.classification,JSON.stringify(value.create),p.identityUserId])).rows[0];
        if(value.classification==='college')value.collegeId=record.id;else value.supplierId=record.id;
      }
      const updated=(await db.query(`INSERT INTO ${s}.student_college_xero_contact_links(customer_id,xero_connection_id,xero_contact_id,college_id,classification,reviewed_by,supplier_id)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(customer_id,xero_connection_id,xero_contact_id) DO UPDATE SET
        supplier_id=EXCLUDED.supplier_id,college_id=EXCLUDED.college_id,classification=EXCLUDED.classification,reviewed_by=EXCLUDED.reviewed_by,reviewed_at=now(),revision=student_college_xero_contact_links.revision+1
        RETURNING college_id,classification,revision,supplier_id`,[p.tenantId,connectionId,contactId,value.collegeId,value.classification,p.identityUserId,value.supplierId??null])).rows[0];
      await db.query(`INSERT INTO ${s}.student_college_xero_mapping_events(customer_id,xero_connection_id,xero_contact_id,actor_identity,previous_value,confirmed_value)
        VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,[p.tenantId,connectionId,contactId,p.identityUserId,previous?JSON.stringify(previous):null,JSON.stringify(updated)]);
      return updated;
    }).catch(error=>{if(error?.code==='23505')throw new ConflictException('A record with this name already exists. Select it from the list.');throw error;});
  }
}
