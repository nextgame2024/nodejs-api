-- Personal contact fields are for an authorized case detail, not the student
-- roster. Runtime has no direct SELECT privilege on public.users.
CREATE VIEW __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_contact
  WITH (security_barrier = true) AS
SELECT c.customer_id, c.case_id,
       NULLIF(btrim(u.cel), '') AS mobile,
       NULLIF(btrim(u.tel), '') AS phone
  FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_cases c
  JOIN __SOPHIA_RUNTIME_SCHEMA__.student_operations_student_user_links l
    ON l.customer_id = c.customer_id AND l.student_id = c.student_id
  JOIN __SOPHIA_RUNTIME_SCHEMA__.customers tenant
    ON tenant.customer_id = c.customer_id AND tenant.status = 'active'
  JOIN public.users u
    ON u.id = l.user_id AND u.company_id::text = tenant.external_company_id
   AND u.type::text = 'student'
 WHERE c.customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid;

GRANT SELECT ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_contact
  TO sophia_runtime_app;
