CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_commission_reviews (
 customer_id uuid NOT NULL,case_id uuid NOT NULL,obligation_id uuid NOT NULL, revision integer NOT NULL CHECK(revision>0),
 decision text NOT NULL CHECK(decision IN ('eligible','uncertain','ineligible')),policy text NOT NULL,earned_on date,
 snapshot jsonb,actor text NOT NULL,recorded_at timestamptz NOT NULL DEFAULT now(),request_id uuid NOT NULL, fingerprint text NOT NULL,
 PRIMARY KEY(customer_id,case_id,obligation_id,revision),UNIQUE(customer_id,request_id),
 FOREIGN KEY(customer_id,case_id,obligation_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_college_obligations,
 CHECK((decision='eligible')=(snapshot IS NOT NULL) AND (decision='eligible')=(earned_on IS NOT NULL))
);
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_commission_claim_invoices (
 customer_id uuid NOT NULL,case_id uuid NOT NULL,obligation_id uuid NOT NULL,revision integer NOT NULL,
 batch_id uuid NOT NULL,sequence integer NOT NULL,connection_id uuid NOT NULL,contact_id uuid NOT NULL,
 origin text NOT NULL CHECK(origin IN ('paired','historical','direct')),status text NOT NULL CHECK(status IN ('submitted','linked')),
 invoice_id uuid,provider_key text NOT NULL,actor text NOT NULL,recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(customer_id,case_id,obligation_id), UNIQUE(customer_id,batch_id,sequence), UNIQUE(customer_id,connection_id,invoice_id),
 FOREIGN KEY(customer_id,case_id,obligation_id,revision) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_commission_reviews,
 FOREIGN KEY(customer_id,batch_id,sequence) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_commission_drafts,
 CHECK((status='linked')=(invoice_id IS NOT NULL) AND (status='linked' OR origin='direct'))
);
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_commission_collections (
 customer_id uuid NOT NULL,case_id uuid NOT NULL,obligation_id uuid NOT NULL,revision integer NOT NULL,
 request_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN ('cash','offset')),source_id uuid NOT NULL,
 amount_minor integer NOT NULL CHECK(amount_minor>0),evidence jsonb NOT NULL,actor text NOT NULL,recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(customer_id,request_id), FOREIGN KEY(customer_id,case_id,obligation_id,revision) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_commission_reviews
);
CREATE INDEX commission_collections_source ON __SOPHIA_RUNTIME_SCHEMA__.student_commission_collections(customer_id,case_id,obligation_id,kind,source_id);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['student_commission_reviews','student_commission_claim_invoices','student_commission_collections'] LOOP
 EXECUTE format('ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON __SOPHIA_RUNTIME_SCHEMA__.%I USING(customer_id=nullif(current_setting(''sophia.tenant_id'',true),'''')::uuid) WITH CHECK(customer_id=nullif(current_setting(''sophia.tenant_id'',true),'''')::uuid)',t);
 EXECUTE format('REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.%I FROM PUBLIC,sophia_runtime_app',t);
 EXECUTE format('GRANT SELECT,INSERT ON __SOPHIA_RUNTIME_SCHEMA__.%I TO sophia_runtime_app',t);
 END LOOP;
END $$;
GRANT UPDATE(status,invoice_id) ON __SOPHIA_RUNTIME_SCHEMA__.student_commission_claim_invoices TO sophia_runtime_app;
-- Both entry points lock the case before reserving the instalment.
CREATE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.check_commission_export_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM __SOPHIA_RUNTIME_SCHEMA__.student_commission_claim_invoices c
   WHERE c.customer_id=NEW.customer_id AND c.batch_id=NEW.batch_id AND c.sequence=NEW.sequence AND c.origin<>'paired') THEN
   RAISE EXCEPTION 'An independently reviewed commission already reserves this instalment';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER commission_export_origin BEFORE INSERT OR UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.student_commission_exports
 FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.check_commission_export_origin();
CREATE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.validate_claim_invoice_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND (OLD.status<>'submitted' OR NEW.status<>'linked') THEN
   RAISE EXCEPTION 'Confirmed commission invoice links cannot be changed';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM __SOPHIA_RUNTIME_SCHEMA__.student_commission_reviews v
   JOIN __SOPHIA_RUNTIME_SCHEMA__.student_college_obligations o USING(customer_id,case_id,obligation_id)
   JOIN __SOPHIA_RUNTIME_SCHEMA__.student_case_invoice_draft_batches b USING(customer_id,case_id,offer_id)
   JOIN __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_sync_configurations cfg ON cfg.customer_id=b.customer_id AND cfg.xero_connection_id=NEW.connection_id
   WHERE (v.customer_id,v.case_id,v.obligation_id,v.revision)=(NEW.customer_id,NEW.case_id,NEW.obligation_id,NEW.revision)
   AND v.decision='eligible' AND b.batch_id=NEW.batch_id AND o.offer_sequence=NEW.sequence AND cfg.organisation_role='operating'
   AND v.snapshot->'snapshot'->>'connectionId'=NEW.connection_id::text AND v.snapshot->'snapshot'->>'contactId'=NEW.contact_id::text) THEN
   RAISE EXCEPTION 'Approved matching PTY instalment required';
 END IF;
 IF NEW.origin='direct' AND NOT EXISTS(SELECT 1 FROM __SOPHIA_RUNTIME_SCHEMA__.student_college_settlement_events e
   WHERE (e.customer_id,e.case_id,e.obligation_id)=(NEW.customer_id,NEW.case_id,NEW.obligation_id) AND e.kind='direct_confirmation') THEN
   RAISE EXCEPTION 'Direct creation requires a confirmed college payment';
 END IF;
 IF NEW.origin='paired' AND NOT EXISTS(SELECT 1 FROM __SOPHIA_RUNTIME_SCHEMA__.student_commission_exports e
   WHERE (e.customer_id,e.case_id,e.batch_id,e.sequence,e.xero_connection_id,e.xero_invoice_id)=(NEW.customer_id,NEW.case_id,NEW.batch_id,NEW.sequence,NEW.connection_id,NEW.invoice_id)
   AND e.status='created') THEN RAISE EXCEPTION 'Matching completed PTY export required'; END IF;
 IF NEW.origin<>'paired' AND EXISTS(SELECT 1 FROM __SOPHIA_RUNTIME_SCHEMA__.student_commission_exports e
   WHERE e.customer_id=NEW.customer_id AND (e.batch_id=NEW.batch_id AND e.sequence=NEW.sequence OR
    e.xero_connection_id=NEW.connection_id AND e.xero_invoice_id=NEW.invoice_id)) THEN RAISE EXCEPTION 'Instalment already has a paired export'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER check_claim_invoice_origin BEFORE INSERT OR UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.student_commission_claim_invoices
 FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.validate_claim_invoice_origin();
