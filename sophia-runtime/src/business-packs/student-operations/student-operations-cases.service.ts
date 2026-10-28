import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { DatabaseService } from '../../database/database.service.js';
import { hasStudentOperationsPermission } from './student-operations-policy.js';
import { ALLOWED_STAGE_STATUSES, CASE_STAGE_LABELS, CASE_STAGES, CASE_STATUS_LABELS, CASE_STATUSES, NEW_CASE_STAGES, publicCaseStatus, resolveCaseWorkflow } from './student-operations-case-workflow.js';
import type { StudentOperationsWorkspacePrincipal as Principal } from './student-operations-workspace.service.js';
import { DOCUMENT_CHECKLIST_KEYS,documentChecklistEnabled,documentChecklistEvidence,reconcileDocumentChecklist } from './student-document-checklist.js';
import {INVOICE_CHECKLIST_KEYS,invoiceChecklistEvidence} from './student-invoice-checklist.js';
import { documentWorkflowEnabled } from './student-document-analysis-state.js';

function caseInvoiceSource(s:string){return {
  ids:`SELECT xero_connection_id,xero_invoice_id FROM ${s}.student_operations_case_invoice_links WHERE customer_id=$1 AND case_id=$2
    UNION SELECT xero_connection_id,xero_invoice_id FROM ${s}.student_case_xero_invoice_exports WHERE customer_id=$1 AND case_id=$2 AND status='created'`,
  joins:`FROM invoice_ids ids
    LEFT JOIN ${s}.student_operations_xero_invoices i ON i.customer_id=$1 AND i.xero_connection_id=ids.xero_connection_id AND i.xero_invoice_id=ids.xero_invoice_id
    LEFT JOIN ${s}.student_case_xero_invoice_exports e ON e.customer_id=$1 AND e.case_id=$2 AND e.xero_connection_id=ids.xero_connection_id AND e.xero_invoice_id=ids.xero_invoice_id AND e.status='created'
    LEFT JOIN ${s}.student_case_invoice_draft_batches b ON b.customer_id=e.customer_id AND b.batch_id=e.batch_id
    LEFT JOIN LATERAL (SELECT value AS invoice FROM jsonb_array_elements(b.snapshot->'invoices') WHERE (value->>'sequence')::int=e.sequence) d ON true`,
};}

const fields = z.object({
  title: z.string().trim().min(1).max(200).nullable().optional(),
  courseName: z.string().trim().min(1).max(200).nullable().optional(),
  advisorUserId: z.string().uuid().nullable().optional(),
  advisorId: z.string().uuid().nullable().optional(),
  collegeId: z.string().uuid().nullable().optional(),
  currentStage: z.enum(CASE_STAGES).optional(),
  status: z.enum(CASE_STATUSES).optional(),
  studentName: z.string().trim().min(1).max(200).optional(),
  studentEmail: z.string().trim().email().max(320).optional(),
  mobile: z.string().trim().max(80).nullable().optional(),
  phone: z.string().trim().max(80).nullable().optional(),
}).strict();
const createSchema = fields.omit({ studentName: true, studentEmail: true, mobile: true, phone: true }).extend({ userId: z.string().uuid() });
const createStudentSchema = fields.omit({ advisorUserId: true }).extend({
  studentName: z.string().trim().min(1).max(200),
  studentEmail: z.string().trim().email().max(320).transform(value=>value.toLowerCase()),
});
const updateSchema = fields.extend({ recordVersion: z.number().int().positive() });
const querySchema = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(25), userId: z.string().uuid().optional() }).strict();
export const PRE_SALE_CHECKLIST = [
  {key:'signed_engagement_letter',label:'Signed engagement letter'},
  {key:'document_completeness',label:'Document completeness'},
  {key:'invoice_loo_consistency',label:'Invoice/LoO consistency'},
  {key:'pending_track_status',label:'Pending Track status'},
] as const;
const checklistUpdateSchema=z.object({
  itemKey:z.enum(['signed_engagement_letter','invoice_loo_consistency','document_completeness','pending_track_status']),
  completed:z.boolean(),recordVersion:z.number().int().min(0),
}).strict();
export function caseSchema(): string {
  const schema = process.env.SOPHIA_RUNTIME_SCHEMA?.trim() || 'sophia_runtime';
  if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) throw new Error('Invalid runtime schema');
  return schema;
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new BadRequestException('Invalid case request.');
  return result.data;
}
export function caseId(value: string): string { return parse(z.string().uuid(), value); }
function assertManage(p: Principal) {
  if (!hasStudentOperationsPermission(p.role, 'cases.manage')) throw new ForbiddenException('Case management permission required.');
}

