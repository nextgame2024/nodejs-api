ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.workflow_run_references
  ADD COLUMN IF NOT EXISTS source_session_id uuid;

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.workflow_run_references
  DROP CONSTRAINT IF EXISTS workflow_run_source_session_tenant_fk;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.workflow_run_references
  ADD CONSTRAINT workflow_run_source_session_tenant_fk
  FOREIGN KEY (source_session_id, customer_id)
  REFERENCES __SOPHIA_RUNTIME_SCHEMA__.sessions(session_id, customer_id) ON DELETE SET NULL (source_session_id);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_source_session
  ON __SOPHIA_RUNTIME_SCHEMA__.workflow_run_references(customer_id, source_session_id, created_at)
  WHERE source_session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.conversation_operator_notes (
  conversation_operator_note_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  session_id uuid NOT NULL,
  note_text text NOT NULL CHECK (length(note_text) BETWEEN 1 AND 4000),
  created_by_identity text NOT NULL CHECK (length(created_by_identity) BETWEEN 1 AND 240),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (session_id, customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.sessions(session_id, customer_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_conversation_notes_session
  ON __SOPHIA_RUNTIME_SCHEMA__.conversation_operator_notes(customer_id, session_id, created_at,
    conversation_operator_note_id);

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_conversation_operator_note()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Conversation operator notes cannot be deleted';
  END IF;
  IF NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.session_id IS DISTINCT FROM OLD.session_id
     OR NEW.created_by_identity IS DISTINCT FROM OLD.created_by_identity
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.note_text <> '[privacy redacted]'
     OR OLD.note_text = '[privacy redacted]' THEN
    RAISE EXCEPTION 'Conversation operator notes are append-only except for privacy redaction';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_conversation_operator_note
  ON __SOPHIA_RUNTIME_SCHEMA__.conversation_operator_notes;
CREATE TRIGGER protect_conversation_operator_note
  BEFORE UPDATE OR DELETE ON __SOPHIA_RUNTIME_SCHEMA__.conversation_operator_notes
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_conversation_operator_note();

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.conversation_operator_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.conversation_operator_notes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS conversation_operator_notes_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.conversation_operator_notes;
CREATE POLICY conversation_operator_notes_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.conversation_operator_notes
  USING (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid)
  WITH CHECK (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.conversation_operator_notes TO sophia_runtime_app;
REVOKE DELETE ON __SOPHIA_RUNTIME_SCHEMA__.conversation_operator_notes FROM sophia_runtime_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA __SOPHIA_RUNTIME_SCHEMA__ TO sophia_runtime_app;
