import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service.js';
import { XeroConnectorService } from '../../connectors/xero/xero-connector.service.js';
import type { XeroAttachmentSource } from '../../connectors/xero/xero.client.js';
import { StudentOperationsCasesService,caseSchema,caseId } from './student-operations-cases.service.js';
import type { StudentOperationsWorkspacePrincipal as Principal } from './student-operations-workspace.service.js';
import { hasStudentOperationsPermission } from './student-operations-policy.js';
import { StudentDocumentSourceDiscovery } from './student-document-source-discovery.js';

@Injectable()
export class StudentOperationsCaseDocumentsService {
  constructor(@Inject(DatabaseService) private readonly database:DatabaseService,
    private readonly cases:StudentOperationsCasesService,private readonly xero:XeroConnectorService) {}

  async list(p:Principal,id:string,input:unknown={}) {
    const parsed=z.object({page:z.coerce.number().int().min(1).default(1),limit:z.coerce.number().int().min(1).max(100).default(25)}).strict().safeParse(input);
    if(!parsed.success) throw new BadRequestException('Invalid document pagination.');
    const {page,limit}=parsed.data;
    return this.database.tenantReadTransaction(p.tenantId,async db=>{
      await this.cases.authorizedCase(db,p,id);
      if(!hasStudentOperationsPermission(p.role,'documents.metadata.read_all') && !hasStudentOperationsPermission(p.role,'documents.metadata.read_assigned')) throw new ForbiddenException();
      const count=await db.query(`SELECT count(*)::int total FROM ${caseSchema()}.student_operations_case_documents WHERE customer_id=$1 AND case_id=$2`,[p.tenantId,id]);
      const documents=await db.query(`SELECT document_id AS "documentId",file_name AS "fileName",mime_type AS "mimeType",size_bytes::float8 AS "sizeBytes",source_kind AS "sourceKind",last_seen_at AS "lastSeenAt" FROM ${caseSchema()}.student_operations_case_documents WHERE customer_id=$1 AND case_id=$2 ORDER BY file_name,document_id LIMIT $3 OFFSET $4`,[p.tenantId,id,limit,(page-1)*limit]);
      const jobs=await db.query(`SELECT status,error_code AS "errorCode",count(*)::int count FROM ${caseSchema()}.student_operations_document_jobs WHERE customer_id=$1 AND case_id=$2 GROUP BY status,error_code`,[p.tenantId,id]);
      return {documents:documents.rows,discovery:jobs.rows,discoveryRequested:jobs.rows.length>0,page,limit,total:count.rows[0].total};
    });
  }

  async enqueue(p:Principal,id:string) {
    if(!hasStudentOperationsPermission(p.role,'cases.manage')) throw new ForbiddenException();
    return this.database.tenantTransaction(p.tenantId,async db=>{
      await this.cases.authorizedCase(db,p,id);
      const result=await db.query(`INSERT INTO ${caseSchema()}.student_operations_document_jobs(customer_id,case_id,xero_connection_id,source_kind,source_id)
        SELECT DISTINCT $1::uuid,$2::uuid,i.xero_connection_id,s.kind,s.id FROM ${caseSchema()}.student_operations_case_invoice_links l
        JOIN ${caseSchema()}.student_operations_xero_invoices i ON i.customer_id=l.customer_id AND i.xero_connection_id=l.xero_connection_id AND i.xero_invoice_id=l.xero_invoice_id
        CROSS JOIN LATERAL (VALUES
          (CASE i.invoice_type WHEN 'ACCREC' THEN 'Invoices' WHEN 'ACCRECCREDIT' THEN 'CreditNotes' END,i.xero_invoice_id),
          ('Contacts',i.xero_contact_id)) s(kind,id)
        WHERE l.customer_id=$1 AND l.case_id=$2 AND s.kind IS NOT NULL
        ON CONFLICT(customer_id,case_id,xero_connection_id,source_kind,source_id) DO UPDATE
          SET status='queued',attempts=0,next_attempt_at=now(),error_code=NULL,updated_at=now()
          ${process.env.STUDENT_DOCUMENT_SOURCE_DEDUP_ENABLED === 'true' ? ',refresh_requested_at=now()' : ''}
          WHERE student_operations_document_jobs.status IN ('succeeded','failed') RETURNING job_id`,[p.tenantId,id]);
      await this.cases.activity(db,p,id,'case.documents_requested','Document discovery requested');
      return {queued:result.rowCount};
    });
  }

