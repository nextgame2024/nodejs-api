-- Track idempotent inspection confirmation email delivery.
ALTER TABLE bm_property_inspection_bookings
  ADD COLUMN IF NOT EXISTS confirmation_email_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS confirmation_email_error text;
