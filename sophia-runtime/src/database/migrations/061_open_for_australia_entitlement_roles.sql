ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.business_pack_entitlements
  ADD COLUMN IF NOT EXISTS role_key text;

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.business_pack_entitlements
  DROP CONSTRAINT IF EXISTS business_pack_entitlements_open_for_australia_role_check;

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.business_pack_entitlements
  ADD CONSTRAINT business_pack_entitlements_open_for_australia_role_check CHECK (
    pack_id <> 'open-for-australia'
    OR status <> 'active'
    OR (role_key IS NOT NULL AND role_key IN ('chief_executive', 'operations', 'advisor'))
  );
