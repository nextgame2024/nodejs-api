import type { DatabaseService } from '../../database/database.service.js';
import { caseId,caseSchema } from './student-operations-cases.service.js';
import { documentSourceLinked,documentSourceReady } from './student-document-source-discovery.js';

// Only the existing shared worker invokes this local scheduler. Requests do not
// fetch Xero; ordinary discovery retains all lease, quota and time-budget gates.
export class StudentDocumentRechecks {
  constructor(private readonly database:DatabaseService) {}

  async schedule(customer:string):Promise<number> {
    if(process.env.STUDENT_DOCUMENT_RECHECKS_ENABLED!=='true') return 0;
    if(process.env.XERO_SHARED_QUOTA_ENABLED!=='true' || process.env.XERO_SHARED_BACKOFF_ENABLED!=='true'
      || process.env.STUDENT_DOCUMENT_SOURCE_DEDUP_ENABLED!=='true') throw new Error('Document rechecks require quota, backoff and source deduplication.');
    caseId(customer);const s=caseSchema();
    return this.database.tenantTransaction(customer,async db=>{
      if(!(await db.query(`SELECT 1 WHERE ${s}.student_operations_document_window()`)).rowCount) return 0;
      // Separate scheduling accounting must not start/reset the 30-minute fetch
      // budget. Locking this row serializes all replicas for the same customer.
      await db.query(`INSERT INTO ${s}.student_document_recheck_budgets(customer_id,business_date)
        VALUES($1,(now() AT TIME ZONE 'Australia/Brisbane')::date) ON CONFLICT DO NOTHING`,[customer]);
      const budget=await db.query<{scheduled_sources:number}>(`SELECT scheduled_sources FROM ${s}.student_document_recheck_budgets
        WHERE customer_id=$1 AND business_date=(now() AT TIME ZONE 'Australia/Brisbane')::date FOR UPDATE`,[customer]);
      const allowance=25-budget.rows[0].scheduled_sources;
      if(allowance<=0) return 0;
      const candidates=await db.query<{job_id:string}>(`SELECT j.job_id
        FROM ${s}.student_operations_document_sources src
        JOIN LATERAL (
          SELECT j.* FROM ${s}.student_operations_document_jobs j
          WHERE j.customer_id=src.customer_id AND j.xero_connection_id=src.xero_connection_id
            AND j.source_kind=src.source_kind AND j.source_id=src.source_id AND j.status='succeeded'
            AND ${documentSourceReady(s)} AND ${documentSourceLinked(s)}
          ORDER BY j.job_id LIMIT 1
        ) j ON true
        LEFT JOIN ${s}.student_operations_xero_invoices i ON i.customer_id=src.customer_id
          AND i.xero_connection_id=src.xero_connection_id AND i.xero_invoice_id=src.source_id
          AND ((src.source_kind='Invoices' AND i.invoice_type='ACCREC')
            OR (src.source_kind='CreditNotes' AND i.invoice_type='ACCRECCREDIT'))
        LEFT JOIN ${s}.student_operations_xero_contacts c ON c.customer_id=src.customer_id
          AND c.xero_connection_id=src.xero_connection_id AND c.xero_contact_id=src.source_id AND src.source_kind='Contacts'
        JOIN ${s}.xero_quota_admission quota ON quota.customer_id=src.customer_id AND quota.xero_connection_id=src.xero_connection_id
        WHERE src.customer_id=$1 AND src.status='succeeded' AND src.checked_at IS NOT NULL
          AND (src.checked_at<=now()-interval '7 days' OR greatest(i.provider_updated_at,c.provider_updated_at)>src.checked_at)
          AND quota.refresh_after>now() AND quota.remaining>quota.discovery_reserve AND quota.generation_admissions<quota.daily_limit
          AND NOT EXISTS(SELECT 1 FROM ${s}.xero_connection_rate_limits rate
            WHERE rate.customer_id=src.customer_id AND rate.xero_connection_id=src.xero_connection_id AND rate.blocked_until>now())
          AND NOT EXISTS(SELECT 1 FROM ${s}.student_operations_document_jobs pending
            WHERE pending.customer_id=src.customer_id AND pending.xero_connection_id=src.xero_connection_id
              AND pending.source_kind=src.source_kind AND pending.source_id=src.source_id AND pending.status IN ('queued','processing'))
        ORDER BY (greatest(i.provider_updated_at,c.provider_updated_at)>src.checked_at) DESC NULLS LAST,
          src.checked_at,src.xero_connection_id,src.source_kind,src.source_id
        LIMIT $2 FOR UPDATE OF src SKIP LOCKED`,[customer,allowance]);
      let scheduled=0;
      for(const candidate of candidates.rows) {
        // Queue one representative, not all duplicate case links. The existing
        // source-level fetch fans the fresh result out after successful commit.
        const queued=await db.query(`UPDATE ${s}.student_operations_document_jobs j SET status='queued',attempts=0,
          refresh_requested_at=now(),next_attempt_at=now(),error_code=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=now()
          WHERE j.customer_id=$1 AND j.job_id=$2 AND j.status='succeeded'
            AND ${documentSourceReady(s)} AND ${documentSourceLinked(s)} RETURNING j.job_id`,[customer,candidate.job_id]);
        scheduled+=queued.rowCount??0;
      }
      await db.query(`UPDATE ${s}.student_document_recheck_budgets SET scheduled_sources=scheduled_sources+$2,updated_at=now()
        WHERE customer_id=$1 AND business_date=(now() AT TIME ZONE 'Australia/Brisbane')::date`,[customer,scheduled]);
      return scheduled;
    });
  }
}
