import { ConflictException } from '@nestjs/common';
import { createHash,randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { DatabaseService } from '../../database/database.service.js';
import type { XeroConnectorService } from '../../connectors/xero/xero-connector.service.js';
import { caseSchema,StudentOperationsCasesService } from './student-operations-cases.service.js';
import type { StudentOperationsWorkspacePrincipal as Principal } from './student-operations-workspace.service.js';

// Explicit upload mutation only: no provider requests or writes on page/dialog GETs.
export class StudentPrimaryXeroContact {
  constructor(private readonly database:DatabaseService,private readonly cases:StudentOperationsCasesService,
    private readonly xero:XeroConnectorService) {}

  async connection(db:PoolClient,tenant:string) {
    const s=caseSchema();
    const result=await db.query(`SELECT x.xero_connection_id FROM ${s}.xero_connections x
      JOIN ${s}.student_operations_xero_sync_configurations c USING(customer_id,xero_connection_id)
      WHERE x.customer_id=$1 AND x.status='active' AND c.organisation_role='trust'
      ORDER BY x.xero_connection_id LIMIT 2`,[tenant]);
    // Never send a student's data to an arbitrary organisation.
    return result.rows.length===1?result.rows[0].xero_connection_id as string:null;
  }

  async ensure(p:Principal,caseId:string) {
    const s=caseSchema(),lease=randomUUID();
    const row=await this.database.tenantTransaction(p.tenantId,async db=>{
      const current=await this.cases.authorizedCase(db,p,caseId);
      const profile=await db.query(`SELECT legal_name,email FROM ${s}.student_operations_students
        WHERE customer_id=$1 AND student_id=$2 FOR UPDATE`,[p.tenantId,current.student_id]);
      const connectionId=await this.connection(db,p.tenantId);
      if(!connectionId) throw new ConflictException({errorCode:'student_document_setup_required',message:'Document storage needs administrator attention in company integrations.'});
      let saved=await db.query(`SELECT *,lease_expires_at>now() AS leased FROM ${s}.student_operations_primary_xero_contacts
        WHERE customer_id=$1 AND student_id=$2 AND xero_connection_id=$3 FOR UPDATE`,[p.tenantId,current.student_id,connectionId]);
      if(!saved.rowCount) {
        const number=`sophia:${current.student_id}`;
        const candidates=await db.query(`SELECT c.xero_contact_id,
          CASE WHEN c.contact_number=$4 THEN 'external_reference'
            WHEN count(i.xero_contact_id)>0 THEN 'latest_invoice' ELSE 'linked_contact' END AS method
          FROM ${s}.student_operations_xero_contacts c
          LEFT JOIN ${s}.student_operations_xero_invoices i ON i.customer_id=c.customer_id
            AND i.xero_connection_id=c.xero_connection_id AND i.xero_contact_id=c.xero_contact_id
            AND i.student_id=$3 AND i.invoice_status NOT IN ('DELETED','VOIDED')
          LEFT JOIN ${s}.student_operations_student_contact_links l ON l.customer_id=c.customer_id
            AND l.xero_connection_id=c.xero_connection_id AND l.xero_contact_id=c.xero_contact_id AND l.student_id=$5
          WHERE c.customer_id=$1 AND c.xero_connection_id=$2 AND c.contact_status='ACTIVE'
            AND (i.xero_contact_id IS NOT NULL OR l.xero_contact_id IS NOT NULL OR c.contact_number=$4)
          GROUP BY c.xero_contact_id,c.contact_number,c.provider_updated_at
          ORDER BY coalesce(c.contact_number=$4,false) DESC,max(i.invoice_date) DESC NULLS LAST,
            c.provider_updated_at DESC NULLS LAST,c.xero_contact_id LIMIT 1`,[p.tenantId,connectionId,current.student_reference,number,current.student_id]);
        const selected=candidates.rows[0];
        if(!selected && process.env.XERO_CONTACT_CREATION_ENABLED!=='true')
          throw new ConflictException({errorCode:'student_document_setup_required',message:'An administrator must enable document storage for this student in company integrations.'});
        await db.query(`INSERT INTO ${s}.student_operations_primary_xero_contacts
          (customer_id,student_id,xero_connection_id,xero_contact_id,contact_number,contact_name,contact_email,selection_method,linked_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $4::uuid IS NOT NULL THEN now() END)`,
          [p.tenantId,current.student_id,connectionId,selected?.xero_contact_id??null,number,`${profile.rows[0].legal_name} (${current.student_reference})`,profile.rows[0].email,selected?.method??'created']);
        if(selected) await this.cases.activity(db,p,caseId,'student.document_storage_linked','Student document storage linked');
        saved=await db.query(`SELECT *,false AS leased FROM ${s}.student_operations_primary_xero_contacts
          WHERE customer_id=$1 AND student_id=$2 AND xero_connection_id=$3`,[p.tenantId,current.student_id,connectionId]);
      }
      const binding=saved.rows[0];
      if(binding.xero_contact_id) {
        const archived=await db.query(`SELECT 1 FROM ${s}.student_operations_xero_contacts
          WHERE customer_id=$1 AND xero_connection_id=$2 AND xero_contact_id=$3 AND contact_status IS DISTINCT FROM 'ACTIVE'`,
          [p.tenantId,connectionId,binding.xero_contact_id]);
        if(archived.rowCount) throw new ConflictException({errorCode:'student_document_setup_required',message:'Student document storage needs administrator attention.'});
        return binding;
      }
      if(binding.leased) throw new ConflictException({errorCode:'student_document_storage_pending',message:'Document storage is being prepared. Retry this file in two minutes.'});
      await db.query(`UPDATE ${s}.student_operations_primary_xero_contacts SET lease_token=$4,lease_expires_at=now()+interval '2 minutes'
        WHERE customer_id=$1 AND student_id=$2 AND xero_connection_id=$3`,[p.tenantId,current.student_id,connectionId,lease]);
      return binding;
    });
    if(row.xero_contact_id) return {xero_connection_id:row.xero_connection_id,source_id:row.xero_contact_id};
    // Snapshot fields and external reference survive timeout/restart/profile edits.
    // Reconcile by exact unique ContactNumber before every create, including after
    // Xero's short-lived idempotency cache has expired. Never match by name/email.
    const key=createHash('sha256').update(`student-contact:${p.tenantId}:${row.student_id}:${row.xero_connection_id}`).digest('hex');
    const contact=await this.xero.ensureStudentContact(p.tenantId,row.xero_connection_id,
      {contactNumber:row.contact_number,name:row.contact_name,email:row.contact_email},key);
    await this.database.tenantTransaction(p.tenantId,async db=>{
      // Store the provider receipt even if assignment changed during the call;
      // the upload itself reauthorizes before sending any file bytes.
      const result=await db.query(`UPDATE ${s}.student_operations_primary_xero_contacts
        SET xero_contact_id=$5,linked_at=now(),lease_token=NULL,lease_expires_at=NULL
        WHERE customer_id=$1 AND student_id=$2 AND xero_connection_id=$3 AND lease_token=$4 RETURNING student_id`,
        [p.tenantId,row.student_id,row.xero_connection_id,lease,contact.contactId]);
      if(!result.rowCount) throw new ConflictException('Document storage confirmation is pending. Retry this file.');
      await this.cases.activity(db,p,caseId,'student.document_storage_linked','Student document storage linked');
    });
    return {xero_connection_id:row.xero_connection_id,source_id:contact.contactId};
  }
}
