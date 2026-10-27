-- Sophia proposals remain editable until an invoice sequence is claimed for
-- Xero creation. Export receipts remain the immutable duplicate-prevention
-- boundary; the Runtime service locks both stores before updating a proposal.
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_case_invoice_draft_batches
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK(revision>0);

REVOKE UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.student_case_invoice_draft_batches FROM PUBLIC,sophia_runtime_app;
GRANT UPDATE(advisor_id,advisor_label,snapshot,actor_identity_user_id,updated_at,revision)
  ON __SOPHIA_RUNTIME_SCHEMA__.student_case_invoice_draft_batches TO sophia_runtime_app;
