import { createHash } from 'node:crypto';
import type { DatabaseService } from '../../database/database.service.js';
import type { XeroConnectorService } from '../../connectors/xero/xero-connector.service.js';
import { DOCUMENT_ANALYSIS_CONCURRENCY, StudentDocumentAnalysisQueue } from './student-document-analysis.queue.js';
import type { StudentDocumentExtractionProvider } from './student-document-analysis.contracts.js';
import { analysisEnabled } from './student-document-analysis.service.js';
import { caseSchema } from './student-operations-cases.service.js';
import { DocumentExtractionError } from './openai-document-extraction.provider.js';
import { studentDocumentTempStorage } from './student-document-temp-storage.js';

export class StudentDocumentAnalysisWorker {
  constructor(private readonly database:DatabaseService,private readonly xero:XeroConnectorService,
    private readonly provider:StudentDocumentExtractionProvider) {}
  async processBatch(tenantId:string):Promise<boolean>{
    const results=await Promise.allSettled(Array.from({length:DOCUMENT_ANALYSIS_CONCURRENCY},()=>this.processOne(tenantId)));
    const failure=results.find(r=>r.status==='rejected');
    if(failure?.status==='rejected')throw failure.reason;
    return results.some(r=>r.status==='fulfilled'&&r.value);
  }
  async processOne(tenantId:string):Promise<boolean> {
    if(!analysisEnabled())return false;
    const queue=new StudentDocumentAnalysisQueue(this.database),job=await queue.claim(tenantId);
    if(!job)return false;
    let stage:'source'|'provider'='source';
    let cacheKey:string|undefined;
    let terminal=false;
    try{
      const document=await this.database.tenantReadTransaction(tenantId,async db=>(await db.query(`SELECT * FROM ${caseSchema()}.student_operations_case_documents
        WHERE customer_id=$1 AND case_id=$2 AND document_id=$3 AND deleted_at IS NULL`,[tenantId,job.caseId,job.documentId])).rows[0]);
      if(!document)throw new DocumentExtractionError('unsupported_document',false);
      const mime=document.mime_type;
      if(!['application/pdf','image/jpeg','image/png'].includes(mime)||Number(document.size_bytes)>10*1024*1024)throw new DocumentExtractionError('unsupported_document',false);
      let cached:Buffer|undefined;
      if(studentDocumentTempStorage.enabled){
        const source=await this.database.tenantReadTransaction(tenantId,async db=>(await db.query(`SELECT * FROM (
          SELECT upload_id AS operation_id,content_sha256,updated_at FROM ${caseSchema()}.student_operations_document_uploads
            WHERE customer_id=$1 AND case_id=$2 AND document_id=$3 AND status='completed' AND deleted_at IS NULL
          UNION ALL SELECT replacement_id,content_sha256,updated_at FROM ${caseSchema()}.student_operations_document_replacements
            WHERE customer_id=$1 AND case_id=$2 AND document_id=$3 AND status IN ('committed','completed')
          ) sources ORDER BY updated_at DESC LIMIT 1`,[tenantId,job.caseId,job.documentId])).rows[0]);
        if(source){
          if(source.content_sha256!==job.contentSha256){terminal=await queue.fail(tenantId,job.jobId,job.leaseToken,'source_changed',false);return true;}
          cacheKey=studentDocumentTempStorage.key(tenantId,job.caseId,source.operation_id,job.contentSha256);
          try{cached=await studentDocumentTempStorage.read(cacheKey);}catch{/* Cache expired/unavailable: use the original. */}
        }
      }
      const bytes=cached??(document.storage_provider==='xero_files'
        ?await this.xero.fileContent(tenantId,document.xero_connection_id,document.xero_file_id)
        :await this.xero.attachmentContent(tenantId,document.xero_connection_id,document.source_kind,document.source_id,document.attachment_id));
      if(!bytes.length||bytes.length>10*1024*1024||createHash('sha256').update(bytes).digest('hex')!==job.contentSha256){
        terminal=await queue.fail(tenantId,job.jobId,job.leaseToken,'source_changed',false);return true;
      }
      stage='provider';
      const result=await this.provider.extract({kind:job.kind,bytes,mimeType:mime,schemaVersion:job.schemaVersion,signal:AbortSignal.timeout(100_000)});
      terminal=Boolean(await queue.complete(tenantId,job.jobId,job.leaseToken,result));
    }catch(error){
      const retryable=error instanceof DocumentExtractionError?error.retryable:stage==='source';
      const saved=await queue.fail(tenantId,job.jobId,job.leaseToken,error instanceof DocumentExtractionError?error.code:
        stage==='source'?'source_unavailable':'invalid_output',retryable);
      terminal=saved&&(!retryable||job.attempts>=5);
    }finally{
      if(terminal&&cacheKey)try{await studentDocumentTempStorage.remove(cacheKey);}catch{/* Lifecycle expiration is the durable cleanup fallback. */}
    }
    return true;
  }
}
