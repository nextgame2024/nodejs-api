import { BadRequestException,ConflictException,ForbiddenException,Inject,Injectable,NotFoundException } from '@nestjs/common';
import { createHash,randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service.js';
import { XeroConnectorService } from '../../connectors/xero/xero-connector.service.js';
import { StudentOperationsCasesService,caseId,caseSchema } from './student-operations-cases.service.js';
import type { StudentOperationsWorkspacePrincipal as Principal } from './student-operations-workspace.service.js';
import { hasStudentOperationsPermission } from './student-operations-policy.js';
import { invoiceRemovalAction } from './student-invoice-removal-policy.js';
import { reconcileDocumentChecklist } from './student-document-checklist.js';

@Injectable()
export class StudentCaseInvoiceRemovalsService {
  constructor(@Inject(DatabaseService) private readonly database:DatabaseService,private readonly cases:StudentOperationsCasesService,private readonly xero:XeroConnectorService){}
  async remove(p:Principal,id:string,connectionId:string,invoiceId:string,input:unknown,key?:string){
    if(!hasStudentOperationsPermission(p.role,'cases.manage')||!hasStudentOperationsPermission(p.role,'payments.prepare')||!hasStudentOperationsPermission(p.role,'payments.read_all'))throw new ForbiddenException();
    [id,connectionId,invoiceId].forEach(caseId);
    const action=(input as {action?:unknown}|null)?.action;
    if(!['delete','void'].includes(String(action))||!key||!/^[A-Za-z0-9._:-]{8,160}$/.test(key))throw new BadRequestException('Reload the invoice list and try again.');
    const target=action==='delete'?'DELETED':'VOIDED',lease=randomUUID(),s=caseSchema();
    const job=await this.database.tenantTransaction(p.tenantId,async db=>{
      await this.cases.authorizedCase(db,p,id,true);
      const linked=(await db.query(`SELECT coalesce(i.xero_contact_id,e.xero_contact_id) AS contact_id
        FROM (SELECT xero_connection_id,xero_invoice_id FROM ${s}.student_operations_case_invoice_links WHERE customer_id=$1 AND case_id=$2
          UNION SELECT xero_connection_id,xero_invoice_id FROM ${s}.student_case_xero_invoice_exports WHERE customer_id=$1 AND case_id=$2 AND status='created') l
        LEFT JOIN ${s}.student_operations_xero_invoices i ON i.customer_id=$1 AND i.xero_connection_id=l.xero_connection_id AND i.xero_invoice_id=l.xero_invoice_id
        LEFT JOIN ${s}.student_case_xero_invoice_exports e ON e.customer_id=$1 AND e.case_id=$2 AND e.xero_connection_id=l.xero_connection_id AND e.xero_invoice_id=l.xero_invoice_id AND e.status='created'
        WHERE l.xero_connection_id=$3 AND l.xero_invoice_id=$4`,[p.tenantId,id,connectionId,invoiceId])).rows[0];
      if(!linked?.contact_id)throw new NotFoundException('Linked invoice not found.');
      const prior=(await db.query(`SELECT * FROM ${s}.student_case_invoice_removals WHERE customer_id=$1 AND actor_identity_user_id=$2 AND idempotency_key=$3`,[p.tenantId,p.identityUserId,key])).rows[0];
      if(prior&&(prior.case_id!==id||prior.xero_connection_id!==connectionId||prior.xero_invoice_id!==invoiceId||prior.target_status!==target))throw new ConflictException('The invoice request changed. Reload the list.');
      await db.query(`INSERT INTO ${s}.student_case_invoice_removals(customer_id,case_id,xero_connection_id,xero_invoice_id,actor_identity_user_id,idempotency_key,target_status)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(customer_id,xero_connection_id,xero_invoice_id) DO NOTHING`,[p.tenantId,id,connectionId,invoiceId,p.identityUserId,key,target]);
      const row=(await db.query(`SELECT *,lease_expires_at>now() AS leased FROM ${s}.student_case_invoice_removals
        WHERE customer_id=$1 AND xero_connection_id=$2 AND xero_invoice_id=$3 FOR UPDATE`,[p.tenantId,connectionId,invoiceId])).rows[0];
      if(row.case_id!==id)throw new ConflictException('The invoice request changed. Reload the list.');
      // A fresh, explicit confirmation may change delete to void after approval.
      // The provider is still re-read below before any mutation.
      if(row.target_status!==target){
        if(row.completed||row.leased||prior)throw new ConflictException('The invoice request changed. Reload the list.');
        await db.query(`UPDATE ${s}.student_case_invoice_removals SET target_status=$4,actor_identity_user_id=$5,idempotency_key=$6
          WHERE customer_id=$1 AND xero_connection_id=$2 AND xero_invoice_id=$3`,[p.tenantId,connectionId,invoiceId,target,p.identityUserId,key]);
      }
      if(row.completed)return {...row,contactId:linked.contact_id};
      if(row.leased)throw new ConflictException('This invoice change is processing. Retry shortly.');
      await db.query(`UPDATE ${s}.student_case_invoice_removals SET lease_token=$4,lease_expires_at=now()+interval '2 minutes',updated_at=now()
        WHERE customer_id=$1 AND xero_connection_id=$2 AND xero_invoice_id=$3`,[p.tenantId,connectionId,invoiceId,lease]);
      return {...row,contactId:linked.contact_id};
    });
    if(job.completed)return {invoiceId,status:target};
    try{
      let invoice=await this.xero.invoiceById(p.tenantId,connectionId,invoiceId);
      if(invoice.invoiceId!==invoiceId||invoice.contactId!==job.contactId)throw new ConflictException('The invoice no longer matches this case. Reload the list.');
      // A retry after an uncertain write confirms the known final status first.
      if(invoice.status!==target){
        if(invoiceRemovalAction(invoice)!==action){
          // Refresh the local status after discovering a settlement/approval so
          // the next list read stops offering an obsolete action.
          await this.database.tenantTransaction(p.tenantId,async db=>{
            await this.cases.authorizedCase(db,p,id,true);
            await db.query(`UPDATE ${s}.student_operations_xero_invoices SET invoice_status=$4,amount_paid=$5,amount_due=$6,total=$7,provider_updated_at=$8,updated_at=now()
              WHERE customer_id=$1 AND xero_connection_id=$2 AND xero_invoice_id=$3`,[p.tenantId,connectionId,invoiceId,invoice.status,invoice.amountPaid,invoice.amountDue,invoice.total,invoice.updatedAt]);
            await db.query(`UPDATE ${s}.student_case_xero_invoice_exports SET provider_status=$4,verified_invoice=$5
              WHERE customer_id=$1 AND xero_connection_id=$2 AND xero_invoice_id=$3`,[p.tenantId,connectionId,invoiceId,invoice.status,JSON.stringify(invoice)]);
          });
          throw new ConflictException('This invoice can no longer be deleted or voided. Refresh the invoice list.');
        }
        invoice=await this.xero.removeInvoice(p.tenantId,connectionId,invoiceId,target,createHash('sha256').update(`${p.tenantId}:${connectionId}:${invoiceId}:${target}`).digest('hex'));
      }
      if(invoice.invoiceId!==invoiceId||invoice.contactId!==job.contactId||invoice.status!==target)throw new ConflictException('The invoice change could not be confirmed. Retry the same action.');
      await this.database.tenantTransaction(p.tenantId,async db=>{
        await this.cases.authorizedCase(db,p,id,true);
        const owned=await db.query(`SELECT 1 FROM ${s}.student_case_invoice_removals WHERE customer_id=$1 AND xero_connection_id=$2 AND xero_invoice_id=$3 AND lease_token=$4 FOR UPDATE`,[p.tenantId,connectionId,invoiceId,lease]);
        if(!owned.rowCount)throw new ConflictException('The invoice change is being finalized. Retry shortly.');
        await db.query(`UPDATE ${s}.student_operations_xero_invoices SET invoice_status=$4,amount_due=0,provider_updated_at=$5,updated_at=now()
          WHERE customer_id=$1 AND xero_connection_id=$2 AND xero_invoice_id=$3`,[p.tenantId,connectionId,invoiceId,target,invoice.updatedAt]);
        await db.query(`UPDATE ${s}.student_case_xero_invoice_exports SET provider_status=$4,verified_invoice=$5,projection_next_attempt_at=NULL
          WHERE customer_id=$1 AND xero_connection_id=$2 AND xero_invoice_id=$3`,[p.tenantId,connectionId,invoiceId,target,JSON.stringify(invoice)]);
        await db.query(`UPDATE ${s}.student_case_invoice_removals SET completed=true,lease_token=NULL,lease_expires_at=NULL,updated_at=now()
          WHERE customer_id=$1 AND xero_connection_id=$2 AND xero_invoice_id=$3 AND lease_token=$4`,[p.tenantId,connectionId,invoiceId,lease]);
        await this.cases.activity(db,p,id,action==='delete'?'case.invoice_deleted':'case.invoice_voided',action==='delete'?'Invoice deleted':'Invoice voided');
        await reconcileDocumentChecklist(db,p.tenantId,id);
      });
      return {invoiceId,status:target};
    }catch(error){
      try{await this.database.tenantTransaction(p.tenantId,db=>db.query(`UPDATE ${s}.student_case_invoice_removals SET lease_token=NULL,lease_expires_at=NULL
        WHERE customer_id=$1 AND xero_connection_id=$2 AND xero_invoice_id=$3 AND lease_token=$4`,[p.tenantId,connectionId,invoiceId,lease]));}catch{/* Durable lease expires after a database outage. */}
      throw error;
    }
  }
}
