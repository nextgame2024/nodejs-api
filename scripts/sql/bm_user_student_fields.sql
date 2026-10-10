-- Run against the Business Manager PostgreSQL database before deploying the API.
ALTER TYPE bm_user_type ADD VALUE IF NOT EXISTS 'student';
ALTER TYPE bm_user_type ADD VALUE IF NOT EXISTS 'advisor';

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS student_id text NULL,
  ADD COLUMN IF NOT EXISTS student_name_in_xero text NULL;

CREATE TABLE IF NOT EXISTS bm_student_id_counter (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  last_value bigint NOT NULL DEFAULT 0 CHECK (last_value >= 0)
);

INSERT INTO bm_student_id_counter (id, last_value)
VALUES (true, 0) ON CONFLICT (id) DO NOTHING;

UPDATE bm_student_id_counter SET last_value = GREATEST(
  last_value,
  COALESCE((SELECT MAX(substring(student_id FROM '^STD-([0-9]+)$')::bigint)
            FROM users WHERE student_id ~ '^STD-[0-9]+$'), 0)
) WHERE id = true;

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_student_id
  ON users (student_id) WHERE student_id IS NOT NULL;
