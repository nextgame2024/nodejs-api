-- Generic scheduling records for business manager.
-- Current implementation targets project bookings, but keeps scheduled item
-- fields generic so the same table can support appointments, jobs, or other
-- schedulable entities later.

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS bm_schedule (
  schedule_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  user_id uuid NULL,
  project_id uuid NULL,
  scheduled_item_type text NOT NULL DEFAULT 'project',
  scheduled_item_id text NOT NULL,
  scheduled_item_label text NOT NULL,
  scheduled_item_secondary_label text NULL,
  schedule_date date NOT NULL,
  start_time time NOT NULL,
  end_time time NOT NULL,
  description text NOT NULL,
  schedule_start_at timestamp GENERATED ALWAYS AS (
    schedule_date::timestamp + start_time
  ) STORED,
  schedule_end_at timestamp GENERATED ALWAYS AS (
    schedule_date::timestamp + end_time
  ) STORED,
  createdat timestamptz NOT NULL DEFAULT NOW(),
  updatedat timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_bm_schedule_company
    FOREIGN KEY (company_id)
    REFERENCES bm_company(company_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_bm_schedule_user
    FOREIGN KEY (user_id)
    REFERENCES users(id)
    ON DELETE SET NULL,
  CONSTRAINT fk_bm_schedule_project
    FOREIGN KEY (project_id)
    REFERENCES bm_projects(project_id)
    ON DELETE SET NULL,
  CONSTRAINT ck_bm_schedule_item_type_nonempty
    CHECK (length(trim(scheduled_item_type)) > 0),
  CONSTRAINT ck_bm_schedule_item_id_nonempty
    CHECK (length(trim(scheduled_item_id)) > 0),
  CONSTRAINT ck_bm_schedule_item_label_nonempty
    CHECK (length(trim(scheduled_item_label)) > 0),
  CONSTRAINT ck_bm_schedule_description_nonempty
    CHECK (length(trim(description)) > 0),
  CONSTRAINT ck_bm_schedule_time_range
    CHECK (start_time < end_time),
  CONSTRAINT ck_bm_schedule_15_minute_slots
    CHECK (
      EXTRACT(SECOND FROM start_time) = 0
      AND EXTRACT(SECOND FROM end_time) = 0
      AND MOD(EXTRACT(MINUTE FROM start_time)::int, 15) = 0
      AND MOD(EXTRACT(MINUTE FROM end_time)::int, 15) = 0
    ),
  CONSTRAINT ex_bm_schedule_company_time_overlap
    EXCLUDE USING gist (
      company_id WITH =,
      tsrange(schedule_start_at, schedule_end_at, '[)') WITH &&
    )
);

CREATE INDEX IF NOT EXISTS idx_bm_schedule_company_date
  ON bm_schedule (company_id, schedule_date, start_time);

CREATE INDEX IF NOT EXISTS idx_bm_schedule_company_item
  ON bm_schedule (company_id, scheduled_item_type, scheduled_item_id);

CREATE INDEX IF NOT EXISTS idx_bm_schedule_project
  ON bm_schedule (project_id);

-- Make the new Scheduling menu entry available in existing company menu
-- configurations. It will still be manageable from Navigation links.
INSERT INTO bm_navigation_links (
  navigation_link_id,
  company_id,
  user_id,
  navigation_type,
  navigation_label,
  active
)
SELECT
  gen_random_uuid(),
  existing_menu.company_id,
  existing_menu.user_id,
  'menu',
  'Scheduling',
  true
FROM (
  SELECT DISTINCT ON (company_id)
    company_id,
    user_id
  FROM bm_navigation_links
  WHERE navigation_type = 'menu'
  ORDER BY company_id, createdat ASC
) existing_menu
ON CONFLICT DO NOTHING;
