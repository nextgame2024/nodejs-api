// Correlated to the verified TRUST receipt aliased as r.
export function trustReceiptPaymentCandidates(schema: string) {
  return `SELECT e.id::uuid AS id, e.amount, e."isReconciled"
      FROM ${schema}.student_operations_xero_invoices i
      JOIN ${schema}.student_operations_xero_sync_configurations c USING (customer_id,xero_connection_id)
      CROSS JOIN LATERAL jsonb_to_recordset(i.settlement->'entries') e(kind text,id text,date text,amount numeric,"isReconciled" boolean)
      WHERE i.customer_id=r.customer_id AND i.xero_connection_id=r.connection_id AND i.xero_invoice_id=r.invoice_id
        AND c.enabled AND c.organisation_role='trust' AND i.invoice_type='ACCREC' AND i.currency_code='AUD'
        AND i.invoice_status IN ('PAID','AUTHORISED') AND e.kind='payment'
        AND e.date=r.received_on::text AND e.amount=least(r.amount,r.invoice_due_at_verification)`;
}
