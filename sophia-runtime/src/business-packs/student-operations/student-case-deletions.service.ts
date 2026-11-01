import {BadRequestException,ConflictException,ForbiddenException,Inject,Injectable} from '@nestjs/common';
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {DatabaseService} from '../../database/database.service.js';
import {XeroConnectorService} from '../../connectors/xero/xero-connector.service.js';
import {StudentOperationsCasesService,caseId,caseSchema} from './student-operations-cases.service.js';
import {hasStudentOperationsPermission} from './student-operations-policy.js';
import {studentDocumentTempStorage} from './student-document-temp-storage.js';
import {invoiceRemovalAction} from './student-invoice-removal-policy.js';
import type {StudentOperationsWorkspacePrincipal as Principal} from './student-operations-workspace.service.js';
type Invoice={connectionId:string;invoiceId:string;contactId:string};
type Contact={connectionId:string;contactId:string};
type Targets={invoices:Invoice[];contacts:Contact[];mutating?:boolean;tempKeys?:string[]};
const body=z.object({recordVersion:z.number().int().positive(),confirmed:z.literal(true)}).strict();
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
/** Durable provider-first deletion. Provider outcomes are re-read on every retry. */
@Injectable()
export class StudentCaseDeletionsService{
  constructor(@Inject(DatabaseService) private readonly database:DatabaseService,private readonly cases:StudentOperationsCasesService,private readonly xero:XeroConnectorService){}
  async remove(p:Principal,id:string,input:unknown,key?:string){
    if(!['cases.manage','payments.prepare','payments.read_all'].every(permission=>hasStudentOperationsPermission(p.role,permission as Parameters<typeof hasStudentOperationsPermission>[1])))throw new ForbiddenException();
    caseId(id);const parsed=body.safeParse(input);
    if(!parsed.success||!key||!/^[A-Za-z0-9._:-]{8,160}$/.test(key))throw new BadRequestException('Confirm permanent deletion and reload the case before trying again.');
    const version=parsed.data.recordVersion,lease=randomUUID(),s=caseSchema();
    const job=await this.database.tenantTransaction(p.tenantId,async db=>{
      const receipt=(await db.query(`SELECT completed_at FROM ${s}.student_case_deletions WHERE customer_id=$1 AND case_id=$2`,[p.tenantId,id])).rows[0];
      if(receipt?.completed_at){await db.query(`SELECT ${s}.purge_orphaned_case_student($1)`,[id]);return {completed:true,targets:{} as Targets};}
      const c=await this.cases.authorizedCase(db,p,id,true,true);
      // Re-read after the case lock: a concurrent first request may just have
      // inserted its lease. Never steal a live claim from a stale pre-lock read.
      const prior=(await db.query(`SELECT *,lease_expires_at>now() AS leased FROM ${s}.student_case_deletions WHERE customer_id=$1 AND case_id=$2 FOR UPDATE`,[p.tenantId,id])).rows[0];
      if(c.record_version!==version)throw new ConflictException('This case changed. Reload it before deleting.');
      if(prior?.leased)throw new ConflictException('Case deletion is still processing. Retry shortly.');
      // Serialize new cases/restores with the contact archive decision.
      await db.query(`SELECT student_id FROM ${s}.student_operations_students WHERE customer_id=$1 AND student_id=$2 FOR UPDATE`,[p.tenantId,c.student_id]);
      const otherDelete=await db.query(`SELECT 1 FROM ${s}.student_operations_cases WHERE customer_id=$1 AND student_id=$2 AND case_id<>$3 AND deleting_at IS NOT NULL`,[p.tenantId,c.student_id,id]);
      if(otherDelete.rowCount)throw new ConflictException('Finish the other case deletion for this student first.');
      const active=(await db.query(`SELECT
        EXISTS(SELECT 1 FROM ${s}.student_operations_document_uploads WHERE customer_id=$1 AND case_id=$2 AND lease_expires_at>now()) OR
        EXISTS(SELECT 1 FROM ${s}.student_operations_document_replacements WHERE customer_id=$1 AND case_id=$2 AND lease_expires_at>now()) OR
        EXISTS(SELECT 1 FROM ${s}.student_operations_document_deletions WHERE customer_id=$1 AND case_id=$2 AND lease_expires_at>now()) OR
        EXISTS(SELECT 1 FROM ${s}.student_case_invoice_edits WHERE customer_id=$1 AND case_id=$2 AND lease_expires_at>now()) OR
        EXISTS(SELECT 1 FROM ${s}.student_case_invoice_removals WHERE customer_id=$1 AND case_id=$2 AND lease_expires_at>now()) OR
        EXISTS(SELECT 1 FROM ${s}.student_document_analysis_jobs WHERE customer_id=$1 AND case_id=$2 AND lease_expires_at>now()) OR
        EXISTS(SELECT 1 FROM ${s}.student_operations_document_jobs WHERE customer_id=$1 AND case_id=$2 AND lease_expires_at>now()) OR
        EXISTS(SELECT 1 FROM ${s}.student_operations_primary_xero_contacts WHERE customer_id=$1 AND student_id=$3 AND lease_expires_at>now()) AS pending`,[p.tenantId,id,c.student_id])).rows[0]?.pending;
      if(active)throw new ConflictException('Document or invoice work is still running. Try deletion when it finishes.');
      // Unlike reversible archiving, permanent deletion cannot abandon an
      // uncertain provider creation. Resolve its existing receipt first.
      const uncertain=await db.query(`SELECT 1 FROM ${s}.student_case_xero_invoice_exports WHERE customer_id=$1 AND case_id=$2 AND status IN ('creating','review_required')`,[p.tenantId,id]);
      if(uncertain.rowCount)throw new ConflictException('An earlier invoice creation needs confirmation before this case can be permanently deleted.');
      // Archived cases still own this student's contact. Permanent deletion
      // must be explicit for every case before the contact can be archived.
      const hasOtherCase=!!(await db.query(`SELECT 1 FROM ${s}.student_operations_cases WHERE customer_id=$1 AND student_id=$2 AND case_id<>$3`,[p.tenantId,c.student_id,id])).rowCount;
      let targets=prior?.targets as Targets|undefined;
      // Old interrupted jobs may contain contacts selected by the former
      // archived-siblings rule. Reapply the current policy on every retry.
      if(targets?.mutating&&hasOtherCase)targets={...targets,contacts:[]};
      if(!targets?.mutating){
        const invoices=(await db.query(`WITH ids AS (
          SELECT xero_connection_id,xero_invoice_id FROM ${s}.student_operations_case_invoice_links WHERE customer_id=$1 AND case_id=$2
          UNION SELECT xero_connection_id,xero_invoice_id FROM ${s}.student_case_xero_invoice_exports WHERE customer_id=$1 AND case_id=$2 AND status='created')
          SELECT ids.xero_connection_id AS "connectionId",ids.xero_invoice_id AS "invoiceId",coalesce(i.xero_contact_id,e.xero_contact_id) AS "contactId"
          FROM ids LEFT JOIN ${s}.student_operations_xero_invoices i ON i.customer_id=$1 AND i.xero_connection_id=ids.xero_connection_id AND i.xero_invoice_id=ids.xero_invoice_id
          LEFT JOIN ${s}.student_case_xero_invoice_exports e ON e.customer_id=$1 AND e.case_id=$2 AND e.xero_connection_id=ids.xero_connection_id AND e.xero_invoice_id=ids.xero_invoice_id`,[p.tenantId,id])).rows as Invoice[];
        if(invoices.some(i=>!i.contactId))throw new ConflictException('Refresh invoice details before deleting this case.');
        const shared=await db.query(`SELECT 1 FROM ${s}.student_case_xero_invoice_exports e JOIN ${s}.student_operations_case_invoice_links l
          ON l.customer_id=e.customer_id AND l.xero_connection_id=e.xero_connection_id AND l.xero_invoice_id=e.xero_invoice_id
          WHERE e.customer_id=$1 AND ((e.case_id=$2 AND l.case_id<>$2) OR (l.case_id=$2 AND e.case_id<>$2))
          UNION ALL SELECT 1 FROM ${s}.student_case_xero_invoice_exports a JOIN ${s}.student_case_xero_invoice_exports b
          ON a.customer_id=b.customer_id AND a.xero_connection_id=b.xero_connection_id AND a.xero_invoice_id=b.xero_invoice_id
          WHERE a.customer_id=$1 AND a.case_id=$2 AND b.case_id<>$2`,[p.tenantId,id]);
        if(shared.rowCount)throw new ConflictException('An invoice is shared with another case. Resolve its case links before deletion.');
        let contacts:Contact[]=[];
        if(!hasOtherCase){
          contacts=(await db.query(`SELECT xero_connection_id AS "connectionId",xero_contact_id AS "contactId" FROM ${s}.student_operations_primary_xero_contacts WHERE customer_id=$1 AND student_id=$2 AND xero_contact_id IS NOT NULL
            UNION SELECT xero_connection_id,xero_contact_id FROM ${s}.student_operations_document_contacts WHERE customer_id=$1 AND student_id=$2 AND xero_contact_id IS NOT NULL
            UNION SELECT xero_connection_id,xero_contact_id FROM ${s}.student_operations_xero_invoices WHERE customer_id=$1 AND student_id=$3 AND xero_contact_id IS NOT NULL
            UNION SELECT xero_connection_id,xero_contact_id FROM ${s}.student_operations_student_contact_links WHERE customer_id=$1 AND student_id=$2`,[p.tenantId,c.student_id,c.student_reference])).rows as Contact[];
          contacts=[...new Map([...contacts,...invoices.map(i=>({connectionId:i.connectionId,contactId:i.contactId}))].map(c=>[`${c.connectionId}:${c.contactId}`,c])).values()];
          for(const contact of contacts){
            const sharedContact=await db.query(`SELECT 1 FROM ${s}.student_operations_primary_xero_contacts WHERE customer_id=$1 AND xero_connection_id=$2 AND xero_contact_id=$3 AND student_id<>$4
              UNION ALL SELECT 1 FROM ${s}.student_operations_document_contacts WHERE customer_id=$1 AND xero_connection_id=$2 AND xero_contact_id=$3 AND student_id<>$4
              UNION ALL SELECT 1 FROM ${s}.student_operations_student_contact_links WHERE customer_id=$1 AND xero_connection_id=$2 AND xero_contact_id=$3 AND student_id<>$4`,[p.tenantId,contact.connectionId,contact.contactId,c.student_id]);
            if(sharedContact.rowCount)throw new ConflictException('A contact belongs to another student and cannot be archived by deleting this case.');
          }
        }
        const tempKeys:string[]=[];
        if(studentDocumentTempStorage.enabled){
          const sources=await db.query(`SELECT upload_id AS operation_id,content_sha256 FROM ${s}.student_operations_document_uploads WHERE customer_id=$1 AND case_id=$2
            UNION SELECT replacement_id,content_sha256 FROM ${s}.student_operations_document_replacements WHERE customer_id=$1 AND case_id=$2`,[p.tenantId,id]);
          for(const source of sources.rows)tempKeys.push(studentDocumentTempStorage.key(p.tenantId,id,source.operation_id,source.content_sha256));
        }
        targets={invoices,contacts,tempKeys};
      }
      await db.query(`INSERT INTO ${s}.student_case_deletions(customer_id,case_id,student_id,actor_identity_user_id,idempotency_key,record_version,targets,lease_token,lease_expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '5 minutes') ON CONFLICT(customer_id,case_id) DO UPDATE SET targets=excluded.targets,lease_token=excluded.lease_token,lease_expires_at=excluded.lease_expires_at`,[p.tenantId,id,c.student_id,p.identityUserId,key,version,JSON.stringify(targets),lease]);
      await db.query(`UPDATE ${s}.student_operations_cases SET deleting_at=coalesce(deleting_at,now()) WHERE customer_id=$1 AND case_id=$2`,[p.tenantId,id]);
      return {completed:false,targets:targets!};
    }).catch(error=>{
      if((error as {code?:string}).code==='23503')throw new ConflictException('The student still has related records that must be resolved before deletion can finish.');
      throw error;
    });
    if(job.completed)return {caseId:id,deleted:true};
    let mutating=!!job.targets.mutating;
    const renew=()=>this.database.tenantTransaction(p.tenantId,async db=>{
      const row=await db.query(`UPDATE ${s}.student_case_deletions SET lease_expires_at=now()+interval '5 minutes' WHERE customer_id=$1 AND case_id=$2 AND lease_token=$3 RETURNING case_id`,[p.tenantId,id,lease]);
      if(!row.rowCount)throw new ConflictException('Case deletion is being finalized. Retry shortly.');
    });
    try{
      for(const connectionId of new Set([...job.targets.invoices,...job.targets.contacts].map(t=>t.connectionId)))
        await this.xero.assertCaseDeletionAccess(p.tenantId,connectionId,job.targets.invoices.some(i=>i.connectionId===connectionId),job.targets.contacts.some(c=>c.connectionId===connectionId));
      // Check every invoice before the first provider change, with three workers.
      const plans=await bounded(job.targets.invoices,async target=>{
        const invoice=await this.xero.invoiceById(p.tenantId,target.connectionId,target.invoiceId);
        if(invoice.invoiceId!==target.invoiceId||invoice.contactId!==target.contactId)throw new ConflictException('An invoice no longer matches this case. Reload before deleting.');
        const action=invoiceRemovalAction(invoice);
        if(Number(invoice.amountPaid)!==0||Number(invoice.amountCredited??0)!==0||(!action&&!['DELETED','VOIDED'].includes(invoice.status)))throw new ConflictException('Paid, credited or otherwise protected invoices must be resolved before deleting this case.');
        return {...target,status:invoice.status,target:action==='delete'?'DELETED' as const:action==='void'?'VOIDED' as const:null};
      });
      for(const contact of job.targets.contacts)await this.xero.contactById(p.tenantId,contact.connectionId,contact.contactId);
      await this.database.tenantTransaction(p.tenantId,db=>db.query(`UPDATE ${s}.student_case_deletions SET targets=jsonb_set(targets,'{mutating}','true') WHERE customer_id=$1 AND case_id=$2 AND lease_token=$3`,[p.tenantId,id,lease]));
      mutating=true;
      await bounded(plans,async invoice=>{
        await renew();
        if(invoice.target){const result=await this.xero.removeInvoice(p.tenantId,invoice.connectionId,invoice.invoiceId,invoice.target,hash(`${p.tenantId}:${invoice.connectionId}:${invoice.invoiceId}:${invoice.target}`));
        if(result.invoiceId!==invoice.invoiceId||result.contactId!==invoice.contactId||result.status!==invoice.target)throw new ConflictException('Invoice deletion could not be confirmed. Retry Delete case.');}
        await this.database.tenantTransaction(p.tenantId,db=>db.query(`UPDATE ${s}.student_operations_xero_invoices SET invoice_status=$4,amount_due=0,updated_at=now() WHERE customer_id=$1 AND xero_connection_id=$2 AND xero_invoice_id=$3`,[p.tenantId,invoice.connectionId,invoice.invoiceId,invoice.target??invoice.status]));
      });
      for(const contact of job.targets.contacts){
        await renew();const existing=await this.xero.contactById(p.tenantId,contact.connectionId,contact.contactId);
        if(existing.contactId!==contact.contactId)throw new ConflictException('The contact no longer matches this case.');
        if(existing.status!=='ARCHIVED'){const result=await this.xero.archiveContact(p.tenantId,contact.connectionId,contact.contactId,hash(`case-contact-archive:${p.tenantId}:${contact.connectionId}:${contact.contactId}`));
          if(result.contactId!==contact.contactId||result.status!=='ARCHIVED')throw new ConflictException('Contact archiving could not be confirmed. Retry Delete case.');}
        await this.database.tenantTransaction(p.tenantId,db=>db.query(`UPDATE ${s}.student_operations_xero_contacts SET contact_status='ARCHIVED' WHERE customer_id=$1 AND xero_connection_id=$2 AND xero_contact_id=$3`,[p.tenantId,contact.connectionId,contact.contactId]));
      }
      for(const tempKey of job.targets.tempKeys??[]){await renew();await studentDocumentTempStorage.remove(tempKey);}
      await this.database.tenantTransaction(p.tenantId,async db=>{
        await this.cases.authorizedCase(db,p,id,true,true);
        const owned=await db.query(`UPDATE ${s}.student_case_deletions SET status='provider_done',lease_expires_at=now()+interval '5 minutes' WHERE customer_id=$1 AND case_id=$2 AND lease_token=$3 RETURNING case_id`,[p.tenantId,id,lease]);
        if(!owned.rowCount)throw new ConflictException('Case deletion is being finalized. Retry shortly.');
        await db.query(`SELECT ${s}.purge_deleted_student_case($1,$2)`,[id,lease]);
      });
      return {caseId:id,deleted:true};
    }catch(error){
      await this.database.tenantTransaction(p.tenantId,async db=>{
        if(!mutating)await db.query(`UPDATE ${s}.student_operations_cases SET deleting_at=NULL WHERE customer_id=$1 AND case_id=$2 AND EXISTS(SELECT 1 FROM ${s}.student_case_deletions WHERE customer_id=$1 AND case_id=$2 AND lease_token=$3)`,[p.tenantId,id,lease]);
        await db.query(`UPDATE ${s}.student_case_deletions SET lease_token=NULL,lease_expires_at=NULL WHERE customer_id=$1 AND case_id=$2 AND lease_token=$3`,[p.tenantId,id,lease]);
      }).catch(()=>{}); // A database outage leaves a bounded lease for recovery.
      if((error as {code?:string}).code==='23503')throw new ConflictException('The student still has related records that must be resolved before deletion can finish.');
      throw error;
    }
  }
}
async function bounded<T,R>(items:T[],work:(item:T)=>Promise<R>):Promise<R[]>{
  const results:R[]=new Array(items.length);let next=0,failed:unknown;
  await Promise.all(Array.from({length:Math.min(3,items.length)},async()=>{
    while(!failed){const index=next++;if(index>=items.length)return;try{results[index]=await work(items[index]);}catch(error){failed=error;}}
  }));
  if(failed)throw failed;return results;
}
