import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { createHash,randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service.js';
import { XeroConnectorService } from '../../connectors/xero/xero-connector.service.js';
import type { XeroAttachmentSource } from '../../connectors/xero/xero.client.js';
import { StudentOperationsCasesService,caseSchema,caseId } from './student-operations-cases.service.js';
import type { StudentOperationsWorkspacePrincipal as Principal } from './student-operations-workspace.service.js';
import { hasStudentOperationsPermission } from './student-operations-policy.js';
import { StudentDocumentSourceDiscovery } from './student-document-source-discovery.js';
import { StudentPrimaryXeroContact } from './student-primary-xero-contact.js';
import { StudentDocumentContactStorage } from './student-document-contact-storage.js';
import { documentRequirements } from './student-document-requirements.js';
import { publicCaseStatus } from './student-operations-case-workflow.js';
import { enqueueUploadedAnalysis,analysisVerdict,eligibleAnalysisUploads } from './student-document-analysis.service.js';
import { reconcileDocumentChecklist } from './student-document-checklist.js';

@Injectable()
export class StudentOperationsCaseDocumentsService {
  constructor(@Inject(DatabaseService) private readonly database:DatabaseService,
    private readonly cases:StudentOperationsCasesService,private readonly xero:XeroConnectorService) {}

  async uploadOptions(p:Principal,id:string) {
    if(!hasStudentOperationsPermission(p.role,'cases.manage')) throw new ForbiddenException();
    return this.database.tenantReadTransaction(p.tenantId,async db=>{
      await this.cases.authorizedCase(db,p,id);
      const connection=await new StudentPrimaryXeroContact(this.database,this.cases,this.xero).connection(db,p.tenantId);
      return {enabled:process.env.XERO_ATTACHMENT_UPLOAD_ENABLED==='true'||process.env.XERO_FILES_DOCUMENT_STORAGE_ENABLED==='true',available:connection!==null};
    });
  }

  async upload(p:Principal,id:string,input:unknown,file:{buffer:Buffer;originalname:string;mimetype:string}|undefined,key?:string) {
    if(!hasStudentOperationsPermission(p.role,'cases.manage')) throw new ForbiddenException();
    caseId(id);
    // Legacy target fields are accepted ONLY to resume already persisted uploads
    // during rollout; new writes always resolve the primary destination server-side.
    const parsed=z.object({documentTypeId:z.string().uuid(),connectionId:z.string().uuid().optional(),contactId:z.string().uuid().optional()})
      .strict().refine(v=>Boolean(v.connectionId)===Boolean(v.contactId)).safeParse(input);
    if(!parsed.success || !file || !Buffer.isBuffer(file.buffer) || !file.buffer.length || file.buffer.length>10*1024*1024
      || !key || !/^[A-Za-z0-9._:-]{8,160}$/.test(key)) throw new BadRequestException('Choose a document type and a PDF, JPEG or PNG file up to 10 MB.');
    const name=file.originalname.replace(/[\x00-\x1f\x7f<>:"\\/|?*+]/g,'_').trim();
    const bytes=file.buffer;
    const mime=bytes.subarray(0,5).toString()==='%PDF-' && bytes.subarray(-1024).includes(Buffer.from('%%EOF')) ? 'application/pdf'
      : bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.subarray(-8,-4).toString()==='IEND' ? 'image/png'
      : bytes[0]===255 && bytes[1]===216 && bytes[2]===255 && bytes[bytes.length-2]===255 && bytes[bytes.length-1]===217 ? 'image/jpeg' : null;
    const extension=mime==='application/pdf'?/\.pdf$/i:mime==='image/png'?/\.png$/i:/\.jpe?g$/i;
    if(!mime || !extension.test(name) || name.length>255 || !['application/octet-stream',mime].includes(file.mimetype)) throw new BadRequestException('The file content, extension and format must match PDF, JPEG or PNG.');
    const hash=createHash('sha256').update(bytes).digest('hex');
    const fingerprint=createHash('sha256').update(JSON.stringify({caseId:id,name,mime,hash,...parsed.data})).digest('hex');
    const lease=randomUUID(),s=caseSchema();
    // Validate case/type/idempotency BEFORE provisioning external storage. A
    // persisted upload keeps its original target even if integration setup changes.
    const prior=await this.database.tenantReadTransaction(p.tenantId,async db=>{
      await this.cases.authorizedCase(db,p,id);
      const saved=await db.query(`SELECT * FROM ${s}.student_operations_document_uploads
        WHERE customer_id=$1 AND actor_identity_user_id=$2 AND idempotency_key=$3`,[p.tenantId,p.identityUserId,key]);
      if(saved.rows[0] && saved.rows[0].request_fingerprint!==fingerprint) throw new ConflictException('The upload request changed. Select the file again.');
      if(!saved.rows[0] && parsed.data.contactId) throw new BadRequestException('Reload the page before uploading a document.');
      if(!saved.rows[0] || !['completed','uploaded','associated'].includes(saved.rows[0].status)) {
        const type=await db.query(`SELECT 1 FROM ${s}.student_operations_document_types WHERE customer_id=$1 AND document_type_id=$2 AND status='active'`,[p.tenantId,parsed.data.documentTypeId]);
        if(!type.rowCount) throw new BadRequestException('Choose an active document type.');
      }
      return saved.rows[0];
    });
    const target=prior?{xero_connection_id:prior.xero_connection_id,source_id:prior.source_id}
      :await new StudentPrimaryXeroContact(this.database,this.cases,this.xero).ensure(p,id);
    const job=await this.database.tenantTransaction(p.tenantId,async db=>{
      await this.cases.authorizedCase(db,p,id);
      const uploadId=randomUUID();
      const extension=name.slice(name.lastIndexOf('.'));
      const remoteName=`${uploadId}-${name.slice(0,-extension.length).slice(0,180)}${extension}`;
      const storageProvider=process.env.XERO_FILES_DOCUMENT_STORAGE_ENABLED==='true'?'xero_files':'accounting_attachment';
      await db.query(`INSERT INTO ${s}.student_operations_document_uploads(upload_id,customer_id,actor_identity_user_id,idempotency_key,request_fingerprint,case_id,document_type_id,xero_connection_id,source_kind,source_id,file_name,mime_type,size_bytes,content_sha256,storage_provider)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT(customer_id,actor_identity_user_id,idempotency_key) DO NOTHING`,[uploadId,p.tenantId,p.identityUserId,key,fingerprint,id,parsed.data.documentTypeId,target.xero_connection_id,'Contacts',target.source_id,remoteName,mime,bytes.length,hash,storageProvider]);
      const saved=await db.query(`SELECT *,lease_expires_at>now() AS leased FROM ${s}.student_operations_document_uploads WHERE customer_id=$1 AND actor_identity_user_id=$2 AND idempotency_key=$3 FOR UPDATE`,[p.tenantId,p.identityUserId,key]);
      const row=saved.rows[0];
      if(row.request_fingerprint!==fingerprint) throw new ConflictException('The upload request changed. Select the file again.');
      if(row.status==='completed' || (row.storage_provider==='accounting_attachment'&&row.status==='uploaded')) return row;
      if(row.leased) throw new ConflictException('This upload is still processing. Retry the same file in two minutes.');
      const type=await db.query(`SELECT 1 FROM ${s}.student_operations_document_types WHERE customer_id=$1 AND document_type_id=$2 AND status='active' FOR SHARE`,[p.tenantId,parsed.data.documentTypeId]);
      if(!type.rowCount) throw new BadRequestException('Choose an active document type.');
      const acquired=await db.query(`UPDATE ${s}.student_operations_document_uploads SET status=CASE WHEN status='ready' THEN 'uploading' ELSE status END,lease_token=$2,lease_expires_at=now()+interval '2 minutes',updated_at=now() WHERE upload_id=$1 RETURNING *`,[row.upload_id,lease]);
      return acquired.rows[0];
    });
    if(job.status==='completed') return {documentId:String(job.document_id)};
    if(job.storage_provider==='xero_files') {
      let providerFileId=job.provider_file_id?String(job.provider_file_id):null;
      const providerKey=createHash('sha256').update(`${p.tenantId}:${p.identityUserId}:${job.upload_id}:file`).digest('hex');
      if(!providerFileId) {
        const uploaded=await this.xero.uploadFile(p.tenantId,job.xero_connection_id,job.file_name,mime,bytes,providerKey);providerFileId=uploaded.fileId;
        await this.database.tenantTransaction(p.tenantId,async db=>{
          const receipt=await db.query(`UPDATE ${s}.student_operations_document_uploads SET status='uploaded',provider_file_id=$3,updated_at=now() WHERE customer_id=$1 AND upload_id=$2 AND lease_token=$4 AND lease_expires_at>now() RETURNING upload_id`,[p.tenantId,job.upload_id,providerFileId,lease]);
          if(!receipt.rowCount)throw new ConflictException('Upload confirmation is pending. Retry the same file.');
        });
      }
      if(!job.provider_associated_at) {
        const associationKey=createHash('sha256').update(`${p.tenantId}:${p.identityUserId}:${job.upload_id}:contact`).digest('hex');
        await this.xero.associateFileWithContact(p.tenantId,job.xero_connection_id,providerFileId,job.source_id,associationKey);
        await this.database.tenantTransaction(p.tenantId,async db=>{
          const receipt=await db.query(`UPDATE ${s}.student_operations_document_uploads SET status='associated',provider_associated_at=now(),updated_at=now() WHERE customer_id=$1 AND upload_id=$2 AND lease_token=$3 AND lease_expires_at>now() RETURNING upload_id`,[p.tenantId,job.upload_id,lease]);
          if(!receipt.rowCount)throw new ConflictException('File association confirmation is pending. Retry the same file.');
        });
      }
    } else if(job.status!=='uploaded') {
      // Stable filename + provider idempotency key survive timeouts/restarts;
      // never blindly retry a write with a new identity or overwrite user files.
      const providerKey=createHash('sha256').update(`${p.tenantId}:${p.identityUserId}:${job.upload_id}`).digest('hex');
      const storage=new StudentDocumentContactStorage(this.database,this.cases,this.xero);
      let destination=await storage.reserve(p,job,lease);
      let attachment:import('../../connectors/xero/xero.client.js').XeroAttachment|undefined;
      for(let routing=0;routing<3;routing++) {
        try {
          attachment=await this.xero.uploadAttachment(p.tenantId,destination.xero_connection_id,'Contacts',destination.source_id,job.file_name,mime,bytes,providerKey,
            ()=>storage.attempted(p,destination,lease));
          break;
        } catch(error) {
          const response=error instanceof ConflictException?error.getResponse():null;
          if(!response || typeof response!=='object' || !('errorCode' in response) || response.errorCode!=='student_document_storage_full'
            || !await storage.releaseFull(p,destination,lease)) throw error;
          destination=await storage.reserve(p,destination,lease);
        }
      }
      if(!attachment) throw new ConflictException({errorCode:'student_document_storage_pending',message:'Document storage is being prepared. Retry the same file shortly.'});
      await this.database.tenantTransaction(p.tenantId,async db=>{
        const receipt=await db.query(`UPDATE ${s}.student_operations_document_uploads SET status='uploaded',provider_attachment_id=$3,lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE customer_id=$1 AND upload_id=$2 AND lease_token=$4 RETURNING upload_id`,[p.tenantId,job.upload_id,attachment.attachmentId,lease]);
        if(!receipt.rowCount) throw new ConflictException('Upload confirmation is pending. Retry the same file.');
      });
    }
    return this.database.tenantTransaction(p.tenantId,async db=>{
      await this.cases.authorizedCase(db,p,id,true);
      const saved=await db.query(`SELECT * FROM ${s}.student_operations_document_uploads WHERE customer_id=$1 AND upload_id=$2 FOR UPDATE`,[p.tenantId,job.upload_id]);
      const row=saved.rows[0];
      if(row.status==='completed') return {documentId:String(row.document_id)};
      if(row.status!==(row.storage_provider==='xero_files'?'associated':'uploaded')) throw new ConflictException('Upload confirmation is pending. Retry the same file.');
      const providerId=row.storage_provider==='xero_files'?row.provider_file_id:row.provider_attachment_id;
      const result=await db.query(`INSERT INTO ${s}.student_operations_case_documents(customer_id,case_id,xero_connection_id,source_kind,source_id,attachment_id,file_name,mime_type,size_bytes,document_type_id,storage_provider,xero_file_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT(customer_id,case_id,xero_connection_id,source_kind,source_id,attachment_id) DO UPDATE SET document_type_id=excluded.document_type_id,last_seen_at=now()
        RETURNING document_id`,[p.tenantId,id,row.xero_connection_id,row.source_kind,row.source_id,providerId,row.file_name,row.mime_type,row.size_bytes,row.document_type_id,row.storage_provider,row.storage_provider==='xero_files'?providerId:null]);
      await this.cases.activity(db,p,id,'case.document_uploaded','Document uploaded to Xero');
      await enqueueUploadedAnalysis(db,p.tenantId,id,String(result.rows[0].document_id),row.document_type_id,row.content_sha256);
      await db.query(`UPDATE ${s}.student_operations_document_uploads SET status='completed',document_id=$3,lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE customer_id=$1 AND upload_id=$2`,[p.tenantId,job.upload_id,result.rows[0].document_id]);
      await reconcileDocumentChecklist(db,p.tenantId,id);
      return {documentId:String(result.rows[0].document_id)};
    });
  }

  async replace(p:Principal,id:string,documentId:string,file:{buffer:Buffer;originalname:string;mimetype:string}|undefined,key?:string) {
    if(!hasStudentOperationsPermission(p.role,'cases.manage'))throw new ForbiddenException();caseId(id);caseId(documentId);
    if(!file||!Buffer.isBuffer(file.buffer)||!file.buffer.length||file.buffer.length>10*1024*1024||!key||!/^[A-Za-z0-9._:-]{8,160}$/.test(key))
      throw new BadRequestException('Choose a PDF, JPEG or PNG file up to 10 MB.');
    const selectedName=file.originalname.replace(/[\x00-\x1f\x7f<>:"\\/|?*+]/g,'_').trim(),bytes=file.buffer;
    const mime=bytes.subarray(0,5).toString()==='%PDF-'&&bytes.subarray(-1024).includes(Buffer.from('%%EOF'))?'application/pdf'
      :bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&bytes.subarray(-8,-4).toString()==='IEND'?'image/png'
      :bytes[0]===255&&bytes[1]===216&&bytes[2]===255&&bytes[bytes.length-2]===255&&bytes[bytes.length-1]===217?'image/jpeg':null;
    const extension=mime==='application/pdf'?/\.pdf$/i:mime==='image/png'?/\.png$/i:/\.jpe?g$/i;
    if(!mime||!extension.test(selectedName)||selectedName.length>255||!['application/octet-stream',mime].includes(file.mimetype))
      throw new BadRequestException('The file content, extension and format must match PDF, JPEG or PNG.');
    const contentHash=createHash('sha256').update(bytes).digest('hex'),fingerprint=createHash('sha256')
      .update(JSON.stringify({caseId:id,documentId,name:selectedName,mime,contentHash})).digest('hex');
    const lease=randomUUID(),replacementId=randomUUID(),s=caseSchema();
    const job=await this.database.tenantTransaction(p.tenantId,async db=>{
      await this.cases.authorizedCase(db,p,id,true);
      const document=(await db.query(`SELECT * FROM ${s}.student_operations_case_documents WHERE customer_id=$1 AND case_id=$2 AND document_id=$3 AND deleted_at IS NULL FOR UPDATE`,[p.tenantId,id,documentId])).rows[0];
      if(!document)throw new NotFoundException('Document not found.');
      let existing=(await db.query(`SELECT * FROM ${s}.student_operations_document_replacements WHERE customer_id=$1 AND actor_identity_user_id=$2 AND idempotency_key=$3 FOR UPDATE`,[p.tenantId,p.identityUserId,key])).rows[0];
      if(existing&&existing.request_fingerprint!==fingerprint)throw new ConflictException('The replacement request changed. Select the file again.');
      if(!existing){
        const deleting=await db.query(`SELECT 1 FROM ${s}.student_operations_document_deletions WHERE customer_id=$1 AND document_id=$2 AND status<>'completed'`,[p.tenantId,documentId]);
        if(deleting.rowCount)throw new ConflictException('This document is being deleted and cannot be replaced.');
        const active=(await db.query(`SELECT * FROM ${s}.student_operations_document_replacements WHERE customer_id=$1 AND document_id=$2 AND status<>'completed' FOR UPDATE`,[p.tenantId,documentId])).rows[0];
        if(active){
          if(active.actor_identity_user_id!==p.identityUserId||active.request_fingerprint!==fingerprint)
            throw new ConflictException('This document is already being replaced. Retry shortly.');
          // A modal/page reload creates a new browser idempotency key. Resume
          // only the exact same actor + file fingerprint; retain the original
          // durable key so an older client retry remains safe as well.
          existing=active;
        }else{
          const remoteName=document.storage_provider==='xero_files'?`${replacementId}-${selectedName}`:String(document.file_name);
          await db.query(`INSERT INTO ${s}.student_operations_document_replacements(customer_id,replacement_id,case_id,document_id,actor_identity_user_id,idempotency_key,request_fingerprint,storage_provider,old_provider_file_id,file_name,mime_type,size_bytes,content_sha256)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[p.tenantId,replacementId,id,documentId,p.identityUserId,key,fingerprint,document.storage_provider,document.xero_file_id,remoteName,mime,bytes.length,contentHash]);
        }
      }
      const durableReplacementId=existing?.replacement_id??replacementId;
      const row=(await db.query(`SELECT *,lease_expires_at>now() AS leased FROM ${s}.student_operations_document_replacements WHERE customer_id=$1 AND replacement_id=$2 FOR UPDATE`,[p.tenantId,durableReplacementId])).rows[0];
      if(row.status==='completed'||row.status==='committed')return {...row,document};
      if(row.leased)throw new ConflictException('This replacement is still processing. Retry the same file in two minutes.');
      const acquired=(await db.query(`UPDATE ${s}.student_operations_document_replacements SET status=CASE WHEN status='ready' THEN 'processing' ELSE status END,lease_token=$3,lease_expires_at=now()+interval '2 minutes',updated_at=now() WHERE customer_id=$1 AND replacement_id=$2 RETURNING *`,[p.tenantId,row.replacement_id,lease])).rows[0];
      return {...acquired,document};
    });
    if(job.status==='completed')return {documentId,replaced:true,cleanupPending:false};
    if(job.status!=='committed'){
      if(job.storage_provider==='xero_files'){
        let newFileId=job.new_provider_file_id?String(job.new_provider_file_id):null;
        if(!newFileId){
          const receipt=await this.xero.uploadFile(p.tenantId,job.document.xero_connection_id,job.file_name,mime,bytes,
            createHash('sha256').update(`${p.tenantId}:${job.replacement_id}:replacement`).digest('hex'));
          newFileId=receipt.fileId;
          await this.database.tenantTransaction(p.tenantId,async db=>{
            const saved=await db.query(`UPDATE ${s}.student_operations_document_replacements SET status='uploaded',new_provider_file_id=$3,updated_at=now() WHERE customer_id=$1 AND replacement_id=$2 AND lease_token=$4 AND lease_expires_at>now() RETURNING replacement_id`,[p.tenantId,job.replacement_id,newFileId,lease]);
            if(!saved.rowCount)throw new ConflictException('Replacement upload confirmation is pending. Retry the same file.');
          });
        }
        if(!job.provider_associated_at){
          await this.xero.associateFileWithContact(p.tenantId,job.document.xero_connection_id,newFileId,job.document.source_id,
            createHash('sha256').update(`${p.tenantId}:${job.replacement_id}:association`).digest('hex'));
          await this.database.tenantTransaction(p.tenantId,async db=>{
            const saved=await db.query(`UPDATE ${s}.student_operations_document_replacements SET status='associated',provider_associated_at=now(),updated_at=now() WHERE customer_id=$1 AND replacement_id=$2 AND lease_token=$3 AND lease_expires_at>now() RETURNING replacement_id`,[p.tenantId,job.replacement_id,lease]);
            if(!saved.rowCount)throw new ConflictException('Replacement association confirmation is pending. Retry the same file.');
          });
        }
      }else{
        const receipt=await this.xero.replaceAttachment(p.tenantId,job.document.xero_connection_id,job.document.source_kind as XeroAttachmentSource,job.document.source_id,
          job.document.file_name,mime,bytes,createHash('sha256').update(`${p.tenantId}:${job.replacement_id}:attachment`).digest('hex'));
        await this.database.tenantTransaction(p.tenantId,async db=>{
          const saved=await db.query(`UPDATE ${s}.student_operations_document_replacements SET status='uploaded',provider_attachment_id=$3,updated_at=now() WHERE customer_id=$1 AND replacement_id=$2 AND lease_token=$4 AND lease_expires_at>now() RETURNING replacement_id`,[p.tenantId,job.replacement_id,receipt.attachmentId,lease]);
          if(!saved.rowCount)throw new ConflictException('Replacement confirmation is pending. Retry the same file.');
        });
      }
      try{await this.database.tenantTransaction(p.tenantId,async db=>{
        await this.cases.authorizedCase(db,p,id,true);
        const replacement=(await db.query(`SELECT * FROM ${s}.student_operations_document_replacements WHERE customer_id=$1 AND replacement_id=$2 FOR UPDATE`,[p.tenantId,job.replacement_id])).rows[0];
        if(replacement.lease_token!==lease)throw new ConflictException('This replacement is being finalized by another request. Retry shortly.');
        const providerId=replacement.storage_provider==='xero_files'?replacement.new_provider_file_id:replacement.provider_attachment_id;
        if(!providerId||replacement.storage_provider==='xero_files'&&!replacement.provider_associated_at)throw new ConflictException('Replacement confirmation is pending. Retry the same file.');
        const displayName=replacement.storage_provider==='xero_files'?replacement.file_name:job.document.file_name;
        const replaced=await db.query(`UPDATE ${s}.student_operations_case_documents SET attachment_id=$4::uuid,xero_file_id=CASE WHEN storage_provider='xero_files' THEN $4::uuid ELSE NULL END,file_name=$5,mime_type=$6,size_bytes=$7,last_seen_at=now(),discovered_at=now() WHERE customer_id=$1 AND case_id=$2 AND document_id=$3 AND deleted_at IS NULL RETURNING document_id`,[p.tenantId,id,documentId,providerId,displayName,mime,bytes.length]);
        if(!replaced.rowCount)throw new ConflictException('The document is no longer available to replace.');
        await db.query(`UPDATE ${s}.student_case_offers SET is_current=false,status='superseded',record_version=record_version+1 WHERE customer_id=$1 AND case_id=$2 AND document_id=$3 AND is_current`,[p.tenantId,id,documentId]);
        await enqueueUploadedAnalysis(db,p.tenantId,id,documentId,job.document.document_type_id,contentHash);
        await db.query(`UPDATE ${s}.student_operations_document_replacements SET status='committed',lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE customer_id=$1 AND replacement_id=$2`,[p.tenantId,job.replacement_id]);
        await this.cases.activity(db,p,id,'case.document_replaced','Document replaced in Xero');await reconcileDocumentChecklist(db,p.tenantId,id);
      });}catch(error){
        // Provider writes have finished and their receipts are persisted. Once
        // the local transaction ends, release only this request's lease so a
        // retry can resume immediately without repeating the Files upload.
        try{await this.database.tenantTransaction(p.tenantId,db=>db.query(`UPDATE ${s}.student_operations_document_replacements
          SET lease_token=NULL,lease_expires_at=NULL,updated_at=now()
          WHERE customer_id=$1 AND replacement_id=$2 AND lease_token=$3`,[p.tenantId,job.replacement_id,lease]));}
        catch{/* Preserve the original error; the bounded lease will expire. */}
        throw error;
      }
    }
    // The new provider file and Sophia document row are already committed at
    // this point. Old-file cleanup is a separate idempotent phase: a provider
    // or bookkeeping failure must not tell the user that replacement failed
    // after the new document became active.
    let cleanupPending=false;
    if(job.storage_provider==='xero_files'&&job.old_provider_file_id){
      try{await this.xero.deleteFile(p.tenantId,job.document.xero_connection_id,job.old_provider_file_id);}
      catch{cleanupPending=true;}
    }
    if(!cleanupPending){
      try{
        await this.database.tenantTransaction(p.tenantId,async db=>{
          await db.query(`UPDATE ${s}.student_operations_document_replacements SET status='completed',updated_at=now() WHERE customer_id=$1 AND replacement_id=$2`,[p.tenantId,job.replacement_id]);
        });
      }catch{
        // Keep the durable row in `committed`. Retrying the same file resumes
        // cleanup/finalization without uploading or associating another file.
        cleanupPending=true;
      }
    }
    return {documentId,replaced:true,cleanupPending};
  }

  async list(p:Principal,id:string,input:unknown={}) {
    const parsed=z.object({page:z.coerce.number().int().min(1).default(1),limit:z.coerce.number().int().min(1).max(100).default(25)}).strict().safeParse(input);
    if(!parsed.success) throw new BadRequestException('Invalid document pagination.');
    const {page,limit}=parsed.data;
    return this.database.tenantReadTransaction(p.tenantId,async db=>{
      const row=await this.cases.authorizedCase(db,p,id);
      if(!hasStudentOperationsPermission(p.role,'documents.metadata.read_all') && !hasStudentOperationsPermission(p.role,'documents.metadata.read_assigned')) throw new ForbiddenException();
      const count=await db.query(`SELECT count(*)::int total FROM ${caseSchema()}.student_operations_case_documents WHERE customer_id=$1 AND case_id=$2 AND deleted_at IS NULL`,[p.tenantId,id]);
      const documents=await db.query(`SELECT d.document_id AS "documentId",d.file_name AS "fileName",d.mime_type AS "mimeType",d.size_bytes::float8 AS "sizeBytes",d.source_kind AS "sourceKind",d.last_seen_at AS "lastSeenAt",t.document_type_id AS "documentTypeId",t.name AS "documentTypeName",t.required AS "documentTypeRequired",
        true AS "canReplaceFile",(d.storage_provider='xero_files' AND d.xero_file_id IS NOT NULL) AS "canDelete"
        FROM ${caseSchema()}.student_operations_case_documents d LEFT JOIN ${caseSchema()}.student_operations_document_types t ON t.customer_id=d.customer_id AND t.document_type_id=d.document_type_id
        WHERE d.customer_id=$1 AND d.case_id=$2 AND d.deleted_at IS NULL ORDER BY d.file_name,d.document_id LIMIT $3 OFFSET $4`,[p.tenantId,id,limit,(page-1)*limit]);
      const jobs=await db.query(`SELECT status,error_code AS "errorCode",count(*)::int count FROM ${caseSchema()}.student_operations_document_jobs WHERE customer_id=$1 AND case_id=$2 GROUP BY status,error_code`,[p.tenantId,id]);
      const requirements=await documentRequirements(db,p.tenantId,publicCaseStatus(row.lifecycle_status),id);
      const analyses=await db.query(`SELECT j.document_id,j.status,r.result_id,r.extraction,v.result_id AS review_result_id,v.corrections,v.decision,v.review_context,
        s.legal_name FROM (SELECT DISTINCT ON(document_id) * FROM ${caseSchema()}.student_document_analysis_jobs
        WHERE customer_id=$1 AND case_id=$2 ORDER BY document_id,created_at DESC,job_id DESC) j
        JOIN ${caseSchema()}.student_operations_case_documents d ON d.customer_id=j.customer_id AND d.case_id=j.case_id AND d.document_id=j.document_id AND d.deleted_at IS NULL
        JOIN ${caseSchema()}.student_operations_cases c ON c.customer_id=j.customer_id AND c.case_id=j.case_id
        JOIN ${caseSchema()}.student_operations_students s ON s.customer_id=c.customer_id AND s.student_id=c.student_id
        LEFT JOIN ${caseSchema()}.student_document_analysis_results r ON r.customer_id=j.customer_id AND r.job_id=j.job_id
        LEFT JOIN LATERAL (SELECT * FROM ${caseSchema()}.student_document_reviews v WHERE v.customer_id=j.customer_id
          AND v.case_id=j.case_id AND v.document_id=j.document_id ORDER BY review_version DESC LIMIT 1) v ON true`,[p.tenantId,id]);
      const eligible=hasStudentOperationsPermission(p.role,'cases.manage')?await eligibleAnalysisUploads(db,p.tenantId,id,documents.rows.map(d=>d.documentId)):[];
      const latest=await db.query(`SELECT DISTINCT ON(document_type_id) document_id FROM ${caseSchema()}.student_operations_case_documents
        WHERE customer_id=$1 AND case_id=$2 AND document_type_id IS NOT NULL AND deleted_at IS NULL ORDER BY document_type_id,discovered_at DESC,document_id DESC`,[p.tenantId,id]);
      return {documents:documents.rows.map(d=>{const a=analyses.rows.find(j=>j.document_id===d.documentId);return {...d,
        canReplace:Boolean(a&&a.decision==='rejected'&&a.review_result_id===a.result_id&&latest.rows.some(r=>r.document_id===d.documentId)),
        analysisStatus:a?analysisVerdict(a,a.legal_name??'').status:eligible.some(u=>u.document_id===d.documentId)?'not_checked':null};}),
        analysisPending:analyses.rows.some(j=>j.status==='queued'||j.status==='processing'),requirements,discovery:jobs.rows,discoveryRequested:jobs.rows.length>0,page,limit,total:count.rows[0].total};
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
      const result=await db.query(`SELECT * FROM ${caseSchema()}.student_operations_case_documents WHERE customer_id=$1 AND case_id=$2 AND document_id=$3 AND deleted_at IS NULL`,[p.tenantId,id,documentId]);
      if(!result.rows[0]) throw new NotFoundException('Document not found.');
      await this.cases.activity(db,p,id,'case.document_access_requested','Document download requested');
      return result.rows[0];
    });
    const buffer=document.storage_provider==='xero_files'
      ?await this.xero.fileContent(p.tenantId,document.xero_connection_id,document.xero_file_id)
      :await this.xero.attachmentContent(p.tenantId,document.xero_connection_id,document.source_kind,document.source_id,document.attachment_id);
    // Recheck after the network call: an advisor may have been reassigned.
    await this.database.tenantTransaction(p.tenantId,async db=>{
      await this.cases.authorizedCase(db,p,id);
      await this.cases.activity(db,p,id,'case.document_downloaded','Document downloaded');
    });
    return {buffer,fileName:String(document.file_name).replace(/[\r\n"\\/\x00-\x1f]/g,'_')};
  }

  async remove(p:Principal,id:string,documentId:string,key?:string) {
    if(!hasStudentOperationsPermission(p.role,'cases.manage'))throw new ForbiddenException();caseId(documentId);
    if(!key||!/^[A-Za-z0-9._:-]{8,160}$/.test(key))throw new BadRequestException('A valid deletion request is required.');
    const token=randomUUID(),fingerprint=createHash('sha256').update(JSON.stringify({caseId:id,documentId})).digest('hex'),s=caseSchema();
    const deletion=await this.database.tenantTransaction(p.tenantId,async db=>{
      await this.cases.authorizedCase(db,p,id,true);
      const document=(await db.query(`SELECT * FROM ${s}.student_operations_case_documents WHERE customer_id=$1 AND case_id=$2 AND document_id=$3 FOR UPDATE`,[p.tenantId,id,documentId])).rows[0];
      if(!document)throw new NotFoundException('Document not found.');
      if(document.storage_provider!=='xero_files'||!document.xero_file_id)throw new ConflictException('Only documents uploaded through the new Xero Files workflow can be deleted.');
      const replacing=await db.query(`SELECT 1 FROM ${s}.student_operations_document_replacements WHERE customer_id=$1 AND document_id=$2 AND status<>'completed'`,[p.tenantId,documentId]);
      if(replacing.rowCount)throw new ConflictException('This document is being replaced and cannot be deleted.');
      await db.query(`INSERT INTO ${s}.student_operations_document_deletions(customer_id,case_id,document_id,actor_identity_user_id,idempotency_key,request_fingerprint)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(customer_id,document_id) DO NOTHING`,[p.tenantId,id,documentId,p.identityUserId,key,fingerprint]);
      const row=(await db.query(`SELECT *,lease_expires_at>now() AS leased FROM ${s}.student_operations_document_deletions WHERE customer_id=$1 AND document_id=$2 FOR UPDATE`,[p.tenantId,documentId])).rows[0];
      if(row.request_fingerprint!==fingerprint)throw new ConflictException('The deletion request does not match this document.');
      if(row.status==='completed'||document.deleted_at)return {...row,status:'completed',xero_file_id:document.xero_file_id,xero_connection_id:document.xero_connection_id};
      if(row.actor_identity_user_id!==p.identityUserId||row.idempotency_key!==key)throw new ConflictException('This document deletion is already in progress.');
      if(row.status==='provider_deleted')return {...row,xero_file_id:document.xero_file_id,xero_connection_id:document.xero_connection_id};
      if(row.leased)throw new ConflictException('This document deletion is still processing. Retry shortly.');
      const acquired=await db.query(`UPDATE ${s}.student_operations_document_deletions SET status='deleting',lease_token=$3,lease_expires_at=now()+interval '2 minutes',updated_at=now() WHERE customer_id=$1 AND document_id=$2 RETURNING *`,[p.tenantId,documentId,token]);
      return {...acquired.rows[0],xero_file_id:document.xero_file_id,xero_connection_id:document.xero_connection_id};
    });
    if(deletion.status==='completed')return {deleted:true};
    if(deletion.status!=='provider_deleted'){
      await this.xero.deleteFile(p.tenantId,deletion.xero_connection_id,deletion.xero_file_id);
      await this.database.tenantTransaction(p.tenantId,async db=>{
        const saved=await db.query(`UPDATE ${s}.student_operations_document_deletions SET status='provider_deleted',lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE customer_id=$1 AND document_id=$2 AND lease_token=$3 RETURNING document_id`,[p.tenantId,documentId,token]);
        if(!saved.rowCount)throw new ConflictException('Deletion confirmation is pending. Retry shortly.');
      });
    }
    return this.database.tenantTransaction(p.tenantId,async db=>{
      await this.cases.authorizedCase(db,p,id,true);
      await db.query(`UPDATE ${s}.student_operations_case_documents SET deleted_at=COALESCE(deleted_at,now()),deleted_by_identity_user_id=$4 WHERE customer_id=$1 AND case_id=$2 AND document_id=$3`,[p.tenantId,id,documentId,p.identityUserId]);
      await db.query(`UPDATE ${s}.student_operations_document_uploads SET deleted_at=COALESCE(deleted_at,now()),updated_at=now() WHERE customer_id=$1 AND document_id=$2`,[p.tenantId,documentId]);
      await db.query(`UPDATE ${s}.student_case_offers SET is_current=false,status='superseded',record_version=record_version+1 WHERE customer_id=$1 AND case_id=$2 AND document_id=$3 AND is_current`,[p.tenantId,id,documentId]);
      await db.query(`UPDATE ${s}.student_operations_document_deletions SET status='completed',lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE customer_id=$1 AND document_id=$2`,[p.tenantId,documentId]);
      await this.cases.activity(db,p,id,'case.document_deleted','Document deleted from Sophia and Xero');
      await reconcileDocumentChecklist(db,p.tenantId,id);return {deleted:true};
    });
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
        for(const file of attachments) await db.query(`INSERT INTO ${s}.student_operations_case_documents(customer_id,case_id,xero_connection_id,source_kind,source_id,attachment_id,file_name,mime_type,size_bytes)
          SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9 WHERE NOT EXISTS(SELECT 1 FROM ${s}.student_operations_document_uploads u
            WHERE u.customer_id=$1 AND u.xero_connection_id=$3 AND u.source_id=$5 AND u.file_name=$7 AND u.case_id<>$2)
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
