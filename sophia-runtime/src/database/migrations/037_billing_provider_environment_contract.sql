-- Contract only after the environment-aware Runtime has deployed. Migration 036
-- deliberately keeps sandbox defaults so the previous Runtime remains compatible
-- during a rolling release.
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_subscription_references
  ALTER COLUMN provider_environment DROP DEFAULT;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_references
  ALTER COLUMN provider_environment DROP DEFAULT;
