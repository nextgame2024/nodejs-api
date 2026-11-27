import { ConflictException } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import type { PoolClient } from 'pg';
import type { XeroInvoiceRecord } from '../../connectors/xero/xero.client.js';
import { receiptProposal, type Snapshot } from './trust-receipt-proposals.js';

export async function currentDispatch(db:PoolClient,schema:string,scope:[string,string,string,string],actor:string,id:string) {
  const detail=await receiptProposal(db,schema,scope,actor);
  const dispatch=detail.dispatch;
  if (!dispatch || dispatch.id!==id || dispatch.cancelledAt || dispatch.expired || detail.state!=='approved' ||
      !detail.snapshot.mappedAccount || detail.accountIssue || detail.revision!==dispatch.revision)
    throw new ConflictException('Refresh the proposal and review the current dispatch.');

  const {rows:[invoice]}=await db.query<{updated:string|null;payments:unknown[]}>(
    `SELECT provider_updated_at AS updated, ARRAY(SELECT entry FROM jsonb_array_elements(settlement->'entries') entry
      WHERE entry->>'kind'='payment' ORDER BY entry->>'id') AS payments
     FROM ${schema}.student_operations_xero_invoices WHERE customer_id=$1 AND xero_connection_id=$2 AND xero_invoice_id=$3`,scope.slice(0,3));
  if (!invoice) throw new ConflictException('Refresh the imported TRUST invoice.');
  return {snapshot:detail.snapshot,token:detail.token,updated:invoice.updated,payments:invoice.payments};
}

export function checkDispatchInvoice(expected:{snapshot:Snapshot;updated:string|null;payments:unknown[]},invoice:XeroInvoiceRecord) {
  const {snapshot}=expected;
  if (invoice.invoiceId!==snapshot.invoice || invoice.invoiceNumber!==snapshot.invoiceNumber || invoice.contactId!==snapshot.contactId)
    return 'The Xero invoice or contact differs from the approval.';
  if (invoice.type!=='ACCREC' || invoice.status!=='AUTHORISED' || invoice.currencyCode!=='AUD')
    return 'Xero must show an authorised AUD sales invoice.';
  if (invoice.amountDue!==Number(snapshot.due) || invoice.amountDue<Number(snapshot.amount))
    return 'The Xero invoice balance changed. Review the payment amount.';
  const settlement=invoice.settlement;
  if (!settlement || settlement.allocationListsOmitted || settlement.omittedKinds?.includes('payment'))
    return 'The current Xero payment list is incomplete.';
  const payments=settlement.entries.filter(e=>e.kind==='payment').sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  if (!isDeepStrictEqual(payments,expected.payments)) return 'Xero invoice payments changed. Refresh the TRUST import.';
  if (!invoice.updatedAt || !expected.updated || Date.parse(invoice.updatedAt)!==new Date(expected.updated).getTime())
    return 'The Xero invoice revision differs from the import. Refresh the TRUST import.';
  return null;
}
