import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { DatabaseService } from '../../database/database.service.js';
import { StudentOperationsCasesService, caseId, caseSchema } from './student-operations-cases.service.js';
import type { StudentOperationsWorkspacePrincipal as Principal } from './student-operations-workspace.service.js';
import { hasStudentOperationsPermission } from './student-operations-policy.js';
import { documentExtraction, documentReview, validateDocument } from './student-document-analysis.contracts.js';
import { enqueueDocumentAnalysis } from './student-document-analysis.queue.js';

export const analysisEnabled = () => process.env.STUDENT_DOCUMENT_ANALYSIS_ENABLED === 'true';
export function analysisToday(now = new Date()): string {
  // Current Business Manager deployment uses Australia/Brisbane; no browser timezone authority.
  const parts = new Intl.DateTimeFormat('en-CA',{timeZone:'Australia/Brisbane',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
  return ['year','month','day'].map(key=>parts.find(p=>p.type===key)!.value).join('-');
}
export function analysisVerdict(row:Record<string,any>,name:string) {
  const extraction=row.review_result_id===row.result_id?(row.corrections??row.extraction):row.extraction;
  const parsed=documentExtraction.safeParse(extraction);
  const verdict=parsed.success?validateDocument(parsed.data,name,analysisToday()):null;
  const reviewed=row.review_result_id===row.result_id?row.decision:null;
  const status=row.status==='queued'||row.status==='processing'?'checking':row.status==='failed'?'check_failed':
    reviewed==='rejected'?'invalid':parsed.success?(reviewed==='confirmed'&&verdict?.status==='needs_review'?'passed':verdict?.status):'not_checked';
  return {status,parsed,verdict,reviewed};
}
export async function enqueueUploadedAnalysis(db: PoolClient, tenantId: string, id: string, documentId: string, typeId: string, hash: string) {
  if (!analysisEnabled()) return;
  const kinds = await db.query(`SELECT DISTINCT requirement_key FROM ${caseSchema()}.student_operations_status_document_requirements
    WHERE customer_id=$1 AND document_type_id=$2 AND status='active' AND requirement_key IN ('passport','engagement_letter')`,[tenantId,typeId]);
  // Ambiguous configuration must never pick a semantic type by name or filename.
  if (kinds.rows.length===1) await enqueueDocumentAnalysis(db,tenantId,{caseId:id,documentId,contentSha256:hash,kind:kinds.rows[0].requirement_key});
}

@Injectable()
export class StudentDocumentAnalysisService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService, private readonly cases: StudentOperationsCasesService) {}
  private manage(p: Principal) { if(!hasStudentOperationsPermission(p.role,'cases.manage')) throw new ForbiddenException(); }
  private async snapshot(db: PoolClient,p: Principal,id: string,documentId: string) {
    const row=await db.query(`SELECT j.job_id,j.status,j.error_code,j.document_kind,r.result_id,r.extraction,
      v.review_version,v.result_id AS review_result_id,v.decision,v.corrections,v.reason
      FROM ${caseSchema()}.student_operations_case_documents d
      LEFT JOIN LATERAL (SELECT * FROM ${caseSchema()}.student_document_analysis_jobs j WHERE j.customer_id=d.customer_id
        AND j.case_id=d.case_id AND j.document_id=d.document_id ORDER BY created_at DESC,job_id DESC LIMIT 1) j ON true
      LEFT JOIN ${caseSchema()}.student_document_analysis_results r ON r.customer_id=j.customer_id AND r.job_id=j.job_id
      LEFT JOIN LATERAL (SELECT * FROM ${caseSchema()}.student_document_reviews v WHERE v.customer_id=d.customer_id
        AND v.case_id=d.case_id AND v.document_id=d.document_id ORDER BY review_version DESC LIMIT 1) v ON true
      WHERE d.customer_id=$1 AND d.case_id=$2 AND d.document_id=$3`,[p.tenantId,id,documentId]);
    if(!row.rows[0])throw new NotFoundException('Document not found.');
    return row.rows[0];
  }
  async get(p: Principal,id: string,documentId: string) {
    caseId(documentId);
    return this.database.tenantReadTransaction(p.tenantId,async db=>{
      await this.cases.authorizedCase(db,p,id);
      if(!hasStudentOperationsPermission(p.role,'documents.metadata.read_all')&&!hasStudentOperationsPermission(p.role,'documents.metadata.read_assigned'))throw new ForbiddenException();
      const row=await this.snapshot(db,p,id,documentId);
      // Full extraction is limited to case managers; advisors receive only a safe status below.
      const manager=hasStudentOperationsPermission(p.role,'cases.manage');
      const profile=await db.query(`SELECT legal_name FROM ${caseSchema()}.student_operations_students s
        JOIN ${caseSchema()}.student_operations_cases c ON c.customer_id=s.customer_id AND c.student_id=s.student_id WHERE c.customer_id=$1 AND c.case_id=$2`,[p.tenantId,id]);
      const {parsed,verdict,status,reviewed}=analysisVerdict(row,profile.rows[0]?.legal_name??'');
      return {documentId,jobId:row.job_id??null,resultId:row.result_id??null,status,reviewVersion:row.review_version??0,
        extraction:manager&&parsed.success?parsed.data:null,reasons:manager?verdict?.reasons??[]:[],
        reviewReason:manager&&reviewed?row.reason??null:null,decision:reviewed??null,enabled:analysisEnabled()};
    });
  }
  async review(p: Principal,id: string,documentId: string,input: unknown,key?: string) {
    this.manage(p);caseId(documentId);
    const parsed=documentReview.safeParse(input);
    if(!parsed.success)throw new BadRequestException('Check the review fields and try again.');
    const value=parsed.data;
    return this.cases.write(p,'document.analysis.review',{caseId:id,documentId,...value},key,async db=>{
      await this.cases.authorizedCase(db,p,id,true);
      const row=await this.snapshot(db,p,id,documentId);
      if(row.status!=='succeeded'||row.result_id!==value.resultId||(row.review_version??0)!==value.expectedReviewVersion)throw new ConflictException('Document check changed. Reload before saving.');
      if(value.corrections && value.corrections.kind!==row.document_kind)throw new BadRequestException('The document type cannot be changed during review.');
      if(row.document_kind==='letter_of_offer')throw new BadRequestException('Offer review is not available yet.');
      const corrected=documentExtraction.parse(value.corrections??row.extraction);
      if(value.decision==='confirmed'&&corrected.kind==='passport'&&(!corrected.expiresOn||corrected.mrzExpiryMatches===false))throw new BadRequestException('Confirm the passport expiry and resolve conflicting dates before accepting.');
      await db.query(`INSERT INTO ${caseSchema()}.student_document_reviews
        (customer_id,case_id,document_id,result_id,review_version,decision,corrections,reason,actor_identity_user_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[p.tenantId,id,documentId,value.resultId,value.expectedReviewVersion+1,value.decision,value.corrections?JSON.stringify(value.corrections):null,value.reason,p.identityUserId]);
      await this.cases.activity(db,p,id,'case.document_reviewed',value.decision==='confirmed'?'Document check confirmed':'Document check rejected');
      return {saved:true};
    });
  }
  async retry(p: Principal,id: string,documentId: string,input: unknown,key?: string) {
    this.manage(p);caseId(documentId);
    const parsed=z.object({jobId:z.uuid()}).strict().safeParse(input);
    if(!parsed.success)throw new BadRequestException('Reload the document before retrying.');
    if(!analysisEnabled())throw new ConflictException('Document checking is currently unavailable.');
    return this.cases.write(p,'document.analysis.retry',{caseId:id,documentId,...parsed.data},key,async db=>{
      await this.cases.authorizedCase(db,p,id,true);
      const row=await this.snapshot(db,p,id,documentId);
      if(row.job_id!==parsed.data.jobId||row.status!=='failed')throw new ConflictException('The document check changed. Refresh its status.');
      await db.query(`UPDATE ${caseSchema()}.student_document_analysis_jobs SET status='queued',attempts=0,error_code=NULL,next_attempt_at=now(),updated_at=now()
        WHERE customer_id=$1 AND job_id=$2 AND status='failed'`,[p.tenantId,row.job_id]);
      await this.cases.activity(db,p,id,'case.document_analysis_retried','Document check retried');
      return {queued:true};
    });
  }
}
