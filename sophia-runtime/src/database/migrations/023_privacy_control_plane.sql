CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.privacy_notice_versions (
  privacy_notice_version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  notice_key text NOT NULL CHECK (notice_key ~ '^[a-z0-9][a-z0-9.-]{0,119}$'),
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'retired')),
  purpose_manifest jsonb NOT NULL CHECK (jsonb_typeof(purpose_manifest) = 'object'),
  content_digest text NOT NULL CHECK (content_digest ~ '^[a-f0-9]{64}$'),
  counsel_reference text,
  created_by_identity text NOT NULL,
  approved_by_identity text,
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  UNIQUE (customer_id, notice_key, version),
  UNIQUE (privacy_notice_version_id, customer_id),
  CHECK ((status = 'draft' AND approved_by_identity IS NULL AND approved_at IS NULL)
    OR (status IN ('approved', 'retired') AND approved_by_identity IS NOT NULL AND approved_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.privacy_consent_events (
  privacy_consent_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  session_id uuid,
  privacy_notice_version_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('recording', 'marketing')),
  decision text NOT NULL CHECK (decision IN ('granted', 'denied', 'withdrawn')),
  source text NOT NULL CHECK (source IN ('explicit_user', 'verified_operator')),
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  recorded_by_identity text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (session_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.sessions(session_id, customer_id) ON DELETE SET NULL (session_id),
  FOREIGN KEY (privacy_notice_version_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.privacy_notice_versions(privacy_notice_version_id, customer_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.session_privacy_controls (
  session_id uuid PRIMARY KEY,
  customer_id uuid NOT NULL,
  raw_audio_recording_enabled boolean NOT NULL DEFAULT false,
  full_transcript_persistence_enabled boolean NOT NULL DEFAULT false,
  marketing_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (session_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.sessions(session_id, customer_id) ON DELETE CASCADE,
  CHECK (raw_audio_recording_enabled = false),
  CHECK (full_transcript_persistence_enabled = false),
  CHECK (marketing_enabled = false)
);

INSERT INTO __SOPHIA_RUNTIME_SCHEMA__.session_privacy_controls (session_id, customer_id)
SELECT session_id, customer_id FROM __SOPHIA_RUNTIME_SCHEMA__.sessions
ON CONFLICT (session_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.privacy_retention_policies (
  privacy_retention_policy_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  dataset_key text NOT NULL CHECK (dataset_key IN (
    'session_content', 'review_payloads', 'generated_personal_documents',
    'provider_data', 'backups', 'audit_evidence'
  )),
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'retired')),
  retention_days integer NOT NULL CHECK (retention_days > 0),
  disposal_method text NOT NULL CHECK (disposal_method IN ('delete', 'deidentify', 'provider_request', 'backup_expiry')),
  policy_reference text NOT NULL,
  created_by_identity text NOT NULL,
  approved_by_identity text,
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  UNIQUE (customer_id, dataset_key, version),
  UNIQUE (privacy_retention_policy_id, customer_id),
  CHECK ((status = 'draft' AND approved_by_identity IS NULL AND approved_at IS NULL)
    OR (status IN ('approved', 'retired') AND approved_by_identity IS NOT NULL AND approved_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.privacy_legal_holds (
  privacy_legal_hold_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  subject_reference_digest text NOT NULL CHECK (subject_reference_digest ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
  reason_reference text NOT NULL,
  created_by_identity text NOT NULL,
  released_by_identity text,
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  CHECK ((status = 'active' AND released_by_identity IS NULL AND released_at IS NULL)
    OR (status = 'released' AND released_by_identity IS NOT NULL AND released_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.privacy_subject_requests (
  privacy_subject_request_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  request_type text NOT NULL CHECK (request_type IN ('access', 'deletion')),
  subject_reference_digest text NOT NULL CHECK (subject_reference_digest ~ '^[a-f0-9]{64}$'),
  selectors jsonb NOT NULL CHECK (jsonb_typeof(selectors) = 'object'),
  verification_status text NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending', 'verified', 'rejected')),
  verification_method text,
  verification_evidence_reference text,
  status text NOT NULL DEFAULT 'pending_verification'
    CHECK (status IN ('pending_verification', 'ready', 'processing', 'blocked', 'completed', 'rejected')),
  requested_by_identity text NOT NULL,
  verified_by_identity text,
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  completed_at timestamptz,
  outcome_digest text,
  UNIQUE (privacy_subject_request_id, customer_id),
  CHECK (outcome_digest IS NULL OR outcome_digest ~ '^[a-f0-9]{64}$')
);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.privacy_subject_request_targets (
  privacy_subject_request_target_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  privacy_subject_request_id uuid NOT NULL,
  target_key text NOT NULL CHECK (target_key IN (
    'runtime_session_content', 'runtime_review_payloads', 'runtime_operational_metadata',
    'business_manager_documents', 'provider_owned_data', 'backups'
  )),
  ownership text NOT NULL CHECK (ownership IN ('runtime_controlled', 'external_owner')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'blocked', 'not_applicable')),
  evidence_reference text,
  evidence_digest text,
  detail text,
  updated_by_identity text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (privacy_subject_request_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.privacy_subject_requests(privacy_subject_request_id, customer_id) ON DELETE CASCADE,
  UNIQUE (privacy_subject_request_id, target_key),
  CHECK (evidence_digest IS NULL OR evidence_digest ~ '^[a-f0-9]{64}$')
);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.privacy_data_flows (
  privacy_data_flow_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  flow_key text NOT NULL CHECK (flow_key ~ '^[a-z0-9][a-z0-9.-]{0,119}$'),
  owner_key text NOT NULL,
  capability text NOT NULL,
  data_categories jsonb NOT NULL CHECK (jsonb_typeof(data_categories) = 'array'),
  processing_jurisdictions jsonb NOT NULL CHECK (jsonb_typeof(processing_jurisdictions) = 'array'),
  storage_jurisdictions jsonb NOT NULL CHECK (jsonb_typeof(storage_jurisdictions) = 'array'),
  retention_control text NOT NULL CHECK (retention_control IN ('unverified', 'provider_configured', 'contractual', 'zero_data_retention')),
  deletion_control text NOT NULL CHECK (deletion_control IN ('unverified', 'manual', 'api_verified', 'not_stored')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'blocked')),
  failover_eligible boolean NOT NULL DEFAULT false,
  assessment_reference text,
  created_by_identity text NOT NULL,
  approved_by_identity text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  UNIQUE (customer_id, flow_key),
  CHECK (failover_eligible = false OR status = 'approved'),
  CHECK (status <> 'approved' OR (assessment_reference IS NOT NULL AND approved_by_identity IS NOT NULL AND approved_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.privacy_legal_reviews (
  privacy_legal_review_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  control_key text NOT NULL CHECK (control_key IN (
    'privacy_act_applicability', 'privacy_notice', 'recording_rules', 'consumer_representations',
    'marketing_consent', 'cross_border_disclosure', 'breach_response', 'provider_customer_terms'
  )),
  status text NOT NULL DEFAULT 'required' CHECK (status IN ('required', 'pending', 'approved')),
  review_reference text,
  reviewer_identity text,
  updated_by_identity text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  UNIQUE (customer_id, control_key),
  CHECK (status <> 'approved' OR (review_reference IS NOT NULL AND reviewer_identity IS NOT NULL AND approved_at IS NOT NULL))
);

INSERT INTO __SOPHIA_RUNTIME_SCHEMA__.privacy_legal_reviews (customer_id, control_key, updated_by_identity)
SELECT c.customer_id, control_key, 'system:migration-023'
FROM __SOPHIA_RUNTIME_SCHEMA__.customers c
CROSS JOIN unnest(ARRAY[
  'privacy_act_applicability', 'privacy_notice', 'recording_rules', 'consumer_representations',
  'marketing_consent', 'cross_border_disclosure', 'breach_response', 'provider_customer_terms'
]::text[]) control_key
ON CONFLICT (customer_id, control_key) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_privacy_subject_requests_customer_status
  ON __SOPHIA_RUNTIME_SCHEMA__.privacy_subject_requests(customer_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_privacy_holds_subject_active
  ON __SOPHIA_RUNTIME_SCHEMA__.privacy_legal_holds(customer_id, subject_reference_digest)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_privacy_consent_session_purpose
  ON __SOPHIA_RUNTIME_SCHEMA__.privacy_consent_events(customer_id, session_id, purpose, recorded_at DESC);

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_privacy_consent_event()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Privacy consent evidence is append-only';
END;
$$;
DROP TRIGGER IF EXISTS protect_privacy_consent_event ON __SOPHIA_RUNTIME_SCHEMA__.privacy_consent_events;
CREATE TRIGGER protect_privacy_consent_event BEFORE UPDATE OR DELETE
  ON __SOPHIA_RUNTIME_SCHEMA__.privacy_consent_events
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_privacy_consent_event();

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_privacy_subject_request_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.request_type IS DISTINCT FROM OLD.request_type
     OR NEW.subject_reference_digest IS DISTINCT FROM OLD.subject_reference_digest
     OR NEW.selectors IS DISTINCT FROM OLD.selectors
     OR NEW.requested_by_identity IS DISTINCT FROM OLD.requested_by_identity
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Privacy subject request identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS protect_privacy_subject_request_identity ON __SOPHIA_RUNTIME_SCHEMA__.privacy_subject_requests;
CREATE TRIGGER protect_privacy_subject_request_identity BEFORE UPDATE
  ON __SOPHIA_RUNTIME_SCHEMA__.privacy_subject_requests
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_privacy_subject_request_identity();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'privacy_notice_versions', 'privacy_consent_events', 'session_privacy_controls',
    'privacy_retention_policies', 'privacy_legal_holds', 'privacy_subject_requests',
    'privacy_subject_request_targets', 'privacy_data_flows', 'privacy_legal_reviews'
  ] LOOP
    EXECUTE format('ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON __SOPHIA_RUNTIME_SCHEMA__.%I', table_name || '_tenant_isolation', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON __SOPHIA_RUNTIME_SCHEMA__.%I USING (customer_id = NULLIF(current_setting(''sophia.tenant_id'', true), '''')::uuid) WITH CHECK (customer_id = NULLIF(current_setting(''sophia.tenant_id'', true), '''')::uuid)',
      table_name || '_tenant_isolation', table_name
    );
  END LOOP;
END;
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  __SOPHIA_RUNTIME_SCHEMA__.privacy_notice_versions,
  __SOPHIA_RUNTIME_SCHEMA__.session_privacy_controls,
  __SOPHIA_RUNTIME_SCHEMA__.privacy_retention_policies,
  __SOPHIA_RUNTIME_SCHEMA__.privacy_legal_holds,
  __SOPHIA_RUNTIME_SCHEMA__.privacy_subject_requests,
  __SOPHIA_RUNTIME_SCHEMA__.privacy_subject_request_targets,
  __SOPHIA_RUNTIME_SCHEMA__.privacy_data_flows,
  __SOPHIA_RUNTIME_SCHEMA__.privacy_legal_reviews
TO sophia_runtime_app;
GRANT SELECT, INSERT ON __SOPHIA_RUNTIME_SCHEMA__.privacy_consent_events TO sophia_runtime_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA __SOPHIA_RUNTIME_SCHEMA__ TO sophia_runtime_app;
