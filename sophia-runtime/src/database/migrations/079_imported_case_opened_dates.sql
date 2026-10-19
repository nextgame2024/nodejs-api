-- One-time historical correction. Native Sophia cases keep CURRENT_DATE.
SELECT set_config('sophia.tenant_id', customer_id::text, true)
  FROM __SOPHIA_RUNTIME_SCHEMA__.customers
 WHERE external_company_id='80d5e42f-2de1-4792-86b5-54c7cdeb2660' AND status='active';

WITH migrated AS (
  SELECT c.* FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_cases c
  JOIN __SOPHIA_RUNTIME_SCHEMA__.customers tenant USING(customer_id)
  WHERE c.migration_key='existing_students_v1'
    AND tenant.external_company_id='80d5e42f-2de1-4792-86b5-54c7cdeb2660'
    AND tenant.status='active'
), source_dates AS (
  SELECT c.customer_id,c.student_id,i.invoice_date
    FROM migrated c
    JOIN __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_invoice_links link
      ON link.customer_id=c.customer_id AND link.case_id=c.case_id AND link.student_id=c.student_id
    JOIN __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_invoices i
      ON i.customer_id=link.customer_id AND i.xero_connection_id=link.xero_connection_id
     AND i.xero_invoice_id=link.xero_invoice_id
   WHERE i.invoice_type='ACCREC' AND i.invoice_status NOT IN ('DELETED','VOIDED')
     AND (i.student_id IS NULL OR EXISTS (
       SELECT 1 FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_student_user_links u
        WHERE u.customer_id=c.customer_id AND u.student_id=c.student_id AND u.student_reference=i.student_id))
  UNION ALL
  SELECT c.customer_id,c.student_id,i.invoice_date
    FROM migrated c
    JOIN __SOPHIA_RUNTIME_SCHEMA__.student_operations_student_user_links u
      ON u.customer_id=c.customer_id AND u.student_id=c.student_id
    JOIN __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_invoices i
      ON i.customer_id=u.customer_id AND i.student_id=u.student_reference
   WHERE i.invoice_type='ACCREC' AND i.invoice_status NOT IN ('DELETED','VOIDED')
), oldest AS (
  SELECT customer_id,student_id,min(invoice_date) AS oldest_invoice_date
    FROM source_dates GROUP BY customer_id,student_id
), corrections AS (
  SELECT c.customer_id,c.case_id,c.case_reference,c.opened_on AS previous_opened_on,
         o.oldest_invoice_date AS opened_on
    FROM migrated c JOIN oldest o USING(customer_id,student_id)
   WHERE o.oldest_invoice_date IS NOT NULL AND c.opened_on IS DISTINCT FROM o.oldest_invoice_date
     AND (c.closed_on IS NULL OR c.closed_on>=o.oldest_invoice_date)
), changed AS (
  UPDATE __SOPHIA_RUNTIME_SCHEMA__.student_operations_cases c
     SET opened_on=corrections.opened_on,record_version=c.record_version+1,updated_at=now()
    FROM corrections WHERE c.customer_id=corrections.customer_id AND c.case_id=corrections.case_id
  RETURNING c.customer_id,c.case_id,corrections.previous_opened_on,c.opened_on
)
INSERT INTO __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_activity
  (customer_id,case_id,actor_identity_user_id,event_type,summary,detail)
SELECT customer_id,case_id,'migration:079_imported_case_opened_dates','case.updated',
       'Imported case opening date set to oldest invoice date',
       jsonb_build_object('previousOpenedOn',previous_opened_on,'openedOn',opened_on,
                          'migration','079_imported_case_opened_dates.sql')
  FROM changed RETURNING case_id;
