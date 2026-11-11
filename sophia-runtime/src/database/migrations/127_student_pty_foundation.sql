-- Additive PTY foundation. Does not assign organisations or create financial records.
CREATE UNIQUE INDEX student_operations_one_operating_xero_org
 ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_sync_configurations(customer_id)
 WHERE organisation_role='operating' AND enabled;
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_college_xero_contact_links (
  customer_id uuid NOT NULL,
  xero_connection_id uuid NOT NULL,
  xero_contact_id uuid NOT NULL,
  college_id uuid,
  classification text NOT NULL CHECK(classification IN ('college','other','unresolved')),
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  reviewed_by text NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(customer_id,xero_connection_id,xero_contact_id),
  FOREIGN KEY(customer_id,xero_connection_id,xero_contact_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_contacts(customer_id,xero_connection_id,xero_contact_id),
  CHECK((classification='college')=(college_id IS NOT NULL))
);

CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_college_xero_mapping_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  xero_connection_id uuid NOT NULL,
  xero_contact_id uuid NOT NULL,
  actor_identity text NOT NULL,
  previous_value jsonb,
  confirmed_value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(customer_id,xero_connection_id,xero_contact_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_college_xero_contact_links(customer_id,xero_connection_id,xero_contact_id)
);

-- The view owner reads Business Manager; Runtime receives only tenant-filtered fields.
CREATE VIEW __SOPHIA_RUNTIME_SCHEMA__.student_college_commission_rules
  WITH (security_barrier=true) AS
SELECT c.customer_id,r.rule_id,r.college_id,r.classification,r.location,r.program,
       r.commission_basis_points,r.calculation_method,r.rounding_decimal_places,
       r.cashback_status,r.bonus_status,r.application_conditions,r.active,r.createdat,r.updatedat
  FROM __SOPHIA_RUNTIME_SCHEMA__.customers c
  JOIN public.bm_college_commission_rules r ON r.company_id::text=c.external_company_id
 WHERE c.status='active'
   AND c.customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid;
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.student_college_commission_rules FROM PUBLIC;
GRANT SELECT ON __SOPHIA_RUNTIME_SCHEMA__.student_college_commission_rules TO sophia_runtime_app;

-- Mapping integrity includes the authoritative company directory, not merely a UUID.
CREATE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.validate_college_xero_mapping() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_sync_configurations
    WHERE customer_id=NEW.customer_id AND xero_connection_id=NEW.xero_connection_id AND organisation_role='operating') THEN
    RAISE EXCEPTION 'College mapping requires an operating organisation';
  END IF;
  IF NEW.college_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_college_directory
    WHERE customer_id=NEW.customer_id AND college_id=NEW.college_id) THEN
    RAISE EXCEPTION 'College is not available in this workspace';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validate_college_xero_mapping BEFORE INSERT OR UPDATE
 ON __SOPHIA_RUNTIME_SCHEMA__.student_college_xero_contact_links
 FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.validate_college_xero_mapping();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['student_college_xero_contact_links','student_college_xero_mapping_events'] LOOP
    EXECUTE format('ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.%I USING(customer_id=NULLIF(current_setting(''sophia.tenant_id'',true),'''')::uuid) WITH CHECK(customer_id=NULLIF(current_setting(''sophia.tenant_id'',true),'''')::uuid)',t);
    EXECUTE format('REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.%I FROM PUBLIC,sophia_runtime_app',t);
    EXECUTE format('GRANT SELECT,INSERT ON __SOPHIA_RUNTIME_SCHEMA__.%I TO sophia_runtime_app',t);
  END LOOP;
END $$;
GRANT UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.student_college_xero_contact_links TO sophia_runtime_app;
CREATE INDEX student_college_xero_mapping_college ON __SOPHIA_RUNTIME_SCHEMA__.student_college_xero_contact_links(customer_id,college_id,xero_connection_id);

-- Retain the worker's leases, maintenance window and rate-budget behaviour.
-- Change only the explicit role predicate in this known owner-defined function.
DO $$ DECLARE definition text; BEGIN
  SELECT pg_get_functiondef('__SOPHIA_RUNTIME_SCHEMA__.claim_due_student_operations_xero_worker_runs(integer)'::regprocedure) INTO definition;
  IF position('c.organisation_role=''trust''' in definition)=0 THEN
    RAISE EXCEPTION 'Unexpected Xero worker definition; review PTY migration';
  END IF;
  EXECUTE replace(definition,'c.organisation_role=''trust''','c.organisation_role IN (''trust'',''operating'')');
END $$;
