-- Global defaults and tenant-owned bindings are separate: labels may change,
-- while a workflow continues to reference the same document type UUID.
CREATE INDEX student_case_document_type_coverage ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_documents
  (customer_id,case_id,document_type_id) WHERE document_type_id IS NOT NULL;
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_requirement_defaults (
  case_status text NOT NULL CHECK(case_status IN ('pre_sale','on_hold','in_progress','payment_overdue','collections','payment_done','closed','cancelled')),
  requirement_key text NOT NULL,
  name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  PRIMARY KEY(case_status,requirement_key)
);
INSERT INTO __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_requirement_defaults VALUES
  ('pre_sale','engagement_letter','Engagement letter',1),
  ('pre_sale','letter_of_offer','Letter of Offer',2),
  ('pre_sale','passport','Passport',3);
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_requirement_defaults FROM PUBLIC,sophia_runtime_app;
GRANT SELECT ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_requirement_defaults TO sophia_runtime_app;

CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_status_document_requirements (
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id),
  case_status text NOT NULL CHECK(case_status IN ('pre_sale','on_hold','in_progress','payment_overdue','collections','payment_done','closed','cancelled')),
  requirement_key text NOT NULL CHECK(length(requirement_key) BETWEEN 1 AND 120),
  document_type_id uuid NOT NULL,
  required boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(customer_id,case_status,requirement_key),
  UNIQUE(customer_id,case_status,document_type_id),
  FOREIGN KEY(customer_id,document_type_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_types(customer_id,document_type_id)
);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_status_document_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_status_document_requirements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_status_document_requirements
  USING(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid)
  WITH CHECK(customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid);
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_status_document_requirements FROM PUBLIC,sophia_runtime_app;
GRANT SELECT,INSERT,UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_status_document_requirements TO sophia_runtime_app;

-- Invoker rights only. Called on case creation, never from normal read requests.
CREATE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.initialize_student_document_requirements(company uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant uuid:=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid;
        template record; type_id uuid; inserted_id uuid;
BEGIN
  -- The authenticated principal supplies company; document_types' composite FK
  -- verifies its tenant binding without granting general customer-table access.
  IF company IS NULL OR tenant IS NULL THEN RAISE EXCEPTION 'Company scope required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('student-document-requirements:'||tenant::text,0));
  FOR template IN SELECT * FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_requirement_defaults LOOP
    -- An archived mapping is a deliberate configuration choice; never revive it.
    IF EXISTS(SELECT 1 FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_status_document_requirements
      WHERE customer_id=tenant AND case_status=template.case_status AND requirement_key=template.requirement_key) THEN CONTINUE; END IF;
    inserted_id:=NULL;
    INSERT INTO __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_types(customer_id,company_id,name,required)
      VALUES(tenant,company,template.name,true) ON CONFLICT DO NOTHING RETURNING document_type_id INTO inserted_id;
    IF inserted_id IS NOT NULL THEN
      INSERT INTO __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_type_events(customer_id,document_type_id,actor_identity_user_id,event_type)
        VALUES(tenant,inserted_id,'system:document-requirements','created');
    END IF;
    SELECT document_type_id INTO type_id FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_types
      WHERE customer_id=tenant AND status='active'
        AND lower(regexp_replace(btrim(name),'[[:space:]]+',' ','g'))=lower(template.name);
    IF type_id IS NULL THEN RAISE EXCEPTION 'Document type company scope mismatch' USING ERRCODE='42501'; END IF;
    INSERT INTO __SOPHIA_RUNTIME_SCHEMA__.student_operations_status_document_requirements(customer_id,case_status,requirement_key,document_type_id,sort_order)
      VALUES(tenant,template.case_status,template.requirement_key,type_id,template.sort_order) ON CONFLICT DO NOTHING;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.initialize_student_document_requirements(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.initialize_student_document_requirements(uuid) TO sophia_runtime_app;

-- Reuse case-insensitive active types; do not relabel historical attachments.
DO $$ DECLARE tenant record; previous_scope text:=current_setting('sophia.tenant_id',true); BEGIN
  FOR tenant IN SELECT c.customer_id,b.company_id FROM __SOPHIA_RUNTIME_SCHEMA__.customers c
    JOIN public.bm_company b ON b.company_id::text=c.external_company_id
    WHERE c.status='active' AND b.workspace_profile='student_operations' LOOP
    PERFORM set_config('sophia.tenant_id',tenant.customer_id::text,true);
    PERFORM __SOPHIA_RUNTIME_SCHEMA__.initialize_student_document_requirements(tenant.company_id);
  END LOOP;
  PERFORM set_config('sophia.tenant_id',coalesce(previous_scope,''),true);
END $$;
