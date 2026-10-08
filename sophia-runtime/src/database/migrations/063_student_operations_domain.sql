ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.business_pack_entitlements
  DROP CONSTRAINT IF EXISTS business_pack_entitlements_open_for_australia_role_check;

UPDATE __SOPHIA_RUNTIME_SCHEMA__.business_pack_entitlements
   SET pack_id = 'student-operations'
 WHERE pack_id = 'open-for-australia';

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.business_pack_entitlements
  ADD CONSTRAINT business_pack_entitlements_student_operations_role_check CHECK (
    pack_id <> 'student-operations'
    OR status <> 'active'
    OR (role_key IS NOT NULL AND role_key IN ('chief_executive', 'operations', 'advisor'))
  );

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.open_for_australia_students
  RENAME TO student_operations_students;

ALTER INDEX __SOPHIA_RUNTIME_SCHEMA__.idx_ofa_students_tenant_status_name
  RENAME TO idx_student_operations_students_tenant_status_name;
ALTER INDEX __SOPHIA_RUNTIME_SCHEMA__.idx_ofa_students_tenant_advisor
  RENAME TO idx_student_operations_students_tenant_advisor;

ALTER POLICY open_for_australia_students_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_students
  RENAME TO student_operations_students_tenant_isolation;

