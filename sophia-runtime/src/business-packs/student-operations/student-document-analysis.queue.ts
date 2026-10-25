import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { DatabaseService } from '../../database/database.service.js';
import { caseSchema } from './student-operations-cases.service.js';
import { DOCUMENT_ANALYSIS_VERSION, documentExtraction, documentKind } from './student-document-analysis.contracts.js';
import { persistOffer } from './student-case-offers.js';
import { reconcileDocumentChecklist } from './student-document-checklist.js';

const enqueueInput = z.object({ caseId: z.uuid(), documentId: z.uuid(),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/), kind: documentKind,
  schemaVersion: z.string().min(1).max(80).default(DOCUMENT_ANALYSIS_VERSION),
}).strict();
const safeError = z.enum(['provider_unavailable', 'rate_limited', 'invalid_output', 'source_unavailable', 'source_changed', 'unsupported_document']);
const receipt = z.object({ extraction: documentExtraction,
  provider: z.string().min(1).max(80), model: z.string().min(1).max(120),
  inputTokens: z.number().int().min(0).max(2147483647), outputTokens: z.number().int().min(0).max(2147483647),
}).strict();
export interface AnalysisLease {
  jobId: string; caseId: string; documentId: string; contentSha256: string;
  kind: z.infer<typeof documentKind>; schemaVersion: string; leaseToken: string; attempts: number;
}

/** Called inside the upload finalization transaction. */
export async function enqueueDocumentAnalysis(db: PoolClient, tenantId: string, input: unknown): Promise<string> {
  z.uuid().parse(tenantId);
  const value = enqueueInput.parse(input), s = caseSchema();
  const args = [tenantId, value.caseId, value.documentId, value.contentSha256, value.kind, value.schemaVersion];
  await db.query(`INSERT INTO ${s}.student_document_analysis_jobs
    (customer_id,case_id,document_id,content_sha256,document_kind,schema_version)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(customer_id,case_id,document_id,content_sha256,document_kind,schema_version) DO NOTHING`, args);
  const result = await db.query(`SELECT job_id FROM ${s}.student_document_analysis_jobs
    WHERE customer_id=$1 AND case_id=$2 AND document_id=$3 AND content_sha256=$4 AND document_kind=$5 AND schema_version=$6`, args);
  if (!result.rows[0]) throw new Error('Analysis scope unavailable');
  return String(result.rows[0].job_id);
}

/** Tenant-specific worker primitive. No provider calls or long-held transaction. */
export class StudentDocumentAnalysisQueue {
  constructor(private readonly database: DatabaseService) {}

  async claim(tenantId: string): Promise<AnalysisLease | null> {
    return this.database.tenantTransaction(tenantId, async db => {
      const s = caseSchema();
      // A worker that dies on its final attempt must still reach a terminal state.
      await db.query(`UPDATE ${s}.student_document_analysis_jobs SET status='failed',lease_token=NULL,
        lease_expires_at=NULL,error_code=coalesce(error_code,'provider_unavailable'),updated_at=now()
        WHERE customer_id=$1 AND status='processing' AND lease_expires_at<=now() AND attempts>=5`, [tenantId]);
      const result = await db.query(`SELECT job_id FROM ${s}.student_document_analysis_jobs WHERE customer_id=$1
        AND attempts<5 AND ((status='queued' AND next_attempt_at<=now()) OR (status='processing' AND lease_expires_at<=now()))
        ORDER BY next_attempt_at,created_at,job_id FOR UPDATE SKIP LOCKED LIMIT 1`, [tenantId]);
      if (!result.rows[0]) return null;
      const claimed = await db.query(`UPDATE ${s}.student_document_analysis_jobs SET status='processing',attempts=attempts+1,
        lease_token=$3,lease_expires_at=now()+interval '3 minutes',error_code=NULL,updated_at=now()
        WHERE customer_id=$1 AND job_id=$2 RETURNING job_id AS "jobId",case_id AS "caseId",document_id AS "documentId",
        content_sha256 AS "contentSha256",document_kind AS kind,schema_version AS "schemaVersion",
        lease_token AS "leaseToken",attempts`, [tenantId, result.rows[0].job_id, randomUUID()]);
      return claimed.rows[0] as AnalysisLease;
    });
  }

