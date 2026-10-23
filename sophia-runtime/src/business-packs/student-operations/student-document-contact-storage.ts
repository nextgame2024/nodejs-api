import { ConflictException } from '@nestjs/common';
import { createHash,randomUUID } from 'node:crypto';
import type { DatabaseService } from '../../database/database.service.js';
import type { XeroConnectorService } from '../../connectors/xero/xero-connector.service.js';
import { caseSchema,StudentOperationsCasesService } from './student-operations-cases.service.js';
import type { StudentOperationsWorkspacePrincipal as Principal } from './student-operations-workspace.service.js';

type Upload={upload_id:string;case_id:string;xero_connection_id:string;source_id:string;file_name:string;
  destination_state:string;storage_contact_id:string|null};
const pending=()=>new ConflictException({errorCode:'student_document_storage_pending',message:'Document storage is being prepared. Retry this same file shortly.'});

// Durable capacity reservations span cases, users and API replicas. A reservation
// is never refunded simply because a provider timeout might have hidden a write.
export class StudentDocumentContactStorage {
  constructor(private readonly database:DatabaseService,private readonly cases:StudentOperationsCasesService,
    private readonly xero:XeroConnectorService) {}

  private async seed(p:Principal,job:Upload) {
    const s=caseSchema();
    return this.database.tenantTransaction(p.tenantId,async db=>{
      const current=await this.cases.authorizedCase(db,p,job.case_id);
      await db.query(`SELECT 1 FROM ${s}.student_operations_students WHERE customer_id=$1 AND student_id=$2 FOR UPDATE`,[p.tenantId,current.student_id]);
      // Existing reviewed Contacts remain eligible even when this case has no invoices.
      await db.query(`INSERT INTO ${s}.student_operations_document_contacts(customer_id,student_id,xero_connection_id,xero_contact_id,kind,linked_at)
        SELECT $1,$2,$3,c.xero_contact_id,'linked',now() FROM ${s}.student_operations_xero_contacts c
        WHERE c.customer_id=$1 AND c.xero_connection_id=$3 AND c.contact_status='ACTIVE' AND (
          c.xero_contact_id=$4 OR EXISTS(SELECT 1 FROM ${s}.student_operations_student_contact_links l
            WHERE l.customer_id=$1 AND l.student_id=$2 AND l.xero_connection_id=$3 AND l.xero_contact_id=c.xero_contact_id)
          OR EXISTS(SELECT 1 FROM ${s}.student_operations_xero_invoices i WHERE i.customer_id=$1
            AND i.xero_connection_id=$3 AND i.xero_contact_id=c.xero_contact_id AND i.student_id=$5 AND i.invoice_status NOT IN ('DELETED','VOIDED')))
        ON CONFLICT(customer_id,xero_connection_id,xero_contact_id) DO NOTHING`,[p.tenantId,current.student_id,job.xero_connection_id,job.source_id,current.student_reference]);
      // A Contact just created by Sophia may not be in the nightly mirror yet.
      await db.query(`INSERT INTO ${s}.student_operations_document_contacts(customer_id,student_id,xero_connection_id,xero_contact_id,kind,linked_at)
        SELECT customer_id,student_id,xero_connection_id,xero_contact_id,'linked',now()
        FROM ${s}.student_operations_primary_xero_contacts WHERE customer_id=$1 AND student_id=$2 AND xero_connection_id=$3
          AND xero_contact_id IS NOT NULL ON CONFLICT(customer_id,xero_connection_id,xero_contact_id) DO NOTHING`,[p.tenantId,current.student_id,job.xero_connection_id]);
      return current;
    });
  }

