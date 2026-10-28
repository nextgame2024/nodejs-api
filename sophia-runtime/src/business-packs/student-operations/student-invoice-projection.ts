import type {PoolClient} from 'pg';
import type {XeroInvoiceRecord} from '../../connectors/xero/xero.client.js';
import {caseSchema} from './student-operations-cases.service.js';

/** Caller authorizes the case, or is the tenant-scoped recovery worker. */
export async function projectCaseInvoice(db:PoolClient,tenant:string,caseId:string,connection:string,invoice:XeroInvoiceRecord,actor:string){
  const s=caseSchema();
  const row=(await db.query(`SELECT c.student_id,${s}.ensure_case_xero_student_identity(c.case_id) AS student_reference
    FROM ${s}.student_operations_cases c WHERE c.customer_id=$1 AND c.case_id=$2`,[tenant,caseId])).rows[0];
  if(!row)throw new Error('Invoice case unavailable');
  // A normal provider import may have arrived first without the legacy user
  // mapping. Fill only this receipt's unassigned identity; never reassign one.
  await db.query(`UPDATE ${s}.student_operations_xero_invoices SET student_id=$5
    WHERE customer_id=$1 AND xero_connection_id=$2 AND xero_invoice_id=$3 AND xero_contact_id=$4 AND student_id IS NULL`,
    [tenant,connection,invoice.invoiceId,invoice.contactId,row.student_reference]);
  await db.query(`INSERT INTO ${s}.student_operations_xero_invoices
    (customer_id,xero_connection_id,xero_invoice_id,xero_contact_id,student_id,invoice_number,invoice_type,invoice_status,invoice_date,due_date,
      advisor_name,invoice_reference,college_name,payment_track,total,amount_paid,amount_due,currency_code,sent_to_contact,line_items,provider_updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
    ON CONFLICT(customer_id,xero_connection_id,xero_invoice_id) DO UPDATE SET
      invoice_number=excluded.invoice_number,invoice_status=excluded.invoice_status,invoice_date=excluded.invoice_date,due_date=excluded.due_date,
      advisor_name=excluded.advisor_name,invoice_reference=excluded.invoice_reference,college_name=excluded.college_name,payment_track=excluded.payment_track,
      total=excluded.total,amount_paid=excluded.amount_paid,amount_due=excluded.amount_due,currency_code=excluded.currency_code,
      sent_to_contact=excluded.sent_to_contact,line_items=excluded.line_items,provider_updated_at=excluded.provider_updated_at,updated_at=now()
    WHERE student_operations_xero_invoices.provider_updated_at IS NULL OR
      (excluded.provider_updated_at IS NOT NULL AND excluded.provider_updated_at>=student_operations_xero_invoices.provider_updated_at)`,
    [tenant,connection,invoice.invoiceId,invoice.contactId,row.student_reference,invoice.invoiceNumber,invoice.type,invoice.status,invoice.invoiceDate,invoice.dueDate,
      invoice.advisorName,invoice.invoiceReference,invoice.collegeName,invoice.paymentTrack,invoice.total,invoice.amountPaid,invoice.amountDue,invoice.currencyCode,
      invoice.sentToContact,JSON.stringify(invoice.lineItems),invoice.updatedAt]);
  await db.query(`INSERT INTO ${s}.student_operations_case_invoice_links(customer_id,case_id,student_id,student_reference,xero_connection_id,xero_invoice_id,linked_by_identity)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,[tenant,caseId,row.student_id,row.student_reference,connection,invoice.invoiceId,actor]);
}
