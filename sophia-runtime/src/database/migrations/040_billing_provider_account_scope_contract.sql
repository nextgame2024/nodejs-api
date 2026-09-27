ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_provider_customers
  ALTER COLUMN provider_account_key DROP DEFAULT;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_webhook_events
  ALTER COLUMN provider_account_key DROP DEFAULT;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_checkout_intents
  ALTER COLUMN provider_account_key DROP DEFAULT;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_subscription_references
  ALTER COLUMN provider_account_key DROP DEFAULT;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_references
  ALTER COLUMN provider_account_key DROP DEFAULT;

DROP FUNCTION IF EXISTS __SOPHIA_RUNTIME_SCHEMA__.resolve_billing_customer_tenant(text, text, text);

COMMENT ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.resolve_billing_customer_tenant(text, text, text, text) IS
  'Resolves an opaque provider customer only inside one provider environment and provider-account scope.';
