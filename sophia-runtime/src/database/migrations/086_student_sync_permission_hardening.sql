-- Migration 010's default table CRUD grants are additive: column-level GRANT
-- alone did not remove the inherited table-wide UPDATE/INSERT/DELETE rights.
-- Repair only these student sync stores. Do not change global defaults or data.
REVOKE ALL PRIVILEGES ON TABLE
  __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_daily_budgets,
  __SOPHIA_RUNTIME_SCHEMA__.xero_connection_rate_limits,
  __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_sources,
  __SOPHIA_RUNTIME_SCHEMA__.xero_quota_admission,
  __SOPHIA_RUNTIME_SCHEMA__.student_document_recheck_budgets
  FROM sophia_runtime_app;
GRANT SELECT,INSERT,UPDATE ON TABLE
  __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_daily_budgets,
  __SOPHIA_RUNTIME_SCHEMA__.xero_connection_rate_limits,
  __SOPHIA_RUNTIME_SCHEMA__.student_operations_document_sources,
  __SOPHIA_RUNTIME_SCHEMA__.student_document_recheck_budgets
  TO sophia_runtime_app;
GRANT SELECT ON __SOPHIA_RUNTIME_SCHEMA__.xero_quota_admission TO sophia_runtime_app;
GRANT INSERT(customer_id,xero_connection_id) ON __SOPHIA_RUNTIME_SCHEMA__.xero_quota_admission TO sophia_runtime_app;
GRANT UPDATE(remaining,refresh_after,provider_reset_at,generation,reservation_sequence,generation_admissions,
  operational_admissions,discovery_admissions,probe_until,probe_sequence,observed_at,updated_at)
  ON __SOPHIA_RUNTIME_SCHEMA__.xero_quota_admission TO sophia_runtime_app;