@Injectable()
export class StudentOperationsCasesService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  options() {
    return { statuses: CASE_STATUSES, stages: NEW_CASE_STAGES, stageLabels: CASE_STAGE_LABELS, statusLabels: CASE_STATUS_LABELS, allowedStatuses: ALLOWED_STAGE_STATUSES, migratedStageLabel: CASE_STAGE_LABELS.imported_pending_review, caseNumberFormat: 'CASE-1' };
  }

  async editOptions(p: Principal) {
    assertManage(p);
    return this.database.tenantReadTransaction(p.tenantId, async db => {
      const s = caseSchema();
      const [advisors, colleges] = await Promise.all([
        db.query(`SELECT advisor_id AS "advisorId",code,name,xero_label AS "xeroLabel" FROM ${s}.student_operations_advisor_directory WHERE customer_id=$1 AND status='active' ORDER BY lower(name),advisor_id`, [p.tenantId]),
        db.query(`SELECT college_id AS "collegeId",college_name AS name FROM ${s}.student_operations_college_directory WHERE customer_id=$1 ORDER BY lower(college_name),college_id`, [p.tenantId]),
      ]);
      return { advisors: advisors.rows, colleges: colleges.rows };
    });
  }

  async list(p: Principal, input: unknown) {
    const q = parse(querySchema, input);
    return this.database.tenantReadTransaction(p.tenantId, async db => {
      const s = caseSchema();
      const where = `c.customer_id=$1 AND ($2::uuid IS NULL OR l.user_id=$2)
        AND ($3::boolean OR EXISTS (SELECT 1 FROM ${s}.student_operations_case_advisors a WHERE a.customer_id=c.customer_id AND a.case_id=c.case_id AND a.is_primary AND a.advisor_user_id::text=$4))`;
      const params = [p.tenantId, q.userId ?? null, hasStudentOperationsPermission(p.role, 'cases.read_all'), p.identityUserId];
      const count = await db.query(`SELECT count(*)::int total FROM ${s}.student_operations_cases c JOIN ${s}.student_operations_student_user_links l ON l.customer_id=c.customer_id AND l.student_id=c.student_id WHERE ${where}`, params);
      const rows = await db.query(`SELECT c.case_id AS "caseId",c.case_reference AS "caseNumber",l.user_id AS "userId", l.student_reference AS "studentReference", c.title, c.course_name AS "courseName",c.current_stage AS "currentStage",CASE WHEN c.lifecycle_status='open' THEN 'in_progress' WHEN c.lifecycle_status='completed' THEN 'closed' ELSE c.lifecycle_status END AS status,c.record_version AS "recordVersion"
        FROM ${s}.student_operations_cases c JOIN ${s}.student_operations_student_user_links l ON l.customer_id=c.customer_id AND l.student_id=c.student_id
        WHERE ${where} ORDER BY c.created_at DESC,c.case_id LIMIT $5 OFFSET $6`, [...params, q.limit, (q.page - 1) * q.limit]);
      return { cases: rows.rows, page: q.page, limit: q.limit, total: count.rows[0].total };
    });
  }

  async authorizedCase(db: PoolClient, p: Principal, id: string, lock = false) {
    const s = caseSchema();
    const rows = await db.query(`SELECT c.*,l.user_id,l.student_reference FROM ${s}.student_operations_cases c
      JOIN ${s}.student_operations_student_user_links l ON l.customer_id=c.customer_id AND l.student_id=c.student_id
      WHERE c.customer_id=$1 AND c.case_id=$2
        AND ($3::boolean OR EXISTS (SELECT 1 FROM ${s}.student_operations_case_advisors a WHERE a.customer_id=c.customer_id AND a.case_id=c.case_id AND a.is_primary AND a.advisor_user_id::text=$4)) ${lock ? 'FOR UPDATE OF c' : ''}`,
    [p.tenantId, caseId(id), hasStudentOperationsPermission(p.role, 'cases.read_all'), p.identityUserId]);
    if (!rows.rows[0]) throw new NotFoundException('Case not found.');
    return rows.rows[0];
  }

  async get(p: Principal, id: string) {
    return this.database.tenantReadTransaction(p.tenantId, async db => {
      const row = await this.authorizedCase(db, p, id);
      const s = caseSchema();
      const student = await db.query(`SELECT profile.legal_name AS "legalName",profile.email,profile.advisor_id AS "advisorId",directory.name AS "businessAdvisorName",
        contact.mobile AS "studentMobile",contact.phone AS "studentPhone"
        FROM ${s}.student_operations_students profile
        LEFT JOIN ${s}.student_operations_advisor_directory directory
          ON directory.customer_id=profile.customer_id AND directory.advisor_id=profile.advisor_id
        LEFT JOIN ${s}.student_operations_case_contact contact
          ON contact.customer_id=profile.customer_id AND contact.case_id=$3
        WHERE profile.customer_id=$1 AND profile.student_id=$2`, [p.tenantId,row.student_id,id]);
      const advisors = await db.query(`SELECT a.advisor_user_id AS "userId",r.display_name AS name,a.is_primary AS "isPrimary" FROM ${s}.student_operations_case_advisors a LEFT JOIN ${s}.student_operations_advisor_roster r ON r.customer_id=a.customer_id AND r.user_id=a.advisor_user_id WHERE a.customer_id=$1 AND a.case_id=$2 ORDER BY a.is_primary DESC,a.assigned_at,a.advisor_user_id`, [p.tenantId,id]);
      const colleges = await db.query(`SELECT a.college_id AS "collegeId",coalesce(d.college_name,c.college_name) AS name,a.is_primary AS "isPrimary" FROM ${s}.student_operations_case_colleges a JOIN ${s}.student_operations_colleges c ON c.customer_id=a.customer_id AND c.college_id=a.college_id LEFT JOIN ${s}.student_operations_college_directory d ON d.customer_id=a.customer_id AND d.college_id=a.college_id WHERE a.customer_id=$1 AND a.case_id=$2`, [p.tenantId,id]);
      return { caseId: row.case_id, caseNumber: row.case_reference, userId: row.user_id, studentId: row.student_id, studentReference: row.student_reference, studentName: student.rows[0]?.legalName ?? null, studentEmail: student.rows[0]?.email ?? null, studentMobile: student.rows[0]?.studentMobile ?? null, studentPhone: student.rows[0]?.studentPhone ?? null, advisorId: student.rows[0]?.advisorId ?? null, advisorName: student.rows[0]?.businessAdvisorName ?? null, title: row.title, courseName: row.course_name, status: publicCaseStatus(row.lifecycle_status), currentStage: row.current_stage, openedOn: row.opened_on, recordVersion: row.record_version, createdAt: row.created_at, updatedAt: row.updated_at, advisors: advisors.rows, colleges: colleges.rows };
    });
  }

  async create(p: Principal, input: unknown, key?: string) {
    assertManage(p);
    const value = parse(createSchema, input);
    const workflow = resolveCaseWorkflow(null, null, value.currentStage, value.status);
    if(documentWorkflowEnabled()&&workflow.stage==='checklist_complete')throw new BadRequestException('Approve the required documents before selecting Verified Documents.');
    return this.write(p, 'case.create', value, key, db=>this.insertCase(db,p,value,workflow));
  }

  async createStudent(p: Principal, input: unknown, key?: string) {
    assertManage(p);
    const value=parse(createStudentSchema,input);
    const workflow=resolveCaseWorkflow(null,null,value.currentStage,value.status);
    if(documentWorkflowEnabled()&&workflow.stage==='checklist_complete')throw new BadRequestException('Approve the required documents before selecting Verified Documents.');
    try {
      return await this.write(p,'case.create_student',value,key,async db=>{
        const account=await db.query(`SELECT ${caseSchema()}.create_student_case_account($1,$2,$3,$4) AS user_id`,
          [value.studentName,value.studentEmail,value.mobile??null,value.phone??null]);
        const created=await this.insertCase(db,p,{...value,userId:account.rows[0].user_id},workflow);
        await this.activity(db,p,String(created.caseId),'student.created','User created');
        await db.query(`INSERT INTO ${caseSchema()}.student_operations_student_audit_events
          (customer_id,student_id,actor_identity_user_id,event_type,record_version,changed_fields,correlation_id)
          SELECT customer_id,student_id,$3,'student.created',1,$4::text[],$5
          FROM ${caseSchema()}.student_operations_student_user_links WHERE customer_id=$1 AND user_id=$2`,
          [p.tenantId,account.rows[0].user_id,p.identityUserId,['studentReference','legalName','email'],randomUUID()]);
        return created;
      });
    } catch(error) {
      if((error as {code?:string}).code==='23505') throw new ConflictException('Student email or identifier is already in use.');
      throw error;
    }
  }

  private async insertCase(db:PoolClient,p:Principal,value:z.infer<typeof fields>&{userId:string},workflow:{stage:string;status:string}) {
      const s = caseSchema();
      await db.query(`SELECT ${s}.initialize_student_document_requirements($1)`,[p.externalCompanyId]);
      const profile = await db.query(`SELECT ${s}.ensure_student_operations_profile($1) AS id`, [value.userId]);
      const row = await db.query(`INSERT INTO ${s}.student_operations_cases(customer_id,student_id,case_reference,case_kind,title,course_name,current_stage,lifecycle_status,closed_on)
        VALUES($1,$2,'CASE-' || nextval('${s}.student_operations_case_number_seq')::text,'student_operations',$3,$4,$5,$6,CASE WHEN $6 IN ('closed','completed','cancelled') THEN CURRENT_DATE END) RETURNING case_id`,
      [p.tenantId,profile.rows[0].id,value.title ?? null,value.courseName ?? null,workflow.stage,workflow.status]);
      const id = row.rows[0].case_id;
      await this.assign(db,p,id,value);
      await this.assignBusinessAdvisor(db,p,profile.rows[0].id,value.advisorId);
      await this.activity(db,p,id,'case.created','Case created');
      return { caseId: id, recordVersion: 1 };
  }

  async update(p: Principal, id: string, input: unknown, key?: string) {
    assertManage(p); caseId(id);
    const value = parse(updateSchema,input);
    return this.write(p,'case.update',{caseId:id,...value},key,async db => {
      await db.query(`SELECT ${caseSchema()}.initialize_student_document_requirements($1)`,[p.externalCompanyId]);
      const row = await this.authorizedCase(db,p,id,true);
      if (row.record_version !== value.recordVersion) throw new ConflictException('Case changed. Reload before saving.');
      const workflow = resolveCaseWorkflow(row.current_stage,row.lifecycle_status,value.currentStage,value.status);
      if(documentWorkflowEnabled()&&workflow.stage==='checklist_complete'){
        const evidence=await documentChecklistEvidence(db,p.tenantId,id);
        if(!evidence.completed.signed_engagement_letter||!evidence.completed.document_completeness)throw new ConflictException('Approve all required documents before selecting Verified Documents.');
      }
      if(documentWorkflowEnabled()&&(workflow.status!==row.lifecycle_status||workflow.stage!==row.current_stage))await db.query(`UPDATE ${caseSchema()}.student_operations_cases SET document_review_hold=false WHERE customer_id=$1 AND case_id=$2`,[p.tenantId,id]);
      await db.query(`UPDATE ${caseSchema()}.student_operations_cases SET title=$3,course_name=$4,current_stage=$5,lifecycle_status=$6,closed_on=CASE WHEN $6 IN ('closed','completed','cancelled') THEN coalesce(closed_on,CURRENT_DATE) ELSE NULL END,record_version=record_version+1,updated_at=now() WHERE customer_id=$1 AND case_id=$2`,
      [p.tenantId,id,value.title === undefined ? row.title : value.title,value.courseName === undefined ? row.course_name : value.courseName,workflow.stage,workflow.status]);
      await this.assign(db,p,id,value);
      await this.assignBusinessAdvisor(db,p,row.student_id,value.advisorId);
      if (value.studentName !== undefined || value.studentEmail !== undefined || value.mobile !== undefined || value.phone !== undefined) {
        const profile = await db.query(`SELECT s.legal_name AS name,s.email,contact.mobile,contact.phone FROM ${caseSchema()}.student_operations_students s JOIN ${caseSchema()}.student_operations_cases c ON c.customer_id=s.customer_id AND c.student_id=s.student_id LEFT JOIN ${caseSchema()}.student_operations_case_contact contact ON contact.customer_id=c.customer_id AND contact.case_id=c.case_id WHERE c.customer_id=$1 AND c.case_id=$2`, [p.tenantId,id]);
        if (!profile.rows[0]) throw new NotFoundException('Case student profile unavailable.');
        try {
          await db.query(`SELECT ${caseSchema()}.update_student_case_profile($1,$2,$3,$4,$5)`, [id,value.studentName ?? profile.rows[0].name,value.studentEmail ?? profile.rows[0].email,value.mobile === undefined ? profile.rows[0].mobile : value.mobile,value.phone === undefined ? profile.rows[0].phone : value.phone]);
        } catch (error) {
          if ((error as { code?: string }).code === '23505') throw new ConflictException('Student email is already in use.');
          throw error;
        }
      }
      await this.activity(db,p,id,'case.updated','Case details updated');
      await reconcileDocumentChecklist(db,p.tenantId,id);
      return {caseId:id,recordVersion:row.record_version+1};
    });
  }

  private async assign(db: PoolClient,p: Principal,id: string,value: z.infer<typeof fields>) {
    const s=caseSchema();
    if (value.advisorUserId !== undefined) {
      let name: string | null=null;
      if(value.advisorUserId) {
        const advisor=await db.query(`SELECT display_name FROM ${s}.student_operations_advisor_roster WHERE customer_id=$1 AND user_id=$2`,[p.tenantId,value.advisorUserId]);
        if(!advisor.rows[0]) throw new BadRequestException('Advisor is not eligible in this workspace.');
        name=advisor.rows[0].display_name;
      }
      // Historical assignments remain available for audit, but only the primary
      // advisor grants access (see the access predicate below).
      await db.query(`UPDATE ${s}.student_operations_case_advisors SET is_primary=false WHERE customer_id=$1 AND case_id=$2`,[p.tenantId,id]);
      if(value.advisorUserId) await db.query(`INSERT INTO ${s}.student_operations_case_advisors(customer_id,case_id,company_id,advisor_user_id,is_primary) VALUES($1,$2,$3,$4,true) ON CONFLICT(customer_id,case_id,advisor_user_id) DO UPDATE SET is_primary=true`,[p.tenantId,id,p.externalCompanyId,value.advisorUserId]);
      await db.query(`UPDATE ${s}.student_operations_cases SET advisor_name=$3 WHERE customer_id=$1 AND case_id=$2`,[p.tenantId,id,name]);
    }
    if(value.collegeId !== undefined) {
      if(value.collegeId) {
        const college=await db.query(`SELECT college_name FROM ${s}.student_operations_college_directory WHERE customer_id=$1 AND college_id=$2`,[p.tenantId,value.collegeId]);
        if(!college.rows[0]) throw new BadRequestException('College is not available in this workspace.');
        await db.query(`INSERT INTO ${s}.student_operations_colleges(customer_id,college_id,college_name) VALUES($1,$2,$3) ON CONFLICT(customer_id,college_id) DO UPDATE SET college_name=excluded.college_name`,[p.tenantId,value.collegeId,college.rows[0].college_name]);
      }
      await db.query(`UPDATE ${s}.student_operations_case_colleges SET is_primary=false WHERE customer_id=$1 AND case_id=$2`,[p.tenantId,id]);
      if(value.collegeId) await db.query(`INSERT INTO ${s}.student_operations_case_colleges(customer_id,case_id,college_id,is_primary) VALUES($1,$2,$3,true) ON CONFLICT(customer_id,case_id,college_id) DO UPDATE SET is_primary=true`,[p.tenantId,id,value.collegeId]);
    }
  }

  private async assignBusinessAdvisor(db: PoolClient,p: Principal,studentId: string,advisorId: string | null | undefined) {
    if (advisorId === undefined) return;
    const s=caseSchema();
    if (advisorId) {
      const advisor=await db.query(`SELECT 1 FROM ${s}.student_operations_advisor_directory WHERE customer_id=$1 AND advisor_id=$2 AND status='active'`,[p.tenantId,advisorId]);
      if (!advisor.rows[0]) throw new BadRequestException('Advisor is not available in this workspace.');
    }
    await db.query(`UPDATE ${s}.student_operations_students SET advisor_id=$3,updated_at=now() WHERE customer_id=$1 AND student_id=$2`,[p.tenantId,studentId,advisorId]);
  }

  async invoices(p: Principal,id: string,input: unknown) {
    const q=parse(querySchema.omit({userId:true}),input);
    return this.database.tenantReadTransaction(p.tenantId,async db=>{
      await this.authorizedCase(db,p,id);
      const s=caseSchema();
      const financial=hasStudentOperationsPermission(p.role,'payments.read_all');
      // Creation receipts are authoritative even before local indexing finishes.
      // Use the same deduplicated set for rows and pagination/counts; never count
      // drafts or uncertain provider outcomes as linked invoices.
      const {ids:invoiceIds,joins}=caseInvoiceSource(s);
      const rows=await db.query(`WITH invoice_ids AS (${invoiceIds})
        SELECT ids.xero_connection_id AS "connectionId",ids.xero_invoice_id AS "invoiceId",coalesce(i.invoice_number,e.xero_invoice_number) AS "invoiceNumber",
          coalesce(i.invoice_status,e.provider_status,'DRAFT') AS status,coalesce(i.invoice_type,'ACCREC') AS type,
          coalesce(i.invoice_date,(d.invoice->>'issueDate')::date) AS date,coalesce(i.due_date,(d.invoice->>'dueDate')::date) AS "dueDate",
          e.batch_id AS "draftBatchId",e.sequence AS "draftSequence"
          ${financial?`,CASE WHEN i.xero_invoice_id IS NOT NULL THEN i.invoice_reference ELSE b.snapshot->>'collegeName' END AS reference,
            CASE WHEN i.xero_invoice_id IS NOT NULL THEN i.payment_track ELSE 'PENDING' END AS "paymentTrack",
            coalesce(i.currency_code,b.snapshot->>'currency') AS currency,coalesce(i.total,(d.invoice->>'totalMinor')::numeric/100) AS total,
            coalesce(i.amount_paid,0) AS "amountPaid",coalesce(i.amount_due,(d.invoice->>'totalMinor')::numeric/100) AS "amountDue"`:''}
        ${joins}
        ORDER BY date DESC NULLS LAST,ids.xero_invoice_id,ids.xero_connection_id LIMIT $3 OFFSET $4`,[p.tenantId,id,q.limit,(q.page-1)*q.limit]);
      const count=await db.query(`SELECT count(*)::int total FROM (${invoiceIds}) invoices`,[p.tenantId,id]);
      return {invoices:rows.rows,total:count.rows[0].total,page:q.page,limit:q.limit};
    });
  }

  async invoiceDetail(p:Principal,id:string,connectionId:string|null,invoiceId:string){
    if(!hasStudentOperationsPermission(p.role,'payments.read_all'))throw new ForbiddenException('Invoice financial access required.');
    const value=parse(z.object({connectionId:z.uuid().nullable(),invoiceId:z.uuid()}),{connectionId,invoiceId});
    return this.database.tenantReadTransaction(p.tenantId,async db=>{
      const c=await this.authorizedCase(db,p,id),s=caseSchema(),source=caseInvoiceSource(s);
      const rows=(await db.query(`WITH invoice_ids AS (${source.ids})
        SELECT ids.xero_connection_id AS "connectionId",ids.xero_invoice_id AS "invoiceId",i.xero_invoice_id IS NOT NULL AS indexed,
          coalesce(i.invoice_number,e.xero_invoice_number) AS "invoiceNumber",coalesce(i.invoice_status,e.provider_status,'DRAFT') AS status,
          coalesce(i.invoice_type,'ACCREC') AS type,coalesce(i.invoice_date,(d.invoice->>'issueDate')::date) AS date,
          coalesce(i.due_date,(d.invoice->>'dueDate')::date) AS "dueDate",coalesce(i.currency_code,b.snapshot->>'currency') AS currency,
          CASE WHEN i.xero_invoice_id IS NOT NULL THEN i.invoice_reference ELSE b.snapshot->>'collegeName' END AS reference,
          CASE WHEN i.xero_invoice_id IS NOT NULL THEN i.advisor_name ELSE b.snapshot->>'advisorLabel' END AS "advisorName",
          CASE WHEN i.xero_invoice_id IS NOT NULL THEN i.payment_track ELSE 'PENDING' END AS "paymentTrack",
          coalesce(i.total,(d.invoice->>'totalMinor')::numeric/100) AS total,coalesce(i.amount_paid,0) AS "amountPaid",
          coalesce(i.amount_due,(d.invoice->>'totalMinor')::numeric/100) AS "amountDue",i.line_items AS "lineItems",
          i.provider_updated_at AS "updatedAt",i.last_seen_sync_run_id IS NOT NULL AS synchronized,d.invoice AS draft,b.snapshot AS snapshot,profile.legal_name AS "studentName"
        ${source.joins}
        JOIN ${s}.student_operations_students profile ON profile.customer_id=$1 AND profile.student_id=$5
        WHERE ($3::uuid IS NULL OR ids.xero_connection_id=$3) AND ids.xero_invoice_id=$4 LIMIT 2`,[p.tenantId,id,value.connectionId,value.invoiceId,c.student_id])).rows;
      if(rows.length>1)throw new ConflictException('More than one linked invoice has this identity. Reload the invoice list before opening its details.');
      const row=rows[0];
      if(!row)throw new NotFoundException('Case invoice not found.');
      const {indexed,synchronized,draft,snapshot,...detail}=row;
      if(!indexed||(!synchronized&&!detail.lineItems?.length&&draft)){
        const tracking=[{name:'Payment Track',option:'PENDING'},{name:'Sales Representative',option:snapshot.advisorLabel}];
        detail.lineItems=draft.lines.map((line:Record<string,any>)=>({lineItemId:null,itemCode:line.itemCode,description:line.description,quantity:Number(line.quantity),discountRate:null,
          unitAmount:line.unitPrice!==undefined?Number(line.unitPrice):Number(line.unitAmountMinor)/100,accountCode:line.accountCode,taxType:line.taxType,
          taxAmount:line.taxAmountMinor===undefined?null:Number(line.taxAmountMinor)/100,lineAmount:line.amountMinor===undefined?null:Number(line.amountMinor)/100,tracking}));
        if(draft.conditionalFeeMinor>0)detail.lineItems.push({lineItemId:null,itemCode:null,description:'Conditional transfer fee',quantity:1,unitAmount:draft.conditionalFeeMinor/100,discountRate:null,
          accountCode:draft.lines[0].accountCode,taxType:'BASEXCLUDED',taxAmount:0,lineAmount:draft.conditionalFeeMinor/100,tracking});
      }
      return {...detail,lineItems:Array.isArray(detail.lineItems)?detail.lineItems:[]};
    });
  }

  async linkInvoice(p: Principal,id: string,input: unknown,key?: string) {
    assertManage(p);caseId(id);
    const value=parse(z.object({connectionId:z.string().uuid(),invoiceId:z.string().uuid()}).strict(),input);
    return this.write(p,'case.link_invoice',{caseId:id,...value},key,async db=>{
      const row=await this.authorizedCase(db,p,id,true);
      const s=caseSchema();
      const invoice=await db.query(`SELECT student_id FROM ${s}.student_operations_xero_invoices WHERE customer_id=$1 AND xero_connection_id=$2 AND xero_invoice_id=$3`,[p.tenantId,value.connectionId,value.invoiceId]);
      if(invoice.rows[0]?.student_id !== row.student_reference) throw new BadRequestException('Invoice must be linked to this student first.');
      const existing=await db.query(`SELECT case_id FROM ${s}.student_operations_case_invoice_links WHERE customer_id=$1 AND xero_connection_id=$2 AND xero_invoice_id=$3`,[p.tenantId,value.connectionId,value.invoiceId]);
      if(existing.rows[0] && existing.rows[0].case_id !== id) throw new ConflictException('Invoice is already assigned to another case.');
      await db.query(`INSERT INTO ${s}.student_operations_case_invoice_links(customer_id,case_id,student_id,student_reference,xero_connection_id,xero_invoice_id,linked_by_identity) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,[p.tenantId,id,row.student_id,row.student_reference,value.connectionId,value.invoiceId,p.identityUserId]);
      await this.activity(db,p,id,'case.invoice_linked','Invoice associated with case');
      return {caseId:id,invoiceId:value.invoiceId};
    });
  }

  async activities(p:Principal,id:string,input:unknown) {
    const q=parse(querySchema.omit({userId:true}),input);
    return this.database.tenantReadTransaction(p.tenantId,async db=>{
      await this.authorizedCase(db,p,id);
      const result=await db.query(`SELECT a.activity_id AS "activityId",a.event_type AS "eventType",a.summary,a.created_at AS "createdAt",
        coalesce(a.detail->>'actorName',r.display_name,CASE WHEN a.actor_identity_user_id ~ '^(migration:|system:|worker:|sophia:)' THEN 'SophiaAi' ELSE 'User unavailable' END) AS "actorName"
        FROM ${caseSchema()}.student_operations_case_activity a
        LEFT JOIN ${caseSchema()}.student_operations_advisor_roster r ON r.customer_id=a.customer_id AND r.user_id::text=a.actor_identity_user_id
        WHERE a.customer_id=$1 AND a.case_id=$2 ORDER BY a.created_at DESC,a.activity_id DESC LIMIT $3 OFFSET $4`,[p.tenantId,id,q.limit,(q.page-1)*q.limit]);
      return {activity:result.rows,page:q.page,limit:q.limit};
    });
  }

  async activity(db:PoolClient,p:Principal,id:string,event:string,summary:string) {
    await db.query(`INSERT INTO ${caseSchema()}.student_operations_case_activity(customer_id,case_id,actor_identity_user_id,event_type,summary,detail)
      VALUES($1,$2,$3,$4,$5,jsonb_build_object('actorKind','user','actorName',coalesce((SELECT display_name FROM ${caseSchema()}.student_operations_advisor_roster WHERE customer_id=$1 AND user_id::text=$3),'User unavailable')))`,[p.tenantId,id,p.identityUserId,event,summary]);
  }

  private async checklistRows(db:PoolClient,p:Principal,id:string) {
    const result=await db.query(`SELECT item_key,completed,record_version,actor_name,updated_at FROM ${caseSchema()}.student_operations_case_checklist WHERE customer_id=$1 AND case_id=$2 AND checklist_status='pre_sale'`,[p.tenantId,id]);
    const evidence=documentChecklistEnabled()?await documentChecklistEvidence(db,p.tenantId,id):null;
    const financial=documentChecklistEnabled()?await invoiceChecklistEvidence(db,p.tenantId,id,caseSchema()):null;
    return PRE_SALE_CHECKLIST.map(item=>{
      const row=result.rows.find(r=>r.item_key===item.key);
      const documentAutomatic=Boolean(evidence&&DOCUMENT_CHECKLIST_KEYS.some(key=>key===item.key));
      const financialAutomatic=Boolean(financial&&INVOICE_CHECKLIST_KEYS.some(key=>key===item.key));
      // Read-only freshness guard: never display stale acceptance after expiry/replacement.
      const eligible=!documentAutomatic||evidence!.completed[item.key as typeof DOCUMENT_CHECKLIST_KEYS[number]];
      return {...item,completed:Boolean(row?.completed&&eligible),recordVersion:row?.record_version??0,updatedBy:row?.actor_name??null,updatedAt:row?.updated_at??null,
        ...(documentAutomatic?{automatic:true,validationState:evidence!.validation[item.key as typeof DOCUMENT_CHECKLIST_KEYS[number]],hint:item.key==='signed_engagement_letter'?'Updated from the latest engagement letter check.':'Updated when all required documents have passed their checks.'}:financialAutomatic?{automatic:true,validationState:row?.completed?'passed':'checking',hint:item.key==='invoice_loo_consistency'?'Completed when every reviewed invoice is confirmed in Xero.':'Completed when all created invoice lines have confirmed PENDING tracking.'}:{})};
    });
  }

  async checklist(p:Principal,id:string) {
    return this.database.tenantReadTransaction(p.tenantId,async db=>{
      const row=await this.authorizedCase(db,p,id);
      return {status:publicCaseStatus(row.lifecycle_status),items:await this.checklistRows(db,p,id)};
    });
  }

  async updateChecklist(p:Principal,id:string,input:unknown,key?:string) {
    assertManage(p);caseId(id);
    const value=parse(checklistUpdateSchema,input);
    return this.write(p,'case.checklist.update',{caseId:id,...value},key,async db=>{
      // Serialize all four items and case status changes, including first completion.
      const row=await this.authorizedCase(db,p,id,true);
      if(publicCaseStatus(row.lifecycle_status)!=='pre_sale')throw new ConflictException('This checklist is only editable for Pre-sale cases.');
      if(documentChecklistEnabled()&&DOCUMENT_CHECKLIST_KEYS.some(key=>key===value.itemKey))throw new ConflictException('This item is updated from document checks. Review the latest documents instead.');
      if(documentChecklistEnabled()&&INVOICE_CHECKLIST_KEYS.some(key=>key===value.itemKey)&&await invoiceChecklistEvidence(db,p.tenantId,id,caseSchema()))throw new ConflictException('This item is updated from confirmed Xero invoices. Review the invoice outcomes and tracking instead.');
      await reconcileDocumentChecklist(db,p.tenantId,id);
      const before=await this.checklistRows(db,p,id),item=before.find(i=>i.key===value.itemKey)!;
      if(item.recordVersion!==value.recordVersion)throw new ConflictException('Checklist changed. Reload before saving.');
      if(item.completed!==value.completed){
        await db.query(`INSERT INTO ${caseSchema()}.student_operations_case_checklist(customer_id,case_id,item_key,completed,actor_identity_user_id,actor_kind,actor_name)
          VALUES($1,$2,$3,$4,$5,'user',coalesce((SELECT display_name FROM ${caseSchema()}.student_operations_advisor_roster WHERE customer_id=$1 AND user_id::text=$5),'User unavailable'))
          ON CONFLICT(customer_id,case_id,checklist_status,item_key) DO UPDATE SET completed=excluded.completed,record_version=student_operations_case_checklist.record_version+1,actor_identity_user_id=excluded.actor_identity_user_id,actor_kind=excluded.actor_kind,actor_name=excluded.actor_name,updated_at=now()`,[p.tenantId,id,value.itemKey,value.completed,p.identityUserId]);
        await this.activity(db,p,id,'case.checklist_item_updated',`${item.label} ${value.completed?'completed':'reopened'}`);
      }
      const items=await this.checklistRows(db,p,id);
      if(!before.every(i=>i.completed)&&items.every(i=>i.completed))await this.activity(db,p,id,'case.checklist_completed','Checklist complete');
      if(before.every(i=>i.completed)&&!items.every(i=>i.completed))await this.activity(db,p,id,'case.checklist_reopened','Checklist reopened');
      return {status:'pre_sale',items};
    });
  }

  async write(p:Principal,operation:string,value:unknown,key:string|undefined,work:(db:PoolClient)=>Promise<Record<string,unknown>>) {
    const token=parse(z.string().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/),key);
    const fingerprint=createHash('sha256').update(JSON.stringify(value)).digest('hex');
    return this.database.tenantTransaction(p.tenantId,async db=>{
      const s=caseSchema();
      await db.query(`INSERT INTO ${s}.student_operations_write_requests(customer_id,actor_identity_user_id,idempotency_key,operation,request_fingerprint) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[p.tenantId,p.identityUserId,token,operation,fingerprint]);
      const saved=await db.query(`SELECT operation,request_fingerprint,response FROM ${s}.student_operations_write_requests WHERE customer_id=$1 AND actor_identity_user_id=$2 AND idempotency_key=$3 FOR UPDATE`,[p.tenantId,p.identityUserId,token]);
      const row=saved.rows[0];
      if(row.operation!==operation || row.request_fingerprint!==fingerprint) throw new ConflictException('Idempotency key has already been used for another request.');
      if(row.response) return row.response;
      const response=await work(db);
      await db.query(`UPDATE ${s}.student_operations_write_requests SET response=$4::jsonb WHERE customer_id=$1 AND actor_identity_user_id=$2 AND idempotency_key=$3`,[p.tenantId,p.identityUserId,token,JSON.stringify(response)]);
      return response;
    });
  }
}
