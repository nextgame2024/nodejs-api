CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.business_profiles (
  business_profile_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  profile_key text NOT NULL,
  display_name text NOT NULL,
  active_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, profile_key)
);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.business_profile_versions (
  business_profile_version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_profile_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.business_profiles(business_profile_id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  pack_registration_key text,
  extension_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_profile_id, version)
);

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.business_profiles
  DROP CONSTRAINT IF EXISTS business_profiles_active_version_fk;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.business_profiles
  ADD CONSTRAINT business_profiles_active_version_fk
  FOREIGN KEY (active_version_id)
  REFERENCES __SOPHIA_RUNTIME_SCHEMA__.business_profile_versions(business_profile_version_id)
  ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.provider_configurations (
  provider_configuration_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  configuration_key text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  provider_id text NOT NULL,
  adapter_key text NOT NULL,
  manifest jsonb NOT NULL,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  credential_ref text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, configuration_key, version)
);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.capability_bindings (
  capability_binding_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_profile_version_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.business_profile_versions(business_profile_version_id) ON DELETE CASCADE,
  capability_key text NOT NULL,
  connector_key text NOT NULL,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  policy_version text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_profile_version_id, capability_key)
);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.experience_profiles (
  experience_profile_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  experience_key text NOT NULL,
  display_name text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  active_version_id uuid,
  legacy_ai_config_id uuid REFERENCES __SOPHIA_RUNTIME_SCHEMA__.ai_configs(ai_config_id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, experience_key)
);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.experience_profile_versions (
  experience_profile_version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experience_profile_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.experience_profiles(experience_profile_id) ON DELETE CASCADE,
  business_profile_version_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.business_profile_versions(business_profile_version_id),
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  pipeline_mode text NOT NULL CHECK (pipeline_mode IN ('native-realtime', 'orchestrated-text', 'orchestrated-voice', 'composite-realtime')),
  configuration jsonb NOT NULL,
  configuration_digest text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (experience_profile_id, version),
  UNIQUE (experience_profile_version_id, experience_profile_id)
);

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.experience_profiles
  DROP CONSTRAINT IF EXISTS experience_profiles_active_version_fk;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.experience_profiles
  ADD CONSTRAINT experience_profiles_active_version_fk
  FOREIGN KEY (active_version_id, experience_profile_id)
  REFERENCES __SOPHIA_RUNTIME_SCHEMA__.experience_profile_versions(experience_profile_version_id, experience_profile_id)
  ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.experience_provider_bindings (
  experience_profile_version_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.experience_profile_versions(experience_profile_version_id) ON DELETE CASCADE,
  provider_configuration_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.provider_configurations(provider_configuration_id),
  capability_key text NOT NULL,
  binding_key text NOT NULL,
  PRIMARY KEY (experience_profile_version_id, capability_key)
);

CREATE INDEX IF NOT EXISTS idx_sophia_business_profiles_customer
  ON __SOPHIA_RUNTIME_SCHEMA__.business_profiles(customer_id);
CREATE INDEX IF NOT EXISTS idx_sophia_provider_configurations_customer_status
  ON __SOPHIA_RUNTIME_SCHEMA__.provider_configurations(customer_id, status);
CREATE INDEX IF NOT EXISTS idx_sophia_experience_profiles_customer_enabled
  ON __SOPHIA_RUNTIME_SCHEMA__.experience_profiles(customer_id, enabled);

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_published_configuration()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'published' THEN
    RAISE EXCEPTION 'Published configuration rows are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_published_business_profile_version ON __SOPHIA_RUNTIME_SCHEMA__.business_profile_versions;
CREATE TRIGGER protect_published_business_profile_version
  BEFORE UPDATE OR DELETE ON __SOPHIA_RUNTIME_SCHEMA__.business_profile_versions
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_published_configuration();

DROP TRIGGER IF EXISTS protect_published_provider_configuration ON __SOPHIA_RUNTIME_SCHEMA__.provider_configurations;
CREATE TRIGGER protect_published_provider_configuration
  BEFORE UPDATE OR DELETE ON __SOPHIA_RUNTIME_SCHEMA__.provider_configurations
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_published_configuration();

DROP TRIGGER IF EXISTS protect_published_experience_profile_version ON __SOPHIA_RUNTIME_SCHEMA__.experience_profile_versions;
CREATE TRIGGER protect_published_experience_profile_version
  BEFORE UPDATE OR DELETE ON __SOPHIA_RUNTIME_SCHEMA__.experience_profile_versions
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_published_configuration();

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_published_capability_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_business_profile_version_id uuid;
BEGIN
  target_business_profile_version_id := CASE
    WHEN TG_OP = 'DELETE' THEN OLD.business_profile_version_id
    ELSE NEW.business_profile_version_id
  END;
  IF EXISTS (
    SELECT 1 FROM __SOPHIA_RUNTIME_SCHEMA__.business_profile_versions
    WHERE business_profile_version_id = target_business_profile_version_id
      AND status = 'published'
  ) THEN
    RAISE EXCEPTION 'Bindings of a published business profile are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_published_capability_binding ON __SOPHIA_RUNTIME_SCHEMA__.capability_bindings;
CREATE TRIGGER protect_published_capability_binding
  BEFORE INSERT OR UPDATE OR DELETE ON __SOPHIA_RUNTIME_SCHEMA__.capability_bindings
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_published_capability_binding();

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_published_experience_provider_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_experience_profile_version_id uuid;
BEGIN
  target_experience_profile_version_id := CASE
    WHEN TG_OP = 'DELETE' THEN OLD.experience_profile_version_id
    ELSE NEW.experience_profile_version_id
  END;
  IF EXISTS (
    SELECT 1 FROM __SOPHIA_RUNTIME_SCHEMA__.experience_profile_versions
    WHERE experience_profile_version_id = target_experience_profile_version_id
      AND status = 'published'
  ) THEN
    RAISE EXCEPTION 'Bindings of a published experience profile are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_published_experience_provider_binding ON __SOPHIA_RUNTIME_SCHEMA__.experience_provider_bindings;
CREATE TRIGGER protect_published_experience_provider_binding
  BEFORE INSERT OR UPDATE OR DELETE ON __SOPHIA_RUNTIME_SCHEMA__.experience_provider_bindings
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_published_experience_provider_binding();
