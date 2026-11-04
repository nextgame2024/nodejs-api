-- Internal platform operators use Runtime as a normal tenant. Managed text is
-- stored and retrieved by Runtime itself, so it needs a core knowledge grant;
-- it must not borrow an industry connector merely to publish approved text.
CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.ensure_internal_assistant_managed_knowledge(
  target_company_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  target_company_name text;
  target_customer_id uuid;
  target_customer_status text;
  matching_customer_count integer;
  target_profile_id uuid;
  target_version_id uuid;
  target_version_status text;
  target_connector_key text;
  target_policy_version text;
BEGIN
  -- Serialise the company bootstrap because customers.external_company_id is
  -- intentionally not globally unique for unrelated legacy customer records.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('internal-assistant:' || target_company_id::text, 0)
  );

  SELECT company.company_name
    INTO target_company_name
    FROM public.bm_company company
   WHERE company.company_id = target_company_id
     AND company.status = 'active';

  IF target_company_name IS NULL THEN
    RAISE EXCEPTION 'Cannot provision internal assistant for inactive or unknown company %',
      target_company_id;
  END IF;

  SELECT count(*)::integer
    INTO matching_customer_count
    FROM __SOPHIA_RUNTIME_SCHEMA__.customers customer
   WHERE customer.external_company_id = target_company_id::text;

  IF matching_customer_count > 1 THEN
    RAISE EXCEPTION 'Cannot provision internal assistant: company % has multiple Runtime customers',
      target_company_id;
  END IF;

  IF matching_customer_count = 0 THEN
    INSERT INTO __SOPHIA_RUNTIME_SCHEMA__.customers(
      name,
      external_company_id,
      status,
      metadata
    ) VALUES (
      target_company_name,
      target_company_id::text,
      'active',
      jsonb_build_object(
        'provisionedBy', '125_internal_assistant_managed_knowledge',
        'purpose', 'internal_assistant'
      )
    )
    RETURNING customer_id INTO target_customer_id;
  ELSE
    SELECT customer.customer_id, customer.status
      INTO target_customer_id, target_customer_status
      FROM __SOPHIA_RUNTIME_SCHEMA__.customers customer
     WHERE customer.external_company_id = target_company_id::text
     LIMIT 1;

    IF target_customer_status <> 'active' THEN
      RAISE EXCEPTION 'Cannot provision internal assistant: Runtime customer for company % is inactive',
        target_company_id;
    END IF;
  END IF;

  INSERT INTO __SOPHIA_RUNTIME_SCHEMA__.business_profiles(
    customer_id,
    profile_key,
    display_name
  ) VALUES (
    target_customer_id,
    'sophia-ai-managed-knowledge',
    'Sophia AI managed knowledge'
  )
  ON CONFLICT (customer_id, profile_key) DO NOTHING;

  SELECT profile.business_profile_id
    INTO target_profile_id
    FROM __SOPHIA_RUNTIME_SCHEMA__.business_profiles profile
   WHERE profile.customer_id = target_customer_id
     AND profile.profile_key = 'sophia-ai-managed-knowledge';

  SELECT version.business_profile_version_id, version.status
    INTO target_version_id, target_version_status
    FROM __SOPHIA_RUNTIME_SCHEMA__.business_profile_versions version
   WHERE version.business_profile_id = target_profile_id
     AND version.version = 1;

  IF target_version_id IS NULL THEN
    INSERT INTO __SOPHIA_RUNTIME_SCHEMA__.business_profile_versions(
      business_profile_id,
      version,
      status,
      pack_registration_key,
      extension_schema
    ) VALUES (
      target_profile_id,
      1,
      'draft',
      'core-managed-knowledge@1.0.0',
      '{}'::jsonb
    )
    RETURNING business_profile_version_id, status
      INTO target_version_id, target_version_status;
  END IF;

  IF target_version_status NOT IN ('draft', 'published') THEN
    RAISE EXCEPTION 'Managed knowledge profile version is %, expected draft or published',
      target_version_status;
  END IF;

  IF target_version_status = 'draft' THEN
    INSERT INTO __SOPHIA_RUNTIME_SCHEMA__.capability_bindings(
      business_profile_version_id,
      capability_key,
      connector_key,
      connector_binding_id,
      configuration,
      policy_version,
      enabled
    ) VALUES (
      target_version_id,
      'knowledge',
      'sophia-managed-knowledge',
      NULL,
      jsonb_build_object(
        'sourceType', 'managed_text',
        'retrieval', 'published_snapshot'
      ),
      'core:managed-knowledge@1.0.0',
      true
    )
    ON CONFLICT (business_profile_version_id, capability_key) DO NOTHING;
  END IF;

  SELECT binding.connector_key, binding.policy_version
    INTO target_connector_key, target_policy_version
    FROM __SOPHIA_RUNTIME_SCHEMA__.capability_bindings binding
   WHERE binding.business_profile_version_id = target_version_id
     AND binding.capability_key = 'knowledge'
     AND binding.enabled = true
     AND binding.connector_binding_id IS NULL;

  IF target_connector_key IS DISTINCT FROM 'sophia-managed-knowledge'
     OR target_policy_version IS DISTINCT FROM 'core:managed-knowledge@1.0.0' THEN
    RAISE EXCEPTION 'Managed knowledge profile has a conflicting knowledge capability binding';
  END IF;

  IF target_version_status = 'draft' THEN
    UPDATE __SOPHIA_RUNTIME_SCHEMA__.business_profile_versions
       SET status = 'published',
           published_at = now(),
           updated_at = now()
     WHERE business_profile_version_id = target_version_id;
  END IF;

  UPDATE __SOPHIA_RUNTIME_SCHEMA__.business_profiles
     SET active_version_id = target_version_id,
         updated_at = now()
   WHERE business_profile_id = target_profile_id
     AND active_version_id IS DISTINCT FROM target_version_id;

  RETURN target_customer_id;
END;
$$;

REVOKE ALL ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.ensure_internal_assistant_managed_knowledge(uuid)
  FROM PUBLIC;

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.provision_internal_assistant_after_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.status = 'active' THEN
    PERFORM __SOPHIA_RUNTIME_SCHEMA__.ensure_internal_assistant_managed_knowledge(
      NEW.operator_company_id
    );
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.provision_internal_assistant_after_assignment()
  FROM PUBLIC;

DROP TRIGGER IF EXISTS provision_internal_assistant_after_assignment
  ON __SOPHIA_RUNTIME_SCHEMA__.platform_operator_assignments;
CREATE TRIGGER provision_internal_assistant_after_assignment
  AFTER INSERT OR UPDATE OF operator_company_id, status
  ON __SOPHIA_RUNTIME_SCHEMA__.platform_operator_assignments
  FOR EACH ROW
  WHEN (NEW.status = 'active')
  EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.provision_internal_assistant_after_assignment();

-- Backfill active assignments created before the automatic bootstrap existed.
DO $$
DECLARE
  target_company_id uuid;
BEGIN
  FOR target_company_id IN
    SELECT DISTINCT assignment.operator_company_id
      FROM __SOPHIA_RUNTIME_SCHEMA__.platform_operator_assignments assignment
     WHERE assignment.status = 'active'
     ORDER BY assignment.operator_company_id
  LOOP
    PERFORM __SOPHIA_RUNTIME_SCHEMA__.ensure_internal_assistant_managed_knowledge(
      target_company_id
    );
  END LOOP;
END;
$$;
