-- Conservative, connection-scoped HTTP admission. Defaults match the confirmed
-- Starter deployment. Only the owner may change configured allowance/headroom.
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.xero_quota_admission (
  customer_id uuid NOT NULL,
  xero_connection_id uuid NOT NULL,
  daily_limit integer NOT NULL DEFAULT 1000 CHECK(daily_limit BETWEEN 1 AND 5000),
  discovery_reserve integer NOT NULL DEFAULT 200 CHECK(discovery_reserve>=0 AND discovery_reserve<daily_limit),
  remaining integer CHECK(remaining>=0 AND remaining<=daily_limit),
  refresh_after timestamptz NOT NULL DEFAULT now(),
  provider_reset_at timestamptz,
  generation bigint NOT NULL DEFAULT 0,
  reservation_sequence bigint NOT NULL DEFAULT 0,
  generation_admissions integer NOT NULL DEFAULT 0 CHECK(generation_admissions BETWEEN 0 AND daily_limit),
  operational_admissions bigint NOT NULL DEFAULT 0 CHECK(operational_admissions>=0),
  discovery_admissions bigint NOT NULL DEFAULT 0 CHECK(discovery_admissions>=0),
  probe_until timestamptz,
  probe_sequence bigint,
  observed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(customer_id,xero_connection_id),
  FOREIGN KEY(customer_id,xero_connection_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.xero_connections(customer_id,xero_connection_id)
);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.xero_quota_admission ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.xero_quota_admission FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.xero_quota_admission
  USING(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid)
  WITH CHECK(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid);
GRANT SELECT ON __SOPHIA_RUNTIME_SCHEMA__.xero_quota_admission TO sophia_runtime_app;
GRANT INSERT(customer_id,xero_connection_id) ON __SOPHIA_RUNTIME_SCHEMA__.xero_quota_admission TO sophia_runtime_app;
GRANT UPDATE(remaining,refresh_after,provider_reset_at,generation,reservation_sequence,generation_admissions,
  operational_admissions,discovery_admissions,probe_until,probe_sequence,observed_at,updated_at)
  ON __SOPHIA_RUNTIME_SCHEMA__.xero_quota_admission TO sophia_runtime_app;
