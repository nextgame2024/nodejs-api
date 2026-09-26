CREATE OR REPLACE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.protect_commercial_plan_version()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('published', 'retired') THEN
      RAISE EXCEPTION 'Published commercial plan versions are immutable';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'retired' THEN
    RAISE EXCEPTION 'Published commercial plan versions are immutable';
  END IF;
  IF OLD.status = 'published' THEN
    IF NEW.status = 'retired'
       AND (to_jsonb(NEW) - 'status') = (to_jsonb(OLD) - 'status') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Published commercial plan versions are immutable';
  END IF;
  RETURN NEW;
END;
$$;
