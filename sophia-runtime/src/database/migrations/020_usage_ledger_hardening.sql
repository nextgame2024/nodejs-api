REVOKE DELETE, TRUNCATE ON __SOPHIA_RUNTIME_SCHEMA__.provider_usage_events FROM sophia_runtime_app;
GRANT SELECT, INSERT, UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.provider_usage_events TO sophia_runtime_app;

CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_provider_usage_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.measurement_status = 'measured' THEN
    RAISE EXCEPTION 'Measured provider usage is immutable';
  END IF;
  IF NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.session_id IS DISTINCT FROM OLD.session_id
     OR NEW.source_event_id IS DISTINCT FROM OLD.source_event_id
     OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
     OR NEW.adapter_key IS DISTINCT FROM OLD.adapter_key
     OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
     OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at THEN
    RAISE EXCEPTION 'Provider usage event identity is immutable';
  END IF;
  IF OLD.measurement_status = 'estimated' AND NEW.measurement_status = 'incomplete' THEN
    RAISE EXCEPTION 'Estimated usage cannot become incomplete';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'Provider usage reconciliation must increment revision exactly once';
  END IF;
  RETURN NEW;
END;
$$;
