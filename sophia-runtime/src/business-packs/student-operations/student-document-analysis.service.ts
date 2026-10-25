import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { DatabaseService } from '../../database/database.service.js';
import { StudentOperationsCasesService, caseId, caseSchema } from './student-operations-cases.service.js';
import type { StudentOperationsWorkspacePrincipal as Principal } from './student-operations-workspace.service.js';
import { hasStudentOperationsPermission } from './student-operations-policy.js';
import { documentExtraction, documentReview, validateDocument,OFFER_ANALYSIS_VERSION,DOCUMENT_ANALYSIS_VERSION } from './student-document-analysis.contracts.js';
import { enqueueDocumentAnalysis } from './student-document-analysis.queue.js';
import { assignOfferCollege,matchOfferColleges,offerCollegeDirectory,offerConfirmationProblems,offerTotals,persistOffer } from './student-case-offers.js';

const reviewSchema=documentReview.extend({collegeId:z.uuid().nullable().optional(),expectedCaseVersion:z.number().int().positive().optional(),
  replaceCollege:z.boolean().optional(),acknowledgeTotals:z.boolean().optional()}).strict();

export const analysisEnabled = () => process.env.STUDENT_DOCUMENT_ANALYSIS_ENABLED === 'true';
export async function eligibleAnalysisUploads(db:PoolClient,tenant:string,id:string,documents:string[]) {
  if(!analysisEnabled()||!documents.length)return [];
  return (await db.query(`SELECT u.document_id,u.document_type_id,u.content_sha256 FROM ${caseSchema()}.student_operations_document_uploads u
    JOIN ${caseSchema()}.student_operations_case_documents d ON d.customer_id=u.customer_id AND d.case_id=u.case_id AND d.document_id=u.document_id AND d.document_type_id=u.document_type_id
    JOIN ${caseSchema()}.student_operations_document_types t ON t.customer_id=d.customer_id AND t.document_type_id=d.document_type_id AND t.status='active'
    JOIN ${caseSchema()}.student_operations_status_document_requirements r ON r.customer_id=t.customer_id AND r.document_type_id=t.document_type_id AND r.status='active'
    WHERE u.customer_id=$1 AND u.case_id=$2 AND u.document_id=ANY($3::uuid[]) AND u.status='completed'
      AND (r.requirement_key IN ('passport','engagement_letter') OR ($4 AND r.requirement_key='letter_of_offer'))
    GROUP BY u.document_id,u.document_type_id,u.content_sha256 HAVING count(DISTINCT r.requirement_key)=1`,[tenant,id,documents,process.env.STUDENT_OFFER_ANALYSIS_ENABLED==='true'])).rows;
}
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
    WHERE customer_id=$1 AND document_type_id=$2 AND status='active' AND
      (requirement_key IN ('passport','engagement_letter') OR ($3 AND requirement_key='letter_of_offer'))`,[tenantId,typeId,process.env.STUDENT_OFFER_ANALYSIS_ENABLED==='true']);
  // Ambiguous configuration must never pick a semantic type by name or filename.
  if (kinds.rows.length===1) {const kind=kinds.rows[0].requirement_key;await enqueueDocumentAnalysis(db,tenantId,{caseId:id,documentId,contentSha256:hash,kind,schemaVersion:kind==='letter_of_offer'?OFFER_ANALYSIS_VERSION:DOCUMENT_ANALYSIS_VERSION});}
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
      const caseRow=await this.cases.authorizedCase(db,p,id);
      if(!hasStudentOperationsPermission(p.role,'documents.metadata.read_all')&&!hasStudentOperationsPermission(p.role,'documents.metadata.read_assigned'))throw new ForbiddenException();
      const row=await this.snapshot(db,p,id,documentId);
      // Full extraction is limited to case managers; advisors receive only a safe status below.
      const manager=hasStudentOperationsPermission(p.role,'cases.manage');
      const canStart=manager&&!row.job_id&&(await eligibleAnalysisUploads(db,p.tenantId,id,[documentId])).length===1;
      const profile=await db.query(`SELECT legal_name FROM ${caseSchema()}.student_operations_students s
        JOIN ${caseSchema()}.student_operations_cases c ON c.customer_id=s.customer_id AND c.student_id=s.student_id WHERE c.customer_id=$1 AND c.case_id=$2`,[p.tenantId,id]);
      const {parsed,verdict,status,reviewed}=analysisVerdict(row,profile.rows[0]?.legal_name??'');
      let offer=null;
      if(manager&&parsed.success&&parsed.data.kind==='letter_of_offer'){
        const colleges=await offerCollegeDirectory(db,p.tenantId),match=matchOfferColleges(parsed.data.collegeName,parsed.data.abn,colleges);
        const primary=(await db.query(`SELECT college_id FROM ${caseSchema()}.student_operations_case_colleges WHERE customer_id=$1 AND case_id=$2 AND is_primary`,[p.tenantId,id])).rows[0];
        const header=(await db.query(`SELECT offer_id,status,is_current,resolved_college_id FROM ${caseSchema()}.student_case_offers
          WHERE customer_id=$1 AND result_id=$2 ORDER BY review_version DESC LIMIT 1`,[p.tenantId,row.result_id])).rows[0];
        offer={...match,colleges,currentCollegeId:primary?.college_id??null,selectedCollegeId:header?.resolved_college_id??match.exactCollegeId,
          caseRecordVersion:caseRow.record_version,offerId:header?.offer_id??null,isCurrent:header?.is_current??false,
          totals:offerTotals(parsed.data),problems:offerConfirmationProblems(parsed.data)};
      }
      return {documentId,jobId:row.job_id??null,resultId:row.result_id??null,status,reviewVersion:row.review_version??0,
        extraction:manager&&parsed.success?parsed.data:null,reasons:manager?verdict?.reasons??[]:[],
        reviewReason:manager&&reviewed?row.reason??null:null,decision:reviewed??null,enabled:analysisEnabled(),offer,canStart};
    });
  }
  async review(p: Principal,id: string,documentId: string,input: unknown,key?: string) {
    this.manage(p);caseId(documentId);
    const parsed=reviewSchema.safeParse(input);
    if(!parsed.success)throw new BadRequestException('Check the review fields and try again.');
    const value=parsed.data;
    return this.cases.write(p,'document.analysis.review',{caseId:id,documentId,...value},key,async db=>{
      const caseRow=await this.cases.authorizedCase(db,p,id,true);
      const row=await this.snapshot(db,p,id,documentId);
      if(row.status!=='succeeded'||row.result_id!==value.resultId||(row.review_version??0)!==value.expectedReviewVersion)throw new ConflictException('Document check changed. Reload before saving.');
      if(value.corrections && value.corrections.kind!==row.document_kind)throw new BadRequestException('The document type cannot be changed during review.');
      const corrected=documentExtraction.parse(value.corrections??row.extraction);
      let selected=null;
      if(corrected.kind==='letter_of_offer'){
        if(value.expectedCaseVersion!==caseRow.record_version)throw new ConflictException('Case changed. Reload the offer before saving.');
        if(value.decision==='confirmed'){
          const problems=offerConfirmationProblems(corrected);
          if(problems.length)throw new BadRequestException(problems[0]);
          if(offerTotals(corrected).unexplainedDifference&&!value.acknowledgeTotals)throw new BadRequestException('Review and acknowledge the difference between the offer total and instalments.');
          selected=(await offerCollegeDirectory(db,p.tenantId)).find(c=>c.collegeId===value.collegeId);
          if(!selected)throw new BadRequestException('Select an active college in this company.');
          const primary=(await db.query(`SELECT college_id FROM ${caseSchema()}.student_operations_case_colleges WHERE customer_id=$1 AND case_id=$2 AND is_primary`,[p.tenantId,id])).rows[0];
          if(primary&&primary.college_id!==selected.collegeId&&!value.replaceCollege)throw new BadRequestException('Confirm replacing the existing case college.');
        }
      }
      if(value.decision==='confirmed'&&corrected.kind==='passport'&&(!corrected.expiresOn||corrected.mrzExpiryMatches===false))throw new BadRequestException('Confirm the passport expiry and resolve conflicting dates before accepting.');
      const saved=await db.query(`INSERT INTO ${caseSchema()}.student_document_reviews
        (customer_id,case_id,document_id,result_id,review_version,decision,corrections,reason,actor_identity_user_id,review_context)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING review_id`,[p.tenantId,id,documentId,value.resultId,value.expectedReviewVersion+1,value.decision,value.corrections?JSON.stringify(value.corrections):null,value.reason,p.identityUserId,
          JSON.stringify(corrected.kind==='letter_of_offer'?{collegeId:selected?.collegeId??null,expectedCaseVersion:value.expectedCaseVersion,replaceCollege:Boolean(value.replaceCollege),acknowledgeTotals:Boolean(value.acknowledgeTotals)}:{})]);
      if(corrected.kind==='letter_of_offer'){
        if(selected){
          await assignOfferCollege(db,p.tenantId,id,selected);
          await persistOffer(db,p.tenantId,id,documentId,value.resultId,corrected,{id:saved.rows[0].review_id,version:value.expectedReviewVersion+1,collegeId:selected.collegeId});
          await db.query(`UPDATE ${caseSchema()}.student_operations_cases SET course_name=$3,record_version=record_version+1,updated_at=now() WHERE customer_id=$1 AND case_id=$2`,[p.tenantId,id,corrected.courses[0].name.slice(0,200)]);
        }else{
          await db.query(`UPDATE ${caseSchema()}.student_case_offers SET is_current=false,status='superseded',record_version=record_version+1
            WHERE customer_id=$1 AND case_id=$2 AND result_id=$3 AND is_current`,[p.tenantId,id,value.resultId]);
          await db.query(`UPDATE ${caseSchema()}.student_operations_cases SET record_version=record_version+1,updated_at=now() WHERE customer_id=$1 AND case_id=$2`,[p.tenantId,id]);
        }
      }
      await this.cases.activity(db,p,id,'case.document_reviewed',corrected.kind==='letter_of_offer'?(value.decision==='confirmed'?'Letter of Offer confirmed':'Letter of Offer rejected'):(value.decision==='confirmed'?'Document check confirmed':'Document check rejected'));
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
  async start(p:Principal,id:string,documentId:string,input:unknown,key?:string){
    this.manage(p);caseId(documentId);if(!z.object({}).strict().safeParse(input).success)throw new BadRequestException('Reload the document before checking.');
    if(!analysisEnabled())throw new ConflictException('Document checking is currently unavailable.');
    return this.cases.write(p,'document.analysis.start',{caseId:id,documentId},key,async db=>{
      await this.cases.authorizedCase(db,p,id,true);
      const row=await this.snapshot(db,p,id,documentId);
      if(row.job_id)throw new ConflictException('A check already exists. Refresh its status.');
      const upload=(await eligibleAnalysisUploads(db,p.tenantId,id,[documentId]))[0];
      if(!upload)throw new BadRequestException('This saved document is not available for automatic checking.');
      await enqueueUploadedAnalysis(db,p.tenantId,id,documentId,upload.document_type_id,upload.content_sha256);
      await this.cases.activity(db,p,id,'case.document_check_requested','Document check requested');
      return {queued:true};
    });
  }
}