  async complete(tenantId: string, jobId: string, leaseToken: string, input: unknown): Promise<string | null> {
    z.uuid().parse(jobId); z.uuid().parse(leaseToken);
    const value = receipt.parse(input);
    return this.database.tenantTransaction(tenantId, async db => {
      const s = caseSchema();
      // Case-first lock order matches review/upload/checklist and avoids retry deadlocks.
      const scope=(await db.query(`SELECT case_id FROM ${s}.student_document_analysis_jobs WHERE customer_id=$1 AND job_id=$2`,[tenantId,jobId])).rows[0];
      if(!scope)return null;
      await db.query(`SELECT case_id FROM ${s}.student_operations_cases WHERE customer_id=$1 AND case_id=$2 FOR UPDATE`,[tenantId,scope.case_id]);
      const locked = await db.query(`SELECT * FROM ${s}.student_document_analysis_jobs
        WHERE customer_id=$1 AND job_id=$2 AND status='processing' AND lease_token=$3 AND lease_expires_at>now() FOR UPDATE`,
        [tenantId, jobId, leaseToken]);
      const job = locked.rows[0];
      if (!job) return null; // Expired/stolen lease cannot publish evidence.
      if (job.document_kind !== value.extraction.kind) throw new Error('Extraction kind mismatch');
      const result = await db.query(`INSERT INTO ${s}.student_document_analysis_results
        (customer_id,case_id,document_id,job_id,extraction,provider,model,input_tokens,output_tokens)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING result_id`,
        [tenantId, job.case_id, job.document_id, jobId, JSON.stringify(value.extraction), value.provider, value.model, value.inputTokens, value.outputTokens]);
      if(value.extraction.kind==='letter_of_offer')await persistOffer(db,tenantId,job.case_id,job.document_id,String(result.rows[0].result_id),value.extraction);
      await db.query(`UPDATE ${s}.student_document_analysis_jobs SET status='succeeded',lease_token=NULL,lease_expires_at=NULL,updated_at=now()
        WHERE customer_id=$1 AND job_id=$2`, [tenantId, jobId]);
      await db.query(`INSERT INTO ${s}.student_operations_case_activity(customer_id,case_id,actor_identity_user_id,event_type,summary,detail)
        VALUES($1,$2,'system:document-analysis','case.document_checked',$3,jsonb_build_object('actorKind','automation','actorName','SophiaAi'))`,[tenantId,job.case_id,value.extraction.kind==='letter_of_offer'?'Letter of Offer extracted':'Document checked']);
      await reconcileDocumentChecklist(db,tenantId,job.case_id);
      return String(result.rows[0].result_id);
    });
  }

  async fail(tenantId: string, jobId: string, leaseToken: string, code: z.infer<typeof safeError>, retryable: boolean): Promise<boolean> {
    z.uuid().parse(jobId); z.uuid().parse(leaseToken); safeError.parse(code); z.boolean().parse(retryable);
    return this.database.tenantTransaction(tenantId, async db => {
      const result = await db.query(`UPDATE ${caseSchema()}.student_document_analysis_jobs
        SET status=CASE WHEN $5 AND attempts<5 THEN 'queued' ELSE 'failed' END,
        next_attempt_at=now()+least(900,power(2,attempts)*15)*interval '1 second',
        lease_token=NULL,lease_expires_at=NULL,error_code=$4,updated_at=now()
        WHERE customer_id=$1 AND job_id=$2 AND status='processing' AND lease_token=$3 AND lease_expires_at>now() RETURNING job_id`,
        [tenantId, jobId, leaseToken, code, retryable]);
      return Boolean(result.rowCount);
    });
  }
}
