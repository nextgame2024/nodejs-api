-- Shared cooldown/observations, NOT an inferred daily quota or an app-wide
-- reservation ledger. Accounting requests consult this across API/worker hosts.
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.xero_connection_rate_limits (
  customer_id uuid NOT NULL,
  xero_connection_id uuid NOT NULL,
  day_remaining bigint CHECK(day_remaining>=0),
  minute_remaining bigint CHECK(minute_remaining>=0),
  app_minute_remaining bigint CHECK(app_minute_remaining>=0),
  limit_problem text CHECK(limit_problem IN ('day','minute','app','concurrent')),
  blocked_until timestamptz,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(customer_id,xero_connection_id),
  FOREIGN KEY(customer_id,xero_connection_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.xero_connections(customer_id,xero_connection_id)
);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.xero_connection_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.xero_connection_rate_limits FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.xero_connection_rate_limits
  USING(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid)
  WITH CHECK(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.xero_connection_rate_limits TO sophia_runtime_app;
