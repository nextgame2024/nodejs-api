import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { DatabaseService } from '../../database/database.service.js';
import type { XeroConnectorService } from '../../connectors/xero/xero-connector.service.js';
import type { XeroAttachmentSource } from '../../connectors/xero/xero.client.js';
import { caseId, caseSchema } from './student-operations-cases.service.js';

const metadata = z.array(z.object({attachmentId:z.uuid(),fileName:z.string().min(1).max(255),
  mimeType:z.string().min(1).max(200),sizeBytes:z.number().int().min(0).max(26214400)}).strict()).max(1000)
  .transform(files=>Array.from(new Map(files.map(file=>[file.attachmentId,file])).values()));
type Files = z.infer<typeof metadata>;
type Source = {customer_id:string;xero_connection_id:string;source_kind:XeroAttachmentSource;source_id:string;
  status:string;attempts:number;lease_token:string|null;checked_at:Date|null;last_attempt_at:Date|null;
  attachments:unknown;error_code:string|null;cache_fresh:boolean;lease_live:boolean;retry_due:boolean;reset_attempts:boolean;checked_stamp:string|null};
type Job = {job_id:string;refresh_stamp:string|null;attempts:number;xero_connection_id:string;source_kind:XeroAttachmentSource;source_id:string};

// Aliases here are internal SQL constants, never request input. Every predicate
// includes tenant + connection + source identity, even under FORCE RLS.
const key = (alias:string) => `${alias}.customer_id=$1 AND ${alias}.xero_connection_id=$2
  AND ${alias}.source_kind=$3 AND ${alias}.source_id=$4`;
function linked(s:string) { return `EXISTS (
  SELECT 1 FROM ${s}.student_operations_case_invoice_links l
  JOIN ${s}.student_operations_xero_invoices i USING(customer_id,xero_connection_id,xero_invoice_id)
  WHERE l.customer_id=j.customer_id AND l.case_id=j.case_id AND i.xero_connection_id=j.xero_connection_id
    AND i.invoice_status NOT IN ('DELETED','VOIDED')
    AND ((j.source_kind='Invoices' AND i.invoice_type='ACCREC' AND i.xero_invoice_id=j.source_id)
      OR (j.source_kind='CreditNotes' AND i.invoice_type='ACCRECCREDIT' AND i.xero_invoice_id=j.source_id)
      OR (j.source_kind='Contacts' AND i.xero_contact_id=j.source_id
        AND i.invoice_type IN ('ACCREC','ACCRECCREDIT','RECEIVE-PREPAYMENT','RECEIVE-OVERPAYMENT'))))`; }
function ready(s:string) { return `EXISTS (
  SELECT 1 FROM ${s}.student_operations_sync_checkpoints p
  JOIN ${s}.student_operations_xero_sync_configurations c USING(customer_id,xero_connection_id)
  JOIN ${s}.customers t USING(customer_id)
  JOIN ${s}.xero_connections x USING(customer_id,xero_connection_id)
  WHERE p.customer_id=j.customer_id AND p.xero_connection_id=j.xero_connection_id
    AND t.status='active' AND x.status='active' AND c.enabled AND c.organisation_role='trust'
    AND p.source_sync_at>=c.last_successful_sync_at
    AND NOT EXISTS(SELECT 1 FROM ${s}.student_operations_xero_sync_runs r
      WHERE r.customer_id=p.customer_id AND r.xero_connection_id=p.xero_connection_id
        AND r.status IN ('queued','processing')))`; }

export class StudentDocumentSourceDiscovery {
  constructor(private readonly database:DatabaseService,private readonly xero:XeroConnectorService) {}

