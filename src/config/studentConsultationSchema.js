import pool from './db.js';
export async function ensureStudentConsultationSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bm_student_advisers (
      adviser_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL REFERENCES bm_company(company_id),
      adviser_name text NOT NULL, service_name text NOT NULL,
      meeting_details text NOT NULL, time_zone text NOT NULL DEFAULT 'Australia/Brisbane',
      is_demo boolean NOT NULL DEFAULT false, active boolean NOT NULL DEFAULT true,
      UNIQUE(company_id, adviser_id)
    );
    CREATE TABLE IF NOT EXISTS bm_student_consultation_slots (
      slot_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL, adviser_id uuid NOT NULL,
      starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
      capacity integer NOT NULL DEFAULT 1 CHECK(capacity > 0),
      status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed','cancelled')),
      FOREIGN KEY(company_id,adviser_id) REFERENCES bm_student_advisers(company_id,adviser_id),
      CHECK(ends_at > starts_at), UNIQUE(adviser_id,starts_at), UNIQUE(company_id,slot_id)
    );
    CREATE TABLE IF NOT EXISTS bm_student_consultation_bookings (
      booking_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL, slot_id uuid NOT NULL,
      customer_name text NOT NULL, customer_email text NOT NULL,
      enquiry_summary text NOT NULL DEFAULT '', source_links jsonb NOT NULL DEFAULT '[]'::jsonb,
      include_summary boolean NOT NULL DEFAULT false,
      idempotency_key text NOT NULL,
      status text NOT NULL DEFAULT 'confirmed' CHECK(status IN ('confirmed','cancelled')),
      created_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY(company_id,slot_id) REFERENCES bm_student_consultation_slots(company_id,slot_id),
      UNIQUE(company_id,idempotency_key), UNIQUE(slot_id,customer_email), UNIQUE(company_id,booking_id)
    );
    CREATE TABLE IF NOT EXISTS bm_student_consultation_deliveries (
      delivery_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL, booking_id uuid NOT NULL UNIQUE,
      status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sending','retry','sent','failed','logged')),
      attempt_count integer NOT NULL DEFAULT 0,
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      locked_by text, lease_until timestamptz, sent_at timestamptz, last_error text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY(company_id,booking_id) REFERENCES bm_student_consultation_bookings(company_id,booking_id)
    );
    CREATE INDEX IF NOT EXISTS idx_student_consultation_slot_lookup ON bm_student_consultation_slots(company_id,starts_at);
    CREATE INDEX IF NOT EXISTS idx_student_consultation_email_claim ON bm_student_consultation_deliveries(status,next_attempt_at);
  `);
}
