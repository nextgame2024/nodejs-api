import type { DatabaseService } from '../database/database.service.js';
import { runtimeConfig } from '../config/runtime-config.js';

type HealthRow={connection_id:string;document_window:boolean;dependency_ready:boolean;import_pending:boolean;
  import_error:boolean;queued:string;processing:string;succeeded:string;failed:string;cached_sources:string;failed_sources:string;
  attempted_sources:number|null;batch_closed:boolean;quota_known:boolean;remaining:number|null;discovery_reserve:number|null;
  cooling_down:boolean;last_successful_sync_at:Date|null;last_source_check_at:Date|null;
  observed_at:Date|null;refresh_after:Date|null;blocked_until:Date|null};
const count=(value:unknown)=>Math.max(0,Math.min(1_000_000_000,Number(value)||0));
const date=(value:Date|null)=>value instanceof Date && Number.isFinite(value.getTime())?value.toISOString():null;

export class StudentSyncHealth {
  constructor(private readonly database:DatabaseService) {}

  async report(customer:string) {
    if(process.env.STUDENT_SYNC_HEALTH_LOGS_ENABLED!=='true') return null;
    const s=runtimeConfig().schema;
    const row=await this.database.tenantReadTransaction(customer,async db=>{
      await db.query("SET LOCAL statement_timeout='5s'");
      return (await db.query<HealthRow>(`SELECT c.xero_connection_id AS connection_id,
        ${s}.student_operations_document_window() AS document_window,
        coalesce(p.source_sync_at>=c.last_successful_sync_at,false) AS dependency_ready,
        EXISTS(SELECT 1 FROM ${s}.student_operations_xero_sync_runs r
          WHERE r.customer_id=c.customer_id AND r.xero_connection_id=c.xero_connection_id AND r.status IN ('queued','processing')) AS import_pending,
        (c.last_error_code IS NOT NULL AND c.last_error_code NOT IN
          ('xero_rate_limited','xero_quota_unknown','xero_quota_reserved','xero_quota_exhausted')) AS import_error,
        jobs.*,sources.*,b.attempted_sources,
        coalesce(b.attempted_sources>=500 OR b.started_at<=now()-interval '30 minutes' OR b.blocked_until>now(),false) AS batch_closed,
        (q.remaining IS NOT NULL AND q.refresh_after>now()) AS quota_known,q.remaining,q.discovery_reserve,
        coalesce(rate.blocked_until>now(),false) AS cooling_down,
        c.last_successful_sync_at,q.observed_at,q.refresh_after,rate.blocked_until
        FROM ${s}.student_operations_xero_sync_configurations c
        JOIN ${s}.customers t ON t.customer_id=c.customer_id AND t.status='active'
        JOIN ${s}.xero_connections x ON x.customer_id=c.customer_id AND x.xero_connection_id=c.xero_connection_id AND x.status='active'
        LEFT JOIN ${s}.student_operations_sync_checkpoints p ON p.customer_id=c.customer_id AND p.xero_connection_id=c.xero_connection_id
        LEFT JOIN ${s}.xero_quota_admission q ON q.customer_id=c.customer_id AND q.xero_connection_id=c.xero_connection_id
        LEFT JOIN ${s}.xero_connection_rate_limits rate ON rate.customer_id=c.customer_id AND rate.xero_connection_id=c.xero_connection_id
        LEFT JOIN ${s}.student_operations_document_daily_budgets b ON b.customer_id=c.customer_id
          AND b.business_date=(now() AT TIME ZONE 'Australia/Brisbane')::date
        CROSS JOIN LATERAL (SELECT count(*) FILTER(WHERE status='queued') AS queued,
          count(*) FILTER(WHERE status='processing') AS processing,count(*) FILTER(WHERE status='succeeded') AS succeeded,
          count(*) FILTER(WHERE status='failed' AND error_code IS DISTINCT FROM 'source_not_linked') AS failed
          FROM ${s}.student_operations_document_jobs j WHERE j.customer_id=c.customer_id AND j.xero_connection_id=c.xero_connection_id) jobs
        CROSS JOIN LATERAL (SELECT count(*) FILTER(WHERE status='succeeded') AS cached_sources,
          count(*) FILTER(WHERE status='failed' AND error_code IS DISTINCT FROM 'source_not_linked') AS failed_sources,
          max(checked_at) AS last_source_check_at FROM ${s}.student_operations_document_sources src
          WHERE src.customer_id=c.customer_id AND src.xero_connection_id=c.xero_connection_id) sources
        WHERE c.customer_id=$1 AND c.enabled AND c.organisation_role='trust'
        LIMIT 1`,[customer])).rows[0];
    });
    if(!row) return {customerId:customer,status:'unknown',signals:['no_active_trust_connection']};
    const signals:string[]=[],pauses:string[]=[];
    if(row.import_error) signals.push('invoice_sync_error');
    if(count(row.failed)>0) signals.push('document_jobs_failed');
    if(count(row.failed_sources)>0) signals.push('document_sources_failed');
    if(!row.document_window) pauses.push('outside_document_window');
    if(row.import_pending) pauses.push('import_pending');
    if(!row.dependency_ready) pauses.push('reconciliation_pending');
    if(row.cooling_down) pauses.push('provider_cooldown');
    if(!row.quota_known) pauses.push('quota_unknown');
    else if(row.remaining!<=row.discovery_reserve!) pauses.push('discovery_quota_reserved');
    if(row.batch_closed) pauses.push('document_batch_closed');
    // Never spread provider/DB rows: only this explicit metadata allowlist is
    // emitted. An observed report is not a guarantee that the backlog is done.
    return {customerId:customer,connectionId:row.connection_id,
      status:signals.length?'attention':pauses.length?'paused':'observed',signals,pauses,
      counts:{queued:count(row.queued),processing:count(row.processing),succeeded:count(row.succeeded),
        failed:count(row.failed),cachedSources:count(row.cached_sources),failedSources:count(row.failed_sources),
        attemptedSources:row.attempted_sources===null?null:count(row.attempted_sources)},
      lastSuccessfulImportAt:date(row.last_successful_sync_at),lastSourceCheckAt:date(row.last_source_check_at),
      quota:{remaining:row.quota_known?row.remaining:null,reserve:row.discovery_reserve,
        observedAt:date(row.observed_at),refreshAfter:date(row.refresh_after),blockedUntil:date(row.blocked_until)}};
  }
}