  async reserve(p:Principal,job:Upload,lease:string):Promise<Upload> {
    if(job.destination_state==='attempted' || job.destination_state==='reserved') return job;
    const s=caseSchema(),current=await this.seed(p,job),visited:string[]=[];
    // Bounded provider work. Full observations persist, so a retry continues
    // rather than repeatedly scanning a large historical collection from zero.
    for(let pass=0;pass<12;pass++) {
      const candidates=await this.database.tenantReadTransaction(p.tenantId,db=>db.query(`SELECT d.*
        FROM ${s}.student_operations_document_contacts d
        WHERE d.customer_id=$1 AND d.student_id=$2 AND d.xero_connection_id=$3
          AND d.xero_contact_id IS NOT NULL AND NOT d.capacity_full AND NOT(d.storage_contact_id=ANY($4::uuid[]))
          AND NOT EXISTS(SELECT 1 FROM ${s}.student_operations_xero_contacts c WHERE c.customer_id=d.customer_id
            AND c.xero_connection_id=d.xero_connection_id AND c.xero_contact_id=d.xero_contact_id AND c.contact_status IS DISTINCT FROM 'ACTIVE')
        ORDER BY (d.xero_contact_id=$5) DESC,d.kind,d.sequence_number NULLS FIRST,d.storage_contact_id LIMIT 1`,
        [p.tenantId,current.student_id,job.xero_connection_id,visited,job.source_id]));
      let bucket=candidates.rows[0];
      if(!bucket) bucket=await this.overflow(p,job,current.student_id,current.student_reference,lease,visited);
      visited.push(bucket.storage_contact_id);
      await this.database.tenantTransaction(p.tenantId,async db=>{
        await this.cases.authorizedCase(db,p,job.case_id);
        const renewed=await db.query(`UPDATE ${s}.student_operations_document_uploads SET lease_expires_at=now()+interval '2 minutes'
          WHERE customer_id=$1 AND upload_id=$2 AND lease_token=$3 AND lease_expires_at>now() RETURNING upload_id`,[p.tenantId,job.upload_id,lease]);
        if(!renewed.rowCount) throw pending();
      });
      const files=await this.xero.documentContactAttachments(p.tenantId,job.xero_connection_id,bucket.xero_contact_id);
      const reserved=await this.database.tenantTransaction(p.tenantId,async db=>{
        await this.cases.authorizedCase(db,p,job.case_id);
        await db.query(`SELECT 1 FROM ${s}.student_operations_document_contacts WHERE customer_id=$1 AND storage_contact_id=$2 FOR UPDATE`,[p.tenantId,bucket.storage_contact_id]);
        const owned=await db.query(`SELECT * FROM ${s}.student_operations_document_uploads
          WHERE customer_id=$1 AND upload_id=$2 AND lease_token=$3 AND lease_expires_at>now() FOR UPDATE`,[p.tenantId,job.upload_id,lease]);
        if(!owned.rowCount) throw pending();
        if(owned.rows[0].destination_state!=='unallocated') return owned.rows[0] as Upload;
        // Live provider files plus local outstanding writes absent from that list.
        // Completed-but-not-visible receipts also reserve their space conservatively.
        const others=await db.query(`SELECT count(*)::int n FROM ${s}.student_operations_document_uploads
          WHERE customer_id=$1 AND xero_connection_id=$2 AND source_id=$3 AND upload_id<>$4
            AND destination_state IN ('reserved','attempted') AND NOT(file_name=ANY($5::text[]))`,
          [p.tenantId,job.xero_connection_id,bucket.xero_contact_id,job.upload_id,files.map(file=>file.fileName)]);
        if(files.length>=10) await db.query(`UPDATE ${s}.student_operations_document_contacts SET capacity_full=true WHERE customer_id=$1 AND storage_contact_id=$2`,[p.tenantId,bucket.storage_contact_id]);
        if(files.length+others.rows[0].n>=10) return null;
        const result=await db.query(`UPDATE ${s}.student_operations_document_uploads
          SET source_id=$4,storage_contact_id=$5,destination_state='reserved',lease_expires_at=now()+interval '2 minutes',updated_at=now()
          WHERE customer_id=$1 AND upload_id=$2 AND lease_token=$3 RETURNING *`,[p.tenantId,job.upload_id,lease,bucket.xero_contact_id,bucket.storage_contact_id]);
        return result.rows[0] as Upload;
      });
      if(reserved) return reserved;
    }
    throw pending();
  }

