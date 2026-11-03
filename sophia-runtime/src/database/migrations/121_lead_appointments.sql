-- Scheduling extension for tenant-scoped lead appointments. Project bookings
-- keep their existing company-wide calendar; advisor appointments have their
-- own per-advisor conflict boundary, shared by every future booking channel.
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.lead_advisor_calendars (
 customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id),
 advisor_identity text NOT NULL,timezone text NOT NULL CHECK(length(timezone) BETWEEN 1 AND 100),
 slot_minutes int NOT NULL CHECK(slot_minutes IN (15,30,45,60)),
 lead_time_minutes int NOT NULL CHECK(lead_time_minutes BETWEEN 0 AND 10080),
 booking_window_days int NOT NULL CHECK(booking_window_days BETWEEN 1 AND 180),
 weekly_hours jsonb NOT NULL CHECK(jsonb_typeof(weekly_hours)='array' AND jsonb_array_length(weekly_hours)<=28),
 closed_dates jsonb NOT NULL CHECK(jsonb_typeof(closed_dates)='array' AND jsonb_array_length(closed_dates)<=100),
 revision int NOT NULL DEFAULT 1 CHECK(revision>0),updated_by_identity text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(customer_id,advisor_identity)
);
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.lead_appointments (
 appointment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),customer_id uuid NOT NULL,
 lead_id uuid NOT NULL,advisor_identity text NOT NULL,
 starts_at timestamptz NOT NULL,ends_at timestamptz NOT NULL,customer_timezone text NOT NULL,
 description text NOT NULL DEFAULT '' CHECK(length(description)<=1000),
 status text NOT NULL DEFAULT 'confirmed' CHECK(status IN ('confirmed','cancelled')),
 version int NOT NULL DEFAULT 1 CHECK(version>0),calendar_revision int NOT NULL,
 created_by_identity text NOT NULL,updated_by_identity text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(extract(epoch FROM (ends_at-starts_at))/60 IN (15,30,45,60)),
 CHECK(extract(second FROM starts_at)=0 AND mod(extract(minute FROM starts_at AT TIME ZONE 'UTC')::int,15)=0),
 UNIQUE(customer_id,appointment_id),
 FOREIGN KEY(customer_id,lead_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.assistant_leads(customer_id,lead_id),
 FOREIGN KEY(customer_id,advisor_identity) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.lead_advisor_calendars(customer_id,advisor_identity),
 EXCLUDE USING gist(customer_id WITH =,advisor_identity WITH =,tstzrange(starts_at,ends_at,'[)') WITH &&) WHERE(status='confirmed')
);
CREATE INDEX lead_appointments_list ON __SOPHIA_RUNTIME_SCHEMA__.lead_appointments(customer_id,starts_at,appointment_id);
CREATE INDEX lead_appointments_lead ON __SOPHIA_RUNTIME_SCHEMA__.lead_appointments(customer_id,lead_id,starts_at DESC);
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.lead_appointment_mutations (
 customer_id uuid NOT NULL,request_key uuid NOT NULL,actor_identity text NOT NULL,
 request_hash text NOT NULL,appointment_id uuid NOT NULL,action text NOT NULL CHECK(action IN ('book','reschedule','cancel')),
 result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(customer_id,request_key),
 FOREIGN KEY(customer_id,appointment_id) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.lead_appointments(customer_id,appointment_id)
);
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.lead_calendar_audit (
 customer_id uuid NOT NULL,advisor_identity text NOT NULL,revision int NOT NULL,
 actor_identity text NOT NULL,configuration jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(customer_id,advisor_identity,revision),
 FOREIGN KEY(customer_id,advisor_identity) REFERENCES __SOPHIA_RUNTIME_SCHEMA__.lead_advisor_calendars(customer_id,advisor_identity)
);
DO $$ DECLARE item text; BEGIN
 FOREACH item IN ARRAY ARRAY['lead_advisor_calendars','lead_appointments','lead_appointment_mutations','lead_calendar_audit'] LOOP
 EXECUTE format('ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.%I ENABLE ROW LEVEL SECURITY',item);
 EXECUTE format('ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.%I FORCE ROW LEVEL SECURITY',item);
 EXECUTE format('CREATE POLICY tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.%I USING(customer_id=NULLIF(current_setting(''sophia.tenant_id'',true),'''')::uuid) WITH CHECK(customer_id=NULLIF(current_setting(''sophia.tenant_id'',true),'''')::uuid)',item);
 EXECUTE format('REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.%I FROM sophia_runtime_app',item);
 EXECUTE format('GRANT SELECT,INSERT ON __SOPHIA_RUNTIME_SCHEMA__.%I TO sophia_runtime_app',item);
 END LOOP;
END $$;
GRANT UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.lead_advisor_calendars,__SOPHIA_RUNTIME_SCHEMA__.lead_appointments TO sophia_runtime_app;
