-- One authoritative source for the register and recurring reconciliation.
-- Includes drafts and future invoice dates. Never fall back past a blank advisor.
CREATE VIEW __SOPHIA_RUNTIME_SCHEMA__.student_operations_latest_invoice_advisors
WITH (security_invoker = true) AS
WITH sources AS (
  SELECT l.customer_id, l.student_id AS profile_id, i.xero_invoice_id,
         i.xero_connection_id, i.invoice_date, i.advisor_name
    FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_student_user_links l
    JOIN __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_invoices i
      ON i.customer_id=l.customer_id AND i.student_id=l.student_reference
   WHERE i.invoice_type='ACCREC' AND i.invoice_status NOT IN ('DELETED','VOIDED')
  UNION
  SELECT l.customer_id, l.student_id, i.xero_invoice_id,
         i.xero_connection_id, i.invoice_date, i.advisor_name
    FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_invoice_links l
    JOIN __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_invoices i
      USING (customer_id, xero_connection_id, xero_invoice_id)
   WHERE i.invoice_type='ACCREC' AND i.invoice_status NOT IN ('DELETED','VOIDED')
     AND (i.student_id IS NULL OR EXISTS (
       SELECT 1 FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_student_user_links u
        WHERE u.customer_id=l.customer_id AND u.student_id=l.student_id
          AND u.student_reference=i.student_id))
)
SELECT DISTINCT ON (customer_id, profile_id) customer_id, profile_id,
       nullif(btrim(advisor_name),'') AS advisor_name
  FROM sources
 WHERE customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid
 ORDER BY customer_id, profile_id, invoice_date DESC NULLS LAST,
          xero_invoice_id DESC, xero_connection_id DESC;
GRANT SELECT ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_latest_invoice_advisors TO sophia_runtime_app;

CREATE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.reconcile_latest_invoice_advisors(p_customer uuid)
RETURNS void LANGUAGE sql SECURITY INVOKER AS $$
  WITH desired AS (
    SELECT s.student_id, chosen.advisor_id
      FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_students s
      JOIN __SOPHIA_RUNTIME_SCHEMA__.student_operations_latest_invoice_advisors latest
        ON latest.customer_id=s.customer_id AND latest.profile_id=s.student_id
      LEFT JOIN LATERAL (
        SELECT (array_agg(d.advisor_id))[1] AS advisor_id
          FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_advisor_directory d
         WHERE d.customer_id=s.customer_id AND d.status='active'
           AND (lower(btrim(latest.advisor_name)) IN (lower(d.xero_label),lower(d.code||' '||d.name),lower(d.name))
             OR upper(substring(btrim(latest.advisor_name) FROM '^([A-Za-z]+[0-9]+)'))=upper(d.code))
        HAVING count(*)=1
      ) chosen ON true
     WHERE s.customer_id=p_customer
       AND p_customer=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid
  ), changed AS (
  UPDATE __SOPHIA_RUNTIME_SCHEMA__.student_operations_students s
     SET advisor_id=d.advisor_id, updated_at=now(), record_version=record_version+1
    FROM desired d WHERE s.customer_id=p_customer AND s.student_id=d.student_id
     AND s.advisor_id IS DISTINCT FROM d.advisor_id
  RETURNING s.customer_id,s.student_id,s.record_version
  )
  INSERT INTO __SOPHIA_RUNTIME_SCHEMA__.student_operations_student_audit_events
    (customer_id,student_id,actor_identity_user_id,event_type,record_version,changed_fields,correlation_id)
  SELECT customer_id,student_id,'system:xero-sync','student.updated',record_version,
    ARRAY['advisor_id'],'latest-invoice-advisor-reconciliation' FROM changed;
$$;
REVOKE ALL ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.reconcile_latest_invoice_advisors(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.reconcile_latest_invoice_advisors(uuid) TO sophia_runtime_app;
