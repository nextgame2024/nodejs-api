-- Only eligible tenant college identities/aliases, never unrestricted BM access.
CREATE VIEW __SOPHIA_RUNTIME_SCHEMA__.student_college_matching_directory
 WITH (security_barrier=true) AS
SELECT c.customer_id,b.college_id,b.college_name,b.trading_name,b.acronym
 FROM __SOPHIA_RUNTIME_SCHEMA__.customers c
 JOIN public.bm_colleges b ON b.company_id::text=c.external_company_id
 WHERE c.status='active' AND b.status='active'
  AND c.customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid;
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.student_college_matching_directory FROM PUBLIC,sophia_runtime_app;
GRANT SELECT ON __SOPHIA_RUNTIME_SCHEMA__.student_college_matching_directory TO sophia_runtime_app;
