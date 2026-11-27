export function currentTrustInvoice(schema: string, invoice: 'i' | 'invoice' | 'credit') {
  return `EXISTS (
    SELECT 1 FROM ${schema}.student_operations_xero_sync_runs seen
    WHERE seen.customer_id=${invoice}.customer_id
      AND seen.xero_connection_id=${invoice}.xero_connection_id
      AND seen.sync_run_id=${invoice}.last_seen_sync_run_id
      AND NOT EXISTS (
        SELECT 1 FROM ${schema}.student_operations_xero_sync_runs newer
        WHERE newer.customer_id=seen.customer_id AND newer.xero_connection_id=seen.xero_connection_id
          AND newer.status='succeeded' AND newer.mode IN ('initial','reconciliation')
          AND newer.created_at>seen.created_at
      )
  )`;
}

export function receiptAllocationBasis(alias: 'receipt' | 'r') {
  return `coalesce(${alias}.imported_payment_amount,round(${alias}.invoice_due_at_verification,2))`;
}

export const currentPaymentList = `i.settlement->>'allocationListsOmitted' IS DISTINCT FROM 'true'
  AND ((i.settlement->'omittedKinds') ? 'payment') IS NOT TRUE`;

// Group all entries for a payment before filtering. Conflicting observations require review.
export function importedInvoicePayments(searchParameter?: number) {
  return `SELECT lower(e.id) AS id,min(e.date) AS payment_date,min(e.amount) AS amount
    ${searchParameter ? `,bool_or(strpos(lower(e.reference),lower($${searchParameter}))>0) AS matches_reference` : ''}
    FROM jsonb_to_recordset(i.settlement->'entries') e(kind text,id text,date text,amount numeric,reference text)
    WHERE e.kind='payment' AND e.id IS NOT NULL
    GROUP BY lower(e.id)
    HAVING count(e.date)=count(*) AND min(e.date)=max(e.date)
      AND count(e.amount)=count(*) AND min(e.amount)=max(e.amount)
      AND min(e.amount)>0 AND min(e.amount)=round(min(e.amount),2)`;
}

// Correlated to the verified TRUST receipt aliased as r.
export function trustReceiptPaymentCandidates(schema: string) {
  return `SELECT e.id::uuid AS id, min(e.amount) AS amount,
        bool_and(${currentPaymentList}) AS "paymentListCurrent",
        CASE WHEN bool_and(${currentPaymentList})
          AND bool_and(e."isReconciled") = bool_or(e."isReconciled")
          THEN bool_and(e."isReconciled") END AS "isReconciled"
      FROM ${schema}.student_operations_xero_invoices i
      JOIN ${schema}.student_operations_xero_sync_configurations c USING (customer_id,xero_connection_id)
      CROSS JOIN LATERAL jsonb_to_recordset(i.settlement->'entries') e(kind text,id text,date text,amount numeric,"isReconciled" boolean)
      WHERE i.customer_id=r.customer_id AND i.xero_connection_id=r.connection_id AND i.xero_invoice_id=r.invoice_id
        AND c.enabled AND c.organisation_role='trust' AND i.invoice_type='ACCREC' AND i.currency_code='AUD'
        AND i.invoice_status IN ('PAID','AUTHORISED') AND e.kind='payment'
        AND ${currentTrustInvoice(schema, 'i')}
      GROUP BY e.id::uuid
      HAVING bool_and((e.date=r.received_on::text AND e.amount > 0
        AND e.amount=least(r.amount,${receiptAllocationBasis('r')})) IS TRUE)`;
}

export function availableTrustPaymentIds(schema: string, includeExistingLink = false) {
  return `SELECT candidate.id FROM (${trustReceiptPaymentCandidates(schema)}) candidate
    WHERE (candidate."paymentListCurrent"${includeExistingLink ? ' OR candidate.id=l.payment_id' : ''})
      AND NOT EXISTS (SELECT 1 FROM ${schema}.student_trust_receipt_payment_links used
      WHERE used.customer_id=r.customer_id AND used.connection_id=r.connection_id
        AND used.payment_id=candidate.id AND used.verification_id<>r.verification_id)`;
}

export function trustOverpaymentCandidates(schema: string, receipt: 'r' | 'receipt') {
  return `SELECT credit.xero_invoice_id AS id, credit.total
         FROM ${schema}.student_operations_xero_invoices invoice
         JOIN ${schema}.student_operations_xero_sync_configurations cfg USING (customer_id,xero_connection_id)
         JOIN ${schema}.student_operations_xero_invoices credit USING (customer_id,xero_connection_id,xero_contact_id)
         WHERE cfg.enabled AND cfg.organisation_role='trust'
           AND invoice.customer_id=${receipt}.customer_id AND invoice.xero_connection_id=${receipt}.connection_id AND invoice.xero_invoice_id=${receipt}.invoice_id
           AND invoice.invoice_type='ACCREC' AND invoice.currency_code='AUD'
           AND invoice.invoice_status IN ('PAID','AUTHORISED')
           AND ${receipt}.amount > ${receiptAllocationBasis(receipt)}
           AND credit.invoice_type='RECEIVE-OVERPAYMENT' AND credit.invoice_status IN ('PAID','AUTHORISED')
           AND credit.currency_code='AUD' AND credit.invoice_date=${receipt}.received_on
           AND credit.total=${receipt}.amount-${receiptAllocationBasis(receipt)}
           AND ${currentTrustInvoice(schema, 'invoice')}
           AND ${currentTrustInvoice(schema, 'credit')}`;
}
