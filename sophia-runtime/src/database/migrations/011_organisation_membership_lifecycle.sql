ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.customers
  ADD COLUMN IF NOT EXISTS settings_revision integer NOT NULL DEFAULT 1 CHECK (settings_revision > 0),
  ADD COLUMN IF NOT EXISTS admission_suspended_at timestamptz,
  ADD COLUMN IF NOT EXISTS suspension_reason text;

CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.admin_invitations (
  invitation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE CASCADE,
  recipient_email text NOT NULL,
  recipient_email_hash text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  role_key text NOT NULL CHECK (role_key IN (
    'organisation_owner', 'configuration_editor', 'release_publisher',
    'operations_member', 'billing_administrator', 'read_only_auditor'
  )),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'redeemed', 'revoked', 'expired')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  invited_by_identity text NOT NULL,
  redeemed_by_identity text,
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sophia_admin_invitations_tenant_status
  ON __SOPHIA_RUNTIME_SCHEMA__.admin_invitations(customer_id, status, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sophia_admin_invitations_pending_recipient
  ON __SOPHIA_RUNTIME_SCHEMA__.admin_invitations(customer_id, recipient_email_hash)
  WHERE status = 'pending';

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'admin_memberships_role_key_check'
      AND conrelid = '__SOPHIA_RUNTIME_SCHEMA__.admin_memberships'::regclass
  ) THEN
    ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.admin_memberships
      ADD CONSTRAINT admin_memberships_role_key_check CHECK (role_key IN (
        'organisation_owner', 'configuration_editor', 'release_publisher',
        'operations_member', 'billing_administrator', 'read_only_auditor'
      ));
  END IF;
END
$migration$;

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.admin_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.admin_memberships FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS admin_memberships_tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.admin_memberships;
CREATE POLICY admin_memberships_tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.admin_memberships
  USING (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid)
  WITH CHECK (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid);