  async processOne(tenantId:string):Promise<boolean> {
    caseId(tenantId);
    const s=caseSchema(),token=randomUUID();
    const claim=await this.database.tenantTransaction(tenantId,async db=>{
      const invalid=await db.query(`WITH stale AS (
        SELECT j.job_id FROM ${s}.student_operations_document_jobs j WHERE j.customer_id=$1
          AND (j.status='queued' OR (j.status='processing' AND j.lease_expires_at<now()))
          AND ${s}.student_operations_document_window() AND ${ready(s)} AND NOT ${linked(s)}
          ORDER BY j.job_id FOR UPDATE SKIP LOCKED LIMIT 25)
        UPDATE ${s}.student_operations_document_jobs j SET status='failed',error_code='source_not_linked',
          lease_token=NULL,lease_expires_at=NULL,updated_at=now() FROM stale WHERE j.job_id=stale.job_id`,[tenantId]);
      // A small candidate set bounds local work and favors reusable results.
      // Source locks, not case locks, serialize discovery across replicas.
      const candidates=await db.query<Job>(`SELECT j.*,j.refresh_requested_at::text AS refresh_stamp FROM ${s}.student_operations_document_jobs j
        LEFT JOIN ${s}.student_operations_document_sources cached USING(customer_id,xero_connection_id,source_kind,source_id)
        WHERE j.customer_id=$1 AND j.next_attempt_at<=now()
          AND (j.status='queued' OR (j.status='processing' AND j.lease_expires_at<now())
            OR (j.status='succeeded' AND cached.status='succeeded' AND j.updated_at<cached.checked_at))
          AND ${s}.student_operations_document_window() AND ${ready(s)} AND ${linked(s)}
          AND (cached.lease_expires_at IS NULL OR cached.lease_expires_at<=now() OR cached.status<>'processing')
        ORDER BY (cached.status='succeeded' AND cached.checked_at>now()-interval '24 hours'
          AND (j.refresh_requested_at IS NULL OR cached.checked_at>=j.refresh_requested_at)) DESC NULLS LAST,
          j.next_attempt_at,j.job_id LIMIT 25`,[tenantId]);
      for(const job of candidates.rows) {
        const args=[tenantId,job.xero_connection_id,job.source_kind,job.source_id];
        await db.query(`INSERT INTO ${s}.student_operations_document_sources(customer_id,xero_connection_id,source_kind,source_id)
          VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,args);
        const result=await db.query<Source>(`SELECT src.*,checked_at::text AS checked_stamp,
          (checked_at>now()-interval '24 hours' AND ($5::timestamptz IS NULL OR checked_at>=$5)) AS cache_fresh,
          (status='succeeded' OR ($5::timestamptz IS NOT NULL AND (last_attempt_at IS NULL OR $5>last_attempt_at))) AS reset_attempts,
          lease_expires_at>now() AS lease_live,next_attempt_at<=now() AS retry_due
          FROM ${s}.student_operations_document_sources src WHERE ${key('src')} FOR UPDATE SKIP LOCKED`,[...args,job.refresh_stamp]);
        const source=result.rows[0];
        if(!source || (source.status==='processing' && source.lease_live)) continue;
        if(source.status==='succeeded' && source.cache_fresh) {
          await this.fanOut(db,s,args,metadata.parse(source.attachments),source.checked_stamp!);
          return {cached:true as const};
        }
        const reset=source.reset_attempts;
        const attempts=reset?0:Math.max(source.attempts,job.attempts);
        if(!reset && !source.retry_due) continue;
        if(attempts>=5 || (!reset && source.status==='failed')) {
          await db.query(`UPDATE ${s}.student_operations_document_sources src SET status='failed',
            error_code=coalesce(error_code,'source_attempts_exhausted'),lease_token=NULL,lease_expires_at=NULL,updated_at=now()
            WHERE ${key('src')}`,args);
          await db.query(`UPDATE ${s}.student_operations_document_jobs j SET status='failed',
            error_code=$6,lease_token=NULL,lease_expires_at=NULL,updated_at=now()
            WHERE ${key('j')} AND j.job_id=$5`,[...args,job.job_id,source.error_code??'source_attempts_exhausted']);
          return {cached:true as const};
        }
        // Cached fan-out above spends no provider allowance or daily attempt.
        // New fetches retain the existing tenant-wide quota/time/backoff gates.
        if(process.env.XERO_SHARED_BACKOFF_ENABLED==='true') {
          const rate=await db.query(`SELECT 1 FROM ${s}.xero_connection_rate_limits
            WHERE customer_id=$1 AND xero_connection_id=$2 AND blocked_until>now()`,args.slice(0,2));
          if(rate.rowCount) continue;
        }
        if(process.env.XERO_SHARED_QUOTA_ENABLED==='true') {
          const quota=await db.query(`SELECT 1 FROM ${s}.xero_quota_admission
            WHERE customer_id=$1 AND xero_connection_id=$2 AND refresh_after>now()
              AND remaining>discovery_reserve AND generation_admissions<daily_limit`,args.slice(0,2));
          if(!quota.rowCount) continue;
        }
        const budget=await db.query(`INSERT INTO ${s}.student_operations_document_daily_budgets(customer_id,business_date,attempted_sources)
          SELECT $1::uuid,(now() AT TIME ZONE 'Australia/Brisbane')::date,1
          WHERE NOT EXISTS(SELECT 1 FROM ${s}.student_operations_document_daily_budgets
            WHERE customer_id=$1 AND blocked_until>now())
          ON CONFLICT(customer_id,business_date) DO UPDATE SET
            attempted_sources=student_operations_document_daily_budgets.attempted_sources+1,updated_at=now()
          WHERE student_operations_document_daily_budgets.attempted_sources<500
            AND student_operations_document_daily_budgets.started_at>now()-interval '30 minutes'
            AND (student_operations_document_daily_budgets.blocked_until IS NULL OR student_operations_document_daily_budgets.blocked_until<=now())
          RETURNING customer_id,business_date::text`,[tenantId]);
        if(!budget.rowCount) return null;
        const leased=await db.query<{last_attempt_at:string}>(`UPDATE ${s}.student_operations_document_sources src
          SET status='processing',attempts=$5,lease_token=$6,lease_expires_at=now()+interval '2 minutes',
            last_attempt_at=now(),updated_at=now() WHERE ${key('src')} RETURNING last_attempt_at::text`,[...args,attempts+1,token]);
        await db.query(`UPDATE ${s}.student_operations_document_jobs SET status='processing',attempts=$3,
          lease_token=$4,lease_expires_at=now()+interval '2 minutes',updated_at=now()
          WHERE customer_id=$1 AND job_id=$2`,[tenantId,job.job_id,attempts+1,token]);
        return {cached:false as const,args,job,attempts:attempts+1,started:leased.rows[0].last_attempt_at,businessDate:budget.rows[0].business_date};
      }
      return invalid.rowCount?{cached:true as const}:null;
    });
    if(!claim) return false;
    if(claim.cached) return true;
    const {args,job,started,attempts}=claim;
    try {
      // Provider calls never hold a database transaction/lock open.
      const files=metadata.parse(await this.xero.attachments(tenantId,job.xero_connection_id,job.source_kind,job.source_id));
      await this.database.tenantTransaction(tenantId,async db=>{
        const lease=await db.query(`SELECT 1 FROM ${s}.student_operations_document_sources src
          WHERE ${key('src')} AND lease_token=$5 AND lease_expires_at>now() FOR UPDATE`,[...args,token]);
        if(!lease.rowCount) return;
        await db.query(`UPDATE ${s}.student_operations_document_sources src SET status='succeeded',
          checked_at=$5,attachments=$6::jsonb,error_code=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=now()
          WHERE ${key('src')}`,[...args,started,JSON.stringify(files)]);
        await this.fanOut(db,s,args,files,started,token);
        // A removed source link cannot acquire documents. Dependency changes
        // during the provider call leave a valid job queued for local replay.
        await db.query(`UPDATE ${s}.student_operations_document_jobs j SET
          status=CASE WHEN ${linked(s)} THEN 'queued' ELSE 'failed' END,
          error_code=CASE WHEN ${linked(s)} THEN NULL ELSE 'source_not_linked' END,
          lease_token=NULL,lease_expires_at=NULL,updated_at=now()
          WHERE j.customer_id=$1 AND j.job_id=$2 AND j.lease_token=$3`,[tenantId,job.job_id,token]);
      });
      return true;
    } catch(error) {
      const response=error && typeof error==='object' && 'getResponse' in error
        ? (error as {getResponse():unknown}).getResponse() : null;
      const value=response && typeof response==='object'?response as Record<string,unknown>:{};
      const code=typeof value.errorCode==='string' && /^[a-z0-9_]{1,80}$/.test(value.errorCode)
        ? value.errorCode:'document_discovery_failed';
      const retry=Math.max(60,Math.min(Number.isFinite(Number(value.retryAfterSeconds))?Number(value.retryAfterSeconds):60,86400));
      if(value.localQuotaDenial===true && value.upstreamAttempted===false && code.startsWith('xero_quota_')) {
        // Admission lost a race to another process. No HTTP request was sent:
        // release only our fenced source/case attempt, not another worker's.
        await this.database.tenantTransaction(tenantId,async db=>{
          const owned=await db.query(`UPDATE ${s}.student_operations_document_sources src SET status='queued',
            attempts=greatest(0,attempts-1),next_attempt_at=now()+($6 * interval '1 second'),error_code=$7,
            lease_token=NULL,lease_expires_at=NULL,updated_at=now()
            WHERE ${key('src')} AND lease_token=$5 AND lease_expires_at>now() RETURNING source_id`,[...args,token,retry,code]);
          if(!owned.rowCount) return;
          await db.query(`UPDATE ${s}.student_operations_document_jobs SET status='queued',attempts=greatest(0,attempts-1),
            next_attempt_at=now()+($4 * interval '1 second'),error_code=$5,lease_token=NULL,lease_expires_at=NULL,updated_at=now()
            WHERE customer_id=$1 AND job_id=$2 AND lease_token=$3`,[tenantId,job.job_id,token,retry,code]);
          await db.query(`UPDATE ${s}.student_operations_document_daily_budgets SET attempted_sources=greatest(0,attempted_sources-1),updated_at=now()
            WHERE customer_id=$1 AND business_date=$2::date`,[tenantId,claim.businessDate]);
        });
        return false;
      }
      const failed=attempts>=5 || ['xero_attachment_scope_missing','xero_authorization_rejected'].includes(code);
      await this.database.tenantTransaction(tenantId,async db=>{
        const owned=await db.query(`UPDATE ${s}.student_operations_document_sources src SET status=$6,error_code=$7,
          next_attempt_at=now()+($8 * interval '1 second'),lease_token=NULL,lease_expires_at=NULL,updated_at=now()
          WHERE ${key('src')} AND lease_token=$5 AND lease_expires_at>now() RETURNING source_id`,
          [...args,token,failed?'failed':'queued',code,retry]);
        if(!owned.rowCount) return;
        await db.query(`UPDATE ${s}.student_operations_document_jobs SET status=$4,error_code=$5,
          next_attempt_at=now()+($6 * interval '1 second'),lease_token=NULL,lease_expires_at=NULL,updated_at=now()
          WHERE customer_id=$1 AND job_id=$2 AND lease_token=$3`,[tenantId,job.job_id,token,failed?'failed':'queued',code,retry]);
        await db.query(`UPDATE ${s}.student_operations_document_daily_budgets SET blocked_until=greatest(
          blocked_until,now()+($2 * interval '1 second'),
          (((now() AT TIME ZONE 'Australia/Brisbane')::date+1+time '03:00') AT TIME ZONE 'Australia/Brisbane')),
          updated_at=now() WHERE customer_id=$1 AND business_date=(now() AT TIME ZONE 'Australia/Brisbane')::date`,[tenantId,retry]);
      });
      return false;
    }
  }

  private async fanOut(db:PoolClient,s:string,args:unknown[],files:Files,checkedAt:string,token:string|null=null) {
    // At most 25 case jobs per local pass. The remaining jobs reuse the durable
    // result on later passes, including across deployments and empty results.
    const targets=await db.query<{job_id:string;case_id:string}>(`SELECT j.job_id,j.case_id
      FROM ${s}.student_operations_document_jobs j WHERE ${key('j')}
        AND (j.status='queued' OR (j.status='processing' AND (j.lease_token=$6 OR j.lease_expires_at<now()))
          OR (j.status='succeeded' AND j.updated_at<$5))
        AND (j.refresh_requested_at IS NULL OR j.refresh_requested_at<=$5)
        AND ${ready(s)} AND ${linked(s)} ORDER BY j.job_id FOR UPDATE SKIP LOCKED LIMIT 25`,[...args,checkedAt,token]);
    if(!targets.rowCount) return;
    await db.query(`INSERT INTO ${s}.student_operations_case_documents(customer_id,case_id,xero_connection_id,
      source_kind,source_id,attachment_id,file_name,mime_type,size_bytes)
      SELECT $1::uuid,c.case_id,$2::uuid,$3::text,$4::uuid,f."attachmentId",f."fileName",f."mimeType",f."sizeBytes"
      FROM unnest($5::uuid[]) c(case_id) CROSS JOIN jsonb_to_recordset($6::jsonb)
        f("attachmentId" uuid,"fileName" text,"mimeType" text,"sizeBytes" bigint)
      ON CONFLICT(customer_id,case_id,xero_connection_id,source_kind,source_id,attachment_id)
      DO UPDATE SET file_name=excluded.file_name,mime_type=excluded.mime_type,size_bytes=excluded.size_bytes,last_seen_at=now()`,
      [...args,targets.rows.map(row=>row.case_id),JSON.stringify(files)]);
    await db.query(`UPDATE ${s}.student_operations_document_jobs SET status='succeeded',error_code=NULL,
      lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE customer_id=$1 AND job_id=ANY($2::uuid[])`,
      [args[0],targets.rows.map(row=>row.job_id)]);
  }
}
