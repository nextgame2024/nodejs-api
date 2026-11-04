-- The internal operator company may run its own Sophia assistant and WhatsApp
-- channel. Provision it as a normal Runtime tenant so Leads continues to use
-- the same tenant/RLS boundary as every customer; platform authority is not a
-- cross-tenant Leads bypass.
DO $$
DECLARE
  ambiguous_external_company_id text;
BEGIN
  SELECT customer.external_company_id
    INTO ambiguous_external_company_id
    FROM __SOPHIA_RUNTIME_SCHEMA__.customers customer
    JOIN __SOPHIA_RUNTIME_SCHEMA__.platform_operator_assignments assignment
      ON assignment.operator_company_id::text=customer.external_company_id
     AND assignment.status='active'
   GROUP BY customer.external_company_id
  HAVING count(*) > 1
   LIMIT 1;

  IF ambiguous_external_company_id IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot provision internal assistant tenant: company % has multiple Runtime customers',
      ambiguous_external_company_id;
  END IF;

  INSERT INTO __SOPHIA_RUNTIME_SCHEMA__.customers(
    name,
    external_company_id,
    status,
    metadata
  )
  SELECT
    company.company_name,
    assignment.operator_company_id::text,
    'active',
    jsonb_build_object(
      'provisionedBy', '124_platform_operator_lead_tenant',
      'purpose', 'internal_assistant'
    )
    FROM (
      SELECT DISTINCT operator_company_id
        FROM __SOPHIA_RUNTIME_SCHEMA__.platform_operator_assignments
       WHERE status='active'
    ) assignment
    JOIN public.bm_company company
      ON company.company_id=assignment.operator_company_id
     AND company.status='active'
   WHERE NOT EXISTS(
     SELECT 1
       FROM __SOPHIA_RUNTIME_SCHEMA__.customers existing
      WHERE existing.external_company_id=assignment.operator_company_id::text
   );
END $$;
