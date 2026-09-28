ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_meter_event_outbox
  ADD CONSTRAINT billing_meter_event_outbox_tenant_identity_key
  UNIQUE (billing_meter_event_outbox_id, customer_id);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.billing_meter_event_reconciliations (
  billing_meter_event_reconciliation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE RESTRICT,
  billing_meter_event_outbox_id uuid NOT NULL,
  billing_usage_period_ledger_id uuid NOT NULL,
  provider_key text NOT NULL CHECK (provider_key ~ '^[a-z][a-z0-9-]{1,79}$'),
  provider_environment text NOT NULL CHECK (provider_environment IN ('sandbox', 'live')),
  provider_account_key text NOT NULL CHECK (provider_account_key ~ '^[a-z][a-z0-9-]{1,79}$'),
  provider_event_ref text NOT NULL CHECK (length(provider_event_ref) BETWEEN 1 AND 240),
  meter_ref text NOT NULL CHECK (length(meter_ref) BETWEEN 1 AND 240),
  meter_summary_ref text NOT NULL CHECK (length(meter_summary_ref) BETWEEN 1 AND 240),
  meter_summary_start timestamptz NOT NULL,
  meter_summary_end timestamptz NOT NULL,
  meter_summary_quantity bigint NOT NULL CHECK (meter_summary_quantity > 0),
  external_invoice_ref text NOT NULL CHECK (length(external_invoice_ref) BETWEEN 1 AND 240),
  external_invoice_line_ref text NOT NULL CHECK (length(external_invoice_line_ref) BETWEEN 1 AND 240),
  metered_price_ref text NOT NULL CHECK (length(metered_price_ref) BETWEEN 1 AND 240),
  invoice_line_quantity bigint NOT NULL CHECK (invoice_line_quantity > 0),
  invoice_line_amount_minor bigint NOT NULL CHECK (invoice_line_amount_minor >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  observed_at timestamptz NOT NULL,
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (billing_meter_event_outbox_id),
  UNIQUE (provider_key, provider_environment, provider_account_key, meter_summary_ref,
    external_invoice_ref, external_invoice_line_ref),
  FOREIGN KEY (billing_meter_event_outbox_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.billing_meter_event_outbox(
      billing_meter_event_outbox_id, customer_id) ON DELETE RESTRICT,
  FOREIGN KEY (billing_usage_period_ledger_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.billing_usage_period_ledgers(
      billing_usage_period_ledger_id, customer_id) ON DELETE RESTRICT,
  CHECK (meter_summary_end > meter_summary_start),
  CHECK (meter_summary_quantity = invoice_line_quantity)
);

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.reject_billing_meter_reconciliation_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Billing Meter reconciliation evidence is immutable';
END;
$$;

DROP TRIGGER IF EXISTS trg_immutable_billing_meter_event_reconciliation
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_meter_event_reconciliations;
CREATE TRIGGER trg_immutable_billing_meter_event_reconciliation
  BEFORE UPDATE OR DELETE ON __SOPHIA_RUNTIME_SCHEMA__.billing_meter_event_reconciliations
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.reject_billing_meter_reconciliation_change();

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_meter_event_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_meter_event_reconciliations FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_meter_event_reconciliations_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_meter_event_reconciliations
  USING (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid)
  WITH CHECK (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid);

REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.billing_meter_event_reconciliations FROM PUBLIC, sophia_runtime_app;
GRANT SELECT, INSERT ON __SOPHIA_RUNTIME_SCHEMA__.billing_meter_event_reconciliations TO sophia_runtime_app;

COMMENT ON TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_meter_event_reconciliations IS
  'Immutable proof that an exact provider-period Meter summary and finalized invoice line match one Sophia usage ledger.';
