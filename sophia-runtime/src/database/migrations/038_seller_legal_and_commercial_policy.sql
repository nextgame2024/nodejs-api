CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.seller_legal_entities (
  seller_legal_entity_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_key text NOT NULL UNIQUE CHECK (seller_key ~ '^[a-z][a-z0-9-]{1,79}$'),
  status text NOT NULL CHECK (status IN ('active', 'retired')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.seller_legal_entity_versions (
  seller_legal_entity_version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_legal_entity_id uuid NOT NULL
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.seller_legal_entities(seller_legal_entity_id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
  legal_form text NOT NULL CHECK (legal_form IN ('sole_trader', 'company', 'partnership', 'trust', 'other')),
  jurisdiction_country text NOT NULL CHECK (jurisdiction_country ~ '^[A-Z]{2}$'),
  legal_name text NOT NULL CHECK (length(legal_name) BETWEEN 1 AND 240),
  trading_name text CHECK (trading_name IS NULL OR length(trading_name) BETWEEN 1 AND 240),
  registration_identifier_type text
    CHECK (registration_identifier_type IS NULL OR registration_identifier_type ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  registration_identifier_value text
    CHECK (registration_identifier_value IS NULL OR length(registration_identifier_value) BETWEEN 1 AND 80),
  registered_address jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(registered_address) = 'object'),
  effective_from timestamptz,
  effective_to timestamptz,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (seller_legal_entity_id, version),
  UNIQUE (seller_legal_entity_version_id, seller_legal_entity_id),
  CHECK ((registration_identifier_type IS NULL) = (registration_identifier_value IS NULL)),
  CHECK (effective_to IS NULL OR (effective_from IS NOT NULL AND effective_to > effective_from)),
  CHECK ((status = 'draft' AND published_at IS NULL AND effective_from IS NULL)
    OR (status IN ('published', 'retired') AND published_at IS NOT NULL AND effective_from IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.seller_commercial_policy_versions (
  seller_commercial_policy_version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_legal_entity_id uuid NOT NULL,
  seller_legal_entity_version_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
  customer_scope text NOT NULL CHECK (customer_scope IN ('business_only', 'consumer_only', 'mixed')),
  gst_registered boolean NOT NULL,
  tax_jurisdiction_country text NOT NULL CHECK (tax_jurisdiction_country ~ '^[A-Z]{2}$'),
  tax_label text CHECK (tax_label IS NULL OR length(tax_label) BETWEEN 1 AND 40),
  tax_calculation_mode text NOT NULL CHECK (tax_calculation_mode IN ('none', 'fixed_rate', 'provider_automatic')),
  tax_rate_basis_points integer CHECK (tax_rate_basis_points IS NULL OR tax_rate_basis_points BETWEEN 0 AND 10000),
  price_display_mode text NOT NULL CHECK (price_display_mode IN ('no_tax', 'tax_exclusive', 'tax_inclusive')),
  effective_from timestamptz,
  effective_to timestamptz,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (seller_legal_entity_id, version),
  UNIQUE (seller_commercial_policy_version_id, seller_legal_entity_id),
  FOREIGN KEY (seller_legal_entity_version_id, seller_legal_entity_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.seller_legal_entity_versions(
      seller_legal_entity_version_id, seller_legal_entity_id) ON DELETE RESTRICT,
  CHECK (effective_to IS NULL OR (effective_from IS NOT NULL AND effective_to > effective_from)),
  CHECK ((status = 'draft' AND published_at IS NULL AND effective_from IS NULL)
    OR (status IN ('published', 'retired') AND published_at IS NOT NULL AND effective_from IS NOT NULL)),
  CHECK ((gst_registered = false AND tax_calculation_mode = 'none'
      AND tax_rate_basis_points IS NULL AND price_display_mode = 'no_tax' AND tax_label IS NULL)
    OR (gst_registered = true AND tax_calculation_mode = 'fixed_rate'
      AND tax_rate_basis_points IS NOT NULL AND price_display_mode IN ('tax_exclusive', 'tax_inclusive')
      AND tax_label IS NOT NULL)
    OR (gst_registered = true AND tax_calculation_mode = 'provider_automatic'
      AND tax_rate_basis_points IS NULL AND price_display_mode IN ('tax_exclusive', 'tax_inclusive')
      AND tax_label IS NOT NULL))
);

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.commercial_plan_versions
  ADD COLUMN IF NOT EXISTS seller_legal_entity_id uuid
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.seller_legal_entities(seller_legal_entity_id) ON DELETE RESTRICT;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.commercial_plan_versions
  ADD COLUMN IF NOT EXISTS tax_category text NOT NULL DEFAULT 'unconfigured';
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.commercial_plan_versions
  ADD CONSTRAINT commercial_plan_versions_tax_category_check
  CHECK (tax_category IN ('unconfigured', 'standard_rate', 'exempt', 'out_of_scope'));

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_subscription_references
  ADD COLUMN IF NOT EXISTS seller_legal_entity_id uuid
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.seller_legal_entities(seller_legal_entity_id) ON DELETE RESTRICT;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_references
  ADD COLUMN IF NOT EXISTS seller_legal_entity_version_id uuid
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.seller_legal_entity_versions(seller_legal_entity_version_id) ON DELETE RESTRICT;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_references
  ADD COLUMN IF NOT EXISTS seller_commercial_policy_version_id uuid
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.seller_commercial_policy_versions(seller_commercial_policy_version_id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_seller_version()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('published', 'retired') THEN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Published seller versions are immutable'; END IF;
    IF NOT (OLD.status = 'published' AND NEW.status = 'retired'
      AND (to_jsonb(NEW) - 'status') = (to_jsonb(OLD) - 'status')) THEN
      RAISE EXCEPTION 'Published seller versions are immutable';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_seller_legal_entity_version
  ON __SOPHIA_RUNTIME_SCHEMA__.seller_legal_entity_versions;
CREATE TRIGGER protect_seller_legal_entity_version BEFORE UPDATE OR DELETE
  ON __SOPHIA_RUNTIME_SCHEMA__.seller_legal_entity_versions
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_seller_version();
DROP TRIGGER IF EXISTS protect_seller_commercial_policy_version
  ON __SOPHIA_RUNTIME_SCHEMA__.seller_commercial_policy_versions;
CREATE TRIGGER protect_seller_commercial_policy_version BEFORE UPDATE OR DELETE
  ON __SOPHIA_RUNTIME_SCHEMA__.seller_commercial_policy_versions
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_seller_version();

REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.seller_legal_entities FROM sophia_runtime_app;
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.seller_legal_entity_versions FROM sophia_runtime_app;
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.seller_commercial_policy_versions FROM sophia_runtime_app;
GRANT SELECT ON __SOPHIA_RUNTIME_SCHEMA__.seller_legal_entities TO sophia_runtime_app;
GRANT SELECT ON __SOPHIA_RUNTIME_SCHEMA__.seller_legal_entity_versions TO sophia_runtime_app;
GRANT SELECT ON __SOPHIA_RUNTIME_SCHEMA__.seller_commercial_policy_versions TO sophia_runtime_app;

COMMENT ON COLUMN __SOPHIA_RUNTIME_SCHEMA__.commercial_plan_versions.tax_mode IS
  'Legacy plan-local tax field. Seller-linked production plans resolve collectible tax from the effective seller commercial policy.';
COMMENT ON COLUMN __SOPHIA_RUNTIME_SCHEMA__.commercial_plan_versions.tax_category IS
  'Product tax classification, independent from seller registration and price-display policy.';
COMMENT ON TABLE __SOPHIA_RUNTIME_SCHEMA__.seller_commercial_policy_versions IS
  'Versioned seller-level customer audience, tax-registration, tax-calculation and price-display authority.';
