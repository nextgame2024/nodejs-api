-- Correct the supplied directory entry in place so existing student links
-- continue to reference the same advisor identity.
UPDATE __SOPHIA_RUNTIME_SCHEMA__.student_operations_advisor_directory directory
   SET code = 'S69', xero_label = 'S69 Pedro Muñoz', updated_at = now()
  FROM __SOPHIA_RUNTIME_SCHEMA__.customers customer
 WHERE customer.customer_id = directory.customer_id
   AND customer.external_company_id = '80d5e42f-2de1-4792-86b5-54c7cdeb2660'
   AND directory.code = 'C01' AND directory.name = 'Pedro Muñoz';

-- The original CSV label omitted S69. Match both the corrected Xero label
-- and the original label for profiles left unassigned by migration 075.
WITH candidates AS (
  SELECT link.customer_id, link.student_id, i.advisor_name,
         i.invoice_date, i.xero_invoice_id
    FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_invoice_links link
    JOIN __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_invoices i
      ON i.customer_id = link.customer_id
     AND i.xero_connection_id = link.xero_connection_id
     AND i.xero_invoice_id = link.xero_invoice_id
    JOIN __SOPHIA_RUNTIME_SCHEMA__.customers customer
      ON customer.customer_id = link.customer_id
   WHERE customer.external_company_id = '80d5e42f-2de1-4792-86b5-54c7cdeb2660'
     AND i.invoice_status NOT IN ('DELETED', 'VOIDED')
     AND nullif(btrim(i.advisor_name), '') IS NOT NULL
  UNION ALL
  SELECT link.customer_id, link.student_id, i.advisor_name,
         i.invoice_date, i.xero_invoice_id
    FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_student_user_links link
    JOIN __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_invoices i
      ON i.customer_id = link.customer_id AND i.student_id = link.student_reference
    JOIN __SOPHIA_RUNTIME_SCHEMA__.customers customer
      ON customer.customer_id = link.customer_id
   WHERE customer.external_company_id = '80d5e42f-2de1-4792-86b5-54c7cdeb2660'
     AND i.invoice_status NOT IN ('DELETED', 'VOIDED')
     AND nullif(btrim(i.advisor_name), '') IS NOT NULL
), latest AS (
  SELECT DISTINCT ON (customer_id, student_id)
         customer_id, student_id, advisor_name
    FROM candidates
   ORDER BY customer_id, student_id, invoice_date DESC NULLS LAST, xero_invoice_id DESC
)
UPDATE __SOPHIA_RUNTIME_SCHEMA__.student_operations_students student
   SET advisor_id = directory.advisor_id, updated_at = now()
  FROM latest
  JOIN __SOPHIA_RUNTIME_SCHEMA__.student_operations_advisor_directory directory
    ON directory.customer_id = latest.customer_id
   AND directory.code = 'S69' AND directory.name = 'Pedro Muñoz'
 WHERE student.customer_id = latest.customer_id
   AND student.student_id = latest.student_id
   AND student.advisor_id IS NULL
   AND lower(regexp_replace(btrim(latest.advisor_name), '[[:space:]]+', ' ', 'g'))
       IN ('s69 pedro muñoz', 'pedro muñoz', 'c01 pedro muñoz');
