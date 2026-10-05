CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.business_pack_entitlements (
  entitlement_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  identity_user_id text NOT NULL,
  pack_id text NOT NULL CHECK (pack_id ~ '^[a-z][a-z0-9-]{1,79}$'),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'revoked')),
  authorization_revision integer NOT NULL DEFAULT 1
    CHECK (authorization_revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, identity_user_id, pack_id)
);

CREATE INDEX IF NOT EXISTS idx_business_pack_entitlements_identity
  ON __SOPHIA_RUNTIME_SCHEMA__.business_pack_entitlements(identity_user_id, pack_id, status);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.business_pack_access_audit_events (
  audit_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE RESTRICT,
  identity_user_id text NOT NULL,
  pack_id text NOT NULL,
  event_type text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('allowed', 'denied', 'failed')),
  correlation_id text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_business_pack_access_audit_tenant_created
  ON __SOPHIA_RUNTIME_SCHEMA__.business_pack_access_audit_events(customer_id, created_at DESC);

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_business_pack_access_audit_event()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Business-pack access audit events are append-only';
END;
$$;

DROP TRIGGER IF EXISTS protect_business_pack_access_audit_event
  ON __SOPHIA_RUNTIME_SCHEMA__.business_pack_access_audit_events;
CREATE TRIGGER protect_business_pack_access_audit_event BEFORE UPDATE OR DELETE
  ON __SOPHIA_RUNTIME_SCHEMA__.business_pack_access_audit_events
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_business_pack_access_audit_event();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'business_pack_entitlements', 'business_pack_access_audit_events'
  ] LOOP
    EXECUTE format('ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON __SOPHIA_RUNTIME_SCHEMA__.%I',
      table_name || '_tenant_isolation', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON __SOPHIA_RUNTIME_SCHEMA__.%I USING (customer_id = NULLIF(current_setting(''sophia.tenant_id'', true), '''')::uuid) WITH CHECK (customer_id = NULLIF(current_setting(''sophia.tenant_id'', true), '''')::uuid)',
      table_name || '_tenant_isolation', table_name
    );
  END LOOP;
END;
$$;

GRANT SELECT ON __SOPHIA_RUNTIME_SCHEMA__.business_pack_entitlements
  TO sophia_runtime_app;
GRANT SELECT, INSERT ON __SOPHIA_RUNTIME_SCHEMA__.business_pack_access_audit_events
  TO sophia_runtime_app;