  private async overflow(p:Principal,job:Upload,studentId:string,reference:string,lease:string,visited:string[]) {
    const s=caseSchema(),token=randomUUID();
    const intent=await this.database.tenantTransaction(p.tenantId,async db=>{
      await this.cases.authorizedCase(db,p,job.case_id);
      const owned=await db.query(`SELECT 1 FROM ${s}.student_operations_document_uploads
        WHERE customer_id=$1 AND upload_id=$2 AND lease_token=$3 AND lease_expires_at>now() AND status='uploading'`,[p.tenantId,job.upload_id,lease]);
      if(!owned.rowCount) throw pending();
      const profile=await db.query(`SELECT legal_name FROM ${s}.student_operations_students WHERE customer_id=$1 AND student_id=$2 FOR UPDATE`,[p.tenantId,studentId]);
      // Locking the student serializes ordinal allocation across different cases.
      const existing=await db.query(`SELECT *,lease_expires_at>now() AS leased FROM ${s}.student_operations_document_contacts
        WHERE customer_id=$1 AND student_id=$2 AND xero_connection_id=$3 AND kind='overflow' AND xero_contact_id IS NULL
        ORDER BY sequence_number LIMIT 1 FOR UPDATE`,[p.tenantId,studentId,job.xero_connection_id]);
      let row=existing.rows[0];
      if(row?.leased) throw pending();
      if(!row) {
        // Another caller may have finished provisioning after our candidate read.
        const available=await db.query(`SELECT d.* FROM ${s}.student_operations_document_contacts d
          WHERE d.customer_id=$1 AND d.student_id=$2 AND d.xero_connection_id=$3 AND d.kind='overflow' AND NOT d.capacity_full
            AND d.xero_contact_id IS NOT NULL AND NOT(d.storage_contact_id=ANY($4::uuid[]))
            AND NOT EXISTS(SELECT 1 FROM ${s}.student_operations_xero_contacts c WHERE c.customer_id=d.customer_id
              AND c.xero_connection_id=d.xero_connection_id AND c.xero_contact_id=d.xero_contact_id AND c.contact_status IS DISTINCT FROM 'ACTIVE')
          ORDER BY d.sequence_number LIMIT 1`,[p.tenantId,studentId,job.xero_connection_id,visited]);
        if(available.rowCount) return available.rows[0];
        const next=await db.query(`SELECT coalesce(max(sequence_number),1)+1 AS n FROM ${s}.student_operations_document_contacts
          WHERE customer_id=$1 AND student_id=$2 AND xero_connection_id=$3`,[p.tenantId,studentId,job.xero_connection_id]);
        const n=next.rows[0].n;
        const inserted=await db.query(`INSERT INTO ${s}.student_operations_document_contacts
          (customer_id,student_id,xero_connection_id,kind,sequence_number,contact_number,contact_name)
          VALUES($1,$2,$3,'overflow',$4,$5,$6) RETURNING *`,[p.tenantId,studentId,job.xero_connection_id,n,
          `sophia:${studentId}:docs:${n}`,`${profile.rows[0].legal_name.slice(0,180)} (${reference}) — Documents ${n}`]);
        row=inserted.rows[0];
      }
      await db.query(`UPDATE ${s}.student_operations_document_contacts SET lease_token=$3,lease_expires_at=now()+interval '2 minutes'
        WHERE customer_id=$1 AND storage_contact_id=$2`,[p.tenantId,row.storage_contact_id,token]);
      return row;
    });
    if(intent.xero_contact_id) return intent;
    const key=createHash('sha256').update(`document-overflow:${p.tenantId}:${intent.storage_contact_id}`).digest('hex');
    const contact=await this.xero.ensureStudentContact(p.tenantId,job.xero_connection_id,
      {contactNumber:intent.contact_number,name:intent.contact_name,email:null},key);
    return this.database.tenantTransaction(p.tenantId,async db=>{
      const saved=await db.query(`UPDATE ${s}.student_operations_document_contacts
        SET xero_contact_id=$4,linked_at=now(),lease_token=NULL,lease_expires_at=NULL
        WHERE customer_id=$1 AND storage_contact_id=$2 AND lease_token=$3 RETURNING *`,[p.tenantId,intent.storage_contact_id,token,contact.contactId]);
      if(!saved.rowCount) throw pending();
      await this.cases.activity(db,p,job.case_id,'student.document_overflow_linked','Additional student document storage prepared');
      return saved.rows[0];
    });
  }

  async attempted(p:Principal,job:Upload,lease:string) {
    await this.database.tenantTransaction(p.tenantId,async db=>{
      await this.cases.authorizedCase(db,p,job.case_id);
      const result=await db.query(`UPDATE ${caseSchema()}.student_operations_document_uploads
        SET destination_state='attempted',updated_at=now() WHERE customer_id=$1 AND upload_id=$2
          AND lease_token=$3 AND lease_expires_at>now() AND source_id=$4 RETURNING upload_id`,[p.tenantId,job.upload_id,lease,job.source_id]);
      if(!result.rowCount) throw pending();
    });
  }

  async releaseFull(p:Principal,job:Upload,lease:string) {
    return this.database.tenantTransaction(p.tenantId,async db=>{
      // Safe only when the connector capacity check rejected BEFORE byte PUT.
      const result=await db.query(`UPDATE ${caseSchema()}.student_operations_document_uploads
        SET destination_state='unallocated',storage_contact_id=NULL,updated_at=now()
        WHERE customer_id=$1 AND upload_id=$2 AND lease_token=$3 AND destination_state='reserved'
        RETURNING upload_id`,[p.tenantId,job.upload_id,lease]);
      if(!result.rowCount) return false;
      await db.query(`UPDATE ${caseSchema()}.student_operations_document_contacts SET capacity_full=true
        WHERE customer_id=$1 AND storage_contact_id=$2`,[p.tenantId,job.storage_contact_id]);
      job.destination_state='unallocated';job.storage_contact_id=null;
      return true;
    });
  }
}
