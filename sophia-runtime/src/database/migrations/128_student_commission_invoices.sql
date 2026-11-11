-- Calculation snapshots and permanent TRUST -> PTY relationships. No provider writes.
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_invoices ADD COLUMN settlement jsonb;
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_commission_drafts (
 customer_id uuid NOT NULL, case_id uuid NOT NULL, batch_id uuid NOT NULL,
 sequence integer NOT NULL CHECK(sequence>0), revision integer NOT NULL DEFAULT 1,
 source_hash text NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),
 snapshot jsonb NOT NULL, prepared_by text NOT NULL, prepared_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(customer_id,batch_id,sequence),
 FOREIGN KEY(customer_id,batch_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_case_invoice_draft_batches(customer_id,batch_id)
);
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_commission_exports (
 customer_id uuid NOT NULL,case_id uuid NOT NULL,batch_id uuid NOT NULL,sequence integer NOT NULL,
 trust_connection_id uuid NOT NULL,trust_invoice_id uuid NOT NULL,
 xero_connection_id uuid NOT NULL,xero_contact_id uuid NOT NULL,
 provider_key text NOT NULL CHECK(provider_key ~ '^[a-f0-9]{64}$'),
 status text NOT NULL CHECK(status IN ('not_attempted','creating','created','review_required')),
 xero_invoice_id uuid,xero_invoice_number text,provider_status text,
 requested_by text NOT NULL,requested_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,
 PRIMARY KEY(customer_id,batch_id,sequence),
 UNIQUE(customer_id,trust_connection_id,trust_invoice_id,xero_connection_id),
 UNIQUE(customer_id,xero_connection_id,xero_invoice_id),UNIQUE(customer_id,provider_key),
 FOREIGN KEY(customer_id,batch_id,sequence) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_commission_drafts(customer_id,batch_id,sequence),
 FOREIGN KEY(customer_id,batch_id,sequence) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_case_xero_invoice_exports(customer_id,batch_id,sequence),
 FOREIGN KEY(customer_id,xero_connection_id,xero_contact_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_contacts(customer_id,xero_connection_id,xero_contact_id),
 CHECK((status='created')=(xero_invoice_id IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.validate_commission_export() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.status='created' AND
   (NEW.status,NEW.xero_invoice_id,NEW.xero_invoice_number,NEW.completed_at) IS DISTINCT FROM
   (OLD.status,OLD.xero_invoice_id,OLD.xero_invoice_number,OLD.completed_at) THEN
  RAISE EXCEPTION 'A confirmed commission receipt is immutable';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM __SOPHIA_RUNTIME_SCHEMA__.student_case_xero_invoice_exports t
   WHERE t.customer_id=NEW.customer_id AND t.batch_id=NEW.batch_id AND t.sequence=NEW.sequence
    AND t.case_id=NEW.case_id AND t.status='created' AND t.xero_connection_id=NEW.trust_connection_id AND t.xero_invoice_id=NEW.trust_invoice_id) THEN
  RAISE EXCEPTION 'A confirmed matching TRUST invoice is required';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_sync_configurations c
   WHERE c.customer_id=NEW.customer_id AND c.xero_connection_id=NEW.xero_connection_id AND c.organisation_role='operating') THEN
  RAISE EXCEPTION 'An operating organisation is required';
 END IF;
 IF TG_OP='UPDATE' AND OLD.status<>'not_attempted' AND (OLD.trust_connection_id,OLD.trust_invoice_id,OLD.xero_connection_id,OLD.xero_contact_id,OLD.case_id,OLD.batch_id,OLD.sequence)
   IS DISTINCT FROM (NEW.trust_connection_id,NEW.trust_invoice_id,NEW.xero_connection_id,NEW.xero_contact_id,NEW.case_id,NEW.batch_id,NEW.sequence) THEN
  RAISE EXCEPTION 'Invoice relationships are immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER validate_commission_export BEFORE INSERT OR UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.student_commission_exports
 FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.validate_commission_export();
CREATE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_commission_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (OLD.snapshot,OLD.source_hash) IS DISTINCT FROM (NEW.snapshot,NEW.source_hash) AND EXISTS(
  SELECT 1 FROM __SOPHIA_RUNTIME_SCHEMA__.student_commission_exports e WHERE e.customer_id=OLD.customer_id AND e.batch_id=OLD.batch_id AND e.sequence=OLD.sequence AND e.status<>'not_attempted') THEN
  RAISE EXCEPTION 'Commission calculation is immutable after export starts';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_commission_snapshot BEFORE UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.student_commission_drafts
 FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_commission_snapshot();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['student_commission_drafts','student_commission_exports'] LOOP
  EXECUTE format('ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.%I USING(customer_id=NULLIF(current_setting(''sophia.tenant_id'',true),'''')::uuid) WITH CHECK(customer_id=NULLIF(current_setting(''sophia.tenant_id'',true),'''')::uuid)',t);
  EXECUTE format('REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.%I FROM PUBLIC,sophia_runtime_app',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.%I TO sophia_runtime_app',t);
 END LOOP;
END $$;
CREATE INDEX student_commission_exports_case ON __SOPHIA_RUNTIME_SCHEMA__.student_commission_exports(customer_id,case_id,requested_at DESC);
