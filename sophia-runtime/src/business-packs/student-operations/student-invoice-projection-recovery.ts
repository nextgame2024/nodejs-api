import {Logger} from '@nestjs/common';
import type {DatabaseService} from '../../database/database.service.js';
import type {XeroConnectorService} from '../../connectors/xero/xero-connector.service.js';
import type {XeroInvoiceRecord} from '../../connectors/xero/xero.client.js';
import {caseSchema} from './student-operations-cases.service.js';
import {projectCaseInvoice} from './student-invoice-projection.js';
import {documentChecklistEnabled,reconcileDocumentChecklist} from './student-document-checklist.js';

/** Durable indexing recovery only. It can never create/re-send an invoice. */
export class StudentInvoiceProjectionRecovery {
  private readonly logger=new Logger(StudentInvoiceProjectionRecovery.name);
  constructor(private readonly database:DatabaseService,private readonly xero:XeroConnectorService){}
  async processBatch(tenant:string){
    if(!documentChecklistEnabled())return false;
    const s=caseSchema();let worked=false;
    for(let index=0;index<3;index++){
      const row=await this.database.tenantTransaction(tenant,async db=>{
        const row=(await db.query(`SELECT e.* FROM ${s}.student_case_xero_invoice_exports e
          WHERE e.customer_id=$1 AND e.status='created' AND e.projection_next_attempt_at<=now() AND e.projection_attempts<8
          ORDER BY e.projection_next_attempt_at,e.batch_id,e.sequence LIMIT 1 FOR UPDATE SKIP LOCKED`,[tenant])).rows[0];
        if(!row)return null;
        await db.query(`UPDATE ${s}.student_case_xero_invoice_exports SET projection_attempts=projection_attempts+1,
          projection_next_attempt_at=now()+interval '5 minutes' WHERE customer_id=$1 AND batch_id=$2 AND sequence=$3`,[tenant,row.batch_id,row.sequence]);
        return row;
      });
      if(!row)break;worked=true;
      try{
        const indexed=await this.database.tenantReadTransaction(tenant,db=>db.query(`SELECT 1 FROM ${s}.student_operations_xero_invoices i
          JOIN ${s}.student_operations_case_invoice_links l USING(customer_id,xero_connection_id,xero_invoice_id)
          WHERE i.customer_id=$1 AND i.xero_connection_id=$2 AND i.xero_invoice_id=$3 AND l.case_id=$4 AND jsonb_array_length(i.line_items)>0`,[tenant,row.xero_connection_id,row.xero_invoice_id,row.case_id]));
        if(indexed.rowCount){
          await this.database.tenantTransaction(tenant,db=>db.query(`UPDATE ${s}.student_case_xero_invoice_exports SET projection_next_attempt_at=NULL
            WHERE customer_id=$1 AND batch_id=$2 AND sequence=$3 AND projection_attempts=$4`,[tenant,row.batch_id,row.sequence,row.projection_attempts+1]));
          continue;
        }
        // New receipts replay their verified response without any provider call.
        // Older receipts read only their exact known ID via shared quota policy.
        const invoice=(row.verified_invoice??await this.xero.invoiceById(tenant,row.xero_connection_id,row.xero_invoice_id)) as XeroInvoiceRecord;
        if(invoice.invoiceId!==row.xero_invoice_id||invoice.contactId!==row.xero_contact_id||!invoice.lineItems.length)throw new Error('Invoice details unavailable');
        await this.database.tenantTransaction(tenant,async db=>{
          const c=await db.query(`SELECT 1 FROM ${s}.student_operations_cases WHERE customer_id=$1 AND case_id=$2 FOR UPDATE`,[tenant,row.case_id]);
          if(!c.rowCount)throw new Error('Case unavailable');
          const owned=await db.query(`SELECT 1 FROM ${s}.student_case_xero_invoice_exports WHERE customer_id=$1 AND batch_id=$2 AND sequence=$3
            AND projection_attempts=$4 AND projection_next_attempt_at IS NOT NULL FOR UPDATE`,[tenant,row.batch_id,row.sequence,row.projection_attempts+1]);
          if(!owned.rowCount)return;
          await projectCaseInvoice(db,tenant,row.case_id,row.xero_connection_id,invoice,'system:invoice-projection');
          await db.query(`UPDATE ${s}.student_case_xero_invoice_exports SET verified_invoice=$4,projection_next_attempt_at=NULL
            WHERE customer_id=$1 AND batch_id=$2 AND sequence=$3 AND status='created'`,[tenant,row.batch_id,row.sequence,JSON.stringify(invoice)]);
          await reconcileDocumentChecklist(db,tenant,row.case_id);
        });
      }catch(error){
        const code=(error as {code?:unknown})?.code;
        this.logger.warn({event:'xero_invoice_projection_recovery_failed',code:typeof code==='string'&&/^[A-Z0-9]{5}$/.test(code)?code:'projection_failed'});
        // Bounded retries after provider/DB outages; never mutate Xero or turn a
        // confirmed creation into an uncertain send. Exhaustion remains visible.
        await this.database.tenantTransaction(tenant,async db=>{
          const result=await db.query(`UPDATE ${s}.student_case_xero_invoice_exports SET
          projection_next_attempt_at=CASE WHEN projection_attempts>=8 THEN NULL ELSE now()+least(projection_attempts,12)*interval '5 minutes' END
          WHERE customer_id=$1 AND batch_id=$2 AND sequence=$3 AND projection_attempts=$4 AND projection_next_attempt_at IS NOT NULL RETURNING projection_attempts`,[tenant,row.batch_id,row.sequence,row.projection_attempts+1]);
          if(result.rows[0]?.projection_attempts>=8)await db.query(`UPDATE ${s}.student_document_checklist_evaluations SET invoice_dirty=true WHERE customer_id=$1 AND case_id=$2`,[tenant,row.case_id]);
        });
      }
    }
    return worked;
  }
}
