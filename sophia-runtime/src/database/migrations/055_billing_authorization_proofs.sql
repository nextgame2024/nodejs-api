CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.billing_authorization_proofs (
  proof_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE RESTRICT,
  identity_user_id text NOT NULL,
  permission_key text NOT NULL CHECK (permission_key = 'billing.manage'),
  mfa_verified_at timestamptz NOT NULL,
  proved_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK (mfa_verified_at <= proved_at + interval '30 seconds'),
  CHECK (expires_at = proved_at + interval '12 hours')
);

CREATE INDEX IF NOT EXISTS idx_billing_authorization_proofs_expiry
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_authorization_proofs(expires_at DESC);

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_billing_authorization_proof()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Billing authorization proof evidence is append-only';
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_billing_authorization_proof
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_authorization_proofs;
CREATE TRIGGER trg_protect_billing_authorization_proof
  BEFORE UPDATE OR DELETE ON __SOPHIA_RUNTIME_SCHEMA__.billing_authorization_proofs
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_billing_authorization_proof();

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.record_billing_authorization_proof(
  requested_customer_id uuid,
  requested_identity_user_id text,
  requested_mfa_verified_at timestamptz
) RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = pg_catalog, __SOPHIA_RUNTIME_SCHEMA__
AS $$
DECLARE
  tenant_id uuid := NULLIF(current_setting('sophia.tenant_id', true), '')::uuid;
  recorded_at timestamptz;
BEGIN
  IF tenant_id IS NULL OR tenant_id <> requested_customer_id THEN
    RAISE EXCEPTION 'Billing authorization proof requires exact tenant context';
  END IF;
  IF requested_identity_user_id IS NULL OR length(requested_identity_user_id) = 0 THEN
    RAISE EXCEPTION 'Billing authorization proof requires an identity';
  END IF;
  IF requested_mfa_verified_at > now() + interval '30 seconds'
    OR requested_mfa_verified_at < now() - interval '12 hours' THEN
    RAISE EXCEPTION 'Billing authorization proof requires current MFA evidence';
  END IF;

  INSERT INTO billing_authorization_proofs
    (customer_id,identity_user_id,permission_key,mfa_verified_at,proved_at,expires_at)
  VALUES
    (requested_customer_id,requested_identity_user_id,'billing.manage',requested_mfa_verified_at,
     now(),now()+interval '12 hours')
  RETURNING proved_at INTO recorded_at;
  RETURN recorded_at;
END;
$$;

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.latest_billing_authorization_proof()
RETURNS timestamptz
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, __SOPHIA_RUNTIME_SCHEMA__
AS $$
  SELECT max(proved_at)
  FROM billing_authorization_proofs
  WHERE permission_key='billing.manage' AND expires_at>=now()
$$;

REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.billing_authorization_proofs FROM sophia_runtime_app;
REVOKE ALL ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.record_billing_authorization_proof(uuid,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.latest_billing_authorization_proof() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.record_billing_authorization_proof(uuid,text,timestamptz)
  TO sophia_runtime_app;
GRANT EXECUTE ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.latest_billing_authorization_proof()
  TO sophia_runtime_app;

COMMENT ON TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_authorization_proofs IS
  'Append-only, non-billing evidence that recent MFA passed the billing.manage guard; inaccessible directly to the runtime role.';
