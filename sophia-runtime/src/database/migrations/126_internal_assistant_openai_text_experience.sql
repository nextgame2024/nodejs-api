-- Provision the first provider-neutral text experience for internal platform
-- operators. OpenAI is the initial approved reasoning adapter; additional
-- provider-backed experiences can be published later without changing agents.

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.stable_configuration_json(
  input_value jsonb
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
DECLARE
  result text;
BEGIN
  CASE pg_catalog.jsonb_typeof(input_value)
    WHEN 'object' THEN
      SELECT '{' || COALESCE(
        pg_catalog.string_agg(
          pg_catalog.to_jsonb(entry.key)::text || ':' ||
            __SOPHIA_RUNTIME_SCHEMA__.stable_configuration_json(entry.value),
          ',' ORDER BY entry.key COLLATE pg_catalog."C"
        ),
        ''
      ) || '}'
        INTO result
        FROM pg_catalog.jsonb_each(input_value) AS entry;
    WHEN 'array' THEN
      SELECT '[' || COALESCE(
        pg_catalog.string_agg(
          __SOPHIA_RUNTIME_SCHEMA__.stable_configuration_json(entry.value),
          ',' ORDER BY entry.position
        ),
        ''
      ) || ']'
        INTO result
        FROM pg_catalog.jsonb_array_elements(input_value)
          WITH ORDINALITY AS entry(value, position);
    ELSE
      result := input_value::text;
  END CASE;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.stable_configuration_json(jsonb)
  FROM PUBLIC;

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.ensure_internal_assistant_openai_text_experience(
  target_company_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  target_customer_id uuid;
  target_business_version_id uuid;
  target_knowledge_binding_id uuid;
  target_provider_configuration_id uuid;
  target_provider_status text;
  target_provider_id text;
  target_adapter_key text;
  target_credential_ref text;
  target_provider_manifest jsonb;
  target_provider_settings jsonb;
  expected_provider_manifest jsonb;
  target_experience_profile_id uuid;
  target_experience_version_id uuid;
  target_experience_status text;
  target_experience_business_version_id uuid;
  target_pipeline_mode text;
  target_experience_configuration jsonb;
  expected_experience_configuration jsonb;
  expected_configuration_digest text;
  target_bound_provider_id uuid;
  target_binding_key text;
BEGIN
  target_customer_id := __SOPHIA_RUNTIME_SCHEMA__.ensure_internal_assistant_managed_knowledge(
    target_company_id
  );

  SELECT version.business_profile_version_id, binding.capability_binding_id
    INTO target_business_version_id, target_knowledge_binding_id
    FROM __SOPHIA_RUNTIME_SCHEMA__.business_profiles profile
    JOIN __SOPHIA_RUNTIME_SCHEMA__.business_profile_versions version
      ON version.business_profile_id = profile.business_profile_id
     AND version.business_profile_version_id = profile.active_version_id
     AND version.status = 'published'
    JOIN __SOPHIA_RUNTIME_SCHEMA__.capability_bindings binding
      ON binding.business_profile_version_id = version.business_profile_version_id
     AND binding.capability_key = 'knowledge'
     AND binding.connector_key = 'sophia-managed-knowledge'
     AND binding.connector_binding_id IS NULL
     AND binding.enabled = true
   WHERE profile.customer_id = target_customer_id
     AND profile.profile_key = 'sophia-ai-managed-knowledge';

  IF target_business_version_id IS NULL OR target_knowledge_binding_id IS NULL THEN
    RAISE EXCEPTION 'Cannot provision text experience: managed knowledge profile is unavailable';
  END IF;

  expected_provider_manifest := pg_catalog.jsonb_build_object(
    'providerId', 'openai-reasoning',
    'adapterVersion', 'v1-wrapper.1',
    'configurationSchema', pg_catalog.jsonb_build_object(
      'type', 'object',
      'additionalProperties', false
    ),
    'capabilities', pg_catalog.jsonb_build_array('reasoning'),
    'supportedModes', pg_catalog.jsonb_build_array('orchestrated-text', 'orchestrated-voice'),
    'supportedInputModalities', pg_catalog.jsonb_build_array('text', 'tool-result'),
    'supportedOutputModalities', pg_catalog.jsonb_build_array('text', 'tool-call'),
    'languages', pg_catalog.jsonb_build_array('en-AU'),
    'toolSchemaCapabilities', pg_catalog.jsonb_build_array('json-schema-object'),
    'toolDeliveryModes', pg_catalog.jsonb_build_array('session-provisioning'),
    'transportAdapters', pg_catalog.jsonb_build_array('server-http-stream'),
    'interruptionCapabilities', pg_catalog.jsonb_build_array('provider-cancel'),
    'inputAudioFormats', '[]'::jsonb,
    'outputAudioFormats', '[]'::jsonb,
    'usageDimensions', pg_catalog.jsonb_build_array(
      'input-tokens', 'output-tokens', 'reasoning-tokens'
    ),
    'dataHandlingAssessmentRef', 'review://openai-reasoning',
    'credentialRef', 'env://openai-reasoning',
    'healthPolicy', pg_catalog.jsonb_build_object(
      'checkKey', 'openai-reasoning.health',
      'maximumAgeSeconds', 60,
      'failClosed', true
    ),
    'reasoningIsReplaceable', true
  );

  SELECT configuration.provider_configuration_id,
         configuration.status,
         configuration.provider_id,
         configuration.adapter_key,
         configuration.credential_ref,
         configuration.manifest,
         configuration.settings
    INTO target_provider_configuration_id,
         target_provider_status,
         target_provider_id,
         target_adapter_key,
         target_credential_ref,
         target_provider_manifest,
         target_provider_settings
    FROM __SOPHIA_RUNTIME_SCHEMA__.provider_configurations configuration
   WHERE configuration.customer_id = target_customer_id
     AND configuration.configuration_key = 'sophia-openai-reasoning'
     AND configuration.version = 1;

  IF target_provider_configuration_id IS NULL THEN
    INSERT INTO __SOPHIA_RUNTIME_SCHEMA__.provider_configurations(
      customer_id,
      configuration_key,
      version,
      status,
      provider_id,
      adapter_key,
      manifest,
      settings,
      credential_ref,
      published_at
    ) VALUES (
      target_customer_id,
      'sophia-openai-reasoning',
      1,
      'published',
      'openai-reasoning',
      'openai-reasoning-v1',
      expected_provider_manifest,
      '{}'::jsonb,
      'env://openai-reasoning',
      now()
    )
    RETURNING provider_configuration_id, status
      INTO target_provider_configuration_id, target_provider_status;
  ELSE
    IF target_provider_id IS DISTINCT FROM 'openai-reasoning'
       OR target_adapter_key IS DISTINCT FROM 'openai-reasoning-v1'
       OR target_credential_ref IS DISTINCT FROM 'env://openai-reasoning'
       OR target_provider_manifest IS DISTINCT FROM expected_provider_manifest
       OR target_provider_settings IS DISTINCT FROM '{}'::jsonb THEN
      RAISE EXCEPTION 'OpenAI reasoning configuration conflicts with the approved profile';
    END IF;
    IF target_provider_status = 'draft' THEN
      UPDATE __SOPHIA_RUNTIME_SCHEMA__.provider_configurations
         SET status = 'published', published_at = now(), updated_at = now()
       WHERE provider_configuration_id = target_provider_configuration_id;
      target_provider_status := 'published';
    END IF;
  END IF;

  IF target_provider_status IS DISTINCT FROM 'published' THEN
    RAISE EXCEPTION 'OpenAI reasoning configuration is %, expected published',
      target_provider_status;
  END IF;

  INSERT INTO __SOPHIA_RUNTIME_SCHEMA__.experience_profiles(
    customer_id,
    experience_key,
    display_name,
    enabled
  ) VALUES (
    target_customer_id,
    'sophia-whatsapp-openai-text',
    'Sophia AI text reasoning (OpenAI)',
    false
  )
  ON CONFLICT (customer_id, experience_key) DO NOTHING;

  SELECT profile.experience_profile_id
    INTO target_experience_profile_id
    FROM __SOPHIA_RUNTIME_SCHEMA__.experience_profiles profile
   WHERE profile.customer_id = target_customer_id
     AND profile.experience_key = 'sophia-whatsapp-openai-text';

  SELECT version.experience_profile_version_id,
         version.status,
         version.business_profile_version_id,
         version.pipeline_mode,
         version.configuration
    INTO target_experience_version_id,
         target_experience_status,
         target_experience_business_version_id,
         target_pipeline_mode,
         target_experience_configuration
    FROM __SOPHIA_RUNTIME_SCHEMA__.experience_profile_versions version
   WHERE version.experience_profile_id = target_experience_profile_id
     AND version.version = 1;

  IF target_experience_version_id IS NULL THEN
    target_experience_version_id := gen_random_uuid();
    target_experience_status := 'draft';
  END IF;

  expected_experience_configuration := pg_catalog.jsonb_build_object(
    'experienceProfileId', target_experience_profile_id,
    'experienceProfileVersionId', target_experience_version_id,
    'businessProfileVersionId', target_business_version_id,
    'revision', 1,
    'plan', pg_catalog.jsonb_build_object(
      'tenantId', target_customer_id,
      'agentId', 'sophia-whatsapp',
      'experienceId', 'sophia-whatsapp-openai-text',
      'profileVersion', target_experience_version_id,
      'pipelineMode', 'orchestrated-text',
      'capabilityOwners', pg_catalog.jsonb_build_object(
        'reasoning', 'openai-reasoning'
      ),
      'providerBindings', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'bindingId', 'openai-reasoning',
          'providerId', 'openai-reasoning',
          'adapterKey', 'openai-reasoning-v1',
          'capability', 'reasoning',
          'configurationVersion', 'v1-wrapper.1'
        )
      ),
      'capabilityBindings', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'capabilityBindingId', target_knowledge_binding_id,
          'capability', 'knowledge',
          'connectorKey', 'sophia-managed-knowledge',
          'configurationVersion', 'core:managed-knowledge@1.0.0'
        )
      ),
      'policyVersion', 'sophia-safety-1',
      'toolCatalogVersion', 'core-tools-v1',
      'languagePolicy', pg_catalog.jsonb_build_object(
        'defaultLocale', 'en-AU',
        'allowedLocales', pg_catalog.jsonb_build_array('en-AU')
      ),
      'dataPolicy', pg_catalog.jsonb_build_object(
        'policyRef', 'sophia-public-enquiries-v1',
        'transcriptPersistence', 'disabled',
        'audioPersistence', 'disabled',
        'processingRegions', '[]'::jsonb
      ),
      'usageLimits', pg_catalog.jsonb_build_object(
        'maximumSessionSeconds', 600,
        'maximumToolCalls', 0
      ),
      'fallbackPolicy', pg_catalog.jsonb_build_object(
        'mode', 'none',
        'allowedProfileVersions', '[]'::jsonb
      )
    ),
    'providers', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'providerConfigurationId', target_provider_configuration_id,
        'bindingId', 'openai-reasoning',
        'adapterKey', 'openai-reasoning-v1',
        'credentialRef', 'env://openai-reasoning',
        'settings', '{}'::jsonb,
        'manifest', expected_provider_manifest
      )
    )
  );

  expected_configuration_digest := pg_catalog.encode(
    public.digest(
      __SOPHIA_RUNTIME_SCHEMA__.stable_configuration_json(
        expected_experience_configuration
      ),
      'sha256'
    ),
    'hex'
  );

  IF target_experience_configuration IS NULL THEN
    INSERT INTO __SOPHIA_RUNTIME_SCHEMA__.experience_profile_versions(
      experience_profile_version_id,
      experience_profile_id,
      business_profile_version_id,
      version,
      status,
      pipeline_mode,
      configuration,
      configuration_digest,
      revision
    ) VALUES (
      target_experience_version_id,
      target_experience_profile_id,
      target_business_version_id,
      1,
      'draft',
      'orchestrated-text',
      expected_experience_configuration,
      expected_configuration_digest,
      1
    );
  ELSE
    IF target_experience_business_version_id IS DISTINCT FROM target_business_version_id
       OR target_pipeline_mode IS DISTINCT FROM 'orchestrated-text'
       OR target_experience_configuration IS DISTINCT FROM expected_experience_configuration THEN
      RAISE EXCEPTION 'OpenAI text experience conflicts with the approved profile';
    END IF;
  END IF;

  IF target_experience_status = 'draft' THEN
    UPDATE __SOPHIA_RUNTIME_SCHEMA__.experience_profile_versions
       SET configuration_digest = expected_configuration_digest,
           updated_at = now()
     WHERE experience_profile_version_id = target_experience_version_id;

    INSERT INTO __SOPHIA_RUNTIME_SCHEMA__.experience_provider_bindings(
      experience_profile_version_id,
      provider_configuration_id,
      capability_key,
      binding_key
    ) VALUES (
      target_experience_version_id,
      target_provider_configuration_id,
      'reasoning',
      'openai-reasoning'
    )
    ON CONFLICT (experience_profile_version_id, capability_key) DO NOTHING;

    UPDATE __SOPHIA_RUNTIME_SCHEMA__.experience_profile_versions
       SET status = 'published', published_at = now(), updated_at = now()
     WHERE experience_profile_version_id = target_experience_version_id;
    target_experience_status := 'published';
  END IF;

  SELECT binding.provider_configuration_id, binding.binding_key
    INTO target_bound_provider_id, target_binding_key
    FROM __SOPHIA_RUNTIME_SCHEMA__.experience_provider_bindings binding
   WHERE binding.experience_profile_version_id = target_experience_version_id
     AND binding.capability_key = 'reasoning';

  IF target_experience_status IS DISTINCT FROM 'published'
     OR target_bound_provider_id IS DISTINCT FROM target_provider_configuration_id
     OR target_binding_key IS DISTINCT FROM 'openai-reasoning' THEN
    RAISE EXCEPTION 'OpenAI text experience is not fully published or has a conflicting binding';
  END IF;

  UPDATE __SOPHIA_RUNTIME_SCHEMA__.experience_profiles
     SET active_version_id = target_experience_version_id,
         enabled = true,
         updated_at = now()
   WHERE experience_profile_id = target_experience_profile_id
     AND (
       active_version_id IS DISTINCT FROM target_experience_version_id
       OR enabled IS DISTINCT FROM true
     );

  RETURN target_experience_version_id;
END;
$$;

REVOKE ALL ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.ensure_internal_assistant_openai_text_experience(uuid)
  FROM PUBLIC;

-- Extend the existing future-assignment trigger without widening its scope.
CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.provision_internal_assistant_after_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.status = 'active' THEN
    PERFORM __SOPHIA_RUNTIME_SCHEMA__.ensure_internal_assistant_openai_text_experience(
      NEW.operator_company_id
    );
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.provision_internal_assistant_after_assignment()
  FROM PUBLIC;

-- Backfill active platform operators that already received managed knowledge.
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
    PERFORM __SOPHIA_RUNTIME_SCHEMA__.ensure_internal_assistant_openai_text_experience(
      target_company_id
    );
  END LOOP;
END;
$$;
