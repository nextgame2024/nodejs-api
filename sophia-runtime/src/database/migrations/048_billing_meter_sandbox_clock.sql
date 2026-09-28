ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_meter_event_outbox
  DROP CONSTRAINT IF EXISTS billing_meter_event_outbox_check1;

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_meter_event_outbox
  ADD CONSTRAINT billing_meter_event_outbox_event_timestamp_check CHECK (
    (provider_environment = 'live' AND event_timestamp <= created_at)
    OR
    (provider_environment = 'sandbox'
      AND event_timestamp <= created_at + interval '62 days')
  );

COMMENT ON CONSTRAINT billing_meter_event_outbox_event_timestamp_check
  ON __SOPHIA_RUNTIME_SCHEMA__.billing_meter_event_outbox IS
  'Live events cannot be future-dated. Sandbox events permit only the bounded two-month test-clock horizon used by the isolated billing proof.';
