CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.seller_tax_attestations (
  seller_tax_attestation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_legal_entity_id uuid NOT NULL
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.seller_legal_entities(seller_legal_entity_id) ON DELETE RESTRICT,
  seller_commercial_policy_version_id uuid NOT NULL
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.seller_commercial_policy_versions(seller_commercial_policy_version_id)
      ON DELETE RESTRICT,
  attested_by_identity_user_id text NOT NULL CHECK (length(attested_by_identity_user_id) BETWEEN 1 AND 240),
  attestation_basis text NOT NULL CHECK (attestation_basis = 'owner_statement'),
  jurisdiction_country text NOT NULL CHECK (jurisdiction_country = 'AU'),
  currency text NOT NULL CHECK (currency = 'AUD'),
  gst_registration_threshold_minor bigint NOT NULL CHECK (gst_registration_threshold_minor = 7500000),
  gst_registered boolean NOT NULL CHECK (gst_registered = false),
  current_turnover_below_threshold boolean NOT NULL CHECK (current_turnover_below_threshold = true),
  projected_turnover_below_threshold boolean NOT NULL CHECK (projected_turnover_below_threshold = true),
  projection_months integer NOT NULL CHECK (projection_months = 12),
  statement_digest text NOT NULL CHECK (statement_digest ~ '^[a-f0-9]{64}$'),
  attested_at timestamptz NOT NULL DEFAULT now(),
  review_due_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (review_due_at > attested_at),
  CHECK (review_due_at <= attested_at + interval '31 days'),
  CHECK (attested_at <= created_at + interval '30 seconds')
);

CREATE INDEX IF NOT EXISTS idx_seller_tax_attestations_current
  ON __SOPHIA_RUNTIME_SCHEMA__.seller_tax_attestations
    (seller_legal_entity_id, seller_commercial_policy_version_id, review_due_at DESC);

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_seller_tax_attestation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Seller tax attestation evidence is append-only';
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_seller_tax_attestation
  ON __SOPHIA_RUNTIME_SCHEMA__.seller_tax_attestations;
CREATE TRIGGER trg_protect_seller_tax_attestation
  BEFORE UPDATE OR DELETE ON __SOPHIA_RUNTIME_SCHEMA__.seller_tax_attestations
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_seller_tax_attestation();

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.latest_current_seller_tax_attestation(
  requested_seller_legal_entity_id uuid,
  requested_seller_commercial_policy_version_id uuid
) RETURNS timestamptz
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, __SOPHIA_RUNTIME_SCHEMA__
AS $$
  SELECT max(attested_at)
  FROM seller_tax_attestations
  WHERE seller_legal_entity_id = requested_seller_legal_entity_id
    AND seller_commercial_policy_version_id = requested_seller_commercial_policy_version_id
    AND attestation_basis = 'owner_statement'
    AND jurisdiction_country = 'AU'
    AND currency = 'AUD'
    AND gst_registration_threshold_minor = 7500000
    AND gst_registered = false
    AND current_turnover_below_threshold = true
    AND projected_turnover_below_threshold = true
    AND projection_months = 12
    AND attested_at <= now()
    AND review_due_at > now()
$$;

REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.seller_tax_attestations FROM sophia_runtime_app;
REVOKE ALL ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.latest_current_seller_tax_attestation(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.latest_current_seller_tax_attestation(uuid,uuid)
  TO sophia_runtime_app;

COMMENT ON TABLE __SOPHIA_RUNTIME_SCHEMA__.seller_tax_attestations IS
  'Append-only owner tax-status evidence. The raw statement is not retained; only its digest and structured claims are stored.';
