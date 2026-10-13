-- The runtime register needs advisor labels, never credentials or general user access.
CREATE VIEW __SOPHIA_RUNTIME_SCHEMA__.student_operations_advisor_roster
  WITH (security_barrier = true) AS
SELECT c.customer_id, u.id AS user_id, u.name AS display_name
  FROM __SOPHIA_RUNTIME_SCHEMA__.customers c
  JOIN public.users u ON u.company_id::text = c.external_company_id
  JOIN __SOPHIA_RUNTIME_SCHEMA__.business_pack_entitlements e
    ON e.customer_id = c.customer_id AND e.identity_user_id = u.id::text
 WHERE c.status = 'active' AND u.status::text <> 'archived'
   AND e.pack_id = 'student-operations' AND e.status = 'active'
   AND e.role_key IN ('advisor', 'operations', 'chief_executive')
   AND c.customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid;

GRANT SELECT ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_advisor_roster
  TO sophia_runtime_app;

CREATE INDEX IF NOT EXISTS student_operations_users_company_name_sort
  ON public.users (company_id, lower(name), id);
