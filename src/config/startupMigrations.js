import pool from "./db.js";

const BM_USER_TYPE_VALUES = ["employee", "supplier", "client"];

export async function ensureStartupMigrations() {
  await ensureBmUserTypeValues();
  await ensureTownPlannerBookingWorkflowSchema();
}

export async function ensureTownPlannerBookingWorkflowSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bm_property_report_jobs (
      report_job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL REFERENCES bm_company(company_id) ON DELETE CASCADE,
      property_id uuid NOT NULL REFERENCES bm_properties(property_id) ON DELETE CASCADE,
      cache_key text NOT NULL UNIQUE,
      report_version text NOT NULL,
      property_version text NOT NULL,
      report_inputs jsonb NOT NULL,
      status text NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'retry', 'daily_retry', 'running', 'ready', 'failed')),
      attempt_count integer NOT NULL DEFAULT 0,
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      locked_at timestamptz,
      lease_until timestamptz,
      locked_by text,
      pdf_key text,
      pdf_url text,
      last_error text,
      initial_attempts_exhausted_at timestamptz,
      completed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_bm_property_report_jobs_claim
      ON bm_property_report_jobs(status, next_attempt_at, created_at);

    CREATE TABLE IF NOT EXISTS bm_inspection_confirmation_deliveries (
      delivery_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL REFERENCES bm_company(company_id) ON DELETE CASCADE,
      booking_id uuid NOT NULL UNIQUE
        REFERENCES bm_property_inspection_bookings(booking_id) ON DELETE CASCADE,
      report_job_id uuid NOT NULL
        REFERENCES bm_property_report_jobs(report_job_id) ON DELETE CASCADE,
      status text NOT NULL DEFAULT 'waiting_report'
        CHECK (status IN (
          'waiting_report', 'email_queued', 'email_sending', 'email_retry',
          'sent', 'fallback_queued', 'fallback_sent', 'failed'
        )),
      attempt_count integer NOT NULL DEFAULT 0,
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      locked_at timestamptz,
      lease_until timestamptz,
      locked_by text,
      sent_at timestamptz,
      fallback_without_report boolean NOT NULL DEFAULT false,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_bm_inspection_deliveries_claim
      ON bm_inspection_confirmation_deliveries(status, next_attempt_at, created_at);
  `);
}

async function ensureBmUserTypeValues() {
  for (const value of BM_USER_TYPE_VALUES) {
    try {
      await pool.query(
        `ALTER TYPE bm_user_type ADD VALUE IF NOT EXISTS '${value}'`
      );
    } catch (error) {
      if (error?.code === "42704") {
        console.warn("bm_user_type enum not found; skipping user type sync");
        return;
      }
      throw error;
    }
  }
}