  async content(p:Principal,id:string,documentId:string) {
    caseId(documentId);
    if(!hasStudentOperationsPermission(p.role,'documents.content.read_all') && !hasStudentOperationsPermission(p.role,'documents.content.read_assigned')) throw new ForbiddenException();
    const document=await this.database.tenantTransaction(p.tenantId,async db=>{
      await this.cases.authorizedCase(db,p,id);
      const result=await db.query(`SELECT * FROM ${caseSchema()}.student_operations_case_documents WHERE customer_id=$1 AND case_id=$2 AND document_id=$3`,[p.tenantId,id,documentId]);
      if(!result.rows[0]) throw new NotFoundException('Document not found.');
      await this.cases.activity(db,p,id,'case.document_access_requested','Document download requested');
      return result.rows[0];
    });
    const buffer=await this.xero.attachmentContent(p.tenantId,document.xero_connection_id,document.source_kind,document.source_id,document.attachment_id);
    // Recheck after the network call: an advisor may have been reassigned.
    await this.database.tenantTransaction(p.tenantId,async db=>{
      await this.cases.authorizedCase(db,p,id);
      await this.cases.activity(db,p,id,'case.document_downloaded','Document downloaded');
    });
    return {buffer,fileName:String(document.file_name).replace(/[\r\n"\\/\x00-\x1f]/g,'_')};
  }

  // Called by the dedicated worker, never by a read endpoint. Tenant scope is
  // explicit and each network call runs outside the database transaction.
  async processOne(tenantId:string,options:{dailyBudget?:boolean}={}):Promise<boolean> {
    caseId(tenantId);
    if(process.env.XERO_SHARED_QUOTA_ENABLED==='true' && process.env.STUDENT_DOCUMENT_SOURCE_DEDUP_ENABLED!=='true')
      throw new Error('Shared quota requires source-level discovery.');
    if(process.env.STUDENT_DOCUMENT_SOURCE_DEDUP_ENABLED === 'true') {
      if(!options.dailyBudget) throw new Error('Source discovery requires the shared worker daily budget.');
      return new StudentDocumentSourceDiscovery(this.database,this.xero).processOne(tenantId);
    }
    const token=randomUUID(),s=caseSchema();
    const job=await this.database.tenantTransaction(tenantId,async db=>{
      await db.query(`UPDATE ${s}.student_operations_document_jobs SET status='failed',error_code='lease_attempts_exhausted',lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE customer_id=$1 AND status='processing' AND lease_expires_at<now() AND attempts>=5`,[tenantId]);
      const result=await db.query(`WITH candidate AS (
        SELECT job_id FROM ${s}.student_operations_document_jobs WHERE customer_id=$1 AND attempts<5 AND next_attempt_at<=now()
          AND (status='queued' OR (status='processing' AND lease_expires_at<now()))
          ${process.env.XERO_SHARED_BACKOFF_ENABLED === 'true' ? `AND NOT EXISTS (
            SELECT 1 FROM ${s}.xero_connection_rate_limits rate
            WHERE rate.customer_id=student_operations_document_jobs.customer_id
              AND rate.xero_connection_id=student_operations_document_jobs.xero_connection_id
              AND rate.blocked_until>now())` : ''}
          ${process.env.STUDENT_SYNC_PIPELINE_ENABLED === 'true' || options.dailyBudget ? `AND EXISTS (
            SELECT 1 FROM ${s}.student_operations_sync_checkpoints checkpoint
            JOIN ${s}.student_operations_xero_sync_configurations config USING(customer_id,xero_connection_id)
            JOIN ${s}.customers tenant USING(customer_id)
            JOIN ${s}.xero_connections connection USING(customer_id,xero_connection_id)
            WHERE checkpoint.customer_id=student_operations_document_jobs.customer_id
              AND checkpoint.xero_connection_id=student_operations_document_jobs.xero_connection_id
              AND tenant.status='active' AND connection.status='active' AND config.enabled
              AND checkpoint.source_sync_at>=config.last_successful_sync_at
              AND NOT EXISTS (SELECT 1 FROM ${s}.student_operations_xero_sync_runs active
                WHERE active.customer_id=checkpoint.customer_id AND active.xero_connection_id=checkpoint.xero_connection_id
                  AND active.status IN ('queued','processing')))` : ''}
          ${options.dailyBudget ? `AND ${s}.student_operations_document_window()
            AND NOT EXISTS (SELECT 1 FROM ${s}.student_operations_document_daily_budgets blocked
              WHERE blocked.customer_id=$1 AND blocked.blocked_until>now())` : ''}
          ORDER BY next_attempt_at,job_id FOR UPDATE SKIP LOCKED LIMIT 1)
        ${options.dailyBudget ? `, budget AS (
          INSERT INTO ${s}.student_operations_document_daily_budgets(customer_id,business_date,attempted_sources)
          SELECT $1::uuid,(now() AT TIME ZONE 'Australia/Brisbane')::date,1 FROM candidate
          ON CONFLICT(customer_id,business_date) DO UPDATE SET
            attempted_sources=student_operations_document_daily_budgets.attempted_sources+1,updated_at=now()
          WHERE student_operations_document_daily_budgets.attempted_sources<500
            AND student_operations_document_daily_budgets.started_at>now()-interval '30 minutes'
            AND (student_operations_document_daily_budgets.blocked_until IS NULL
              OR student_operations_document_daily_budgets.blocked_until<=now())
          RETURNING customer_id)` : ''}
        UPDATE ${s}.student_operations_document_jobs j SET status='processing',attempts=attempts+1,lease_token=$2,lease_expires_at=now()+interval '2 minutes',updated_at=now()
        FROM candidate c${options.dailyBudget ? ',budget' : ''} WHERE j.job_id=c.job_id RETURNING j.*`,[tenantId,token]);
      return result.rows[0];
    });
    if(!job) return false;
    try {
      const attachments=await this.xero.attachments(tenantId,job.xero_connection_id,job.source_kind as XeroAttachmentSource,job.source_id);
      await this.database.tenantTransaction(tenantId,async db=>{
        const lease=await db.query(`SELECT job_id FROM ${s}.student_operations_document_jobs WHERE customer_id=$1 AND job_id=$2 AND lease_token=$3 AND lease_expires_at>now() FOR UPDATE`,[tenantId,job.job_id,token]);
        if(!lease.rows.length) return;
        for(const file of attachments) await db.query(`INSERT INTO ${s}.student_operations_case_documents(customer_id,case_id,xero_connection_id,source_kind,source_id,attachment_id,file_name,mime_type,size_bytes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
          ON CONFLICT(customer_id,case_id,xero_connection_id,source_kind,source_id,attachment_id) DO UPDATE SET file_name=excluded.file_name,mime_type=excluded.mime_type,size_bytes=excluded.size_bytes,last_seen_at=now()`,[tenantId,job.case_id,job.xero_connection_id,job.source_kind,job.source_id,file.attachmentId,file.fileName,file.mimeType,file.sizeBytes]);
        await db.query(`UPDATE ${s}.student_operations_document_jobs SET status='succeeded',error_code=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE customer_id=$1 AND job_id=$2 AND lease_token=$3`,[tenantId,job.job_id,token]);
      });
    } catch(error) {
      const response=error && typeof error==='object' && 'getResponse' in error ? (error as {getResponse:()=>unknown}).getResponse() : null;
      const code=response && typeof response==='object' && 'errorCode' in response ? String(response.errorCode) : 'document_discovery_failed';
      const permanent=code==='xero_attachment_scope_missing' || code==='xero_authorization_rejected';
      const retry=response && typeof response==='object' && 'retryAfterSeconds' in response ? Number(response.retryAfterSeconds) : 60;
      await this.database.tenantTransaction(tenantId,async db=>{
        await db.query(`UPDATE ${s}.student_operations_document_jobs SET status=$4,error_code=$5,next_attempt_at=now()+($6 * interval '1 second'),lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE customer_id=$1 AND job_id=$2 AND lease_token=$3`,[tenantId,job.job_id,token,permanent || job.attempts>=5 ? 'failed':'queued',code,Math.max(60,Math.min(Number.isFinite(retry)?retry:60,86400))]);
        if(options.dailyBudget) await db.query(`UPDATE ${s}.student_operations_document_daily_budgets
          SET blocked_until=greatest(now()+($2 * interval '1 second'),
            (((now() AT TIME ZONE 'Australia/Brisbane')::date+1+time '03:00') AT TIME ZONE 'Australia/Brisbane')),
            updated_at=now()
          WHERE customer_id=$1 AND business_date=(now() AT TIME ZONE 'Australia/Brisbane')::date`,
          [tenantId,Math.max(60,Math.min(Number.isFinite(retry)?retry:60,86400))]);
      });
      // Back off the whole worker on provider failures/rate limiting.
      return false;
    }
    return true;
  }
}
