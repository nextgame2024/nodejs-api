ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.admin_memberships
  DROP CONSTRAINT IF EXISTS admin_memberships_client_module_scope_check;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.admin_memberships
  ADD CONSTRAINT admin_memberships_client_module_scope_check CHECK (
    role_key <> 'client_administrator'
    OR status <> 'active'
    OR (
      module_scope IS NOT NULL
      AND cardinality(module_scope) > 0
      AND module_scope <@ ARRAY[
        'ADM-01','ADM-02','ADM-03','ADM-04','ADM-05','ADM-06','ADM-07','ADM-08',
        'ADM-09','ADM-10','ADM-11','ADM-12','ADM-13','ADM-14','ADM-15','ADM-16'
      ]::text[]
    )
  );
