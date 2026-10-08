REVOKE DELETE ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_students
  FROM sophia_runtime_app;

REVOKE UPDATE, DELETE ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_student_audit_events
  FROM sophia_runtime_app;

REVOKE DELETE ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_write_requests
  FROM sophia_runtime_app;

GRANT SELECT, INSERT, UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_students
  TO sophia_runtime_app;
GRANT SELECT, INSERT ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_student_audit_events
  TO sophia_runtime_app;
GRANT SELECT, INSERT, UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_write_requests
  TO sophia_runtime_app;
